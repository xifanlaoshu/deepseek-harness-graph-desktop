import { mkdtemp, mkdir, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
import type { ResolvedSubagentStartRequest, SubagentCapabilities, SubagentProvider, SubagentRun } from '@deepseek-ai/dsh-subagent'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it } from 'vitest'
import * as LocalWorker from '../src/index.ts'

const roots: string[] = []
afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

class WritingProvider implements SubagentProvider {
  readonly name = 'stub'
  readonly inheritsParentContext = false
  readonly capabilities: SubagentCapabilities = { outputSchema: true, depthLimit: true, toolFilter: true, persona: true, sandboxMode: true }
  readonly requests: ResolvedSubagentStartRequest[] = []

  constructor(
    private readonly writePath: string,
    private readonly content = 'generated',
    private readonly waitForAbort = false,
  ) {}

  async start(request: ResolvedSubagentStartRequest): Promise<SubagentRun> {
    this.requests.push(request)
    const cwd = request.workspaceCwd as string
    await mkdir(join(cwd, this.writePath, '..'), { recursive: true })
    await writeFile(join(cwd, this.writePath), this.content, 'utf8')
    const result = this.waitForAbort
      ? new Promise<Awaited<SubagentRun['result']>>((resolve) => {
        request.signal.addEventListener('abort', () => { resolve({ stopReason: 'aborted', output: [] }) }, { once: true })
      })
      : Promise.resolve({
        stopReason: 'completed' as const,
        output: [{ type: 'text' as const, text: 'done' }],
        structured: { summary: 'done', artifacts: [this.writePath] },
      })
    return {
      id: SessionId(`child-${this.writePath}`),
      localAgent: undefined,
      result,
      async dispose() {},
    }
  }
}

const assignment = (sourceRoot: string, cleanup: GraphWorkerAssignment['workspace']['cleanup'] = 'retain'): GraphWorkerAssignment => ({
  protocolVersion: 1,
  workId: GraphWorkId('work-1'),
  operationId: GraphControlOperationId('operation-1'),
  attemptId: GraphAttemptId('attempt-1'),
  activation: 0,
  runId: GraphRunId('run-1'),
  generationId: GraphRunGenerationId('generation-1'),
  ownerEpoch: 1,
  fencingToken: 1,
  parent: { id: SessionId('parent'), session: { header: { cwd: sourceRoot } } } as unknown as Agent,
  node: {
    id: GraphNodeId('node-1'),
    title: 'Implement',
    objective: 'Create an output.',
    kind: 'implementation',
    roleId: GraphRoleId('engineer'),
    acceptanceCriteria: ['Output exists.'],
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
    prompt: 'Implement only the assignment.',
    maxParallel: 1,
  },
  prompt: [{ type: 'text', text: 'Create the output.' }],
  outputSchema: defaultGraphOutputSchema().schema,
  budget: defaultGraphNodeExecutionBudget(),
  workspace: { mode: 'isolated-copy', sourceRoot, readRoots: ['.'], writeRoots: ['src'], cleanup },
  deadline: Date.now() + 60_000,
  signal: new AbortController().signal,
})

async function mounted(writePath: string, waitForAbort = false) {
  const source = await mkdtemp(join(tmpdir(), 'dsh-worker-source-'))
  roots.push(source)
  await mkdir(join(source, 'src'))
  await writeFile(join(source, 'src', 'base.txt'), 'base', 'utf8')
  await writeFile(join(source, 'README.md'), 'source', 'utf8')
  const isolationRoot = await mkdtemp(join(tmpdir(), 'dsh-worker-allocations-'))
  roots.push(isolationRoot)
  const ctx = new Context()
  await ctx.plugin(SubagentRuntime).await()
  const provider = new WritingProvider(writePath, 'generated', waitForAbort)
  ctx.subagents.registerProvider(provider)
  await ctx.plugin(GraphWorkerRuntime).await()
  await ctx.plugin(LocalWorker, {
    providerName: 'local',
    subagentProvider: 'stub',
    isolationRoot,
    exclude: [],
    maxArtifactFiles: 10,
    maxArtifactBytes: 1_000_000,
  }).await()
  return { ctx, source, isolationRoot, provider }
}

