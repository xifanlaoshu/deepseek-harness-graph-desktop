/** Provider-neutral content-addressed artifact transport for Graph workers. @module @deepseek-ai/dsh-graph-artifacts */

import { Context, Service } from '@deepseek-ai/cordis'
import {
  validateGraphArtifactManifest,
  type GraphArtifactAttribution,
  type GraphArtifactManifest,
  type GraphArtifactManifestId,
  type GraphWorkspaceAllocationId,
} from '@deepseek-ai/dsh-graph-worker'

declare module '@deepseek-ai/cordis' {
  interface Context {
    graphArtifacts: GraphArtifactRuntime
  }
}

/** Immutable source and bounds for one attempt-owned artifact capture. */
export interface GraphArtifactCaptureRequest extends GraphArtifactAttribution {
  readonly workspaceId: GraphWorkspaceAllocationId
  /** Absolute workspace path in the selected Provider's execution world. */
  readonly sourceRoot: string
  readonly workspaceReference: string
  /** Untrusted source-relative files or directories selected by structured Worker output. */
  readonly paths: readonly string[]
  /** Optional source hashes for optimistic conflict detection during later integration. */
  readonly baseContentHashes?: Readonly<Record<string, string | null>>
  readonly maxFiles: number
  readonly maxBytes: number
  readonly deadline: number
  readonly signal: AbortSignal
}

/** Explicit import of one immutable manifest into an existing target workspace. */
export interface GraphArtifactMaterializeRequest {
  readonly manifest: GraphArtifactManifest
  /** Absolute target path in the selected Provider's execution world. */
  readonly targetRoot: string
  readonly overwrite: 'forbid' | 'replace'
  readonly signal: AbortSignal
}

/** Files written by a completed materialization. */
export interface GraphArtifactMaterializeResult {
  readonly paths: readonly string[]
  readonly totalBytes: number
}

/** Recovery request for one exact provider-owned manifest reference. */
export interface GraphArtifactReconcileRequest {
  readonly manifestId: GraphArtifactManifestId
  readonly providerReference: string
  /** Authorizes manifest deletion only after Graph proves no committed output refers to it. */
  readonly safeToDelete: boolean
  readonly signal: AbortSignal
}

/** Auditable disposition of one artifact reference during recovery. */
export interface GraphArtifactReconcileResult {
  readonly status: 'deleted' | 'retained' | 'absent' | 'quarantined'
  readonly evidence: string
}

/** One authenticated storage or transport implementation. */
export interface GraphArtifactProvider {
  readonly name: string
  readonly persistent: boolean
  readonly remote: boolean
  capture(request: GraphArtifactCaptureRequest): Promise<GraphArtifactManifest>
  materialize(request: GraphArtifactMaterializeRequest): Promise<GraphArtifactMaterializeResult>
  reconcile(request: GraphArtifactReconcileRequest): Promise<GraphArtifactReconcileResult>
}

