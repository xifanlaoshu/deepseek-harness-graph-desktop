import { describe, expect, it } from 'vitest'
import {
  GraphId,
  MAX_GRAPH_TIMER_MS,
  GraphAttemptId,
  GraphBranchGroupId,
  GraphCampaignBatchId,
  GraphCampaignId,
  GraphControlOperationId,
  GraphNodeId,
  GraphRunId,
  GraphRunGenerationId,
  GraphRoleId,
  GraphSettlementId,
  GraphSubmissionId,
  GraphTaskId,
  GraphWorkId,
  GraphValidationError,
  apply,
  applyGraphEvent,
  defaultGraphModeConfig,
  defaultGraphExecutionPolicy,
  defaultGraphNodeExecutionBudget,
  defaultGraphOutputSchema,
  downstreamInvalidation,
  emptyGraphProjection,
  foldGraph,
  graphProjectionDefinition,
  graphProjectionSchema,
  validateGraphNodeOutput,
  validateGraphModeConfig,
  validateGraphRevision,
  validateGraphRun,
} from '../src/index.ts'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { GraphModeConfig, GraphNode, GraphRevision, GraphRun } from '../src/index.ts'

const node = (id: string, role = 'engineer'): GraphNode => ({
  id: GraphNodeId(id),
  title: id,
  objective: `Complete ${id}`,
  kind: 'implementation' as const,
  roleId: GraphRoleId(role),
  acceptanceCriteria: [`${id} is complete`],
  outputSchema: defaultGraphOutputSchema(`output-${id}`),
  maxAttempts: 2,
  weight: 1,
  executionBudget: defaultGraphNodeExecutionBudget(),
  skippable: false,
  effectPolicy: 'idempotent',
})

const graph = (edges: GraphRevision['edges']): GraphRevision => ({
  graphId: GraphId('g-1'),
  revision: 1,
  objective: 'Ship graph mode',
  createdAt: 1,
  userInput: 'Build graph mode',
  nodes: [node('a', 'analyst'), node('b'), node('c', 'verifier'), node('d', 'writer')],
  edges,
  branchGroups: [...new Set(edges.flatMap(edge => edge.branchGroupId === undefined ? [] : [edge.branchGroupId]))]
    .map(id => ({ id, to: edges.find(edge => edge.branchGroupId === id)!.to, mode: 'all' as const })),
  terminationPolicy: { ...defaultGraphExecutionPolicy(), onExhausted: 'awaiting_user' },
})

const runFor = (revision: GraphRevision): GraphRun => ({
  id: GraphRunId('run-1'),
  graphId: revision.graphId,
  revision: revision.revision,
  generation: 1,
  generationId: GraphRunGenerationId('generation-1'),
  ownerEpoch: 1,
  configSnapshot: defaultGraphModeConfig(),
  overrides: {},
  phase: 'succeeded',
  createdAt: 1,
  updatedAt: 3,
  terminal: { outcome: 'succeeded', rule: 'all-required-nodes-settled', acceptedAt: 3 },
  nodes: Object.fromEntries(revision.nodes.map(item => [item.id, {
    workId: GraphWorkId(`work-${item.id}`),
    nodeId: item.id,
    phase: 'succeeded' as const,
    attempts: [{ id: GraphAttemptId(`attempt-${item.id}`), number: 1, startedAt: 1, finishedAt: 2 }],
    output: { summary: 'done', artifacts: [] },
  }])),
})

function expectCode(code: string, check: () => void): void {
  try {
    check()
    throw new Error(`expected ${code}`)
  } catch (error) {
    expect(error).toBeInstanceOf(GraphValidationError)
    expect((error as GraphValidationError).code).toBe(code)
  }
}

const sessionEvent = (type: string, data: unknown, seq = 0): SessionEvent => ({ type, data, seq, time: seq } as SessionEvent)

