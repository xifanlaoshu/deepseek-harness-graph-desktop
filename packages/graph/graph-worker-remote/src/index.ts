/** Remote Graph Worker Provider over a configured out-of-process subagent. @module @deepseek-ai/dsh-graph-worker-remote */

import { isAbsolute, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { GraphArtifactRuntime } from '@deepseek-ai/dsh-graph-artifacts'
import type { GraphResourceRuntime } from '@deepseek-ai/dsh-graph-resources'
import type { GraphSchedulerRuntime } from '@deepseek-ai/dsh-graph-scheduler'
import z from '@deepseek-ai/schemastery'
import {
  GraphWorkerId,
  GraphWorkspaceAllocationId,
  type GraphWorkerAssignment,
  type GraphWorkerCapabilities,
  type GraphWorkerOutcome,
  type GraphWorkerProvider,
  type GraphWorkerReconcileRequest,
  type GraphWorkerReconcileResult,
  type GraphWorkerResult,
  type GraphWorkerRun,
  type GraphWorkspaceAllocation,
} from '@deepseek-ai/dsh-graph-worker'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentResult, SubagentRun, SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { HttpGraphWorkerProvider } from './http-client.ts'
import { HttpGraphArtifactProvider } from './http-artifact.ts'
import { HttpGraphResourceProvider } from './http-resource.ts'
import { HttpGraphSchedulerProvider } from './http-scheduler.ts'
import { HttpGraphWorkerServer } from './http-server.ts'
import { GraphWorkerRemoteAudienceId, GraphWorkerRemotePrincipalId } from './wire.ts'

export * from './wire.ts'
export * from './http-client.ts'
export * from './http-artifact.ts'
export * from './http-server.ts'
export * from './http-resource.ts'
export * from './http-scheduler.ts'

export const name = 'graph-worker-remote'
export const inject = ['graphWorkers']

const WORKSPACE_MODES = ['read-only-snapshot', 'isolated-copy', 'git-worktree', 'sandbox-mount', 'shared'] as const

/** Authenticated HTTP Worker route configuration. */
export interface HttpConfig {
  /** HTTPS service prefix; loopback HTTP requires explicit development opt-in. */
  readonly endpoint: string
  /** Authenticated caller identity configured by the Worker service. */
  readonly principal: string
  /** Authenticated service identity expected by the caller. */
  readonly audience: string
  /** Credential reference resolving the shared request-signing secret. */
  readonly credentialRef: string
  /** Workspace modes advertised by this remote route. */
  readonly workspaceModes: Array<typeof WORKSPACE_MODES[number]>
  /** Delay between terminal-state observations and idempotent start retries. */
  readonly pollIntervalMs: number
  /** Maximum total attempts for one idempotent start request. */
  readonly startAttempts: number
  /** Consecutive retryable observation failures tolerated before terminal failure. */
  readonly maxPollFailures: number
  /** Per-operation HTTP deadline in milliseconds. */
  readonly requestTimeoutMs: number
  /** Maximum successful or error response bytes retained by the Client. */
  readonly maxResponseBytes: number
  /** Permit cleartext HTTP only when the endpoint resolves to loopback. */
  readonly allowInsecureLoopback: boolean
  /** Optional Graph Resource route registered over the same authenticated service. */
  readonly resourceProviderName: string
  /** Optional authenticated Graph Scheduler route registered over the same service. */
  readonly schedulerProviderName: string
  /** Optional authenticated Graph Artifact route registered over the same service. */
  readonly artifactProviderName: string
  /** Absolute local roots from which the HTTP Artifact route may upload files. */
  readonly artifactAllowedCaptureRoots: string[]
  /** Absolute local roots into which the HTTP Artifact route may download files. */
  readonly artifactAllowedMaterializeRoots: string[]
  /** Local ceiling for files in one HTTP Artifact transfer. */
  readonly artifactMaxFiles: number
  /** Local ceiling for decoded bytes in one HTTP Artifact transfer. */
  readonly artifactMaxBytes: number
}

/** One authenticated caller allowed to submit jobs to the HTTP Worker service. */
export interface HttpServerPrincipalConfig {
  /** Authenticated caller identity. */
  readonly principal: string
  /** Credential reference resolving this caller's shared signing secret. */
  readonly credentialRef: string
}

/** Durable authenticated HTTP Worker service configuration. */
export interface HttpServerConfig {
  /** Service identity that every accepted signature must address. */
  readonly audience: string
  /** Prefix owning the versioned authenticated Worker, Resource, Scheduler, and Artifact operations. */
  readonly basePath: string
  /** SQLite path retaining accepted jobs and terminal evidence. */
  readonly journalPath: string
  /** Same-process Graph Worker Provider executing accepted assignments. */
  readonly workerProvider: string
  /** Live service-owned Agent used as the delegation parent. */
  readonly parentSessionId: string
  /** Non-empty unique authenticated caller allowlist. */
  readonly principals: HttpServerPrincipalConfig[]
  /** Maximum accepted absolute caller/server clock difference. */
  readonly maxClockSkewMs: number
  /** Maximum authenticated request-body bytes. */
  readonly maxRequestBytes: number
  /** Maximum persisted and returned terminal-result bytes. */
  readonly maxResultBytes: number
  /** Maximum unexpired caller/nonce pairs retained for replay rejection. */
  readonly maxReplayEntries: number
  /** Maximum SQLite lock wait in milliseconds. */
  readonly busyTimeoutMs: number
  /** Deadline for one delegated Worker, Resource, Scheduler, or Artifact operation. */
  readonly operationTimeoutMs: number
  /** Public Graph Resource route identity exposed to authenticated callers. */
  readonly resourceRouteName: string
  /** Same-process Graph Resource Provider delegated by the public route. */
  readonly resourceProvider: string
  /** Public Graph Scheduler route identity exposed to authenticated callers. */
  readonly schedulerRouteName: string
  /** Same-process durable Graph Scheduler Provider delegated by the public route. */
  readonly schedulerProvider: string
  /** Public Graph Artifact route identity exposed to authenticated callers. */
  readonly artifactRouteName: string
  /** Same-process persistent Graph Artifact Provider delegated by the public route. */
  readonly artifactProvider: string
  /** Absolute private directory used only for bounded Artifact transfer staging. */
  readonly artifactTempRoot: string
  /** Service ceiling for files in one Artifact transfer. */
  readonly artifactMaxFiles: number
  /** Service ceiling for decoded bytes in one Artifact transfer. */
  readonly artifactMaxBytes: number
}

/** Deployment binding from a Graph Worker route to a remote subagent backend. */
export interface Config {
  /** Which outbound and/or inbound HTTP role this plugin instance mounts. */
  readonly mode?: 'client' | 'server' | 'both'
  /** Registered Graph Worker route name. */
  readonly providerName: string
  /** Existing out-of-process subagent Provider used for remote execution. */
  readonly subagentProvider: string
  /** Absolute working directory in the remote provider's execution world. */
  readonly cwd?: string
  /** Artifact transport used to capture structured output paths. */
  readonly artifactProvider?: string
  /** Maximum files accepted from one remote structured result. */
  readonly maxArtifactFiles: number
  /** Maximum bytes captured from one remote structured result. */
  readonly maxArtifactBytes: number
  /** Authenticated HTTP route; omission retains the out-of-process subagent adapter. */
  readonly http?: HttpConfig | undefined
  /** Authenticated inbound Worker service; required in server and both modes. */
  readonly server?: HttpServerConfig | undefined
}

/** Plugin configuration schema. */
export const Config: z<Config> = z.object({
  mode: z.union([z.const('client'), z.const('server'), z.const('both')]).default('client'),
  providerName: z.string().default('remote'),
  subagentProvider: z.string().default('codex'),
  cwd: z.string(),
  artifactProvider: z.string(),
  maxArtifactFiles: z.natural().min(1).max(100_000).default(10_000),
  maxArtifactBytes: z.natural().min(1).default(536_870_912),
  http: z.union([z.object({
    endpoint: z.string().required(),
    principal: z.string().required(),
    audience: z.string().required(),
    credentialRef: z.string().required(),
    workspaceModes: z.array(z.union(WORKSPACE_MODES.map(mode => z.const(mode)))).default(['isolated-copy']),
    pollIntervalMs: z.natural().min(1).default(250),
    startAttempts: z.natural().min(1).max(10).default(2),
    maxPollFailures: z.natural().max(100).default(3),
    requestTimeoutMs: z.natural().min(1).default(30_000),
    maxResponseBytes: z.natural().min(1).default(8_388_608),
    allowInsecureLoopback: z.boolean().default(false),
    resourceProviderName: z.string().default(''),
    schedulerProviderName: z.string().default(''),
    artifactProviderName: z.string().default(''),
    artifactAllowedCaptureRoots: z.array(z.string()).default([]),
    artifactAllowedMaterializeRoots: z.array(z.string()).default([]),
    artifactMaxFiles: z.natural().min(1).max(100_000).default(10_000),
    artifactMaxBytes: z.natural().min(1).default(536_870_912),
  }), z.const(undefined)]),
  server: z.union([z.object({
    audience: z.string().required(),
    basePath: z.string().default('/graph-worker'),
    journalPath: z.string().default('.sessions/graph-worker-http.sqlite'),
    workerProvider: z.string().required(),
    parentSessionId: z.string().required(),
    principals: z.array(z.object({
      principal: z.string().required(),
      credentialRef: z.string().required(),
    })).required(),
    maxClockSkewMs: z.natural().min(1).default(30_000),
    maxRequestBytes: z.natural().min(1).default(8_388_608),
    maxResultBytes: z.natural().min(1).default(8_388_608),
    maxReplayEntries: z.natural().min(1).default(100_000),
    busyTimeoutMs: z.natural().min(1).default(5_000),
    operationTimeoutMs: z.natural().min(1).default(30_000),
    resourceRouteName: z.string().default(''),
    resourceProvider: z.string().default(''),
    schedulerRouteName: z.string().default(''),
    schedulerProvider: z.string().default(''),
    artifactRouteName: z.string().default(''),
    artifactProvider: z.string().default(''),
    artifactTempRoot: z.string().default('.sessions/graph-worker-http-artifacts'),
    artifactMaxFiles: z.natural().min(1).max(100_000).default(10_000),
    artifactMaxBytes: z.natural().min(1).default(536_870_912),
  }), z.const(undefined)]),
})

function installServer(ctx: Context, config: HttpServerConfig): void {
  const credentials = ctx.get('credentials')
  const webServer: WebServer | undefined = ctx.get('webServer')
  const agents: AgentRegistry | undefined = ctx.get('agents')
  if (credentials === undefined) throw new Error('graph-worker-remote server mode requires ctx.credentials')
  if (webServer === undefined) throw new Error('graph-worker-remote server mode requires ctx.webServer')
  if (agents === undefined) throw new Error('graph-worker-remote server mode requires ctx.agents')
  const audience = GraphWorkerRemoteAudienceId(config.audience)
  const principals = new Map(config.principals.map(item => [
    GraphWorkerRemotePrincipalId(item.principal),
    credentialRef(item.credentialRef),
  ]))
  if (principals.size === 0 || principals.size !== config.principals.length) {
    throw new Error('graph-worker-remote server principals must be non-empty and unique')
  }
  if (!config.resourceRouteName.trim() !== !config.resourceProvider.trim()) {
    throw new Error('graph-worker-remote server resourceRouteName and resourceProvider must be configured together')
  }
  if (!config.artifactRouteName.trim() !== !config.artifactProvider.trim()) {
    throw new Error('graph-worker-remote server artifactRouteName and artifactProvider must be configured together')
  }
  if (!config.schedulerRouteName.trim() !== !config.schedulerProvider.trim()) {
    throw new Error('graph-worker-remote server schedulerRouteName and schedulerProvider must be configured together')
  }
  const graphResources: GraphResourceRuntime | undefined = ctx.get('graphResources')
  if (config.resourceProvider && graphResources === undefined) {
    throw new Error('graph-worker-remote server resource route requires ctx.graphResources')
  }
  const graphArtifacts: GraphArtifactRuntime | undefined = ctx.get('graphArtifacts')
  if (config.artifactProvider && graphArtifacts === undefined) {
    throw new Error('graph-worker-remote server artifact route requires ctx.graphArtifacts')
  }
  const graphScheduler: GraphSchedulerRuntime | undefined = ctx.get('graphScheduler')
  if (config.schedulerProvider && graphScheduler === undefined) {
    throw new Error('graph-worker-remote server scheduler route requires ctx.graphScheduler')
  }
  const server = new HttpGraphWorkerServer({
    audience,
    basePath: config.basePath,
    journalPath: resolve(config.journalPath),
    workerProvider: config.workerProvider,
    graphWorkers: ctx.graphWorkers,
    ...!config.resourceProvider || !config.resourceRouteName || graphResources === undefined
      ? {}
      : { resource: { routeName: config.resourceRouteName, providerName: config.resourceProvider, graphResources } },
    ...!config.artifactProvider || !config.artifactRouteName || graphArtifacts === undefined
      ? {}
      : {
        artifact: {
          routeName: config.artifactRouteName,
          providerName: config.artifactProvider,
          graphArtifacts,
          tempRoot: resolve(config.artifactTempRoot),
          maxFiles: config.artifactMaxFiles,
          maxBytes: config.artifactMaxBytes,
        },
      },
    ...!config.schedulerProvider || !config.schedulerRouteName || graphScheduler === undefined
      ? {}
      : {
        scheduler: {
          routeName: config.schedulerRouteName,
          providerName: config.schedulerProvider,
          graphScheduler,
        },
      },
    resolveSecret: async (principal) => {
      const ref = principals.get(principal)
      return ref === undefined ? undefined : (await credentials.resolve(ref))?.value
    },
    resolveParent: () => agents.get(SessionId(config.parentSessionId)),
    maxClockSkewMs: config.maxClockSkewMs,
    maxRequestBytes: config.maxRequestBytes,
    maxResultBytes: config.maxResultBytes,
    maxReplayEntries: config.maxReplayEntries,
    busyTimeoutMs: config.busyTimeoutMs,
    operationTimeoutMs: config.operationTimeoutMs,
  })
  ctx.effect(() => {
    const disposeRoute = webServer.register({ kind: 'prefix', path: config.basePath, handler: server.handle.bind(server) })
    return async () => {
      disposeRoute()
      await server.close()
    }
  }, 'graph-worker-remote: HTTP server registration')
}

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

class RemoteGraphWorkerProvider implements GraphWorkerProvider {
  readonly capabilities: GraphWorkerCapabilities
  private readonly active = new Map<string, GraphWorkerRun>()

  constructor(
    readonly name: string,
    private readonly subagents: SubagentRuntime,
    private readonly config: Config,
    private readonly artifacts: GraphArtifactRuntime | undefined,
  ) {
    this.capabilities = {
      protocolVersion: 1,
      remote: true,
      workspaceModes: ['shared'],
      structuredOutput: true,
      toolFilter: false,
      artifactManifest: artifacts !== undefined,
      progress: false,
      cancellation: true,
    }
  }

  async start(assignment: GraphWorkerAssignment) {
    const ownAbort = new AbortController()
    const signal = AbortSignal.any([assignment.signal, ownAbort.signal])
    const cwd = this.config.cwd ?? assignment.workspace.sourceRoot
    const child = await this.subagents.start(this.config.subagentProvider, {
      label: assignment.node.title,
      prompt: [
        { type: 'text', text: `Role instructions:\n${assignment.role.prompt}` },
        ...assignment.prompt,
        { type: 'text', text: `Return only one JSON value matching this schema. Do not use Markdown fences.\n${JSON.stringify(assignment.outputSchema)}` },
      ],
      parent: assignment.parent,
      signal,
      workspaceCwd: cwd,
      agentOptions: {
        ...assignment.role.model.provider === undefined ? {} : { provider: assignment.role.model.provider },
        ...assignment.role.model.model === undefined ? {} : { model: assignment.role.model.model },
        ...assignment.role.model.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: ReasoningEffortId(assignment.role.model.reasoningEffort) },
      },
    })
    const workspace: GraphWorkspaceAllocation = {
      id: GraphWorkspaceAllocationId(`workspace:${assignment.workId}:${assignment.attemptId}:${String(assignment.activation)}`),
      mode: 'shared' as const,
      root: cwd,
      providerReference: `remote:${this.name}:${assignment.workId}:${assignment.attemptId}:${String(assignment.activation)}`,
      createdAt: Date.now(),
      ...assignment.workspace.sourceRevision === undefined ? {} : { sourceRevision: assignment.workspace.sourceRevision },
      ...assignment.workspace.baseContentHash === undefined ? {} : { baseContentHash: assignment.workspace.baseContentHash },
    }
    const run: GraphWorkerRun = {
      id: GraphWorkerId(`worker:${child.id}`),
      provider: this.name,
      workspace,
      childSessionId: String(child.id),
      result: this.finish(child, assignment, workspace),
      cancel: (reason: string, cancelSignal: AbortSignal): Promise<void> => {
        cancelSignal.throwIfAborted()
        if (!reason.trim()) throw new Error('graph worker cancellation reason must be non-empty')
        ownAbort.abort(new Error(reason))
        return Promise.resolve()
      },
    }
    this.active.set(run.id, run)
    void run.result.then(
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
      await active.cancel('scheduler recovery superseded this remote Worker', signal)
      await active.result
      return { status: 'canceled', evidence: `canceled active remote Worker ${request.workerId}` }
    }
    return {
      status: 'quarantined',
      evidence: `remote Worker ${request.workerId} is not attached to this process; the subagent transport must reconcile its workspace`,
    }
  }

  private async finish(
    child: SubagentRun,
    assignment: GraphWorkerAssignment,
    workspace: GraphWorkspaceAllocation,
  ): Promise<GraphWorkerResult> {
    try {
      const result = await child.result
      const outcome = mapOutcome(result)
      if (outcome === 'completed') {
        const text = result.output.filter(block => block.type === 'text').map(block => block.text).join('').trim()
        let structured: unknown
        try {
          structured = JSON.parse(text)
        } catch {
          return { outcome: 'error', output: result.output, childSessionId: String(child.id), error: { code: 'GRAPH_WORKER_REMOTE_JSON', message: 'remote worker did not return one JSON value' } }
        }
        const violations = validateJsonSchemaValue(assignment.outputSchema, structured, 'worker output')
        if (violations.length > 0) {
          return { outcome: 'error', output: result.output, childSessionId: String(child.id), error: { code: 'GRAPH_WORKER_REMOTE_SCHEMA', message: violations.join('; ') } }
        }
        if (this.config.artifactProvider === undefined) {
          return { outcome, output: result.output, childSessionId: String(child.id), structured }
        }
        const paths = (structured as { readonly artifacts?: unknown }).artifacts
        if (!Array.isArray(paths) || paths.some(path => typeof path !== 'string')) {
          return { outcome: 'error', output: result.output, childSessionId: String(child.id), error: { code: 'GRAPH_WORKER_REMOTE_ARTIFACTS', message: 'remote worker structured output must contain artifact path strings' } }
        }
        if (paths.length === 0) return { outcome, output: result.output, childSessionId: String(child.id), structured }
        if (this.artifacts === undefined) throw new Error('configured Graph artifact runtime is unavailable')
        const artifactManifest = await this.artifacts.capture(this.config.artifactProvider, {
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
          paths,
          maxFiles: this.config.maxArtifactFiles,
          maxBytes: this.config.maxArtifactBytes,
          deadline: assignment.deadline,
          signal: assignment.signal,
        })
        return { outcome, output: result.output, childSessionId: String(child.id), structured, artifactManifest }
      }
      return {
        outcome,
        output: result.output,
        childSessionId: String(child.id),
        error: { code: `GRAPH_WORKER_${outcome.replace('-', '_').toUpperCase()}`, message: `remote subagent stopped with ${result.stopReason}` },
      }
    } catch (error) {
      return {
        outcome: assignment.signal.aborted ? 'aborted' : 'unavailable',
        output: [],
        childSessionId: String(child.id),
        error: { code: 'GRAPH_WORKER_REMOTE_FAILURE', message: error instanceof Error ? error.message : String(error) },
      }
    } finally {
      await child.dispose().catch(() => { /* terminal result remains authoritative when remote cleanup loses transport */ })
    }
  }
}

