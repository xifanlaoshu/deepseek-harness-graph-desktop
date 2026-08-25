/** Service Definition for local and remote Graph Worker providers. @module @deepseek-ai/dsh-graph-worker */

import { posix } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type {
  GraphAttemptId,
  GraphControlOperationId,
  GraphNode,
  GraphNodeExecutionBudget,
  GraphRole,
  GraphRunGenerationId,
  GraphRunId,
  GraphWorkId,
} from '@deepseek-ai/dsh-graph'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ObjectJsonSchema, ToolRestriction } from '@deepseek-ai/dsh-tools'

declare module '@deepseek-ai/cordis' {
  interface Context {
    graphWorkers: GraphWorkerRuntime
  }
}

/** Stable identity of one registered execution worker. */
export type GraphWorkerId = Branded<'GraphWorkerId'>
/** Stable identity of one provider-owned workspace allocation. */
export type GraphWorkspaceAllocationId = Branded<'GraphWorkspaceAllocationId'>
/** Stable identity of one provider-owned artifact manifest. */
export type GraphArtifactManifestId = Branded<'GraphArtifactManifestId'>

/**
 * Brand one validated worker identity.
 * @param value validated worker identity text.
 * @returns branded worker identity.
 */
export const GraphWorkerId = (value: string): GraphWorkerId => value as GraphWorkerId
/**
 * Brand one validated workspace-allocation identity.
 * @param value validated workspace-allocation identity text.
 * @returns branded workspace-allocation identity.
 */
export const GraphWorkspaceAllocationId = (value: string): GraphWorkspaceAllocationId => value as GraphWorkspaceAllocationId
/**
 * Brand one validated artifact-manifest identity.
 * @param value validated artifact-manifest identity text.
 * @returns branded artifact-manifest identity.
 */
export const GraphArtifactManifestId = (value: string): GraphArtifactManifestId => value as GraphArtifactManifestId

/** Workspace guarantees requested for one physical attempt. */
export type GraphWorkspaceMode = 'read-only-snapshot' | 'isolated-copy' | 'git-worktree' | 'sandbox-mount' | 'shared'

/** Immutable workspace and path-ownership request resolved before dispatch. */
export interface GraphWorkspaceRequest {
  readonly mode: GraphWorkspaceMode
  /** Absolute source workspace in the provider's execution world. */
  readonly sourceRoot: string
  /** Normalized source-relative roots the worker may read. */
  readonly readRoots: readonly string[]
  /** Normalized source-relative roots the worker may mutate. */
  readonly writeRoots: readonly string[]
  readonly cleanup: 'delete-on-settlement' | 'retain-on-failure' | 'retain'
  readonly sourceRevision?: string
  readonly baseContentHash?: string
}

/** Provider-owned workspace fact exposed for recovery and evidence. */
export interface GraphWorkspaceAllocation {
  readonly id: GraphWorkspaceAllocationId
  readonly mode: GraphWorkspaceMode
  /** Absolute working directory used by the worker; never model-visible by default. */
  readonly root: string
  readonly providerReference: string
  readonly createdAt: number
  readonly sourceRevision?: string
  readonly baseContentHash?: string
}

/** One content-addressed file produced by a worker. */
export interface GraphArtifactEntry {
  readonly path: string
  readonly sha256: string
  /** Content hash copied from the source workspace, or null when the file was newly created. */
  readonly baseSha256?: string | null
  readonly size: number
  readonly mode: number
  readonly kind: 'file' | 'symlink'
}

/** Immutable fenced identity shared by an artifact capture and its producing attempt. */
export interface GraphArtifactAttribution {
  readonly workId: GraphWorkId
  readonly operationId: GraphControlOperationId
  readonly attemptId: GraphAttemptId
  readonly runId: GraphRunId
  readonly generationId: GraphRunGenerationId
  readonly ownerEpoch: number
  readonly fencingToken: number
}

/** Bounded provider-staged artifacts attributable to one exact attempt. */
export interface GraphArtifactManifest extends GraphArtifactAttribution {
  readonly id: GraphArtifactManifestId
  readonly algorithm: 'sha256'
  /** Artifact Provider that owns capture, materialization, and reconciliation. */
  readonly provider: string
  readonly createdAt: number
  readonly totalBytes: number
  readonly entries: readonly GraphArtifactEntry[]
  readonly providerReference: string
}