async function mountedWithDefaultExcludes(writePath: string, exclude?: string[]) {
  const source = await mkdtemp(join(tmpdir(), 'dsh-worker-source-'))
  roots.push(source)
  await mkdir(join(source, 'src'))
  await mkdir(join(source, 'node_modules', 'dependency'), { recursive: true })
  await mkdir(join(source, '.npm-cache'), { recursive: true })
  await mkdir(join(source, 'frontend', 'node_modules', 'dependency'), { recursive: true })
  await mkdir(join(source, 'frontend', '.npm-cache'), { recursive: true })
  await mkdir(join(source, 'frontend', 'vendor', 'dependency'), { recursive: true })
  await writeFile(join(source, 'node_modules', 'dependency', 'index.js'), 'dependency', 'utf8')
  await writeFile(join(source, '.npm-cache', 'entry'), 'cache', 'utf8')
  await writeFile(join(source, 'frontend', 'node_modules', 'dependency', 'index.js'), 'nested dependency', 'utf8')
  await writeFile(join(source, 'frontend', '.npm-cache', 'entry'), 'nested cache', 'utf8')
  await writeFile(join(source, 'frontend', 'vendor', 'dependency', 'index.js'), 'vendored dependency', 'utf8')
  const isolationRoot = await mkdtemp(join(tmpdir(), 'dsh-worker-allocations-'))
  roots.push(isolationRoot)
  const ctx = new Context()
  await ctx.plugin(SubagentRuntime).await()
  ctx.subagents.registerProvider(new WritingProvider(writePath))
  await ctx.plugin(GraphWorkerRuntime).await()
  await ctx.plugin(LocalWorker, {
    providerName: 'local',
    subagentProvider: 'stub',
    isolationRoot,
    maxArtifactFiles: 10,
    maxArtifactBytes: 1_000_000,
    ...exclude === undefined ? {} : { exclude },
  } as LocalWorker.Config).await()
  return { ctx, source }
}

