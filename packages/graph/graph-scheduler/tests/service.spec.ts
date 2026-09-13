import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { GraphRunGenerationId, GraphRunId } from '@deepseek-ai/dsh-graph'
import GraphSchedulerRuntime, { GraphSchedulerAuthorityError, GraphSchedulerLeaseId, GraphSchedulerOwnerId, MemoryGraphSchedulerProvider, type GraphSchedulerProvider } from '../src/index.ts'
import { runGraphSchedulerProviderContract } from './contract.ts'

const request = () => ({
  protocolVersion: 1 as const, sessionId: 'session', runId: GraphRunId('run'), generationId: GraphRunGenerationId('generation'),
  ownerId: GraphSchedulerOwnerId('owner'), minimumOwnerEpoch: 1, requestedAt: 100,
})

runGraphSchedulerProviderContract('memory', () => ({
  provider: new MemoryGraphSchedulerProvider('memory-scheduler', 60_000, 100),
}))
const lease = () => ({
  id: GraphSchedulerLeaseId('lease'), providerId: 'test', sessionId: 'session', runId: GraphRunId('run'),
  generationId: GraphRunGenerationId('generation'), ownerId: GraphSchedulerOwnerId('owner'), ownerEpoch: 1,
  fencingToken: 1, acquiredAt: 100, expiresAt: 200,
})

describe('GraphSchedulerRuntime', () => {
  it('routes validated acquire, heartbeat, and release operations', async () => {
    const ctx = new Context()
    await ctx.plugin(GraphSchedulerRuntime)
    const provider: GraphSchedulerProvider = {
      protocolVersion: 1, name: 'test', acquire: vi.fn(async () => ({ status: 'granted' as const, lease: lease() })),
      heartbeat: vi.fn(async () => lease()), release: vi.fn(async () => {}),
    }
    const dispose = ctx.graphScheduler.register(provider)
    const decision = await ctx.graphScheduler.acquire('test', request(), new AbortController().signal)
    expect(decision).toMatchObject({ status: 'granted' })
    const exact = { protocolVersion: 1 as const, providerId: 'test', leaseId: GraphSchedulerLeaseId('lease'), runId: GraphRunId('run'), generationId: GraphRunGenerationId('generation'), ownerId: GraphSchedulerOwnerId('owner'), ownerEpoch: 1, fencingToken: 1, at: 150 }
    await expect(ctx.graphScheduler.heartbeat(exact, new AbortController().signal)).resolves.toMatchObject({ expiresAt: 200 })
    await expect(ctx.graphScheduler.release(exact, new AbortController().signal)).resolves.toBeUndefined()
    dispose()
    await expect(ctx.graphScheduler.acquire('test', request(), new AbortController().signal)).rejects.toThrow(/unknown/)
    await ctx.fiber.dispose()
  })

  it('rejects malformed requests and Provider responses', async () => {
    const ctx = new Context()
    await ctx.plugin(GraphSchedulerRuntime)
    expect(() => ctx.graphScheduler.register({ protocolVersion: 1, name: '', acquire: vi.fn(), heartbeat: vi.fn(), release: vi.fn() })).toThrow(/name/)
    const provider: GraphSchedulerProvider = { protocolVersion: 1, name: 'test', acquire: vi.fn(async () => ({ status: 'busy' as const, retryAt: 100, evidence: '' })), heartbeat: vi.fn(async () => ({ ...lease(), id: GraphSchedulerLeaseId('changed') })), release: vi.fn(async () => {}) }
    ctx.graphScheduler.register(provider)
    expect(() => ctx.graphScheduler.register(provider)).toThrow(/duplicate/)
    await expect(ctx.graphScheduler.acquire('test', { ...request(), sessionId: '' }, new AbortController().signal)).rejects.toThrow(/sessionId/)
    await expect(ctx.graphScheduler.acquire('test', { ...request(), runId: GraphRunId('') }, new AbortController().signal)).rejects.toThrow(/ids must be non-empty/)
    await expect(ctx.graphScheduler.acquire('test', { ...request(), minimumOwnerEpoch: 0 }, new AbortController().signal)).rejects.toThrow(/positive/)
    await expect(ctx.graphScheduler.acquire('test', { ...request(), requestedAt: -1 }, new AbortController().signal)).rejects.toThrow(/requestedAt/)
    await expect(ctx.graphScheduler.acquire('test', request(), new AbortController().signal)).rejects.toThrow(/busy decision/)
    const exact = { protocolVersion: 1 as const, providerId: 'test', leaseId: GraphSchedulerLeaseId('lease'), runId: GraphRunId('run'), generationId: GraphRunGenerationId('generation'), ownerId: GraphSchedulerOwnerId('owner'), ownerEpoch: 1, fencingToken: 1, at: 150 }
    await expect(ctx.graphScheduler.heartbeat(exact, new AbortController().signal)).rejects.toBeInstanceOf(GraphSchedulerAuthorityError)
    await ctx.fiber.dispose()
  })

  it('accepts a valid busy decision and rejects malformed lease fields and exact lease requests', async () => {
    const ctx = new Context()
    await ctx.plugin(GraphSchedulerRuntime)
    let current = lease()
    const provider: GraphSchedulerProvider = {
      protocolVersion: 1, name: 'test', acquire: vi.fn(async () => ({ status: 'granted' as const, lease: current })),
      heartbeat: vi.fn(async () => current), release: vi.fn(async () => {}),
    }
    ctx.graphScheduler.register(provider)
    const exact = { protocolVersion: 1 as const, providerId: 'test', leaseId: GraphSchedulerLeaseId('lease'), runId: GraphRunId('run'), generationId: GraphRunGenerationId('generation'), ownerId: GraphSchedulerOwnerId('owner'), ownerEpoch: 1, fencingToken: 1, at: 150 }
    for (const malformed of [
      { ...lease(), providerId: 'other' },
      { ...lease(), id: GraphSchedulerLeaseId('') },
      { ...lease(), ownerEpoch: 0 },
      { ...lease(), fencingToken: 0 },
      { ...lease(), acquiredAt: 200, expiresAt: 200 },
      { ...lease(), ownerEpoch: 1, fencingToken: 2 },
    ]) {
      current = malformed
      const acquireRequest = current.fencingToken === 2 ? { ...request(), minimumOwnerEpoch: 2 } : request()
      await expect(ctx.graphScheduler.acquire('test', acquireRequest, new AbortController().signal)).rejects.toThrow()
    }
    current = lease()
    for (const malformed of [
      { ...exact, providerId: '' }, { ...exact, leaseId: GraphSchedulerLeaseId('') },
      { ...exact, ownerEpoch: 0 }, { ...exact, fencingToken: 0 }, { ...exact, at: -1 },
    ]) await expect(ctx.graphScheduler.release(malformed, new AbortController().signal)).rejects.toThrow()
    provider.acquire = vi.fn(async () => ({ status: 'busy' as const, retryAt: 200, evidence: 'another owner' }))
    await expect(ctx.graphScheduler.acquire('test', request(), new AbortController().signal)).resolves.toMatchObject({ status: 'busy' })
    const disposable: GraphSchedulerProvider = { ...provider, name: 'disposable' }
    const staleDispose = ctx.graphScheduler.register(disposable)
    staleDispose()
    ctx.graphScheduler.register({ ...disposable, acquire: vi.fn(async () => ({ status: 'busy' as const, retryAt: 200, evidence: 'replacement' })) })
    staleDispose()
    await ctx.fiber.dispose()
  })
})