const positiveLimit = (value: number, label: string): void => {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive safe integer`)
}

/** Registry, validation, and dispatch for Graph artifact Providers. */
export class GraphArtifactRuntime extends Service {
  private readonly providers = new Map<string, GraphArtifactProvider>()

  constructor(ctx: Context) {
    super(ctx, 'graphArtifacts')
  }

  /**
   * Register one unique artifact Provider.
   * @param provider authenticated storage or transport implementation.
   * @returns disposer for only this registration.
   */
  register(provider: GraphArtifactProvider): () => void {
    if (!provider.name.trim()) throw new Error('graph artifact provider name must be non-empty')
    if (this.providers.has(provider.name)) throw new Error(`graph artifact provider ${provider.name} is already registered`)
    this.providers.set(provider.name, provider)
    return () => {
      if (this.providers.get(provider.name) === provider) this.providers.delete(provider.name)
    }
  }

  /**
   * Inspect the registered artifact routes without exposing mutable Provider objects.
   * @returns detached Provider deployment facts.
   */
  list(): readonly { readonly name: string; readonly persistent: boolean; readonly remote: boolean }[] {
    return [...this.providers.values()].map(({ name, persistent, remote }) => ({ name, persistent, remote }))
  }

  /**
   * Capture and validate files produced by one fenced Worker attempt.
   * @param providerName registered transport route.
   * @param request exact attribution, source, selection, and bounds.
   * @returns immutable manifest owned by the selected Provider.
   */
  async capture(providerName: string, request: GraphArtifactCaptureRequest): Promise<GraphArtifactManifest> {
    const provider = this.require(providerName)
    request.signal.throwIfAborted()
    positiveLimit(request.maxFiles, 'graph artifact maxFiles')
    positiveLimit(request.maxBytes, 'graph artifact maxBytes')
    if (!Number.isSafeInteger(request.deadline) || request.deadline <= Date.now()) throw new Error('graph artifact deadline must be in the future')
    if (!request.sourceRoot.trim() || !request.workspaceReference.trim()) throw new Error('graph artifact source references must be non-empty')
    if (request.paths.length > request.maxFiles) throw new Error('graph artifact path selection exceeds maxFiles')
    if (request.baseContentHashes !== undefined && Object.entries(request.baseContentHashes).some(([path, hash]) => (
      !request.paths.includes(path) || (hash !== null && !/^[a-f0-9]{64}$/u.test(hash))
    ))) throw new Error('graph artifact base hashes must name selected paths and contain sha256 values or null')
    const manifest = await provider.capture(request)
    if (manifest.provider !== providerName) throw new Error(`graph artifact provider ${providerName} published a manifest for ${manifest.provider}`)
    validateGraphArtifactManifest(manifest, request)
    if (manifest.entries.length > request.maxFiles || manifest.totalBytes > request.maxBytes) throw new Error('graph artifact Provider exceeded capture bounds')
    return manifest
  }

  /**
   * Materialize a validated immutable manifest into one explicit workspace.
   * @param providerName registered transport route.
   * @param request manifest, target, and overwrite policy.
   * @returns paths and byte count written from the complete manifest.
   */
  async materialize(providerName: string, request: GraphArtifactMaterializeRequest): Promise<GraphArtifactMaterializeResult> {
    const provider = this.require(providerName)
    request.signal.throwIfAborted()
    validateGraphArtifactManifest(request.manifest, request.manifest)
    if (!request.targetRoot.trim()) throw new Error('graph artifact targetRoot must be non-empty')
    const result = await provider.materialize(request)
    if (!Number.isSafeInteger(result.totalBytes) || result.totalBytes !== request.manifest.totalBytes) throw new Error('graph artifact materialization reported an invalid byte count')
    const pathsMatch = result.paths.length === request.manifest.entries.length
      && result.paths.every((path, index) => path === request.manifest.entries[index]?.path)
    if (!pathsMatch) {
      throw new Error('graph artifact materialization did not report the complete manifest in lexical order')
    }
    return result
  }

  /**
   * Reconcile one abandoned provider reference without guessing ownership.
   * @param providerName registered transport route.
   * @param request exact manifest reference and deletion authority.
   * @returns auditable Provider disposition.
   */
  async reconcile(providerName: string, request: GraphArtifactReconcileRequest): Promise<GraphArtifactReconcileResult> {
    const provider = this.require(providerName)
    request.signal.throwIfAborted()
    if (!String(request.manifestId).trim() || !request.providerReference.trim()) throw new Error('graph artifact reconcile references must be non-empty')
    const result = await provider.reconcile(request)
    if (!result.evidence.trim() || result.evidence.length > 4_000) throw new Error('graph artifact reconcile evidence must be bounded non-empty text')
    return result
  }

  private require(name: string): GraphArtifactProvider {
    const provider = this.providers.get(name)
    if (provider === undefined) throw new Error(`unknown graph artifact provider ${name}`)
    return provider
  }
}

export default GraphArtifactRuntime