const safeArtifactPath = (value: string): boolean => {
  if (!value || value.includes('\\')) return false
  const normalized = posix.normalize(value)
  return normalized === value && normalized !== '.' && normalized !== '..' && !normalized.startsWith('../') && !normalized.startsWith('/')
}

/**
 * Validate one provider-published manifest against its immutable assignment.
 * @param manifest provider-published content-addressed artifact evidence.
 * @param assignment exact fenced physical attempt that produced the evidence.
 */
export function validateGraphArtifactManifest(manifest: GraphArtifactManifest, assignment: GraphArtifactAttribution): void {
  if (!String(manifest.id).trim()) throw new Error('graph artifact manifest id must be non-empty')
  if (!manifest.provider.trim()) throw new Error('graph artifact manifest provider must be non-empty')
  if (manifest.workId !== assignment.workId
    || manifest.operationId !== assignment.operationId
    || manifest.attemptId !== assignment.attemptId
    || manifest.runId !== assignment.runId
    || manifest.generationId !== assignment.generationId
    || manifest.ownerEpoch !== assignment.ownerEpoch
    || manifest.fencingToken !== assignment.fencingToken) {
    throw new Error('graph artifact manifest belongs to a different fenced attempt')
  }
  if (!Number.isSafeInteger(manifest.createdAt) || manifest.createdAt < 0) throw new Error('graph artifact manifest createdAt must be a non-negative safe integer')
  if (!Number.isSafeInteger(manifest.totalBytes) || manifest.totalBytes < 0) throw new Error('graph artifact manifest totalBytes must be a non-negative safe integer')
  if (!manifest.providerReference.trim() || manifest.providerReference.length > 4_000) throw new Error('graph artifact manifest providerReference must be bounded non-empty text')
  let totalBytes = 0
  let previousPath: string | undefined
  for (const entry of manifest.entries) {
    if (!safeArtifactPath(entry.path)) throw new Error(`graph artifact path is not normalized and source-relative: ${entry.path}`)
    if (previousPath !== undefined && previousPath.localeCompare(entry.path) >= 0) throw new Error('graph artifact entries must have unique paths in lexical order')
    previousPath = entry.path
    if (!/^[a-f0-9]{64}$/u.test(entry.sha256)) throw new Error(`graph artifact ${entry.path} has an invalid sha256`)
    if (entry.baseSha256 !== undefined && entry.baseSha256 !== null && !/^[a-f0-9]{64}$/u.test(entry.baseSha256)) {
      throw new Error(`graph artifact ${entry.path} has an invalid base sha256`)
    }
    if (!Number.isSafeInteger(entry.size) || entry.size < 0) throw new Error(`graph artifact ${entry.path} has an invalid size`)
    if (!Number.isSafeInteger(entry.mode) || entry.mode < 0 || entry.mode > 0xffff) throw new Error(`graph artifact ${entry.path} has an invalid mode`)
    totalBytes += entry.size
    if (!Number.isSafeInteger(totalBytes)) throw new Error('graph artifact manifest total size exceeds the safe integer range')
  }
  if (manifest.totalBytes !== totalBytes) throw new Error('graph artifact manifest totalBytes does not match its entries')
}

/** Features a Worker Provider can honor for an assignment. */
export interface GraphWorkerCapabilities {
  readonly protocolVersion: 1
  readonly remote: boolean
  readonly workspaceModes: readonly GraphWorkspaceMode[]
  readonly structuredOutput: boolean
  readonly toolFilter: boolean
  readonly artifactManifest: boolean
  readonly progress: boolean
  readonly cancellation: boolean
}