/** Register the configured remote Worker route. */
export function apply(ctx: Context, config: Config): void {
  const mode = config.mode ?? 'client'
  if (!config.providerName.trim()) throw new Error('graph-worker-remote providerName must be non-empty')
  if (config.artifactProvider !== undefined && !config.artifactProvider.trim()) throw new Error('graph-worker-remote artifactProvider must be non-empty')
  if (config.cwd !== undefined && (!config.cwd.trim() || !isAbsolute(config.cwd))) throw new Error('graph-worker-remote cwd must be an absolute path in the provider execution world')
  if (mode === 'server' || mode === 'both') {
    if (config.server === undefined) throw new Error(`graph-worker-remote ${mode} mode requires server configuration`)
    installServer(ctx, config.server)
  } else if (config.server !== undefined) {
    throw new Error('graph-worker-remote server configuration requires server or both mode')
  }
  if (mode === 'server') return
  if (config.http !== undefined) {
    if (config.cwd !== undefined || config.artifactProvider !== undefined) {
      throw new Error('graph-worker-remote HTTP mode does not accept cwd or artifactProvider; the Worker service owns both')
    }
    const credentials = ctx.get('credentials')
    if (credentials === undefined) throw new Error('graph-worker-remote HTTP mode requires ctx.credentials')
    const ref = credentialRef(config.http.credentialRef)
    const provider = new HttpGraphWorkerProvider({
      providerName: config.providerName,
      endpoint: config.http.endpoint,
      principal: GraphWorkerRemotePrincipalId(config.http.principal),
      audience: GraphWorkerRemoteAudienceId(config.http.audience),
      workspaceModes: config.http.workspaceModes,
      pollIntervalMs: config.http.pollIntervalMs,
      startAttempts: config.http.startAttempts,
      maxPollFailures: config.http.maxPollFailures,
      requestTimeoutMs: config.http.requestTimeoutMs,
      maxResponseBytes: config.http.maxResponseBytes,
      allowInsecureLoopback: config.http.allowInsecureLoopback,
      resolveSecret: async () => (await credentials.resolve(ref))?.value,
    })
    ctx.effect(() => ctx.graphWorkers.register(provider), 'graph-worker-remote: HTTP provider registration')
    if (config.http.resourceProviderName) {
      const graphResources: GraphResourceRuntime | undefined = ctx.get('graphResources')
      if (graphResources === undefined) throw new Error('graph-worker-remote HTTP resource route requires ctx.graphResources')
      const resourceProvider = new HttpGraphResourceProvider({
        providerName: config.http.resourceProviderName,
        endpoint: config.http.endpoint,
        principal: GraphWorkerRemotePrincipalId(config.http.principal),
        audience: GraphWorkerRemoteAudienceId(config.http.audience),
        requestTimeoutMs: config.http.requestTimeoutMs,
        maxResponseBytes: config.http.maxResponseBytes,
        allowInsecureLoopback: config.http.allowInsecureLoopback,
        resolveSecret: async () => (await credentials.resolve(ref))?.value,
      })
      ctx.effect(() => graphResources.register(resourceProvider), 'graph-worker-remote: HTTP resource provider registration')
    }
    if (config.http.artifactProviderName) {
      const graphArtifacts: GraphArtifactRuntime | undefined = ctx.get('graphArtifacts')
      if (graphArtifacts === undefined) throw new Error('graph-worker-remote HTTP artifact route requires ctx.graphArtifacts')
      const artifactProvider = new HttpGraphArtifactProvider({
        providerName: config.http.artifactProviderName,
        endpoint: config.http.endpoint,
        principal: GraphWorkerRemotePrincipalId(config.http.principal),
        audience: GraphWorkerRemoteAudienceId(config.http.audience),
        requestTimeoutMs: config.http.requestTimeoutMs,
        maxResponseBytes: config.http.maxResponseBytes,
        allowInsecureLoopback: config.http.allowInsecureLoopback,
        allowedCaptureRoots: config.http.artifactAllowedCaptureRoots,
        allowedMaterializeRoots: config.http.artifactAllowedMaterializeRoots,
        maxTransferFiles: config.http.artifactMaxFiles,
        maxTransferBytes: config.http.artifactMaxBytes,
        resolveSecret: async () => (await credentials.resolve(ref))?.value,
      })
      ctx.effect(() => graphArtifacts.register(artifactProvider), 'graph-worker-remote: HTTP artifact provider registration')
    }
    if (config.http.schedulerProviderName) {
      const graphScheduler: GraphSchedulerRuntime | undefined = ctx.get('graphScheduler')
      if (graphScheduler === undefined) throw new Error('graph-worker-remote HTTP scheduler route requires ctx.graphScheduler')
      const schedulerProvider = new HttpGraphSchedulerProvider({
        providerName: config.http.schedulerProviderName,
        endpoint: config.http.endpoint,
        principal: GraphWorkerRemotePrincipalId(config.http.principal),
        audience: GraphWorkerRemoteAudienceId(config.http.audience),
        requestTimeoutMs: config.http.requestTimeoutMs,
        maxResponseBytes: config.http.maxResponseBytes,
        allowInsecureLoopback: config.http.allowInsecureLoopback,
        resolveSecret: async () => (await credentials.resolve(ref))?.value,
      })
      ctx.effect(() => graphScheduler.register(schedulerProvider), 'graph-worker-remote: HTTP scheduler provider registration')
    }
    return
  }
  if (mode === 'both') throw new Error('graph-worker-remote both mode requires outbound http configuration')
  if (!config.subagentProvider.trim()) throw new Error('graph-worker-remote subagentProvider must be non-empty')
  const subagents = ctx.get('subagents')
  if (subagents === undefined) throw new Error('graph-worker-remote subagent mode requires ctx.subagents')
  const artifacts = config.artifactProvider === undefined ? undefined : ctx.get('graphArtifacts')
  if (config.artifactProvider !== undefined && artifacts === undefined) throw new Error('graph-worker-remote artifactProvider requires ctx.graphArtifacts')
  const provider = new RemoteGraphWorkerProvider(config.providerName, subagents, config, artifacts)
  ctx.effect(() => ctx.graphWorkers.register(provider), 'graph-worker-remote: provider registration')
}