describe('graph domain', () => {
  it('provides one enabled controller and bounded default concurrency', () => {
    const config = defaultGraphModeConfig()
    expect(() =>{  validateGraphModeConfig(config) }).not.toThrow()
    expect(config.roles.filter(role => role.controller && role.enabled).map(role => role.id)).toEqual(['controller'])
    expect(config.roles.find(role => role.id === 'browser-tester')).toMatchObject({
      enabled: true,
      maxParallel: 1,
      description: 'Validates web flows with DOM, visual, console, and network evidence.',
    })
    expect(config.limits.controllerReserve).toBe(1)
  })

  it('rejects cycles and malformed structured conditions', () => {
    expect(() =>{  validateGraphRevision(graph([
      { from: GraphNodeId('a'), to: GraphNodeId('b'), kind: 'control' },
      { from: GraphNodeId('b'), to: GraphNodeId('a'), kind: 'control' },
    ]), defaultGraphModeConfig()) }).toThrow(/cycle/)
    expect(() =>{  validateGraphRevision(graph([
      { from: GraphNodeId('a'), to: GraphNodeId('b'), kind: 'conditional', branchGroupId: GraphBranchGroupId('to-b'), condition: { path: [], operator: 'equals' } },
    ]), defaultGraphModeConfig()) }).toThrow(/condition/)
    expect(() => { validateGraphRevision({ ...graph([]), nodes: [{ ...node('a'), kind: 'script' as 'implementation' }] }, defaultGraphModeConfig()) }).toThrow(/kind/)
    expect(() => { validateGraphRevision({ ...graph([]), execute: 'rm -rf' }, defaultGraphModeConfig()) }).toThrow(/unknown fields/)
  })

  it('rejects inconsistent durable run snapshots', () => {
    const revision = graph([])
    const run = {
      id: GraphRunId('run-1'), graphId: revision.graphId, revision: 1, phase: 'succeeded' as const,
      generation: 1, createdAt: 1, updatedAt: 3,
      generationId: GraphRunGenerationId('generation-1'), ownerEpoch: 1,
      configSnapshot: defaultGraphModeConfig(), overrides: {},
      terminal: { outcome: 'succeeded' as const, rule: 'complete', acceptedAt: 3 },
      nodes: Object.fromEntries(revision.nodes.map(item => [item.id, {
        workId: GraphWorkId(`work-${item.id}`),
        nodeId: item.id,
        phase: 'succeeded' as const,
        attempts: [{ id: GraphAttemptId(`attempt-${item.id}`), number: 1, startedAt: 1, finishedAt: 2 }],
        output: { summary: 'done', artifacts: [] },
      }])),
    }
    expect(() => { validateGraphRun(run, revision) }).not.toThrow()
    expect(() => { validateGraphRun({
      ...run,
      nodes: { ...run.nodes, a: { ...run.nodes['a'], phase: 'running' as const } },
    }, revision) }).toThrow(/succeeded run/)
    expect(() => { validateGraphRun({
      ...run,
      phase: 'failed',
      terminal: { outcome: 'failed', rule: 'required-node-failed', acceptedAt: 3 },
      error: { code: 'GRAPH_COORDINATION_CLAIM_FAILED', message: 'claim failed', nodeId: GraphNodeId('a') },
    }, revision) }).not.toThrow()
    expectCode('GRAPH_RUN_ERROR', () => { validateGraphRun({
      ...run,
      phase: 'failed',
      terminal: { outcome: 'failed', rule: 'required-node-failed', acceptedAt: 3 },
      error: { code: 'GRAPH_COORDINATION_CLAIM_FAILED', message: 'claim failed', nodeId: GraphNodeId('missing') },
    }, revision) })
    expectCode('GRAPH_RUN_ERROR', () => { validateGraphRun({
      ...run,
      error: { code: 'UNEXPECTED', message: 'not allowed on success' },
    }, revision) })
  })

  it('orders directly changed nodes and all transitive successors', () => {
    const revision = graph([
      { from: GraphNodeId('a'), to: GraphNodeId('b'), kind: 'data' },
      { from: GraphNodeId('a'), to: GraphNodeId('c'), kind: 'control' },
      { from: GraphNodeId('b'), to: GraphNodeId('d'), kind: 'control' },
      { from: GraphNodeId('c'), to: GraphNodeId('d'), kind: 'control' },
    ])
    validateGraphRevision(revision, defaultGraphModeConfig())
    expect(downstreamInvalidation(revision, [GraphNodeId('b')])).toEqual(['b', 'd'])
    expect(downstreamInvalidation(revision, [GraphNodeId('a')])).toEqual(['a', 'b', 'c', 'd'])
  })

  it('validates every published-output boundary', () => {
    const valid = {
      summary: 'complete',
      coordinationSummary: 'public progress',
      data: { values: [null, true, 'text', 2, { nested: false }] },
      artifacts: ['report.md'],
    }
    expect(() => { validateGraphNodeOutput(valid) }).not.toThrow()
    expectCode('GRAPH_RUN_OUTPUT', () => { validateGraphNodeOutput(null) })
    expectCode('GRAPH_RUN_OUTPUT', () => { validateGraphNodeOutput({ ...valid, extra: true }) })
    expectCode('GRAPH_RUN_OUTPUT', () => { validateGraphNodeOutput({ ...valid, summary: '' }) })
    expectCode('GRAPH_RUN_OUTPUT', () => { validateGraphNodeOutput({ ...valid, coordinationSummary: ' bad' }) })
    expectCode('GRAPH_RUN_OUTPUT', () => { validateGraphNodeOutput({ ...valid, coordinationSummary: 'x'.repeat(2_001) }) })
    expectCode('GRAPH_RUN_OUTPUT', () => { validateGraphNodeOutput({ ...valid, artifacts: [''] }) })
    expectCode('GRAPH_RUN_OUTPUT', () => { validateGraphNodeOutput({ ...valid, data: Number.POSITIVE_INFINITY }) })
    expectCode('GRAPH_RUN_OUTPUT', () => { validateGraphNodeOutput({ ...valid, data: 1n }) })
    expectCode('GRAPH_RUN_OUTPUT', () => { validateGraphNodeOutput({ ...valid, data: new Date(0) }) })
    expectCode('GRAPH_RUN_OUTPUT', () => { validateGraphNodeOutput({ ...valid, data: [new Date(0)] }) })
    const cyclic: { self?: unknown } = {}
    cyclic.self = cyclic
    expectCode('GRAPH_RUN_OUTPUT', () => { validateGraphNodeOutput({ ...valid, data: cyclic }) })
    expect(() => { validateGraphNodeOutput({ summary: 'complete', artifacts: [] }) }).not.toThrow()
  })

  it('enforces the node-owned output schema and byte limit', () => {
    const declared = {
      id: 'review-output',
      version: 1,
      maxBytes: 512,
      schema: {
        type: 'object' as const,
        additionalProperties: false,
        properties: {
          summary: { type: 'string' as const },
          artifacts: { type: 'array' as const, items: { type: 'string' as const } },
          data: {
            type: 'object' as const,
            additionalProperties: false,
            properties: { decision: { type: 'string' as const, enum: ['approved', 'rejected'] } },
            required: ['decision'],
          },
        },
        required: ['summary', 'artifacts', 'data'],
      },
    }
    expect(() => { validateGraphNodeOutput({ summary: 'approved', artifacts: [], data: { decision: 'approved' } }, declared) }).not.toThrow()
    expectCode('GRAPH_RUN_OUTPUT_SCHEMA', () => {
      validateGraphNodeOutput({ summary: 'unknown', artifacts: [], data: { decision: 'unknown' } }, declared)
    })
    expectCode('GRAPH_RUN_OUTPUT_SIZE', () => {
      validateGraphNodeOutput({ summary: 'too large', artifacts: [], data: { decision: 'approved' } }, { ...declared, maxBytes: 8 })
    })
  })

  it('rejects malformed graph-mode configuration semantics', () => {
    const base = defaultGraphModeConfig()
    const first = base.roles[0]!
    const second = base.roles[1]!
    const withFirst = (patch: Partial<typeof first>): GraphModeConfig => ({
      ...base,
      roles: [{ ...first, ...patch }, ...base.roles.slice(1)],
    })
    const withLimit = (limit: unknown): GraphModeConfig => ({
      ...base,
      limits: { ...base.limits, models: [limit] },
    } as unknown as GraphModeConfig)

    expectCode('GRAPH_CONFIG_STRUCTURE', () => { validateGraphModeConfig(null) })
    expectCode('GRAPH_CONFIG_STRUCTURE', () => { validateGraphModeConfig({ ...base, extra: true }) })
    expect(() => { validateGraphModeConfig(withFirst({ label: 42 as never })) })
      .toThrow(/roles\.0\.label/)
    expectCode('GRAPH_CONFIG_VERSION', () => { validateGraphModeConfig({ ...base, version: 1 }) })
    expectCode('GRAPH_GLOBAL_PARALLELISM', () => { validateGraphModeConfig({ ...base, limits: { ...base.limits, globalMaxParallel: 1.5 } }) })
    expectCode('GRAPH_GLOBAL_PARALLELISM', () => { validateGraphModeConfig({ ...base, limits: { ...base.limits, globalMaxParallel: 0 } }) })
    expectCode('GRAPH_CONTROLLER_RESERVE', () => { validateGraphModeConfig({ ...base, limits: { ...base.limits, controllerReserve: 1.5 } }) })
    expectCode('GRAPH_CONTROLLER_RESERVE', () => { validateGraphModeConfig({ ...base, limits: { ...base.limits, controllerReserve: 0 } }) })
    expectCode('GRAPH_CONTROLLER_RESERVE', () => { validateGraphModeConfig({ ...base, limits: { ...base.limits, controllerReserve: 8 } }) })
    expectCode('GRAPH_ROLE_ID', () => { validateGraphModeConfig(withFirst({ id: GraphRoleId('') })) })
    expectCode('GRAPH_ROLE_ID', () => { validateGraphModeConfig(withFirst({ id: GraphRoleId('bad/id') })) })
    expectCode('GRAPH_ROLE_ID', () => { validateGraphModeConfig({ ...base, roles: [first, { ...second, id: first.id }] }) })
    expectCode('GRAPH_ROLE_TEXT', () => { validateGraphModeConfig(withFirst({ label: '' })) })
    expectCode('GRAPH_ROLE_TEXT', () => { validateGraphModeConfig(withFirst({ description: '' })) })
    expectCode('GRAPH_ROLE_TEXT', () => { validateGraphModeConfig(withFirst({ prompt: ' bad' })) })
    expectCode('GRAPH_ROLE_MODEL', () => { validateGraphModeConfig(withFirst({ model: { provider: '' } })) })
    expect(() => { validateGraphModeConfig(withFirst({ model: { provider: 'local', model: 'planner' } })) }).not.toThrow()
    expectCode('GRAPH_ROLE_PARALLELISM', () => { validateGraphModeConfig(withFirst({ maxParallel: 1.5 })) })
    expectCode('GRAPH_ROLE_PARALLELISM', () => { validateGraphModeConfig(withFirst({ maxParallel: 0 })) })
    expectCode('GRAPH_CONTROLLER_COUNT', () => { validateGraphModeConfig(withFirst({ enabled: false })) })
    expectCode('GRAPH_CONTROLLER_COUNT', () => { validateGraphModeConfig({ ...base, roles: [first, { ...second, controller: true }] }) })
    expectCode('GRAPH_MODEL_LIMIT', () => { validateGraphModeConfig(withLimit({ model: '', maxParallel: 1 })) })
    expectCode('GRAPH_MODEL_LIMIT', () => { validateGraphModeConfig(withLimit({ provider: '', model: 'coder', maxParallel: 1 })) })
    expectCode('GRAPH_MODEL_LIMIT', () => { validateGraphModeConfig(withLimit({ model: 'coder', maxParallel: 1.5 })) })
    expectCode('GRAPH_MODEL_LIMIT', () => { validateGraphModeConfig(withLimit({ model: 'coder', maxParallel: 0 })) })
    const duplicate = { model: 'coder', maxParallel: 1 }
    expectCode('GRAPH_MODEL_LIMIT_DUPLICATE', () => {
      validateGraphModeConfig({ ...base, limits: { ...base.limits, models: [duplicate, duplicate] } })
    })
    expectCode('GRAPH_MODEL_WEIGHT', () => { validateGraphModeConfig(withLimit({ provider: 'local', model: 'coder', maxParallel: 1, maxWeight: 0 })) })
    expect(() => { validateGraphModeConfig(withLimit({ provider: 'local', model: 'coder', maxParallel: 1, maxWeight: 2 })) }).not.toThrow()
    expectCode('GRAPH_ROLE_WORKER_PROVIDER', () => {
      validateGraphModeConfig({ ...base, roles: [{ ...first, workerProvider: ' ' }, second] })
    })
    for (const name of ['firstDurableActionMs', 'maxNoDurableProgressMs', 'checkpointIntervalMs', 'maxWallTimeMs'] as const) {
      expectCode('GRAPH_EXECUTION_POLICY', () => {
        validateGraphModeConfig({
          ...base,
          executionPolicy: { ...base.executionPolicy, [name]: MAX_GRAPH_TIMER_MS + 1 },
        })
      })
    }
  })

  it('rejects malformed revision semantics and accepts all condition operators', () => {
    const base = graph([])
    const first = base.nodes[0]!
    const withNode = (patch: Partial<typeof first>): GraphRevision => ({ ...base, nodes: [{ ...first, ...patch }, ...base.nodes.slice(1)] })
    const withEdge = (edge: unknown): GraphRevision => {
      const candidate = edge as GraphRevision['edges'][number]
      return {
        ...base,
        edges: [candidate],
        branchGroups: candidate.branchGroupId === undefined ? [] : [{ id: candidate.branchGroupId, to: candidate.to, mode: 'all' }],
      }
    }

    expectCode('GRAPH_REVISION_STRUCTURE', () => { validateGraphRevision(null, defaultGraphModeConfig()) })
    expectCode('GRAPH_REVISION_TEXT', () => { validateGraphRevision({ ...base, graphId: GraphId('') }, defaultGraphModeConfig()) })
    expectCode('GRAPH_REVISION_TEXT', () => { validateGraphRevision({ ...base, graphId: GraphId('bad/id') }, defaultGraphModeConfig()) })
    expectCode('GRAPH_REVISION_TEXT', () => { validateGraphRevision({ ...base, objective: '' }, defaultGraphModeConfig()) })
    expectCode('GRAPH_REVISION_TEXT', () => { validateGraphRevision({ ...base, userInput: ' bad' }, defaultGraphModeConfig()) })
    expectCode('GRAPH_REVISION_NUMBER', () => { validateGraphRevision({ ...base, revision: 1.5 }, defaultGraphModeConfig()) })
    expectCode('GRAPH_REVISION_NUMBER', () => { validateGraphRevision({ ...base, revision: 0 }, defaultGraphModeConfig()) })
    expectCode('GRAPH_REVISION_NUMBER', () => { validateGraphRevision({ ...base, createdAt: 1.5 }, defaultGraphModeConfig()) })
    expectCode('GRAPH_REVISION_NUMBER', () => { validateGraphRevision({ ...base, createdAt: -1 }, defaultGraphModeConfig()) })
    expectCode('GRAPH_PARENT_REVISION', () => { validateGraphRevision({ ...base, parentRevision: 0 }, defaultGraphModeConfig()) })
    expectCode('GRAPH_PARENT_REVISION', () => { validateGraphRevision({ ...base, revision: 2 }, defaultGraphModeConfig()) })
    expectCode('GRAPH_PARENT_REVISION', () => { validateGraphRevision({ ...base, revision: 3, parentRevision: 1 }, defaultGraphModeConfig()) })
    expectCode('GRAPH_NODE_ID', () => { validateGraphRevision(withNode({ id: GraphNodeId('') }), defaultGraphModeConfig()) })
    expectCode('GRAPH_NODE_ID', () => { validateGraphRevision(withNode({ id: GraphNodeId('bad/id') }), defaultGraphModeConfig()) })
    expectCode('GRAPH_NODE_ID', () => { validateGraphRevision({ ...base, nodes: [first, first] }, defaultGraphModeConfig()) })
    expectCode('GRAPH_NODE_TEXT', () => { validateGraphRevision(withNode({ title: '' }), defaultGraphModeConfig()) })
    expectCode('GRAPH_NODE_TEXT', () => { validateGraphRevision(withNode({ objective: '' }), defaultGraphModeConfig()) })
    expectCode('GRAPH_NODE_TEXT', () => { validateGraphRevision(withNode({ acceptanceCriteria: [] }), defaultGraphModeConfig()) })
    expectCode('GRAPH_NODE_TEXT', () => { validateGraphRevision(withNode({ acceptanceCriteria: [' bad'] }), defaultGraphModeConfig()) })
    expectCode('GRAPH_NODE_ROLE', () => { validateGraphRevision(withNode({ roleId: GraphRoleId('missing') }), defaultGraphModeConfig()) })
    expectCode('GRAPH_NODE_CONTROLLER', () => { validateGraphRevision(withNode({ roleId: GraphRoleId('controller') }), defaultGraphModeConfig()) })
    expectCode('GRAPH_NODE_POLICY', () => { validateGraphRevision(withNode({ maxAttempts: 1.5 }), defaultGraphModeConfig()) })
    expectCode('GRAPH_NODE_POLICY', () => { validateGraphRevision(withNode({ maxAttempts: 0 }), defaultGraphModeConfig()) })
    expectCode('GRAPH_NODE_POLICY', () => { validateGraphRevision(withNode({ weight: 0 }), defaultGraphModeConfig()) })
    expectCode('GRAPH_NODE_WORKSPACE', () => {
      validateGraphRevision(withNode({ workspace: { mode: 'read-only-snapshot', readRoots: ['.'], writeRoots: ['src'], cleanup: 'retain' } }), defaultGraphModeConfig())
    })
    expectCode('GRAPH_NODE_WORKSPACE', () => {
      validateGraphRevision(withNode({ workspace: { mode: 'isolated-copy', readRoots: ['../secret'], writeRoots: ['src'], cleanup: 'retain' } }), defaultGraphModeConfig())
    })
    expectCode('GRAPH_WORKSPACE_OWNERSHIP', () => {
      validateGraphRevision({
        ...base,
        nodes: base.nodes.map(item => ['a', 'b'].includes(item.id)
          ? { ...item, workspace: { mode: 'isolated-copy' as const, readRoots: ['.'], writeRoots: ['src'], cleanup: 'retain' as const } }
          : item),
      }, defaultGraphModeConfig())
    })
    expect(() => {
      validateGraphRevision({
        ...base,
        nodes: base.nodes.map(item => ['a', 'b'].includes(item.id)
          ? { ...item, workspace: { mode: 'isolated-copy' as const, readRoots: ['.'], writeRoots: ['src'], cleanup: 'retain' as const } }
          : item),
        edges: [{ from: GraphNodeId('a'), to: GraphNodeId('b'), kind: 'control' }],
      }, defaultGraphModeConfig())
    }).not.toThrow()
    expectCode('GRAPH_EMPTY', () => { validateGraphRevision({ ...base, nodes: [] }, defaultGraphModeConfig()) })
    expectCode('GRAPH_EDGE_KIND', () => { validateGraphRevision(withEdge({ from: 'a', to: 'b', kind: 'unknown' }), defaultGraphModeConfig()) })
    expectCode('GRAPH_EDGE_ENDPOINT', () => { validateGraphRevision(withEdge({ from: 'missing', to: 'b', kind: 'control' }), defaultGraphModeConfig()) })
    expectCode('GRAPH_EDGE_ENDPOINT', () => { validateGraphRevision(withEdge({ from: 'a', to: 'missing', kind: 'control' }), defaultGraphModeConfig()) })
    expectCode('GRAPH_EDGE_ENDPOINT', () => { validateGraphRevision(withEdge({ from: 'a', to: 'a', kind: 'control' }), defaultGraphModeConfig()) })
    expectCode('GRAPH_EDGE_DUPLICATE', () => { validateGraphRevision({ ...base, edges: [{ from: GraphNodeId('a'), to: GraphNodeId('b'), kind: 'control' }, { from: GraphNodeId('a'), to: GraphNodeId('b'), kind: 'data' }] }, defaultGraphModeConfig()) })
    expectCode('GRAPH_EDGE_CONDITION', () => { validateGraphRevision(withEdge({ from: 'a', to: 'b', kind: 'conditional' }), defaultGraphModeConfig()) })
    expectCode('GRAPH_EDGE_CONDITION', () => { validateGraphRevision(withEdge({ from: 'a', to: 'b', kind: 'control', condition: { path: [], operator: 'exists' } }), defaultGraphModeConfig()) })
    expectCode('GRAPH_CONDITION', () => { validateGraphRevision(withEdge({ from: 'a', to: 'b', kind: 'conditional', branchGroupId: GraphBranchGroupId('to-b'), condition: { path: [], operator: 'unknown' } }), defaultGraphModeConfig()) })
    expectCode('GRAPH_CONDITION', () => { validateGraphRevision(withEdge({ from: 'a', to: 'b', kind: 'conditional', branchGroupId: GraphBranchGroupId('to-b'), condition: { path: [' bad'], operator: 'exists' } }), defaultGraphModeConfig()) })
    expectCode('GRAPH_CONDITION', () => { validateGraphRevision(withEdge({ from: 'a', to: 'b', kind: 'conditional', branchGroupId: GraphBranchGroupId('to-b'), condition: { path: [], operator: 'equals' } }), defaultGraphModeConfig()) })
    expectCode('GRAPH_CONDITION', () => { validateGraphRevision(withEdge({ from: 'a', to: 'b', kind: 'conditional', branchGroupId: GraphBranchGroupId('to-b'), condition: { path: [], operator: 'not-equals' } }), defaultGraphModeConfig()) })
    expectCode('GRAPH_CONDITION', () => { validateGraphRevision(withEdge({ from: 'a', to: 'b', kind: 'conditional', branchGroupId: GraphBranchGroupId('to-b'), condition: { path: [], operator: 'exists', value: true } }), defaultGraphModeConfig()) })
    expectCode('GRAPH_CONDITION', () => { validateGraphRevision(withEdge({ from: 'a', to: 'b', kind: 'conditional', branchGroupId: GraphBranchGroupId('to-b'), condition: { path: [], operator: 'truthy', value: false } }), defaultGraphModeConfig()) })
    for (const condition of [
      { path: [], operator: 'exists' },
      { path: ['ok'], operator: 'truthy' },
      { path: ['value'], operator: 'equals', value: 1 },
      { path: ['value'], operator: 'not-equals', value: null },
    ] as const) {
      expect(() => { validateGraphRevision(withEdge({ from: 'a', to: 'b', kind: 'conditional', branchGroupId: GraphBranchGroupId('to-b'), condition }), defaultGraphModeConfig()) }).not.toThrow()
    }
    for (const mode of ['all', 'any', 'exactly-one', 'activated'] as const) {
      const candidate = withEdge({
        from: 'a', to: 'b', kind: 'conditional', branchGroupId: GraphBranchGroupId('to-b'),
        condition: { path: ['ok'], operator: 'truthy' },
      })
      expect(() => { validateGraphRevision({ ...candidate, branchGroups: [{ id: GraphBranchGroupId('to-b'), to: GraphNodeId('b'), mode }] }, defaultGraphModeConfig()) }).not.toThrow()
    }
    expectCode('GRAPH_BRANCH_GROUP', () => {
      validateGraphRevision({ ...base, branchGroups: [{ id: GraphBranchGroupId('empty'), to: GraphNodeId('b'), mode: 'all' }] }, defaultGraphModeConfig())
    })
    expectCode('GRAPH_OUTPUT_SCHEMA', () => {
      validateGraphRevision(withNode({ outputSchema: { ...first.outputSchema, schema: { type: 'object', patternProperties: {} } as never } }), defaultGraphModeConfig())
    })
    expectCode('GRAPH_TERMINATION_POLICY', () => {
      validateGraphRevision({
        ...base,
        terminationPolicy: {
          ...base.terminationPolicy,
          maxGraphRevisions: defaultGraphModeConfig().executionPolicy.maxGraphRevisions + 1,
        },
      }, defaultGraphModeConfig())
    })
    expect(() => {
      validateGraphRevision({
        ...base,
        nodes: base.nodes.map(item => ({ ...item, executionBudget: { ...item.executionBudget, maxContinuations: 0 } })),
        terminationPolicy: {
          ...base.terminationPolicy,
          maxRepairRevisions: 0,
          maxDynamicExpansions: 0,
          maxSubgraphDepth: 0,
          maxRuntimeContinuations: 0,
        },
      }, defaultGraphModeConfig())
    }).not.toThrow()
    expectCode('GRAPH_TERMINATION_POLICY', () => {
      validateGraphRevision({
        ...base,
        terminationPolicy: { ...base.terminationPolicy, maxAttemptsPerNode: 0 },
      }, defaultGraphModeConfig())
    })
    const disabled = defaultGraphModeConfig()
    const disabledAnalyst = { ...disabled.roles[1]!, enabled: false }
    expectCode('GRAPH_NODE_ROLE', () => {
      validateGraphRevision(base, { ...disabled, roles: [disabled.roles[0]!, disabledAnalyst, ...disabled.roles.slice(2)] })
    })
    expect(() => { validateGraphRevision(graph([
      { from: GraphNodeId('a'), to: GraphNodeId('b'), kind: 'control' },
      { from: GraphNodeId('a'), to: GraphNodeId('c'), kind: 'control' },
      { from: GraphNodeId('b'), to: GraphNodeId('d'), kind: 'control' },
      { from: GraphNodeId('c'), to: GraphNodeId('d'), kind: 'control' },
    ]), defaultGraphModeConfig()) }).not.toThrow()
  })

  it('rejects malformed run snapshots and accepts terminal variants', () => {
    const revision = graph([])
    const base = runFor(revision)
    const first = base.nodes['a']!
    const firstAttempt = first.attempts[0]!
    const withRun = (patch: Partial<GraphRun>): GraphRun => ({ ...base, ...patch })
    const withFirst = (patch: Partial<typeof first>): GraphRun => ({ ...base, nodes: { ...base.nodes, a: { ...first, ...patch } } })
    const withAttempt = (
      patch: Partial<typeof firstAttempt>,
      attempts = [{ ...firstAttempt, ...patch }],
    ): GraphRun => withFirst({ attempts })

    expectCode('GRAPH_RUN_STRUCTURE', () => { validateGraphRun(null, revision) })
    expectCode('GRAPH_RUN_STRUCTURE', () => { validateGraphRun(withRun({ id: GraphRunId('') }), revision) })
    expectCode('GRAPH_RUN_STRUCTURE', () => { validateGraphRun(withRun({ id: GraphRunId('bad/id') }), revision) })
    expectCode('GRAPH_RUN_STRUCTURE', () => { validateGraphRun(withRun({ graphId: GraphId('other') }), revision) })
    expectCode('GRAPH_RUN_STRUCTURE', () => { validateGraphRun(withRun({ revision: 2 }), revision) })
    expectCode('GRAPH_RUN_STRUCTURE', () => { validateGraphRun(withRun({ phase: 'unknown' as GraphRun['phase'] }), revision) })
    expectCode('GRAPH_RUN_STRUCTURE', () => { validateGraphRun(withRun({ createdAt: 1.5 }), revision) })
    expectCode('GRAPH_RUN_STRUCTURE', () => { validateGraphRun(withRun({ createdAt: -1 }), revision) })
    expectCode('GRAPH_RUN_STRUCTURE', () => { validateGraphRun(withRun({ updatedAt: 1.5 }), revision) })
    expectCode('GRAPH_RUN_STRUCTURE', () => { validateGraphRun(withRun({ updatedAt: 0 }), revision) })
    expectCode('GRAPH_RUN_NODES', () => { validateGraphRun(withRun({ nodes: {} }), revision) })
    expectCode('GRAPH_RUN_NODES', () => { validateGraphRun(withRun({ nodes: { ...base.nodes, extra: first } }), revision) })
    expectCode('GRAPH_RUN_NODE', () => { validateGraphRun(withFirst({ nodeId: GraphNodeId('b') }), revision) })
    expectCode('GRAPH_RUN_NODE', () => { validateGraphRun(withFirst({ phase: 'unknown' as typeof first.phase }), revision) })
    expectCode('GRAPH_RUN_ATTEMPTS', () => { validateGraphRun(withFirst({ attempts: [firstAttempt, { ...firstAttempt, id: GraphAttemptId('second') }, { ...firstAttempt, id: GraphAttemptId('third') }] }), revision) })
    expectCode('GRAPH_RUN_ATTEMPT', () => { validateGraphRun(withAttempt({ id: GraphAttemptId('') }), revision) })
    expectCode('GRAPH_RUN_ATTEMPT', () => { validateGraphRun(withAttempt({ id: GraphAttemptId('bad/id') }), revision) })
    expectCode('GRAPH_RUN_ATTEMPT', () => { validateGraphRun(withAttempt({}, [firstAttempt, firstAttempt]), revision) })
    expectCode('GRAPH_RUN_ATTEMPT', () => { validateGraphRun(withAttempt({ number: 2 }), revision) })
    expectCode('GRAPH_RUN_ATTEMPT', () => { validateGraphRun(withAttempt({ startedAt: 1.5 }), revision) })
    expectCode('GRAPH_RUN_ATTEMPT', () => { validateGraphRun(withAttempt({ startedAt: 0 }), revision) })
    expectCode('GRAPH_RUN_ATTEMPT', () => { validateGraphRun(withAttempt({ finishedAt: 1.5 }), revision) })
    expectCode('GRAPH_RUN_ATTEMPT', () => { validateGraphRun(withAttempt({ finishedAt: 0 }), revision) })
    expectCode('GRAPH_RUN_ATTEMPT', () => { validateGraphRun(withAttempt({ childSessionId: '' }), revision) })
    expectCode('GRAPH_RUN_ATTEMPT', () => { validateGraphRun(withAttempt({ loopxClaimId: ' bad' }), revision) })
    expectCode('GRAPH_RUN_ATTEMPT', () => { validateGraphRun(withAttempt({ error: { code: '', message: 'failed' } }), revision) })
    expectCode('GRAPH_RUN_ATTEMPT', () => { validateGraphRun(withAttempt({ error: { code: 'FAILED', message: '' } }), revision) })
    const { output: _output, ...withoutOutput } = first
    expectCode('GRAPH_RUN_OUTPUT', () => {
      validateGraphRun({ ...base, nodes: { ...base.nodes, a: withoutOutput } }, revision)
    })
    expectCode('GRAPH_RUN_INVALIDATION', () => { validateGraphRun(withFirst({ invalidatedBy: [GraphNodeId('missing')] }), revision) })
    expectCode('GRAPH_RUN_REUSE', () => { validateGraphRun(withFirst({ reusedFrom: { runId: GraphRunId(''), generationId: GraphRunGenerationId('prior-generation'), nodeId: GraphNodeId('a') } }), revision) })
    expectCode('GRAPH_RUN_REUSE', () => { validateGraphRun(withFirst({ reusedFrom: { runId: GraphRunId('prior'), generationId: GraphRunGenerationId(''), nodeId: GraphNodeId('a') } }), revision) })
    expectCode('GRAPH_RUN_REUSE', () => { validateGraphRun(withFirst({ reusedFrom: { runId: GraphRunId('prior'), generationId: GraphRunGenerationId('prior-generation'), nodeId: GraphNodeId('') } }), revision) })
    expectCode('GRAPH_RUN_REUSE', () => { validateGraphRun(withFirst({ reusedFrom: { runId: GraphRunId('prior'), generationId: GraphRunGenerationId('prior-generation'), nodeId: GraphNodeId('missing') } }), revision) })
    expectCode('GRAPH_RUN_TERMINAL', () => { validateGraphRun(withFirst({ phase: 'running' }), revision) })
    expectCode('GRAPH_RUN_TERMINAL', () => { validateGraphRun(withRun({ phase: 'failed', nodes: { ...base.nodes, a: { ...first, phase: 'running' } } }), revision) })
    expectCode('GRAPH_RUN_TERMINAL', () => { validateGraphRun(withRun({ phase: 'canceled', nodes: { ...base.nodes, a: { ...first, phase: 'ready' } } }), revision) })
    for (const phase of ['failed', 'canceled'] as const) {
      expect(() => { validateGraphRun(withRun({ phase, terminal: { outcome: phase, rule: `${phase}-rule`, acceptedAt: 3 }, nodes: Object.fromEntries(Object.entries(base.nodes).map(([id, state]) => [id, { ...state, phase: 'failed' }])) }), revision) }).not.toThrow()
    }
    expect(() => { validateGraphRun(withFirst({ invalidatedBy: [GraphNodeId('a')], reusedFrom: { runId: GraphRunId('prior'), generationId: GraphRunGenerationId('prior-generation'), nodeId: GraphNodeId('a') } }), revision) }).not.toThrow()
  })

  it('projects configuration, revisions, and run replacements deterministically', () => {
    const config = { ...defaultGraphModeConfig(), active: true }
    const revision1 = graph([])
    const revision2 = { ...revision1, revision: 2, parentRevision: 1, createdAt: 2 }
    const configEvent = sessionEvent('graph/change', { kind: 'graph/config', version: 2, config })
    const firstEvent = sessionEvent('graph/change', { kind: 'graph/revision', version: 2, graph: revision1, current: true }, 1)
    const secondEvent = sessionEvent('graph/change', { kind: 'graph/revision', version: 2, graph: revision2, current: false }, 2)
    let state = emptyGraphProjection()
    state = applyGraphEvent(state, configEvent)
    expectCode('GRAPH_CHANGE_VERSION', () => { applyGraphEvent(state, sessionEvent('graph/change', { kind: 'graph/config', version: 1, config })) })
    expectCode('GRAPH_REVISION_SEQUENCE', () => { applyGraphEvent(state, secondEvent) })
    state = applyGraphEvent(state, firstEvent)
    state = applyGraphEvent(state, secondEvent)
    const otherRevision = { ...revision1, graphId: GraphId('other') }
    const otherEvent = sessionEvent('graph/change', {
      kind: 'graph/revision', version: 2, graph: otherRevision, current: false,
    }, 3)
    state = applyGraphEvent(state, otherEvent)
    expect(state.currentGraphId).toBe(revision1.graphId)
    const run = { ...runFor(revision2), revision: 2, updatedAt: 4 }
    expectCode('GRAPH_RUN_REVISION', () => { applyGraphEvent(emptyGraphProjection(), sessionEvent('graph/run', run)) })
    state = applyGraphEvent(state, sessionEvent('graph/run', run, 3))
    expect(applyGraphEvent(state, sessionEvent('turn/start', { turn: 1 }))).toBe(state)
    expectCode('GRAPH_RUN_REPLACEMENT', () => {
      applyGraphEvent(state, sessionEvent('graph/run', { ...run, graphId: GraphId('other'), revision: 1 }, 4))
    })
    expectCode('GRAPH_RUN_REPLACEMENT', () => { applyGraphEvent(state, sessionEvent('graph/run', { ...run, revision: 1 }, 4)) })
    expectCode('GRAPH_RUN_REPLACEMENT', () => { applyGraphEvent(state, sessionEvent('graph/run', { ...run, updatedAt: 3 }, 4)) })
    expectCode('GRAPH_RUN_REPLACEMENT', () => {
      applyGraphEvent(state, sessionEvent('graph/run', { ...run, updatedAt: 5 }, 4))
    })
    expectCode('GRAPH_RUN_REPLACEMENT', () => {
      applyGraphEvent(state, sessionEvent('graph/run', { ...run, generation: 2, ownerEpoch: run.ownerEpoch }, 4))
    })
    expectCode('GRAPH_RUN_REPLACEMENT', () => {
      applyGraphEvent(state, sessionEvent('graph/run', { ...run, generation: 3, generationId: GraphRunGenerationId('generation-3'), ownerEpoch: 3 }, 4))
    })
    const takeover = {
      ...run,
      generation: 2,
      generationId: GraphRunGenerationId('generation-2'),
      ownerEpoch: 2,
      updatedAt: 5,
    }
    state = applyGraphEvent(state, sessionEvent('graph/run', takeover, 4))
    expectCode('GRAPH_RUN_REPLACEMENT', () => {
      applyGraphEvent(state, sessionEvent('graph/run', { ...run, updatedAt: 6 }, 5))
    })
    const folded = foldGraph([configEvent, firstEvent, secondEvent, otherEvent, sessionEvent('graph/run', run, 4)])
    expect(folded.runs[run.id]).toEqual(run)
    expect(graphProjectionSchema.safeParse(folded).success).toBe(true)
    expect(graphProjectionSchema.safeParse(null).success).toBe(false)
    expect(graphProjectionSchema.safeParse({ ...folded, config: { ...config, version: 1 } }).success).toBe(false)
    expect(graphProjectionDefinition.init()).toEqual(emptyGraphProjection())
    expect(graphProjectionDefinition.wire.view(state)).toBe(state)
    let registered: unknown
    type ProjectionHost = { sessionProjections: { register: (definition: unknown) => void } }
    apply({ inject: (_dependencies: readonly string[], callback: (inner: ProjectionHost) => void) => {
      callback({ sessionProjections: { register: (definition) => { registered = definition } } })
    } } as unknown as Context)
    expect(registered).toBe(graphProjectionDefinition)
  })

  it('projects campaign batches as independent graph executions with immutable history', () => {
    const revision = graph([])
    const run = runFor(revision)
    let state = applyGraphEvent(emptyGraphProjection(), sessionEvent('graph/change', {
      kind: 'graph/revision', version: 2, graph: revision, current: true,
    }, 1))
    state = applyGraphEvent(state, sessionEvent('graph/run', run, 2))
    const campaign = {
      version: 1 as const,
      id: GraphCampaignId('campaign-1'),
      objective: 'Accept the complete product',
      createdAt: 1,
      updatedAt: 2,
      phase: 'running' as const,
      activeBatchId: GraphCampaignBatchId('batch-1'),
      batches: [{
        id: GraphCampaignBatchId('batch-1'),
        ordinal: 1,
        title: 'Customer workflows',
        objective: 'Accept customer workflows',
        dependsOn: [],
        status: 'running' as const,
        graphId: revision.graphId,
        executions: [{
          graphId: revision.graphId,
          revision: revision.revision,
          runId: run.id,
          status: 'running' as const,
          startedAt: 1,
          settlementIds: [],
        }],
      }],
    }
    state = applyGraphEvent(state, sessionEvent('graph/campaign', campaign, 3))
    expect(state.currentCampaignId).toBe(campaign.id)
    expect(state.campaigns[campaign.id]?.batches[0]?.graphId).toBe(revision.graphId)

    const completed = {
      ...campaign,
      updatedAt: 3,
      phase: 'succeeded' as const,
      activeBatchId: undefined,
      batches: [{
        ...campaign.batches[0],
        status: 'approved' as const,
        executions: [{ ...campaign.batches[0]!.executions[0]!, status: 'succeeded' as const, completedAt: 3 }],
      }],
    }
    state = applyGraphEvent(state, sessionEvent('graph/campaign', completed, 4))
    expect(state.campaigns[campaign.id]?.phase).toBe('succeeded')
    expectCode('GRAPH_CAMPAIGN_REPLACEMENT', () => {
      applyGraphEvent(state, sessionEvent('graph/campaign', {
        ...completed,
        updatedAt: 4,
        batches: [{
          ...completed.batches[0],
          executions: [{ ...completed.batches[0]!.executions[0]!, startedAt: 2 }],
        }],
      }, 5))
    })

    const secondRevision = { ...revision, graphId: GraphId('g-2'), objective: 'Accept diagnosis workflows' }
    const { terminal: _terminal, ...secondRunBase } = runFor(secondRevision)
    const secondRun = {
      ...secondRunBase,
      id: GraphRunId('run-2'),
      graphId: secondRevision.graphId,
      phase: 'running' as const,
      createdAt: 4,
      updatedAt: 4,
      nodes: Object.fromEntries(secondRevision.nodes.map(item => [item.id, {
        workId: GraphWorkId(`work-2-${item.id}`), nodeId: item.id, phase: 'pending' as const, attempts: [],
      }])),
    }
    state = applyGraphEvent(state, sessionEvent('graph/change', {
      kind: 'graph/revision', version: 2, graph: secondRevision, current: true,
    }, 5))
    state = applyGraphEvent(state, sessionEvent('graph/run', secondRun, 6))
    const extended = {
      ...completed,
      updatedAt: 7,
      phase: 'running' as const,
      activeBatchId: GraphCampaignBatchId('batch-2'),
      planRevision: 2,
      planExtensions: [{
        revision: 2,
        createdAt: 7,
        reason: 'Functional inventory discovered diagnosis workflows.',
        addedBatchIds: [GraphCampaignBatchId('batch-2')],
        sourceBatchId: GraphCampaignBatchId('batch-1'),
        sourceRunId: run.id,
        settlementIds: [],
      }],
      batches: [...completed.batches, {
        id: GraphCampaignBatchId('batch-2'),
        ordinal: 2,
        title: 'Diagnosis workflows',
        objective: 'Accept diagnosis workflows',
        dependsOn: [GraphCampaignBatchId('batch-1')],
        status: 'running' as const,
        graphId: secondRevision.graphId,
        executions: [{
          graphId: secondRevision.graphId,
          revision: secondRevision.revision,
          runId: secondRun.id,
          status: 'running' as const,
          startedAt: 4,
          settlementIds: [],
        }],
      }],
    }
    state = applyGraphEvent(state, sessionEvent('graph/campaign', extended, 7))
    expect(state.campaigns[campaign.id]).toMatchObject({
      planRevision: 2,
      batches: [{ id: 'batch-1', status: 'approved' }, { id: 'batch-2', status: 'running' }],
    })
    expectCode('GRAPH_CAMPAIGN_PLAN', () => {
      applyGraphEvent(state, sessionEvent('graph/campaign', {
        ...extended,
        updatedAt: 8,
        planRevision: 3,
        planExtensions: [...extended.planExtensions, {
          revision: 3,
          createdAt: 8,
          reason: 'Invalid non-tail history.',
          addedBatchIds: [GraphCampaignBatchId('batch-x')],
          settlementIds: [],
        }],
      }, 8))
    })
  })

  it('keeps a graph revision provisional until its submission is accepted', () => {
    const revision = graph([])
    const completed = runFor(revision)
    const { terminal: completedTerminal, ...completedWithoutTerminal } = completed
    expect(completedTerminal).toBeDefined()
    const run: GraphRun = {
      ...completedWithoutTerminal,
      phase: 'queued',
      updatedAt: 1,
      nodes: Object.fromEntries(revision.nodes.map(item => [item.id, {
        workId: GraphWorkId(`work-${item.id}`), nodeId: item.id, phase: 'pending' as const, attempts: [],
      }])),
    }
    const pending = {
      version: 1 as const,
      id: GraphSubmissionId('submission-a'),
      intent: 'new' as const,
      graph: revision,
      run,
      changedNodeIds: revision.nodes.map(item => item.id),
      outcome: 'pending' as const,
      requestedAt: 1,
      lineage: {
        version: 1 as const,
        taskId: GraphTaskId('g-1'),
        kind: 'new_task' as const,
        title: 'Ship graph mode',
        objective: 'Ship graph mode',
        reason: 'Start the logical task.',
        creator: 'controller' as const,
        createdAt: 1,
        trigger: { source: 'user' as const, summary: 'Build graph mode.', evidence: [] },
        relationships: [],
        successCriteria: ['Graph mode ships'],
        changes: {
          addedNodeIds: revision.nodes.map(item => item.id),
          changedNodeIds: [], removedNodeIds: [], preservedNodeIds: [],
          invalidatedNodeIds: revision.nodes.map(item => item.id),
        },
      },
    }
    let state = applyGraphEvent(emptyGraphProjection(), sessionEvent('graph/submission', pending, 1))
    expect(state.graphs[revision.graphId]).toBeUndefined()
    expect(state.submissions[pending.id]).toEqual(pending)
    expectCode('GRAPH_SUBMISSION_LINEAGE', () => {
      applyGraphEvent(emptyGraphProjection(), sessionEvent('graph/submission', {
        ...pending, lineage: { ...pending.lineage, kind: 'analysis_refactor' },
      }, 1))
    })
    expectCode('GRAPH_SUBMISSION_SEQUENCE', () => {
      applyGraphEvent(state, sessionEvent('graph/submission', { ...pending, id: GraphSubmissionId('submission-b') }, 2))
    })
    expectCode('GRAPH_SUBMISSION_SEQUENCE', () => {
      const acceptedState = applyGraphEvent(state, sessionEvent('graph/submission', { ...pending, outcome: 'accepted', completedAt: 2 }, 2))
      applyGraphEvent(acceptedState, sessionEvent('graph/submission', { ...pending, outcome: 'failed', completedAt: 3, error: { code: 'FAILED', message: 'late' } }, 3))
    })
    state = applyGraphEvent(state, sessionEvent('graph/change', {
      kind: 'graph/revision', version: 2, graph: revision, current: true,
    }, 2))
    state = applyGraphEvent(state, sessionEvent('graph/run', run, 3))
    const changedConfig = defaultGraphModeConfig()
    state = applyGraphEvent(state, sessionEvent('graph/change', {
      kind: 'graph/config',
      version: 2,
      config: {
        ...changedConfig,
        roles: changedConfig.roles.map(role => role.id === 'analyst' ? { ...role, enabled: false } : role),
      },
    }, 4))
    state = applyGraphEvent(state, sessionEvent('graph/submission', {
      ...pending, outcome: 'accepted', completedAt: 5,
    }, 5))
    expect(state.submissions[pending.id]?.outcome).toBe('accepted')
  })

  it('retries failed external settlements under one stable identity', () => {
    const revision = graph([])
    let state = applyGraphEvent(emptyGraphProjection(), sessionEvent('graph/change', {
      kind: 'graph/revision', version: 2, graph: revision, current: true,
    }, 1))
    const run = runFor(revision)
    state = applyGraphEvent(state, sessionEvent('graph/run', run, 2))
    const base = {
      version: 2 as const,
      id: GraphSettlementId('settlement-a'),
      operationId: GraphControlOperationId('operation-a'),
      workId: run.nodes['a']!.workId,
      runId: run.id,
      generationId: run.generationId,
      ownerEpoch: run.ownerEpoch,
      kind: 'resource-release' as const,
      externalReference: { kind: 'model' as const, provider: 'local', id: 'reservation-a' },
    }
    state = applyGraphEvent(state, sessionEvent('graph/settlement', {
      ...base, attempt: 1, outcome: 'pending', requestedAt: 3,
    }, 3))
    state = applyGraphEvent(state, sessionEvent('graph/settlement', {
      ...base, attempt: 1, outcome: 'failed', requestedAt: 3, completedAt: 4,
      error: { code: 'UNAVAILABLE', message: 'provider unavailable' },
    }, 4))
    expectCode('GRAPH_SETTLEMENT_SEQUENCE', () => {
      applyGraphEvent(state, sessionEvent('graph/settlement', {
        ...base,
        externalReference: { kind: 'model', provider: 'local', id: 'reservation-b' },
        attempt: 2,
        outcome: 'pending',
        requestedAt: 5,
      }, 5))
    })
    state = applyGraphEvent(state, sessionEvent('graph/settlement', {
      ...base, attempt: 2, outcome: 'pending', requestedAt: 5,
    }, 5))
    state = applyGraphEvent(state, sessionEvent('graph/settlement', {
      ...base, attempt: 2, outcome: 'confirmed', requestedAt: 5, completedAt: 6,
      evidence: 'release confirmed',
    }, 6))
    expect(state.settlements[base.id]?.map(record => [record.attempt, record.outcome])).toEqual([
      [1, 'pending'], [1, 'failed'], [2, 'pending'], [2, 'confirmed'],
    ])
    expectCode('GRAPH_SETTLEMENT_SEQUENCE', () => {
      applyGraphEvent(state, sessionEvent('graph/settlement', {
        ...base, attempt: 3, outcome: 'pending', requestedAt: 7,
      }, 7))
    })
  })

  it('rejects invalidation of missing nodes and cyclic closures', () => {
    expectCode('GRAPH_INVALIDATION_NODE', () => { downstreamInvalidation(graph([]), [GraphNodeId('missing')]) })
    const cyclic = graph([
      { from: GraphNodeId('a'), to: GraphNodeId('b'), kind: 'control' },
      { from: GraphNodeId('b'), to: GraphNodeId('a'), kind: 'control' },
    ])
    expectCode('GRAPH_CYCLE', () => { downstreamInvalidation(cyclic, [GraphNodeId('a')]) })
  })
})
