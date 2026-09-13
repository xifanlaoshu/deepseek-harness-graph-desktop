import { resolve } from 'node:path'
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
import GraphWorkerRuntime, { type GraphWorkerAssignment } from '@deepseek-ai/dsh-graph-worker'
import { runGraphWorkerProviderContract, type GraphWorkerContractScenario } from '../../graph-worker/tests/contract.ts'
import { GraphArtifactManifestId } from '@deepseek-ai/dsh-graph-worker'
import GraphArtifactRuntime, { type GraphArtifactProvider } from '@deepseek-ai/dsh-graph-artifacts'
import type { ResolvedSubagentStartRequest, SubagentCapabilities, SubagentProvider, SubagentRun } from '@deepseek-ai/dsh-subagent'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import * as RemoteWorker from '../src/index.ts'

class RemoteStub implements SubagentProvider {
  readonly name = 'transport'
  readonly inheritsParentContext = false
  readonly capabilities: SubagentCapabilities = {
    outputSchema: false,
    depthLimit: false,
    toolFilter: false,
    persona: false,
    sandboxMode: false,
  }
  request: ResolvedSubagentStartRequest | undefined

  constructor(private readonly text: string, private readonly waitForAbort = false) {}

  async start(request: ResolvedSubagentStartRequest): Promise<SubagentRun> {
    this.request = request
    const result = this.waitForAbort
      ? new Promise<Awaited<SubagentRun['result']>>((resolve) => {
        request.signal.addEventListener('abort', () => { resolve({ stopReason: 'aborted', output: [] }) }, { once: true })
      })
      : Promise.resolve({ stopReason: 'completed' as const, output: [{ type: 'text' as const, text: this.text }] })
    return { id: SessionId('remote-child'), localAgent: undefined, result, async dispose() {} }
  }
}

const assignment = (sourceRoot: string): GraphWorkerAssignment => ({
  protocolVersion: 1,
  workId: GraphWorkId('work-1'),
  operationId: GraphControlOperationId('operation-1'),
  attemptId: GraphAttemptId('attempt-1'),
  activation: 0,
  runId: GraphRunId('run-1'),
  generationId: GraphRunGenerationId('generation-1'),
  ownerEpoch: 1,
  fencingToken: 1,
  parent: { id: SessionId('parent'), options: {}, session: { header: { cwd: sourceRoot } } } as unknown as Agent,
  node: {
    id: GraphNodeId('node-1'), title: 'Analyze', objective: 'Analyze.', kind: 'analysis', roleId: GraphRoleId('analyst'),
    acceptanceCriteria: ['Return evidence.'], outputSchema: defaultGraphOutputSchema(), maxAttempts: 1, weight: 1,
    executionBudget: defaultGraphNodeExecutionBudget(), skippable: false, effectPolicy: 'idempotent',
  },
  role: {
    id: GraphRoleId('analyst'), label: 'Analyst', description: 'Analyzes.', controller: false, enabled: true,
    model: {}, prompt: 'Analyze only the assignment.', maxParallel: 1,
  },
  prompt: [{ type: 'text', text: 'Analyze.' }],
  outputSchema: defaultGraphOutputSchema().schema,
  budget: defaultGraphNodeExecutionBudget(),
  workspace: { mode: 'shared', sourceRoot, readRoots: ['.'], writeRoots: [], cleanup: 'retain' },
  deadline: Date.now() + 60_000,
  signal: new AbortController().signal,
})

runGraphWorkerProviderContract('remote', async (scenario: GraphWorkerContractScenario) => {
  const mountedWorker = await mounted(new RemoteStub(
    '{"summary":"contract complete","artifacts":[]}',
    scenario === 'pending',
  ))
  return {
    runtime: mountedWorker.ctx.graphWorkers,
    providerName: 'remote',
    assignment: assignment(resolve('contract-local-workspace')),
    dispose: async () => { await mountedWorker.ctx.fiber.dispose() },
  }
})

async function mounted(stub: RemoteStub, artifacts?: GraphArtifactProvider) {
  const ctx = new Context()
  await ctx.plugin(SubagentRuntime).await()
  ctx.subagents.registerProvider(stub)
  await ctx.plugin(GraphWorkerRuntime).await()
  if (artifacts !== undefined) {
    await ctx.plugin(GraphArtifactRuntime).await()
    ctx.graphArtifacts.register(artifacts)
  }
  const cwd = resolve('remote-workspace')
  await ctx.plugin(RemoteWorker, {
    providerName: 'remote', subagentProvider: 'transport', cwd,
    maxArtifactFiles: 10,
    maxArtifactBytes: 1_000,
    ...artifacts === undefined ? {} : { artifactProvider: artifacts.name },
  }).await()
  return { ctx, cwd }
}

