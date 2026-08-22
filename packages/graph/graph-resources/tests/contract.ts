/** Shared behavioral conformance suite for Graph resource Providers. @module */

import { describe, expect, it } from 'vitest'
import { GraphControlOperationId, GraphWorkId } from '@deepseek-ai/dsh-graph'
import {
  GraphResourceReservationId,
  type GraphResourceProvider,
  type GraphResourceReservationRequest,
  type GraphResourceRoute,
} from '../src/index.ts'

/** Fresh Provider instance used by one resource-conformance case. */
export interface GraphResourceContractHarness {
  readonly provider: GraphResourceProvider
  readonly route: GraphResourceRoute
  readonly dispose?: () => void
}

const signal = (): AbortSignal => new AbortController().signal

const request = (
  route: GraphResourceRoute,
  operation: string,
  overrides: Partial<GraphResourceReservationRequest> = {},
): GraphResourceReservationRequest => {
  const now = Date.now()
  return {
    protocolVersion: 1,
    ...route,
    workId: GraphWorkId(`contract-work-${operation}`),
    operationId: GraphControlOperationId(`contract-operation-${operation}`),
    ownerEpoch: 1,
    weight: 1,
    hardMaxParallel: 1,
    hardMaxWeight: 2,
    requestedAt: now,
    deadline: now + 60_000,
    ...overrides,
  }
}

/**
 * Run the Provider-neutral reservation, fencing, backoff, and recovery assertions.
 * @param label Provider label shown by the test runner.
 * @param create factory returning an isolated Provider for each case.
 */
export function runGraphResourceProviderContract(
  label: string,
  create: () => Promise<GraphResourceContractHarness> | GraphResourceContractHarness,
): void {
  describe(`graph resource provider contract: ${label}`, () => {
    it('keeps active reservation replay idempotent and rejects conflicting or stale writes', async () => {
      const harness = await create()
      try {
        const firstRequest = request(harness.route, 'active')
        const first = await harness.provider.reserve(firstRequest, signal())
        if (first.status !== 'granted') throw new Error('expected the contract reservation to be granted')
        await expect(harness.provider.reserve(firstRequest, signal())).resolves.toMatchObject({
          status: 'granted',
          reservation: {
            id: first.reservation.id,
            workId: first.reservation.workId,
            operationId: first.reservation.operationId,
            ownerEpoch: first.reservation.ownerEpoch,
            fencingToken: first.reservation.fencingToken,
            acquiredAt: first.reservation.acquiredAt,
            expiresAt: first.reservation.expiresAt,
          },
        })
        await expect(harness.provider.reserve({ ...firstRequest, weight: 1.5 }, signal())).rejects.toThrow(/conflict/i)

        await expect(harness.provider.observe(harness.route, signal())).resolves.toMatchObject({
          providerId: harness.provider.name,
          status: 'available',
          activeRequests: 1,
        })
        await expect(harness.provider.reserve(request(harness.route, 'capacity'), signal())).resolves.toMatchObject({
          status: 'wait',
          reason: 'concurrency',
        })

        const outcome = {
          reservationId: first.reservation.id,
          providerId: harness.provider.name,
          workId: first.reservation.workId,
          ownerEpoch: first.reservation.ownerEpoch,
          fencingToken: first.reservation.fencingToken,
          outcome: 'completed' as const,
          at: Date.now(),
          evidence: 'contract completion',
        }
        await expect(harness.provider.report({ ...outcome, fencingToken: outcome.fencingToken + 1 }, signal()))
          .rejects.toThrow(/fenced|absent/i)
        await harness.provider.report(outcome, signal())
        await expect(harness.provider.report(outcome, signal())).resolves.toBeUndefined()
        await expect(harness.provider.report({ ...outcome, outcome: 'released' }, signal())).rejects.toThrow(/conflict/i)

        const replacement = await harness.provider.reserve(firstRequest, signal())
        if (replacement.status !== 'granted') throw new Error('expected a replacement reservation')
        expect(replacement.reservation.id).toBe(first.reservation.id)
        expect(replacement.reservation.fencingToken).toBeGreaterThan(first.reservation.fencingToken)
      } finally {
        harness.dispose?.()
      }
    })

    it('releases abandoned capacity idempotently and distinguishes conflicts from absence', async () => {
      const harness = await create()
      try {
        const decision = await harness.provider.reserve(request(harness.route, 'orphan'), signal())
        if (decision.status !== 'granted') throw new Error('expected the contract reservation to be granted')
        const recovery = {
          protocolVersion: 1 as const,
          reservationId: decision.reservation.id,
          providerId: harness.provider.name,
          workId: decision.reservation.workId,
          ownerEpoch: decision.reservation.ownerEpoch,
          fencingToken: decision.reservation.fencingToken,
          at: Date.now(),
          evidence: 'contract recovery released abandoned capacity',
        }
        await expect(harness.provider.reconcile(recovery, signal())).resolves.toMatchObject({ status: 'released' })
        await expect(harness.provider.reconcile(recovery, signal())).resolves.toMatchObject({ status: 'already-released' })
        await expect(harness.provider.reconcile({ ...recovery, workId: GraphWorkId('different-work') }, signal()))
          .resolves.toMatchObject({ status: 'conflict' })
        await expect(harness.provider.reconcile({
          ...recovery,
          reservationId: GraphResourceReservationId(`${String(recovery.reservationId)}-absent`),
        }, signal())).resolves.toMatchObject({ status: 'absent' })
      } finally {
        harness.dispose?.()
      }
    })

    it('publishes OOM degradation before admitting more work on the route', async () => {
      const harness = await create()
      try {
        const decision = await harness.provider.reserve(request(harness.route, 'oom'), signal())
        if (decision.status !== 'granted') throw new Error('expected the contract reservation to be granted')
        await harness.provider.report({
          reservationId: decision.reservation.id,
          providerId: harness.provider.name,
          workId: decision.reservation.workId,
          ownerEpoch: decision.reservation.ownerEpoch,
          fencingToken: decision.reservation.fencingToken,
          outcome: 'oom',
          at: Date.now(),
          evidence: 'contract model server OOM',
        }, signal())
        await expect(harness.provider.observe(harness.route, signal())).resolves.toMatchObject({ status: 'degraded' })
        await expect(harness.provider.reserve(request(harness.route, 'after-oom'), signal())).resolves.toMatchObject({
          status: 'wait',
          reason: 'oom-backoff',
        })
      } finally {
        harness.dispose?.()
      }
    })
  })
}
