/** Shared behavioral conformance suite for Graph Scheduler Providers. @module */

import { describe, expect, it } from 'vitest'
import { GraphRunGenerationId, GraphRunId } from '@deepseek-ai/dsh-graph'
import {
  GraphSchedulerOwnerId,
  type GraphSchedulerAcquireRequest,
  type GraphSchedulerLease,
  type GraphSchedulerProvider,
} from '../src/index.ts'

/** Fresh Scheduler Provider used by one conformance case. */
export interface GraphSchedulerContractHarness {
  readonly provider: GraphSchedulerProvider
  readonly dispose?: () => void
}

const signal = (): AbortSignal => new AbortController().signal
const acquire = (
  owner: string,
  generation = 'generation-1',
  overrides: Partial<GraphSchedulerAcquireRequest> = {},
): GraphSchedulerAcquireRequest => ({
  protocolVersion: 1,
  sessionId: 'contract-session',
  runId: GraphRunId('contract-run'),
  generationId: GraphRunGenerationId(generation),
  ownerId: GraphSchedulerOwnerId(owner),
  minimumOwnerEpoch: 1,
  requestedAt: Date.now(),
  ...overrides,
})

const exact = (lease: GraphSchedulerLease) => ({
  protocolVersion: 1 as const,
  providerId: lease.providerId,
  leaseId: lease.id,
  runId: lease.runId,
  generationId: lease.generationId,
  ownerId: lease.ownerId,
  ownerEpoch: lease.ownerEpoch,
  fencingToken: lease.fencingToken,
  at: Date.now(),
})

/**
 * Run the Provider-neutral exclusive ownership, renewal, release, and takeover assertions.
 * @param label Provider label shown by the test runner.
 * @param create factory returning an isolated Scheduler Provider.
 */
export function runGraphSchedulerProviderContract(
  label: string,
  create: () => Promise<GraphSchedulerContractHarness> | GraphSchedulerContractHarness,
): void {
  describe(`graph scheduler provider contract: ${label}`, () => {
    it('serializes owners and preserves exact idempotent acquisition identity', async () => {
      const harness = await create()
      try {
        const request = acquire('owner-one')
        const first = await harness.provider.acquire(request, signal())
        if (first.status !== 'granted') throw new Error('expected contract ownership')
        await expect(harness.provider.acquire(request, signal())).resolves.toEqual(first)
        await expect(harness.provider.acquire(acquire('owner-two', 'generation-2'), signal())).resolves.toMatchObject({ status: 'busy' })
        await expect(async () => await harness.provider.acquire({ ...request, sessionId: 'different-session' }, signal()))
          .rejects.toThrow(/session/i)
        await expect(harness.provider.acquire({ ...request, minimumOwnerEpoch: first.lease.ownerEpoch + 1 }, signal()))
          .resolves.toMatchObject({ status: 'busy' })
      } finally {
        if (harness.dispose) {
          harness.dispose()
        }
      }
    })

    it('renews and releases only the exact identity, then fences a replaced owner', async () => {
      const harness = await create()
      try {
        const first = await harness.provider.acquire(acquire('owner-one'), signal())
        if (first.status !== 'granted') throw new Error('expected contract ownership')
        const renewed = await harness.provider.heartbeat(exact(first.lease), signal())
        expect(renewed).toMatchObject({ id: first.lease.id, fencingToken: first.lease.fencingToken })
        await expect(async () => await harness.provider.heartbeat({
          ...exact(renewed), fencingToken: renewed.fencingToken + 1,
        }, signal()))
          .rejects.toThrow(/fenced|absent/i)
        await harness.provider.release(exact(renewed), signal())
        await expect(harness.provider.release(exact(renewed), signal())).resolves.toBeUndefined()

        const replacement = await harness.provider.acquire(acquire('owner-two', 'generation-2', {
          minimumOwnerEpoch: renewed.ownerEpoch + 1,
        }), signal())
        if (replacement.status !== 'granted') throw new Error('expected replacement ownership')
        expect(replacement.lease.fencingToken).toBeGreaterThan(renewed.fencingToken)
        await expect(async () => await harness.provider.heartbeat(exact(renewed), signal())).rejects.toThrow(/fenced|absent/i)
        await expect(async () => {
          await harness.provider.release(exact(renewed), signal())
        }).rejects.toThrow(/fenced|absent/i)
      } finally {
        if (harness.dispose) {
          harness.dispose()
        }
      }
    })
  })
}
