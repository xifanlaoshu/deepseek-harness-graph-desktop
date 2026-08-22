import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { describe, expect, it } from 'vitest'
import * as GraphModeInvariant from '../src/invariant.ts'

describe('graph-mode invariant companion', () => {
  it('reserves package invariant ownership', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await ctx.plugin(GraphModeInvariant).await()
    expect(() => {
      ctx.invariants.register('@deepseek-ai/dsh-graph-mode', () => {})
    }).toThrow(/already registered/)
  })
})
