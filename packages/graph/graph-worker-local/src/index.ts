/** Local isolated Graph Worker Provider over `ctx.subagents`. @module @deepseek-ai/dsh-graph-worker-local */

import { createHash } from 'node:crypto'
import { cp, lstat, mkdir, readFile, readdir, readlink, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join, posix, relative, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { GraphArtifactRuntime } from '@deepseek-ai/dsh-graph-artifacts'
import z from '@deepseek-ai/schemastery'
import {
  GraphArtifactManifestId,
  GraphWorkerId,
  GraphWorkspaceAllocationId,
  type GraphArtifactEntry,
  type GraphArtifactManifest,
  type GraphWorkerAssignment,
  type GraphWorkerOutcome,
  type GraphWorkerProvider,
  type GraphWorkerReconcileRequest,
  type GraphWorkerReconcileResult,
  type GraphWorkerResult,
  type GraphWorkerRun,
  type GraphWorkspaceAllocation,
} from '@deepseek-ai/dsh-graph-worker'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { SubagentCapacityScopeId, type SubagentResult, type SubagentRun } from '@deepseek-ai/dsh-subagent'

export const name = 'graph-worker-local'
export const inject = ['graphWorkers', 'subagents']

/** Deployment settings for local workspace copying and artifact bounds. */
export interface Config {
  /** Provider name selected by Graph roles. */
  providerName: string
  /** Registered subagent provider used inside the allocation. */
  subagentProvider: string
  /** Parent directory for isolated allocations; omission uses the operating-system temp directory. */
  isolationRoot?: string
  /** Source-relative names omitted from isolated copies and mutation scans. */
  exclude: string[]
  /** Maximum changed files retained in one artifact manifest. */
  maxArtifactFiles: number
  /** Maximum changed bytes retained in one artifact manifest. */
  maxArtifactBytes: number
  /** Durable artifact transport; omission keeps only the Provider-owned allocation reference. */
  artifactProvider?: string
}

/** Plugin configuration schema. */
export const Config: z<Config> = z.object({
  providerName: z.string().default('local'),
  subagentProvider: z.string().default('spawn'),
  isolationRoot: z.string(),
  exclude: z.array(z.string()).default([
    '.git', '.sessions', '.child-sessions', '.playwright-mcp', 'lib', 'node_modules', '.npm-cache',
  ]),
  maxArtifactFiles: z.natural().min(1).max(100_000).default(10_000),
  maxArtifactBytes: z.natural().min(1).default(536_870_912),
  artifactProvider: z.string(),
})

interface FileFact {
  readonly kind: 'file' | 'symlink'
  readonly hash: string
  readonly size: number
  readonly mode: number
}

const safeRelative = (value: string, label: string): string => {
  if (!value.trim()) throw new Error(`${label} must be non-empty`)
  const portable = value.replaceAll('\\', '/')
  if (portable.startsWith('/') || /^[A-Za-z]:\//u.test(portable)) throw new Error(`${label} must be source-relative`)
  const normalized = posix.normalize(portable)
  if (normalized === '..' || normalized.startsWith('../')) throw new Error(`${label} escapes the workspace`)
  return normalized === './' ? '.' : normalized.replace(/^\.\//u, '')
}

const inside = (root: string, path: string): boolean => path === root || path.startsWith(`${root}${sep}`)

const isOwned = (path: string, roots: readonly string[]): boolean => roots.some(root => root === '.' || path === root || path.startsWith(`${root}/`))

const isExcluded = (path: string, excluded: ReadonlySet<string>): boolean => [...excluded].some((item) => {
  if (item.includes('/')) return item === path || path.startsWith(`${item}/`)
  return path.split('/').includes(item)
})

const mapOutcome = (result: SubagentResult): GraphWorkerOutcome => {
  switch (result.stopReason) {
    case 'completed': return 'completed'
    case 'aborted': return 'aborted'
    case 'max-tokens': return 'max-tokens'
    case 'error':
    case 'refusal': return 'error'
    default: return 'error'
  }
}

class LocalGraphWorkerProvider implements GraphWorkerProvider {
  readonly capabilities = {
    protocolVersion: 1 as const,
    remote: false,
    workspaceModes: ['shared', 'isolated-copy', 'read-only-snapshot'] as const,
    structuredOutput: true,
    toolFilter: true,
    artifactManifest: true,
    progress: false,
    cancellation: true,
  }
  private readonly active = new Map<string, GraphWorkerRun>()

  constructor(
    readonly name: string,
    private readonly ctx: Context,
    private readonly config: Config,
    private readonly artifacts: GraphArtifactRuntime | undefined,
  ) {}

  async start(assignment: GraphWorkerAssignment) {
    const workspace = await this.allocate(assignment)
    const ownAbort = new AbortController()
    const deadlineSignal = AbortSignal.timeout(Math.max(1, assignment.deadline - Date.now()))
    const workerSignal = AbortSignal.any([assignment.signal, ownAbort.signal, deadlineSignal])
    let before: ReadonlyMap<string, FileFact> | undefined
    let child: SubagentRun
    try {
      before = ['isolated-copy', 'read-only-snapshot'].includes(assignment.workspace.mode)
        ? await this.snapshot(workspace.root)
        : undefined
      child = await this.ctx.subagents.start(this.config.subagentProvider, {
        label: assignment.node.title,
        prompt: [...assignment.prompt],
        parent: assignment.parent,
        signal: workerSignal,
        workspaceCwd: workspace.root,
        agentOptions: {
          ...assignment.role.model.provider === undefined ? {} : { provider: assignment.role.model.provider },
          ...assignment.role.model.model === undefined ? {} : { model: assignment.role.model.model },
          ...assignment.role.model.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: ReasoningEffortId(assignment.role.model.reasoningEffort) },
          maxTokens: assignment.budget.maxOutputTokens,
          ...assignment.activeSubagentLimit === undefined ? {} : {
            subagentCapacity: {
              scope: SubagentCapacityScopeId(`graph-run:${assignment.runId}`),
              maxActive: assignment.activeSubagentLimit,
            },
          },
        },
        outputSchema: assignment.outputSchema,
        ...assignment.toolFilter === undefined ? {} : { toolFilter: assignment.toolFilter },
        persona: assignment.role.prompt,
        ...assignment.workspace.mode === 'isolated-copy'
          ? { sandboxModeCap: 'workspace-write' as const }
          : assignment.workspace.mode === 'read-only-snapshot'
            ? { sandboxModeCap: 'read-only' as const }
            : {},
      })
    } catch (error) {
      try {
        await this.cleanup(workspace, 'delete-on-settlement', false)
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], `graph worker initialization and allocation cleanup failed for ${workspace.id}`)
      }
      throw error
    }

    const result = this.finish(assignment, workspace, before, child)
    const run: GraphWorkerRun = {
      id: GraphWorkerId(`worker:${child.id}`),
      provider: this.name,
      workspace,
      childSessionId: String(child.id),
      result,
      cancel: (reason: string, signal: AbortSignal): Promise<void> => {
        signal.throwIfAborted()
        if (!reason.trim()) throw new Error('graph worker cancellation reason must be non-empty')
        ownAbort.abort(new Error(reason))
        return Promise.resolve()
      },
    }
    this.active.set(run.id, run)
    void result.then(
      () => { this.active.delete(run.id) },
      () => { this.active.delete(run.id) },
    )
    return run
  }

  async reconcile(request: GraphWorkerReconcileRequest, signal: AbortSignal): Promise<GraphWorkerReconcileResult> {
    signal.throwIfAborted()
    const active = this.active.get(request.workerId)
    if (active !== undefined) {
      if (active.workspace.id !== request.workspaceId) throw new Error(`graph worker ${request.workerId} owns a different workspace`)
      await active.cancel('scheduler recovery superseded this Worker', signal)
      await active.result
      return { status: 'canceled', evidence: `canceled active local Worker ${request.workerId}` }
    }
    if (request.workspaceMode === 'shared') {
      return { status: 'retained', evidence: 'shared source workspace is never deleted by Worker reconciliation' }
    }
    if (!['isolated-copy', 'read-only-snapshot'].includes(request.workspaceMode)) {
      return { status: 'quarantined', evidence: `local Provider cannot reconcile ${request.workspaceMode} allocation ${request.workspaceId}` }
    }
    const root = this.allocationRoot(request.workspaceId)
    let stat
    try {
      stat = await lstat(root)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'absent', evidence: `isolated allocation ${request.workspaceId} is absent` }
      throw error
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      return { status: 'quarantined', evidence: `allocation path for ${request.workspaceId} is not an owned directory` }
    }
    if (!request.safeToDelete || request.cleanup !== 'delete-on-settlement') {
      return { status: 'retained', evidence: `isolated allocation ${request.workspaceId} retained by recovery policy` }
    }
    await rm(root, { recursive: true, force: true })
    return { status: 'deleted', evidence: `deleted idempotent orphan allocation ${request.workspaceId}` }
  }

  private async allocate(assignment: GraphWorkerAssignment): Promise<GraphWorkspaceAllocation> {
    const source = await realpath(assignment.workspace.sourceRoot)
    if (!isAbsolute(source) || !(await lstat(source)).isDirectory()) throw new Error('graph worker sourceRoot must be an accessible absolute directory')
    for (const root of [...assignment.workspace.readRoots, ...assignment.workspace.writeRoots]) safeRelative(root, 'graph worker ownership root')
    const id = GraphWorkspaceAllocationId(`workspace:${assignment.workId}:${assignment.attemptId}:${String(assignment.activation)}`)
    if (assignment.workspace.mode === 'shared') {
      return { id, mode: 'shared', root: source, providerReference: String(id), createdAt: Date.now(), ...assignment.workspace.sourceRevision === undefined ? {} : { sourceRevision: assignment.workspace.sourceRevision }, ...assignment.workspace.baseContentHash === undefined ? {} : { baseContentHash: assignment.workspace.baseContentHash } }
    }
    const parent = this.config.isolationRoot === undefined ? tmpdir() : resolve(this.config.isolationRoot)
    await mkdir(parent, { recursive: true })
    const root = this.allocationRoot(id)
    await mkdir(root)
    const excluded = new Set(this.config.exclude.map(item => safeRelative(item, 'graph worker exclude')))
    try {
      await cp(source, root, {
        recursive: true,
        dereference: false,
        verbatimSymlinks: false,
        filter: (from) => {
          const path = relative(source, from).replaceAll('\\', '/') || '.'
          return !isExcluded(path, excluded)
        },
      })
    } catch (error) {
      await rm(root, { recursive: true, force: true })
      throw error
    }
    return {
      id,
      mode: assignment.workspace.mode,
      root,
      providerReference: String(id),
      createdAt: Date.now(),
      ...assignment.workspace.sourceRevision === undefined
        ? {}
        : { sourceRevision: assignment.workspace.sourceRevision },
      ...assignment.workspace.baseContentHash === undefined
        ? {}
        : { baseContentHash: assignment.workspace.baseContentHash },
    }
  }

  private allocationRoot(id: GraphWorkspaceAllocationId): string {
    const parent = this.config.isolationRoot === undefined ? tmpdir() : resolve(this.config.isolationRoot)
    const suffix = createHash('sha256').update(id).digest('hex').slice(0, 32)
    return join(parent, `dsh-graph-worker-${suffix}`)
  }

  private async finish(
    assignment: GraphWorkerAssignment,
    workspace: GraphWorkspaceAllocation,
    before: ReadonlyMap<string, FileFact> | undefined,
    child: SubagentRun,
  ): Promise<GraphWorkerResult> {
    let completed = false
    try {
      const childResult = await child.result
      const outcome = mapOutcome(childResult)
      if (before === undefined) return this.childResult(child, childResult, outcome)
      const after = await this.snapshot(workspace.root)
      const changed = this.changed(before, after)
      const deleted = changed.find(path => !after.has(path))
      if (deleted !== undefined) {
        return {
          outcome: 'error',
          output: childResult.output,
          childSessionId: String(child.id),
          error: { code: 'GRAPH_WORKER_DELETION_UNSUPPORTED', message: `isolated worker deleted ${deleted}; use an explicit integration task`, retryable: false },
        }
      }
      const writeRoots = assignment.workspace.writeRoots.map(root => safeRelative(root, 'graph worker write root'))
      const undeclared = changed.find(path => !isOwned(path, writeRoots))
      if (undeclared !== undefined) {
        return {
          outcome: 'error',
          output: childResult.output,
          childSessionId: String(child.id),
          error: { code: 'GRAPH_WORKER_UNDECLARED_WRITE', message: `worker changed undeclared path ${undeclared}`, retryable: false },
        }
      }
      const artifactManifest = this.config.artifactProvider === undefined
        ? await this.manifest(assignment, workspace, changed, before, after)
        : await this.captureArtifacts(assignment, workspace, changed, before, after)
      completed = outcome === 'completed'
      return { ...this.childResult(child, childResult, outcome), artifactManifest }
    } catch (error) {
      return {
        outcome: assignment.signal.aborted ? 'aborted' : 'error',
        output: [],
        childSessionId: String(child.id),
        error: { code: 'GRAPH_WORKER_LOCAL_FAILURE', message: error instanceof Error ? error.message : String(error) },
      }
    } finally {
      await child.dispose().catch(() => { /* result evidence already owns the child outcome; disposal cannot replace it */ })
      await this.cleanup(workspace, assignment.workspace.cleanup, completed)
    }
  }

  private childResult(child: SubagentRun, result: SubagentResult, outcome: GraphWorkerOutcome): GraphWorkerResult {
    return {
      outcome,
      output: result.output,
      childSessionId: String(child.id),
      ...result.structured === undefined ? {} : { structured: result.structured },
      ...outcome === 'completed' ? {} : { error: { code: `GRAPH_WORKER_${outcome.replace('-', '_').toUpperCase()}`, message: `subagent stopped with ${result.stopReason}` } },
    }
  }

  private async snapshot(root: string): Promise<Map<string, FileFact>> {
    const facts = new Map<string, FileFact>()
    const excluded = new Set(this.config.exclude.map(item => safeRelative(item, 'graph worker exclude')))
    const visit = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const absolute = join(directory, entry.name)
        const path = relative(root, absolute).replaceAll('\\', '/')
        if (isExcluded(path, excluded)) continue
        const stat = await lstat(absolute)
        if (stat.isDirectory()) {
          await visit(absolute)
          continue
        }
        if (stat.isSymbolicLink()) {
          const target = await readlink(absolute)
          const resolvedTarget = resolve(directory, target)
          if (!inside(root, resolvedTarget)) throw new Error(`graph worker symlink escapes allocation: ${path}`)
          facts.set(path, { kind: 'symlink', hash: createHash('sha256').update(target).digest('hex'), size: Buffer.byteLength(target), mode: stat.mode })
          continue
        }
        if (!stat.isFile()) continue
        const bytes = await readFile(absolute)
        facts.set(path, { kind: 'file', hash: createHash('sha256').update(bytes).digest('hex'), size: bytes.byteLength, mode: stat.mode })
      }
    }
    await visit(root)
    return facts
  }

  private changed(before: ReadonlyMap<string, FileFact>, after: ReadonlyMap<string, FileFact>): string[] {
    const paths = new Set([...before.keys(), ...after.keys()])
    return [...paths].filter((path) => {
      const left = before.get(path)
      const right = after.get(path)
      return left?.kind !== right?.kind || left?.hash !== right?.hash || left?.mode !== right?.mode
    }).sort()
  }

  private manifest(
    assignment: GraphWorkerAssignment,
    workspace: GraphWorkspaceAllocation,
    changed: readonly string[],
    before: ReadonlyMap<string, FileFact>,
    after: ReadonlyMap<string, FileFact>,
  ): Promise<GraphArtifactManifest> {
    if (changed.length > this.config.maxArtifactFiles) throw new Error(`graph worker produced ${String(changed.length)} changed paths, exceeding maxArtifactFiles`)
    const entries: GraphArtifactEntry[] = []
    let totalBytes = 0
    for (const path of changed) {
      const fact = after.get(path)
      if (fact === undefined) continue
      totalBytes += fact.size
      if (totalBytes > this.config.maxArtifactBytes) throw new Error('graph worker changed artifacts exceed maxArtifactBytes')
      entries.push({
        path,
        sha256: fact.hash,
        baseSha256: before.get(path)?.hash ?? null,
        size: fact.size,
        mode: fact.mode,
        kind: fact.kind,
      })
    }
    const digest = createHash('sha256').update(JSON.stringify({ workId: assignment.workId, attemptId: assignment.attemptId, entries })).digest('hex')
    const id = GraphArtifactManifestId(`artifact:${digest}`)
    return Promise.resolve({
      id,
      algorithm: 'sha256',
      provider: this.name,
      workId: assignment.workId,
      operationId: assignment.operationId,
      attemptId: assignment.attemptId,
      runId: assignment.runId,
      generationId: assignment.generationId,
      ownerEpoch: assignment.ownerEpoch,
      fencingToken: assignment.fencingToken,
      createdAt: Date.now(),
      totalBytes,
      entries,
      providerReference: `${workspace.providerReference}:${basename(workspace.root)}:${id}`,
    })
  }

  private captureArtifacts(
    assignment: GraphWorkerAssignment,
    workspace: GraphWorkspaceAllocation,
    changed: readonly string[],
    before: ReadonlyMap<string, FileFact>,
    after: ReadonlyMap<string, FileFact>,
  ): Promise<GraphArtifactManifest> {
    if (this.artifacts === undefined || this.config.artifactProvider === undefined) throw new Error('configured Graph artifact runtime is unavailable')
    return this.artifacts.capture(this.config.artifactProvider, {
      workId: assignment.workId,
      operationId: assignment.operationId,
      attemptId: assignment.attemptId,
      runId: assignment.runId,
      generationId: assignment.generationId,
      ownerEpoch: assignment.ownerEpoch,
      fencingToken: assignment.fencingToken,
      workspaceId: workspace.id,
      sourceRoot: workspace.root,
      workspaceReference: workspace.providerReference,
      paths: changed.filter(path => after.has(path)),
      baseContentHashes: Object.fromEntries(changed.filter(path => after.has(path)).map(path => [path, before.get(path)?.hash ?? null])),
      maxFiles: this.config.maxArtifactFiles,
      maxBytes: this.config.maxArtifactBytes,
      deadline: assignment.deadline,
      signal: assignment.signal,
    })
  }

  private async cleanup(workspace: GraphWorkspaceAllocation, policy: GraphWorkerAssignment['workspace']['cleanup'], completed: boolean): Promise<void> {
    if (!['isolated-copy', 'read-only-snapshot'].includes(workspace.mode)) return
    if (policy === 'retain' || (policy === 'retain-on-failure' && !completed)) return
    await rm(workspace.root, { recursive: true, force: true })
  }
}

/** Register the local Worker Provider under the configured name. */
export function apply(ctx: Context, config: Config): void {
  if (!config.providerName.trim()) throw new Error('graph-worker-local providerName must be non-empty')
  if (!config.subagentProvider.trim()) throw new Error('graph-worker-local subagentProvider must be non-empty')
  if (config.artifactProvider !== undefined && !config.artifactProvider.trim()) throw new Error('graph-worker-local artifactProvider must be non-empty')
  if (config.isolationRoot !== undefined && (!config.isolationRoot.trim() || !isAbsolute(resolve(config.isolationRoot)))) {
    throw new Error('graph-worker-local isolationRoot must resolve to an absolute path')
  }
  const artifacts = config.artifactProvider === undefined ? undefined : ctx.get('graphArtifacts')
  if (config.artifactProvider !== undefined && artifacts === undefined) throw new Error('graph-worker-local artifactProvider requires ctx.graphArtifacts')
  const provider = new LocalGraphWorkerProvider(config.providerName, ctx, config, artifacts)
  ctx.effect(() => ctx.graphWorkers.register(provider), 'graph-worker-local: provider registration')
}
