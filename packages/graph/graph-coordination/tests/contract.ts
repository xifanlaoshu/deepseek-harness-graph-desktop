/** Shared behavioral conformance suite for Graph coordination Providers. @module */

import { describe, expect, it } from 'vitest'
import {
  GraphActivationId,
  GraphControlOperationId,
  GraphRunId,
  GraphSettlementId,
  GraphWorkId,
} from '@deepseek-ai/dsh-graph'
import type { GraphRevision, GraphRole } from '@deepseek-ai/dsh-graph'
import type { GraphCoordination, GraphCoordinationRequest } from '../src/index.ts'

/** Fresh Provider instance used by one protocol-conformance case. */
export interface GraphCoordinationContractHarness {
  readonly coordination: GraphCoordination
  readonly signal: AbortSignal
}

const role = {
  id: 'engineer', label: 'Engineer', description: 'implements', controller: false, enabled: true,
  model: {}, prompt: 'implement', maxParallel: 1,
} as unknown as GraphRole

const graph = {
  graphId: 'contract-graph', revision: 1, objective: 'ship', createdAt: 1, userInput: 'ship',
  nodes: [{
    id: 'task', title: 'Task', objective: 'implement', kind: 'implementation', roleId: 'engineer',
    acceptanceCriteria: ['done'], maxAttempts: 1, weight: 1,
  }],
  edges: [],
} as unknown as GraphRevision

const request = (): GraphCoordinationRequest => ({
  protocolVersion: 3,
  graph,
  node: graph.nodes[0]!,
  role,
  runId: GraphRunId('contract-run'),
  cwd: 'D:/contract-work',
  workId: GraphWorkId('contract-work'),
  activationId: GraphActivationId('contract-activation'),
  ownerEpoch: 1,
  operationId: GraphControlOperationId('contract-operation'),
  callerId: 'contract-caller',
})

/**
 * Run the provider-neutral eight-operation lifecycle and fencing assertions.
 * @param label Provider label shown by the test runner.
 * @param create Factory returning an isolated Provider for each case.
 */
export function runGraphCoordinationContract(
  label: string,
  create: () => Promise<GraphCoordinationContractHarness>,
): void {
  describe(`graph coordination contract: ${label}`, () => {
    it('implements the complete idempotent lifecycle with ordered observation', async () => {
      const { coordination, signal } = await create()
      const base = request()
      await coordination.prepare(graph, [role], base.cwd, signal)
      const claim = await coordination.claim(base, signal)
      const claimed = await coordination.observe({
        protocolVersion: 3, workId: base.workId, activationId: base.activationId, cwd: base.cwd, callerId: base.callerId,
      }, signal)
      expect(claimed).toMatchObject({ status: 'claimed' })
      expect(claimed.events.map(event => event.kind)).toContain('claimed')

      const heartbeat = await coordination.heartbeat({
        ...base, claimId: claim.claimId, leaseId: claim.leaseId,
        fencingToken: claim.fencingToken, progressSequence: 1,
      }, signal)
      const live = { ...base, claimId: claim.claimId, leaseId: heartbeat.leaseId, fencingToken: heartbeat.fencingToken }
      const firstProgress = await coordination.publishProgress({ ...live, progressSequence: 2, evidence: 'half complete' }, signal)
      const duplicateProgress = await coordination.publishProgress({ ...live, progressSequence: 2, evidence: 'half complete' }, signal)
      expect(duplicateProgress).toEqual(firstProgress)
      await expect(async () => await coordination.publishProgress({ ...live, progressSequence: 2, evidence: 'conflicting progress' }, signal))
        .rejects.toThrow(/conflict/i)

      await coordination.cancel({ ...live, progressSequence: 3, reason: 'operator requested stop' }, signal)
      await coordination.cancel({ ...live, progressSequence: 3, reason: 'operator requested stop' }, signal)
      await expect(async () => { await coordination.cancel({ ...live, progressSequence: 3, reason: 'different stop request' }, signal) })
        .rejects.toThrow(/different|conflict/i)
      const canceled = await coordination.watch({
        protocolVersion: 3, workId: base.workId, activationId: base.activationId, cwd: base.cwd, callerId: base.callerId,
        afterCursor: firstProgress.cursor,
      }, signal)
      expect(canceled).toMatchObject({ status: 'cancel-requested' })
      expect(canceled.events.map(event => event.kind)).toContain('cancel-requested')

      const renewed = await coordination.heartbeat({ ...live, progressSequence: 4 }, signal)
      expect(renewed.cancelRequested).toBe(true)
      const settlement = {
        ...base,
        claimId: claim.claimId,
        leaseId: renewed.leaseId,
        fencingToken: renewed.fencingToken,
        settlementId: GraphSettlementId('contract-settlement'),
        outcome: 'canceled' as const,
        evidence: 'operator cancellation confirmed',
      }
      await coordination.settle(settlement, signal)
      await coordination.settle(settlement, signal)
      await expect(async () => { await coordination.settle({ ...settlement, evidence: 'conflicting terminal evidence' }, signal) })
        .rejects.toThrow(/conflict/i)
      const reconciled = await coordination.reconcile({
        protocolVersion: 3,
        workId: base.workId,
        activationId: base.activationId,
        cwd: base.cwd,
        callerId: base.callerId,
        expectedOutcome: 'canceled',
      }, signal)
      expect(reconciled).toMatchObject({
        status: 'confirmed-terminal',
        observation: { status: 'terminal', terminal: { outcome: 'canceled', evidence: 'operator cancellation confirmed' } },
      })
      const conflict = await coordination.reconcile({
        protocolVersion: 3,
        workId: base.workId,
        activationId: base.activationId,
        cwd: base.cwd,
        callerId: base.callerId,
        expectedOutcome: 'succeeded',
      }, signal)
      expect(conflict.status).toBe('conflict')
    })

    it('rejects stale fenced writes and reports absent work without adopting it', async () => {
      const { coordination, signal } = await create()
      const base = request()
      const absent = await coordination.reconcile({
        protocolVersion: 3, workId: base.workId, activationId: base.activationId, cwd: base.cwd, callerId: base.callerId,
      }, signal)
      expect(absent).toMatchObject({ status: 'absent', observation: { status: 'absent' } })

      await coordination.prepare(graph, [role], base.cwd, signal)
      const claim = await coordination.claim(base, signal)
      const stale = {
        ...base,
        claimId: claim.claimId,
        leaseId: `${claim.leaseId}:stale`,
        fencingToken: claim.fencingToken,
        progressSequence: 1,
      }
      await expect(async () => await coordination.publishProgress({ ...stale, evidence: 'late progress' }, signal)).rejects.toThrow(/fenced|lease/i)
      await expect(async () => { await coordination.cancel({ ...stale, reason: 'late cancellation' }, signal) }).rejects.toThrow(/fenced|lease/i)
      await expect(async () => { await coordination.settle({
        ...stale,
        settlementId: GraphSettlementId('stale-settlement'),
        outcome: 'succeeded',
        evidence: 'late result',
      }, signal) }).rejects.toThrow(/fenced|lease/i)
    })
  })
}
