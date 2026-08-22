import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { GraphControlOperationId, GraphWorkId } from '@deepseek-ai/dsh-graph'
import GraphResourceRuntime from '@deepseek-ai/dsh-graph-resources'
import { LocalGraphResourceProvider, apply, type Config } from '../src/index.ts'
import { runGraphResourceProviderContract } from '../../graph-resources/tests/contract.ts'

const config = (): Config => ({
  providerName: 'local-resources', routes: [{ provider: 'local', model: 'qwen', concurrencyLimit: 1, weightLimit: 2, contextWindow: 128_000 }],
  observationTtlMs: 5_000, leaseMs: 60_000, retryMs: 250, oomBackoffMs: 30_000,
})

const request = (operation: string, weight = 1) => ({
  protocolVersion: 1 as const, provider: 'local', model: 'qwen', workId: GraphWorkId(`work-${operation}`),
  operationId: GraphControlOperationId(operation), ownerEpoch: 1, weight, hardMaxParallel: 2,
  hardMaxWeight: 2, requestedAt: Date.now(), deadline: Date.now() + 60_000,
})

describe('LocalGraphResourceProvider', () => {
  it('enforces leases and returns an idempotent reservation for one operation', async () => {
    const provider = new LocalGraphResourceProvider('local-resources', config())
    const first = await provider.reserve(request('one'), new AbortController().signal)
    expect(first.status).toBe('granted')
    expect(await provider.reserve(request('one'), new AbortController().signal)).toEqual(first)
    const waiting = await provider.reserve(request('two'), new AbortController().signal)
    expect(waiting).toMatchObject({ status: 'wait', reason: 'concurrency' })
    expect(await provider.observe({ provider: 'local', model: 'qwen' }, new AbortController().signal))
      .toMatchObject({ status: 'available', activeRequests: 1, activeWeight: 1, contextWindow: 128_000 })
  })

  it('backs off after OOM and rejects unknown or impossible routes', async () => {
    const provider = new LocalGraphResourceProvider('local-resources', config())
    expect(await provider.reserve({ ...request('heavy', 3), hardMaxWeight: 3 }, new AbortController().signal))
      .toMatchObject({ status: 'rejected', reason: 'request-impossible' })
    expect(await provider.reserve({ ...request('unknown'), model: 'missing' }, new AbortController().signal))
      .toMatchObject({ status: 'rejected', reason: 'route-unavailable' })
    const granted = await provider.reserve(request('oom'), new AbortController().signal)
    if (granted.status !== 'granted') throw new Error('expected a reservation')
    const outcome = {
      reservationId: granted.reservation.id, providerId: provider.name, workId: granted.reservation.workId,
      ownerEpoch: 1, fencingToken: granted.reservation.fencingToken, outcome: 'oom' as const, at: Date.now(),
    }
    await provider.report(outcome, new AbortController().signal)
    await provider.report({ ...outcome, at: outcome.at + 1, evidence: 'replayed settlement' }, new AbortController().signal)
    expect(await provider.reserve(request('after-oom'), new AbortController().signal)).toMatchObject({ status: 'wait', reason: 'oom-backoff' })
    await expect(provider.report({ ...outcome, outcome: 'released' }, new AbortController().signal)).rejects.toThrow(/conflicting/)
  })

  it('reconciles active, already released, and absent reservations', async () => {
    const provider = new LocalGraphResourceProvider('local-resources', config())
    const granted = await provider.reserve(request('orphan'), new AbortController().signal)
    if (granted.status !== 'granted') throw new Error('expected a reservation')
    const recovery = {
      protocolVersion: 1 as const,
      reservationId: granted.reservation.id,
      providerId: provider.name,
      workId: granted.reservation.workId,
      ownerEpoch: granted.reservation.ownerEpoch,
      fencingToken: granted.reservation.fencingToken,
      at: Date.now(),
      evidence: 'scheduler recovered an abandoned reservation',
    }
    await expect(provider.reconcile(recovery, new AbortController().signal)).resolves.toMatchObject({ status: 'released' })
    await expect(provider.reconcile(recovery, new AbortController().signal)).resolves.toMatchObject({ status: 'already-released' })
    await expect(provider.reconcile({ ...recovery, reservationId: `${recovery.reservationId}-missing` as typeof recovery.reservationId }, new AbortController().signal))
      .resolves.toMatchObject({ status: 'absent' })
  })

  it('registers through the Cordis plugin and validates route configuration', async () => {
    const base = config()
    expect(() => new LocalGraphResourceProvider('local-resources', {
      providerName: base.providerName,
      routes: [...base.routes, ...base.routes],
      observationTtlMs: base.observationTtlMs,
      leaseMs: base.leaseMs,
      retryMs: base.retryMs,
      oomBackoffMs: base.oomBackoffMs,
    })).toThrow(/duplicate/)
    const ctx = new Context()
    await ctx.plugin(GraphResourceRuntime)
    apply(ctx, config())
    expect(await ctx.graphResources.observe('local-resources', { provider: 'local', model: 'qwen' }, new AbortController().signal))
      .toMatchObject({ status: 'available' })
    await ctx.fiber.dispose()
  })
})

runGraphResourceProviderContract('local', () => ({
  provider: new LocalGraphResourceProvider('local-resources', {
    providerName: 'local-resources',
    routes: [{ provider: 'local', model: 'qwen', concurrencyLimit: 1, weightLimit: 2 }],
    observationTtlMs: 5_000,
    leaseMs: 60_000,
    retryMs: 250,
    oomBackoffMs: 30_000,
  }),
  route: { provider: 'local', model: 'qwen' },
}))
