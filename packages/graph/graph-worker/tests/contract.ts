/** Shared behavioral conformance suite for Graph Worker Providers. @module */

import { describe, expect, it } from 'vitest'
import {
  GraphWorkspaceAllocationId,
  type GraphWorkerAssignment,
  type GraphWorkerRuntime,
} from '../src/index.ts'

/** Worker lifecycle scenario requested from one Provider fixture. */
export type GraphWorkerContractScenario = 'completed' | 'pending'

/** Fresh assembled Worker Provider used by one conformance case. */
export interface GraphWorkerContractHarness {
  readonly runtime: GraphWorkerRuntime
  readonly providerName: string
  readonly assignment: GraphWorkerAssignment
  readonly dispose?: () => Promise<void> | void
}

/**
 * Run the Provider-neutral dispatch, completion, cancellation, and recovery assertions.
 * @param label Provider label shown by the test runner.
 * @param create factory returning an assembled Provider for the requested scenario.
 */
export function runGraphWorkerProviderContract(
  label: string,
  create: (scenario: GraphWorkerContractScenario) => Promise<GraphWorkerContractHarness>,
): void {
  describe(`graph worker provider contract: ${label}`, () => {
    it('publishes stable Worker and workspace references before terminal completion', async () => {
      const harness = await create('completed')
      try {
        const descriptor = harness.runtime.list().find(item => item.name === harness.providerName)
        expect(descriptor).toBeDefined()
        expect(descriptor?.capabilities).toMatchObject({ protocolVersion: 1, structuredOutput: true, cancellation: true })
        expect(descriptor?.capabilities.workspaceModes).toContain(harness.assignment.workspace.mode)
        const run = await harness.runtime.start(harness.providerName, harness.assignment)
        expect(String(run.id)).not.toBe('')
        expect(run.provider).toBe(harness.providerName)
        expect(String(run.workspace.id)).not.toBe('')
        expect(run.workspace.mode).toBe(harness.assignment.workspace.mode)
        expect(run.workspace.providerReference).not.toBe('')
        await expect(run.result).resolves.toMatchObject({ outcome: 'completed' })
      } finally {
        await harness.dispose?.()
      }
    })

    it('accepts cooperative cancellation and returns one aborted terminal result', async () => {
      const harness = await create('pending')
      try {
        const run = await harness.runtime.start(harness.providerName, harness.assignment)
        await expect(async () => { await run.cancel(' ', new AbortController().signal) }).rejects.toThrow(/non-empty/i)
        await run.cancel('contract operator cancellation', new AbortController().signal)
        await expect(run.result).resolves.toMatchObject({ outcome: 'aborted' })
        await expect(run.cancel('contract operator cancellation', new AbortController().signal)).resolves.toBeUndefined()
      } finally {
        await harness.dispose?.()
      }
    })

    it('reconciles only the exact active Worker and workspace identity', async () => {
      const harness = await create('pending')
      try {
        const run = await harness.runtime.start(harness.providerName, harness.assignment)
        const recovery = {
          protocolVersion: 1 as const,
          workId: harness.assignment.workId,
          operationId: harness.assignment.operationId,
          runId: harness.assignment.runId,
          generationId: harness.assignment.generationId,
          ownerEpoch: harness.assignment.ownerEpoch,
          workerId: run.id,
          workspaceId: run.workspace.id,
          workspaceMode: run.workspace.mode,
          cleanup: harness.assignment.workspace.cleanup,
          safeToDelete: false,
        }
        await expect(harness.runtime.reconcile(harness.providerName, {
          ...recovery,
          workspaceId: GraphWorkspaceAllocationId(`${String(run.workspace.id)}-different`),
        }, new AbortController().signal)).rejects.toThrow(/different workspace/i)
        await expect(harness.runtime.reconcile(
          harness.providerName, recovery, new AbortController().signal,
        )).resolves.toMatchObject({ status: 'canceled' })
        await expect(run.result).resolves.toMatchObject({ outcome: 'aborted' })
      } finally {
        await harness.dispose?.()
      }
    })
  })
}
