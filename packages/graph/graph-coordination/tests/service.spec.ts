import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { describe, expect, it } from 'vitest'
import GraphCoordination, { MemoryGraphCoordination } from '../src/index.ts'
import * as CoordinationInvariant from '../src/invariant.ts'
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

  it('reserves package invariant ownership', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await ctx.plugin(CoordinationInvariant).await()
    expect(() => {
      ctx.invariants.register('@deepseek-ai/dsh-graph-coordination', () => {})
    }).toThrow(/already registered/)
  })
})

runGraphCoordinationContract('memory', async () => {
  const ctx = new Context()
  await ctx.plugin(MemoryGraphCoordination).await()
  return { coordination: ctx.graphCoordination, signal: new AbortController().signal }
})
