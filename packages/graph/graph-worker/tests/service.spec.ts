import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  GraphAttemptId,
  GraphControlOperationId,
  GraphNodeId,
  GraphRoleId,
  GraphRunGenerationId,
  GraphRunId,
  GraphWorkId,
  defaultGraphNodeExecutionBudget,
  defaultGraphOutputSchema,
} from '@deepseek-ai/dsh-graph'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { describe, expect, it, vi } from 'vitest'
import GraphWorkerRuntime, {
  GraphArtifactManifestId,
  GraphWorkerId,
  GraphWorkspaceAllocationId,
  type GraphWorkerAssignment,
  type GraphWorkerProvider,
} from '../src/index.ts'
import * as WorkerInvariant from '../src/invariant.ts'

const assignment = (overrides: Partial<GraphWorkerAssignment> = {}): GraphWorkerAssignment => ({
  protocolVersion: 1,
  workId: GraphWorkId('work-1'),
  operationId: GraphControlOperationId('operation-1'),
  attemptId: GraphAttemptId('attempt-1'),
  activation: 0,
  runId: GraphRunId('run-1'),
  generationId: GraphRunGenerationId('generation-1'),
  ownerEpoch: 1,
  fencingToken: 1,
  parent: { id: 'parent-1' } as unknown as Agent,
  node: {
    id: GraphNodeId('node-1'),
    title: 'Implement',
    objective: 'Implement one bounded change.',
    kind: 'implementation',
    roleId: GraphRoleId('engineer'),
    acceptanceCriteria: ['Focused test passes.'],
    outputSchema: defaultGraphOutputSchema(),
    maxAttempts: 1,
    weight: 1,
    executionBudget: defaultGraphNodeExecutionBudget(),
    skippable: false,
    effectPolicy: 'idempotent',
  },
  role: {
    id: GraphRoleId('engineer'),
    label: 'Engineer',
    description: 'Implements work.',
    controller: false,
    enabled: true,
    model: {},
    prompt: 'Implement the assignment.',
    maxParallel: 1,
  },
  prompt: [{ type: 'text', text: 'Implement the assignment.' }],
  outputSchema: defaultGraphOutputSchema().schema,
  budget: defaultGraphNodeExecutionBudget(),
  workspace: {
    mode: 'shared',
    sourceRoot: 'D:\\workspace',
    readRoots: ['.'],
    writeRoots: ['src'],
    cleanup: 'retain',
  },
  deadline: Date.now() + 60_000,
  signal: new AbortController().signal,
  ...overrides,
})

const provider = (name = 'local'): GraphWorkerProvider => ({
  name,
  capabilities: {
    protocolVersion: 1,
    remote: false,
    workspaceModes: ['shared'],
    structuredOutput: true,
    toolFilter: false,
    artifactManifest: false,
    progress: false,
    cancellation: true,
  },
  start: vi.fn(async () => ({
    id: GraphWorkerId('worker-1'),
    provider: name,
    workspace: {
      id: GraphWorkspaceAllocationId('workspace-1'),
      mode: 'shared' as const,
      root: 'D:\\workspace',
      providerReference: 'shared:D:\\workspace',
      createdAt: Date.now(),
    },
    result: Promise.resolve({ outcome: 'completed' as const, output: [], structured: { summary: 'done', artifacts: [] } }),
    cancel: async () => {},
  })),
  reconcile: vi.fn(async () => ({ status: 'retained' as const, evidence: 'shared workspace retained' })),
})