describe('remote Graph Worker provider', () => {
  it('adapts strict JSON output from an out-of-process subagent route', async () => {
    const stub = new RemoteStub('{"summary":"done","artifacts":[]}')
    const { ctx, cwd } = await mounted(stub)
    const run = await ctx.graphWorkers.start('remote', assignment(resolve('local-workspace')))

    await expect(run.result).resolves.toMatchObject({ outcome: 'completed', structured: { summary: 'done', artifacts: [] } })
    expect(stub.request?.workspaceCwd).toBe(cwd)
    expect(stub.request?.outputSchema).toBeUndefined()
    const finalPrompt = stub.request?.prompt.at(-1)
    if (finalPrompt?.type !== 'text') throw new Error('remote adapter must append a text schema instruction')
    expect(finalPrompt.text).toContain('Return only one JSON value')
  })

  it('rejects unstructured completion at the remote wire boundary', async () => {
    const { ctx } = await mounted(new RemoteStub('not json'))
    const run = await ctx.graphWorkers.start('remote', assignment(resolve('local-workspace')))
    await expect(run.result).resolves.toMatchObject({ outcome: 'error', error: { code: 'GRAPH_WORKER_REMOTE_JSON' } })
  })

  it('forwards cooperative cancellation through the assignment signal', async () => {
    const { ctx } = await mounted(new RemoteStub('', true))
    const run = await ctx.graphWorkers.start('remote', assignment(resolve('local-workspace')))
    await run.cancel('user canceled', new AbortController().signal)
    await expect(run.result).resolves.toMatchObject({ outcome: 'aborted' })
  })

  it('captures remote structured artifact paths before publishing success', async () => {
    const transport: GraphArtifactProvider = {
      name: 'artifacts',
      persistent: true,
      remote: true,
      capture: async request => ({
        id: GraphArtifactManifestId(`artifact:${'a'.repeat(64)}`),
        algorithm: 'sha256',
        provider: 'artifacts',
        workId: request.workId,
        operationId: request.operationId,
        attemptId: request.attemptId,
        runId: request.runId,
        generationId: request.generationId,
        ownerEpoch: request.ownerEpoch,
        fencingToken: request.fencingToken,
        createdAt: Date.now(),
        totalBytes: 4,
        entries: [{ path: 'build.zip', sha256: 'b'.repeat(64), size: 4, mode: 0o600, kind: 'file' }],
        providerReference: 'remote:artifact',
      }),
      materialize: async request => ({ paths: request.manifest.entries.map(entry => entry.path), totalBytes: request.manifest.totalBytes }),
      reconcile: async () => ({ status: 'retained', evidence: 'remote artifact retained' }),
    }
    const { ctx } = await mounted(new RemoteStub('{"summary":"done","artifacts":["build.zip"]}'), transport)
    expect(ctx.graphWorkers.list()[0]?.capabilities.artifactManifest).toBe(true)
    const run = await ctx.graphWorkers.start('remote', assignment(resolve('local-workspace')))
    await expect(run.result).resolves.toMatchObject({
      outcome: 'completed',
      artifactManifest: { entries: [{ path: 'build.zip' }] },
    })
  })

  it('reconciles an attached remote Worker by canceling its exact run', async () => {
    const { ctx } = await mounted(new RemoteStub('', true))
    const work = assignment(resolve('local-workspace'))
    const run = await ctx.graphWorkers.start('remote', work)
    await expect(ctx.graphWorkers.reconcile('remote', {
      protocolVersion: 1,
      workId: work.workId,
      operationId: work.operationId,
      runId: work.runId,
      generationId: work.generationId,
      ownerEpoch: work.ownerEpoch,
      workerId: run.id,
      workspaceId: run.workspace.id,
      workspaceMode: 'shared',
      cleanup: 'retain',
      safeToDelete: true,
    }, new AbortController().signal)).resolves.toMatchObject({ status: 'canceled' })
    await expect(run.result).resolves.toMatchObject({ outcome: 'aborted' })
  })
})