describe('local Graph Worker provider', () => {
  it('runs in an isolated copy and publishes changed-file evidence', async () => {
    const { ctx, source, provider } = await mounted('src/output.txt')
    const run = await ctx.graphWorkers.start('local', assignment(source))
    expect(run.workspace.mode).toBe('isolated-copy')
    expect(run.workspace.root).not.toBe(source)
    expect(provider.requests[0]?.sandboxModeCap).toBe('workspace-write')

    await expect(run.result).resolves.toMatchObject({
      outcome: 'completed',
      structured: { summary: 'done' },
      artifactManifest: {
        algorithm: 'sha256',
        entries: [{ path: 'src/output.txt', kind: 'file', size: 9, baseSha256: null }],
      },
    })
    await expect(readFile(join(source, 'src', 'output.txt'), 'utf8')).rejects.toThrow()
    await expect(readFile(join(run.workspace.root, 'src', 'output.txt'), 'utf8')).resolves.toBe('generated')
  })

  it('deletes an unpublished allocation when initial snapshot validation fails', async () => {
    const { ctx, source, isolationRoot } = await mounted('src/output.txt')
    const outside = await mkdtemp(join(tmpdir(), 'dsh-worker-outside-'))
    roots.push(outside)
    await symlink(outside, join(source, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')

    await expect(ctx.graphWorkers.start('local', assignment(source, 'retain'))).rejects.toThrow(
      process.platform === 'win32' ? /EPERM|symlink escapes allocation/u : 'symlink escapes allocation',
    )
    await expect(readdir(isolationRoot)).resolves.toEqual([])
  })

  it('fails an isolated attempt that writes outside its declared roots', async () => {
    const { ctx, source } = await mounted('README.md')
    const run = await ctx.graphWorkers.start('local', assignment(source))
    await expect(run.result).resolves.toMatchObject({
      outcome: 'error',
      error: { code: 'GRAPH_WORKER_UNDECLARED_WRITE', message: 'worker changed undeclared path README.md', retryable: false },
    })
  })

  it('caps snapshot authority and leaves shared workers on inherited policy', async () => {
    const snapshot = await mounted('src/output.txt')
    const snapshotRun = await snapshot.ctx.graphWorkers.start('local', {
      ...assignment(snapshot.source),
      workspace: {
        ...assignment(snapshot.source).workspace,
        mode: 'read-only-snapshot',
        writeRoots: [],
      },
    })
    await snapshotRun.result
    expect(snapshot.provider.requests[0]?.sandboxModeCap).toBe('read-only')

    const shared = await mounted('src/shared.txt')
    const sharedRun = await shared.ctx.graphWorkers.start('local', {
      ...assignment(shared.source),
      workspace: {
        ...assignment(shared.source).workspace,
        mode: 'shared',
        cleanup: 'retain',
      },
    })
    await sharedRun.result
    expect(shared.provider.requests[0]?.sandboxModeCap).toBeUndefined()
  })

  it('omits dependency and package-manager cache trees by default', async () => {
    const { ctx, source } = await mountedWithDefaultExcludes('frontend/node_modules/generated.txt')
    const run = await ctx.graphWorkers.start('local', assignment(source))
    await expect(run.result).resolves.toMatchObject({
      outcome: 'completed',
      artifactManifest: { entries: [] },
    })
    await expect(stat(join(run.workspace.root, '.npm-cache'))).rejects.toThrow()
    await expect(readFile(join(run.workspace.root, 'node_modules', 'dependency', 'index.js'), 'utf8')).rejects.toThrow()
    await expect(stat(join(run.workspace.root, 'frontend', '.npm-cache'))).rejects.toThrow()
    await expect(readFile(join(run.workspace.root, 'frontend', 'node_modules', 'dependency', 'index.js'), 'utf8')).rejects.toThrow()
    await expect(readFile(join(run.workspace.root, 'frontend', 'node_modules', 'generated.txt'), 'utf8')).resolves.toBe('generated')
  })

  it('keeps a multi-segment exclusion relative to the source root', async () => {
    const { ctx, source } = await mountedWithDefaultExcludes('frontend/vendor/generated.txt', ['frontend/vendor'])
    const run = await ctx.graphWorkers.start('local', assignment(source))
    await expect(run.result).resolves.toMatchObject({ outcome: 'completed', artifactManifest: { entries: [] } })
    await expect(readFile(join(run.workspace.root, 'frontend', 'vendor', 'dependency', 'index.js'), 'utf8')).rejects.toThrow()
  })

  it('deletes successful allocations under delete-on-settlement', async () => {
    const { ctx, source } = await mounted('src/output.txt')
    const run = await ctx.graphWorkers.start('local', assignment(source, 'delete-on-settlement'))
    await expect(run.result).resolves.toMatchObject({ outcome: 'completed' })
    await expect(stat(run.workspace.root)).rejects.toThrow()
  })

  it('deletes an idempotent orphan allocation after the Provider is remounted', async () => {
    const { ctx, source, isolationRoot } = await mounted('src/output.txt')
    const work = assignment(source)
    const run = await ctx.graphWorkers.start('local', work)
    await expect(run.result).resolves.toMatchObject({ outcome: 'completed' })
    await expect(stat(run.workspace.root)).resolves.toBeDefined()
    await ctx.fiber.dispose()

    const restored = new Context()
    await restored.plugin(SubagentRuntime).await()
    restored.subagents.registerProvider(new WritingProvider('src/restored.txt'))
    await restored.plugin(GraphWorkerRuntime).await()
    await restored.plugin(LocalWorker, {
      providerName: 'local',
      subagentProvider: 'stub',
      isolationRoot,
      exclude: [],
      maxArtifactFiles: 10,
      maxArtifactBytes: 1_000_000,
    }).await()
    await expect(restored.graphWorkers.reconcile('local', {
      protocolVersion: 1,
      workId: work.workId,
      operationId: work.operationId,
      runId: work.runId,
      generationId: work.generationId,
      ownerEpoch: work.ownerEpoch,
      workerId: run.id,
      workspaceId: run.workspace.id,
      workspaceMode: 'isolated-copy',
      cleanup: 'delete-on-settlement',
      safeToDelete: true,
    }, new AbortController().signal)).resolves.toMatchObject({ status: 'deleted' })
    await expect(stat(run.workspace.root)).rejects.toThrow()
    await restored.fiber.dispose()
  })
})

runGraphWorkerProviderContract('local', async (scenario: GraphWorkerContractScenario) => {
  const mountedWorker = await mounted('src/contract-output.txt', scenario === 'pending')
  return {
    runtime: mountedWorker.ctx.graphWorkers,
    providerName: 'local',
    assignment: assignment(mountedWorker.source),
    dispose: async () => { await mountedWorker.ctx.fiber.dispose() },
  }
})