/** Fully resolved immutable work sent to one provider. */
export interface GraphWorkerAssignment {
  readonly protocolVersion: 1
  readonly workId: GraphWorkId
  readonly operationId: GraphControlOperationId
  readonly attemptId: GraphAttemptId
  /** Zero for the initial child, then one-based same-attempt continuations. */
  readonly activation: number
  readonly runId: GraphRunId
  readonly generationId: GraphRunGenerationId
  readonly ownerEpoch: number
  readonly fencingToken: number
  /** Live delegating Agent used only by same-process Worker Providers. */
  readonly parent: Agent
  readonly node: GraphNode
  readonly role: GraphRole
  readonly prompt: readonly ContentBlock[]
  readonly outputSchema: ObjectJsonSchema
  /** Resolved limits enforced by the Provider for this activation. */
  readonly budget: GraphNodeExecutionBudget
  readonly workspace: GraphWorkspaceRequest
  readonly deadline: number
  readonly signal: AbortSignal
  readonly toolFilter?: ToolRestriction
}

/** Provider-neutral terminal worker classification. */
export type GraphWorkerOutcome = 'completed' | 'aborted' | 'error' | 'max-tokens' | 'stalled' | 'capacity' | 'oom' | 'unavailable'

/** Terminal result of one exact physical worker attempt. */
export interface GraphWorkerResult {
  readonly outcome: GraphWorkerOutcome
  readonly output: readonly ContentBlock[]
  readonly structured?: unknown
  readonly childSessionId?: string
  readonly artifactManifest?: GraphArtifactManifest
  readonly error?: {
    readonly code: string
    readonly message: string
    /** Whether dispatching the unchanged logical node may succeed. Defaults to true when absent. */
    readonly retryable?: boolean
    readonly retryAfterMs?: number
  }
}

/** Published worker ownership returned after assignment has been accepted. */
export interface GraphWorkerRun {
  readonly id: GraphWorkerId
  readonly provider: string
  readonly workspace: GraphWorkspaceAllocation
  /** Published child session identity when the Provider is session-backed. */
  readonly childSessionId?: string
  readonly result: Promise<GraphWorkerResult>
  /** Request cooperative cancellation and wait until the provider has accepted the request. */
  cancel(reason: string, signal: AbortSignal): Promise<void>
}

/** Exact provider-owned Worker and workspace references inspected during recovery. */
export interface GraphWorkerReconcileRequest {
  readonly protocolVersion: 1
  readonly workId: GraphWorkId
  readonly operationId: GraphControlOperationId
  readonly runId: GraphRunId
  readonly generationId: GraphRunGenerationId
  readonly ownerEpoch: number
  readonly workerId: GraphWorkerId
  readonly workspaceId: GraphWorkspaceAllocationId
  readonly workspaceMode: GraphWorkspaceMode
  readonly cleanup: GraphWorkspaceRequest['cleanup']
  /** Authorizes deletion only when the scheduler proved replay is idempotent and no output was staged. */
  readonly safeToDelete: boolean
}

/** Auditable disposition of one provider-owned recovery reference. */
export interface GraphWorkerReconcileResult {
  readonly status: 'canceled' | 'deleted' | 'retained' | 'absent' | 'quarantined'
  readonly evidence: string
}

/** Named local or remote Worker Provider. */
export interface GraphWorkerProvider {
  readonly name: string
  readonly capabilities: GraphWorkerCapabilities
  /** Accept one fenced assignment and publish its owned run. */
  start(assignment: GraphWorkerAssignment): Promise<GraphWorkerRun>
  /** Reconcile one exact prior Worker and workspace without redispatching it. */
  reconcile(request: GraphWorkerReconcileRequest, signal: AbortSignal): Promise<GraphWorkerReconcileResult>
}

/** Provider registry and capability-validating assignment Consumer API. */
export class GraphWorkerRuntime extends Service {
  private readonly providers = new Map<string, GraphWorkerProvider>()

  constructor(ctx: Context) {
    super(ctx, 'graphWorkers')
  }

  /**
   * Register one unique provider until the returned disposer runs.
   * @param provider named Worker implementation and advertised capabilities.
   * @returns disposer that removes only this registration.
   */
  register(provider: GraphWorkerProvider): () => void {
    if (!provider.name.trim()) throw new Error('graph worker provider name must be non-empty')
    if (provider.capabilities.workspaceModes.length === 0) throw new Error(`graph worker provider ${provider.name} must support at least one workspace mode`)
    if (new Set(provider.capabilities.workspaceModes).size !== provider.capabilities.workspaceModes.length) {
      throw new Error(`graph worker provider ${provider.name} repeats a workspace mode`)
    }
    if (this.providers.has(provider.name)) throw new Error(`graph worker provider ${provider.name} is already registered`)
    this.providers.set(provider.name, provider)
    return () => {
      if (this.providers.get(provider.name) === provider) this.providers.delete(provider.name)
    }
  }