describe('graph worker service', () => {
  it('registers, lists, dispatches, and disposes a named provider', async () => {
    const ctx = new Context()
    await ctx.plugin(GraphWorkerRuntime).await()
    const local = provider()
    const dispose = ctx.graphWorkers.register(local)

    expect(ctx.graphWorkers.list()).toEqual([{ name: 'local', capabilities: local.capabilities }])
    const run = await ctx.graphWorkers.start('local', assignment())
    expect(run).toMatchObject({ provider: 'local' })
    // oxlint-disable-next-line typescript/unbound-method -- the Provider field is a Vitest mock in this probe.
    expect(local.start).toHaveBeenCalledOnce()
    await expect(ctx.graphWorkers.reconcile('local', {
      protocolVersion: 1,
      workId: GraphWorkId('work-1'),
      operationId: GraphControlOperationId('operation-1'),
      runId: GraphRunId('run-1'),
      generationId: GraphRunGenerationId('generation-1'),
      ownerEpoch: 1,
      workerId: run.id,
      workspaceId: run.workspace.id,
      workspaceMode: 'shared',
      cleanup: 'retain',
      safeToDelete: false,
    }, new AbortController().signal)).resolves.toEqual({ status: 'retained', evidence: 'shared workspace retained' })
    // oxlint-disable-next-line typescript/unbound-method -- the Provider field is a Vitest mock in this probe.
    expect(local.reconcile).toHaveBeenCalledOnce()

    dispose()
    await expect(ctx.graphWorkers.start('local', assignment())).rejects.toThrow('unknown graph worker provider local')
  })

  it('rejects duplicate providers and unsupported assignment requirements before dispatch', async () => {
    const ctx = new Context()
    await ctx.plugin(GraphWorkerRuntime).await()
    const local = provider()
    ctx.graphWorkers.register(local)
    expect(() => { ctx.graphWorkers.register(provider()) }).toThrow('already registered')

    await expect(ctx.graphWorkers.start('local', assignment({
      workspace: { ...assignment().workspace, mode: 'git-worktree' },
    }))).rejects.toThrow('does not support workspace mode git-worktree')
    // oxlint-disable-next-line typescript/unbound-method -- the Provider field is a Vitest mock in this probe.
    expect(local.start).not.toHaveBeenCalled()
  })

  it('rejects stale identity, deadlines, and provider publication mismatches', async () => {
    const ctx = new Context()
    await ctx.plugin(GraphWorkerRuntime).await()
    const local = provider()
    ctx.graphWorkers.register(local)

    await expect(ctx.graphWorkers.start('local', assignment({ ownerEpoch: 0 }))).rejects.toThrow('ownerEpoch')
    await expect(ctx.graphWorkers.start('local', assignment({ deadline: Date.now() - 1 }))).rejects.toThrow('deadline')

    const wrongBase = provider('wrong')
    const wrong: GraphWorkerProvider = {
      ...wrongBase,
      start: vi.fn(async () => ({ ...await provider('different').start(assignment()), provider: 'different' })),
    }
    ctx.graphWorkers.register(wrong)
    await expect(ctx.graphWorkers.start('wrong', assignment())).rejects.toThrow('published run for different')
  })

  it('rejects malformed or wrongly attributed Provider artifact evidence', async () => {
    const ctx = new Context()
    await ctx.plugin(GraphWorkerRuntime).await()
    const work = assignment()
    const artifactProvider: GraphWorkerProvider = {
      ...provider('artifacts'),
      capabilities: { ...provider('artifacts').capabilities, artifactManifest: true },
      start: async () => ({
        ...await provider('artifacts').start(work),
        result: Promise.resolve({
          outcome: 'completed' as const,
          output: [],
          artifactManifest: {
            id: GraphArtifactManifestId(`artifact:${'a'.repeat(64)}`),
            algorithm: 'sha256' as const,
            provider: 'artifacts',
            workId: work.workId,
            operationId: work.operationId,
            attemptId: GraphAttemptId('different-attempt'),
            runId: work.runId,
            generationId: work.generationId,
            ownerEpoch: work.ownerEpoch,
            fencingToken: work.fencingToken,
            createdAt: Date.now(),
            totalBytes: 0,
            entries: [],
            providerReference: 'test:manifest',
          },
        }),
      }),
    }
    ctx.graphWorkers.register(artifactProvider)
    const run = await ctx.graphWorkers.start('artifacts', work)
    await expect(run.result).rejects.toThrow('different fenced attempt')
  })

  it('reserves package invariant ownership', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await ctx.plugin(WorkerInvariant).await()
    expect(() => {
      ctx.invariants.register('@deepseek-ai/dsh-graph-worker', () => {})
    }).toThrow(/already registered/)
  })
})
