import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import GraphCoordination, { MemoryGraphCoordination } from '../src/index.ts'
import { runGraphCoordinationContract } from './contract.ts'

class MemoryCoordination extends GraphCoordination {
  async prepare(): Promise<void> {}
  async claim(): Promise<Awaited<ReturnType<GraphCoordination['claim']>>> {
    return { claimId: 'claim-1', todoId: 'todo-1', leaseId: 'lease-1', expiresAt: Date.now() + 1_000, fencingToken: 1, observation: 'ready' }
  }
  async heartbeat(request: Parameters<GraphCoordination['heartbeat']>[0]) { return { leaseId: request.leaseId, expiresAt: Date.now() + 1_000, fencingToken: request.fencingToken, progressCursor: '1', cancelRequested: false } }
  async observe(): Promise<Awaited<ReturnType<GraphCoordination['observe']>>> { return { status: 'absent', cursor: '0', events: [], compacted: false } }
  async watch(): Promise<Awaited<ReturnType<GraphCoordination['watch']>>> { return { status: 'absent', cursor: '0', events: [], compacted: false } }
  async publishProgress(): Promise<{ cursor: string }> { return { cursor: '1' } }
  async settle(): Promise<void> {}
  async cancel(): Promise<void> {}
  async reconcile(): Promise<Awaited<ReturnType<GraphCoordination['reconcile']>>> { return { status: 'absent', observation: { status: 'absent', cursor: '0', events: [], compacted: false }, evidence: 'absent' } }
}

describe('graph coordination service', () => {
  it('publishes one provider through the Cordis service seam', async () => {
    const ctx = new Context()
    await ctx.plugin(MemoryCoordination).await()
    expect(ctx.graphCoordination).toBeInstanceOf(MemoryCoordination)
  })

  it('drains each consumer once and shares its shutdown callback with unregister', async () => {
    const ctx = new Context()
    await ctx.plugin(MemoryCoordination).await()
    const coordination = ctx.graphCoordination
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    let calls = 0
    const unregister = coordination.registerQuiescence(async () => { calls += 1; await held })
    const providerDrain = coordination.quiesceConsumers()
    const consumerDispose = unregister()
    await Promise.resolve()
    expect(calls).toBe(1)
    await expect(Promise.resolve().then(() => coordination.registerQuiescence(async () => {})))
      .rejects.toThrow(/no longer accepts consumers/)
    release()
    await Promise.all([providerDrain, consumerDispose])
    expect(calls).toBe(1)
  })

  it('waits for every consumer callback and reports aggregate failures', async () => {
    const ctx = new Context()
    await ctx.plugin(MemoryCoordination).await()
    const coordination = ctx.graphCoordination
    let completed = 0
    coordination.registerQuiescence(async () => { completed += 1; throw new Error('first close failed') })
    coordination.registerQuiescence(async () => { await Promise.resolve(); completed += 1 })
    await expect(coordination.quiesceConsumers()).rejects.toMatchObject({
      name: 'AggregateError', message: 'graph coordination consumers failed to quiesce',
    })
    expect(completed).toBe(2)
    await expect(coordination.quiesceConsumers()).rejects.toMatchObject({ name: 'AggregateError' })
  })

})

runGraphCoordinationContract('memory', async () => {
  const ctx = new Context()
  await ctx.plugin(MemoryGraphCoordination).await()
  return { coordination: ctx.graphCoordination, signal: new AbortController().signal }
})