  /**
   * Return detached descriptors for deployment inspection and scheduler selection.
   * @returns registered provider names and copied capability declarations.
   */
  list(): readonly { readonly name: string; readonly capabilities: GraphWorkerCapabilities }[] {
    return [...this.providers.values()].map(provider => ({
      name: provider.name,
      capabilities: { ...provider.capabilities, workspaceModes: [...provider.capabilities.workspaceModes] },
    }))
  }

  /**
   * Validate requirements and assign work to one exact provider.
   * @param name registered Worker Provider name.
   * @param assignment frozen fenced node attempt.
   * @returns published worker, workspace, result, and cancellation handle.
   */
  async start(name: string, assignment: GraphWorkerAssignment): Promise<GraphWorkerRun> {
    const provider = this.providers.get(name)
    if (provider === undefined) throw new Error(`unknown graph worker provider ${name}`)
    assignment.signal.throwIfAborted()
    if (!Number.isSafeInteger(assignment.activation) || assignment.activation < 0) throw new Error('graph worker activation must be a non-negative safe integer')
    if (!Number.isSafeInteger(assignment.ownerEpoch) || assignment.ownerEpoch < 1) throw new Error('graph worker ownerEpoch must be a positive safe integer')
    if (!Number.isSafeInteger(assignment.fencingToken) || assignment.fencingToken < 1) throw new Error('graph worker fencingToken must be a positive safe integer')
    if (!Number.isSafeInteger(assignment.deadline) || assignment.deadline <= Date.now()) throw new Error('graph worker assignment deadline must be in the future')
    for (const [name, value] of Object.entries(assignment.budget)) {
      const minimum = name === 'maxContinuations' ? 0 : 1
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) throw new Error(`graph worker budget ${name} must be a ${minimum === 0 ? 'non-negative' : 'positive'} safe integer`)
    }
    if (!provider.capabilities.workspaceModes.includes(assignment.workspace.mode)) {
      throw new Error(`graph worker provider ${name} does not support workspace mode ${assignment.workspace.mode}`)
    }
    if (!provider.capabilities.structuredOutput) throw new Error(`graph worker provider ${name} does not support structured output`)
    if (assignment.toolFilter !== undefined && !provider.capabilities.toolFilter) {
      throw new Error(`graph worker provider ${name} does not support tool filtering`)
    }
    const run = await provider.start(assignment)
    if (run.provider !== name) throw new Error(`graph worker provider ${name} published run for ${run.provider}`)
    return {
      ...run,
      result: run.result.then((result) => {
        if (result.artifactManifest !== undefined) {
          if (!provider.capabilities.artifactManifest) throw new Error(`graph worker provider ${name} published an unsupported artifact manifest`)
          validateGraphArtifactManifest(result.artifactManifest, assignment)
        }
        return result
      }),
    }
  }

  /**
   * Reconcile one provider-owned Worker and workspace after scheduler recovery.
   * @param name registered Worker Provider name.
   * @param request exact prior work and allocation references plus deletion authority.
   * @param signal caller cancellation independent from the abandoned Worker signal.
   * @returns validated provider disposition and bounded evidence.
   */
  async reconcile(name: string, request: GraphWorkerReconcileRequest, signal: AbortSignal): Promise<GraphWorkerReconcileResult> {
    const provider = this.providers.get(name)
    if (provider === undefined) throw new Error(`unknown graph worker provider ${name}`)
    signal.throwIfAborted()
    if (!Number.isSafeInteger(request.ownerEpoch) || request.ownerEpoch < 1) throw new Error('graph worker reconcile ownerEpoch must be positive')
    const result = await provider.reconcile(request, signal)
    if (!result.evidence.trim() || result.evidence.length > 4_000) throw new Error(`graph worker provider ${name} returned invalid reconcile evidence`)
    return result
  }
}

export default GraphWorkerRuntime
