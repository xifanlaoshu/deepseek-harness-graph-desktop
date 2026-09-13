import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as GraphInvariant from '../src/invariant.ts'
import {
  GraphId,
  GraphNodeId,
  GraphRunId,
  GraphRunGenerationId,
  GraphRoleId,
  GraphWorkId,
  defaultGraphExecutionPolicy,
  defaultGraphNodeExecutionBudget,
  defaultGraphModeConfig,
  defaultGraphOutputSchema,
} from '../src/index.ts'
import type { GraphRevision } from '../src/index.ts'

const revision: GraphRevision = {
  graphId: GraphId('graph-1'),
  revision: 1,
  objective: 'Implement graph mode',
  createdAt: 1,
  userInput: 'Implement graph mode',
  nodes: [{
    id: GraphNodeId('implementation'),
    title: 'Implement',
    objective: 'Implement graph mode',
    kind: 'implementation' as const,
    roleId: GraphRoleId('engineer'),
    acceptanceCriteria: ['Focused tests pass'],
    outputSchema: defaultGraphOutputSchema('implementation-output'),
    maxAttempts: 1,
    weight: 1,
    executionBudget: defaultGraphNodeExecutionBudget(),
    skippable: false,
    effectPolicy: 'idempotent',
  }],
  edges: [],
  branchGroups: [],
  terminationPolicy: { ...defaultGraphExecutionPolicy(), onExhausted: 'awaiting_user' as const },
}

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry, { enabled: true })
  await ctx.plugin(GraphInvariant)
  return ctx
}

describe('graph stream invariant', () => {
  it('accepts configuration, revision, run, and unrelated events', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    expect(() => {
      session.append('graph/change', { kind: 'graph/config', version: 2, config: defaultGraphModeConfig() })
      session.append('graph/change', { kind: 'graph/revision', version: 2, graph: revision, current: true })
      session.append('graph/run', {
        id: GraphRunId('run-1'), graphId: revision.graphId, revision: 1, generation: 1,
        generationId: GraphRunGenerationId('generation-1'), ownerEpoch: 1,
        configSnapshot: defaultGraphModeConfig(), overrides: {},
        phase: 'succeeded', createdAt: 1, updatedAt: 2,
        terminal: { outcome: 'succeeded', rule: 'complete', acceptedAt: 2 },
        nodes: {
          implementation: {
            workId: GraphWorkId('work-implementation'),
            nodeId: revision.nodes[0]!.id,
            phase: 'succeeded',
            attempts: [],
            output: { summary: 'done', artifacts: [] },
          },
        },
      })
      ctx.emit('tools/change')
    }).not.toThrow()
  })

  it('seeds a session first observed during publication', async () => {
    const ctx = await setup()
    const session = Session.create(SessionId('detached-graph'))
    expect(() => {
      ctx.emit('session/event', session, {
        type: 'turn/start', seq: SessionSeq(0), time: 0, data: { turn: 1 },
      })
    }).not.toThrow()
  })

  it('rejects an invalid newly appended revision', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    expect(() => {
      session.append('graph/change', {
        kind: 'graph/revision', version: 2,
        graph: { ...revision, nodes: [] }, current: true,
      })
    }).toThrow(/durable graph stream.*at least one node/)
  })

  it('rejects invalid existing graph state on late registration', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    ctx.sessions.create().append('graph/change', {
      kind: 'graph/revision', version: 2,
      graph: { ...revision, revision: 2, parentRevision: 1 }, current: true,
    })
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await expect(ctx.plugin(GraphInvariant).then(() => undefined)).rejects.toThrow(/revision is not contiguous/)
  })

  it('replays valid existing graph state on late registration', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    ctx.sessions.create().append('graph/change', {
      kind: 'graph/revision', version: 2, graph: revision, current: true,
    })
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await expect(ctx.plugin(GraphInvariant).then(() => undefined)).resolves.toBeUndefined()
  })
})
