/** Authenticated HTTP client implementation of the remote Graph Worker Provider. @module */

import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import {
  GraphAttemptId,
  GraphControlOperationId,
  GraphRunGenerationId,
  GraphRunId,
  GraphWorkId,
} from '@deepseek-ai/dsh-graph'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import {
  GraphArtifactManifestId,
  GraphWorkerId,
  GraphWorkspaceAllocationId,
  type GraphArtifactManifest,
  type GraphWorkerAssignment,
  type GraphWorkerCapabilities,
  type GraphWorkerProvider,
  type GraphWorkerReconcileRequest,
  type GraphWorkerReconcileResult,
  type GraphWorkerResult,
  type GraphWorkerRun,
  type GraphWorkspaceAllocation,
  type GraphWorkspaceMode,
} from '@deepseek-ai/dsh-graph-worker'
import {
  GraphWorkerRemoteJobId,
  type GraphWorkerRemoteAudienceId,
  type GraphWorkerRemotePrincipalId,
} from './wire.ts'
import {
  AuthenticatedGraphHttpTransport,
  GraphHttpError,
  type GraphHttpFetch,
} from './http-transport.ts'

/** Deployment policy for one authenticated remote Worker HTTP route. */
export interface HttpGraphWorkerOptions {
  readonly providerName: string
  /** HTTPS endpoint prefix; loopback HTTP requires explicit development opt-in. */
  readonly endpoint: string
  readonly principal: GraphWorkerRemotePrincipalId
  readonly audience: GraphWorkerRemoteAudienceId
  readonly workspaceModes: readonly GraphWorkspaceMode[]
  /** Resolve the current shared secret once for every HTTP operation. */
  readonly resolveSecret: () => Promise<string | undefined>
  readonly pollIntervalMs: number
  /** Total idempotent start attempts using the same fenced assignment. */
  readonly startAttempts: number
  readonly maxPollFailures: number
  readonly requestTimeoutMs: number
  readonly maxResponseBytes: number
  readonly allowInsecureLoopback: boolean
  /** Injectable transport used by deterministic tests. */
  readonly fetcher?: GraphHttpFetch
}

const nonEmpty = z.string().min(1).max(4_000)
const safeNonNegative = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const safePositive = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
const workspaceMode = z.enum(['read-only-snapshot', 'isolated-copy', 'git-worktree', 'sandbox-mount', 'shared'])

const workspaceSchema = z.object({
  id: nonEmpty,
  mode: workspaceMode,
  root: nonEmpty,
  providerReference: nonEmpty,
  createdAt: safeNonNegative,
  sourceRevision: z.string().max(4_000).optional(),
  baseContentHash: z.string().max(4_000).optional(),
}).strict()

type WireContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'reasoning'; readonly text: string }
  | { readonly type: 'image'; readonly attachment: { readonly attachmentId: string; readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; readonly bytes: number; readonly width: number; readonly height: number; readonly name?: string | undefined } }
  | { readonly type: 'tool-call'; readonly id: string; readonly name: string; readonly arguments: string }

const contentBlockSchema: z.ZodType<WireContentBlock> = z.lazy(() => z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }).strict(),
  z.object({ type: z.literal('reasoning'), text: z.string() }).strict(),
  z.object({
    type: z.literal('image'),
    attachment: z.object({
      attachmentId: nonEmpty,
      mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
      bytes: safeNonNegative,
      width: safePositive,
      height: safePositive,
      name: z.string().max(1_000).optional(),
    }).strict(),
  }).strict(),
  z.object({ type: z.literal('tool-call'), id: nonEmpty, name: nonEmpty, arguments: z.string() }).strict(),
]))

const artifactManifestSchema = z.object({
  id: nonEmpty,
  algorithm: z.literal('sha256'),
  provider: nonEmpty,
  workId: nonEmpty,
  operationId: nonEmpty,
  attemptId: nonEmpty,
  runId: nonEmpty,
  generationId: nonEmpty,
  ownerEpoch: safePositive,
  fencingToken: safePositive,
  createdAt: safeNonNegative,
  totalBytes: safeNonNegative,
  entries: z.array(z.object({
    path: nonEmpty,
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    baseSha256: z.string().regex(/^[a-f0-9]{64}$/u).nullable().optional(),
    size: safeNonNegative,
    mode: safeNonNegative,
    kind: z.enum(['file', 'symlink']),
  }).strict()),
  providerReference: nonEmpty,
}).strict()

const resultSchema = z.object({
  outcome: z.enum(['completed', 'aborted', 'error', 'max-tokens', 'stalled', 'capacity', 'oom', 'unavailable']),
  output: z.array(contentBlockSchema),
  structured: z.unknown().optional(),
  childSessionId: z.string().min(1).max(1_000).optional(),
  artifactManifest: artifactManifestSchema.optional(),
  error: z.object({
    code: nonEmpty,
    message: z.string().min(1).max(4_000),
    retryable: z.boolean().optional(),
    retryAfterMs: safePositive.optional(),
  }).strict().optional(),
}).strict()

const startResponseSchema = z.object({
  protocolVersion: z.literal(1),
  jobId: z.string().min(1).max(512),
  workerId: nonEmpty,
  workspace: workspaceSchema,
}).strict()

const observeResponseSchema = z.discriminatedUnion('state', [
  z.object({ protocolVersion: z.literal(1), state: z.literal('running') }).strict(),
  z.object({ protocolVersion: z.literal(1), state: z.literal('terminal'), result: resultSchema }).strict(),
])

const acknowledgmentSchema = z.object({ protocolVersion: z.literal(1), accepted: z.literal(true) }).strict()
const reconcileResponseSchema = z.object({
  protocolVersion: z.literal(1),
  status: z.enum(['canceled', 'deleted', 'retained', 'absent', 'quarantined']),
  evidence: z.string().min(1).max(4_000),
}).strict()

function validateOptions(options: HttpGraphWorkerOptions): void {
  if (!options.providerName.trim()) throw new Error('HTTP graph worker providerName must be non-empty')
  if (options.workspaceModes.length === 0 || new Set(options.workspaceModes).size !== options.workspaceModes.length) {
    throw new Error('HTTP graph worker workspaceModes must contain unique supported modes')
  }
  if (!Number.isSafeInteger(options.pollIntervalMs) || options.pollIntervalMs < 1) throw new Error('HTTP graph worker pollIntervalMs must be positive')
  if (!Number.isSafeInteger(options.startAttempts) || options.startAttempts < 1) throw new Error('HTTP graph worker startAttempts must be positive')
  if (!Number.isSafeInteger(options.maxPollFailures) || options.maxPollFailures < 0) throw new Error('HTTP graph worker maxPollFailures must be non-negative')
  if (!Number.isSafeInteger(options.requestTimeoutMs) || options.requestTimeoutMs < 1) throw new Error('HTTP graph worker requestTimeoutMs must be positive')
  if (!Number.isSafeInteger(options.maxResponseBytes) || options.maxResponseBytes < 1) throw new Error('HTTP graph worker maxResponseBytes must be positive')
}

function authority(assignment: GraphWorkerAssignment, jobId: GraphWorkerRemoteJobId): object {
  return {
    protocolVersion: 1,
    jobId,
    workId: assignment.workId,
    operationId: assignment.operationId,
    attemptId: assignment.attemptId,
    runId: assignment.runId,
    generationId: assignment.generationId,
    ownerEpoch: assignment.ownerEpoch,
    fencingToken: assignment.fencingToken,
  }
}

function wireAssignment(assignment: GraphWorkerAssignment): object {
  const { parent: _parent, signal: _signal, ...serializable } = assignment
  return serializable
}

function workspace(value: z.infer<typeof workspaceSchema>): GraphWorkspaceAllocation {
  return {
    id: GraphWorkspaceAllocationId(value.id),
    mode: value.mode,
    root: value.root,
    providerReference: value.providerReference,
    createdAt: value.createdAt,
    ...value.sourceRevision === undefined ? {} : { sourceRevision: value.sourceRevision },
    ...value.baseContentHash === undefined ? {} : { baseContentHash: value.baseContentHash },
  }
}

function contentBlock(value: z.infer<typeof contentBlockSchema>): ContentBlock {
  switch (value.type) {
    case 'text':
    case 'reasoning':
      return value
    case 'image':
      return {
        type: 'image',
        attachment: {
          attachmentId: brandString<Extract<ContentBlock, { type: 'image' }>['attachment']['attachmentId']>(value.attachment.attachmentId),
          mediaType: value.attachment.mediaType,
          bytes: value.attachment.bytes,
          width: value.attachment.width,
          height: value.attachment.height,
          ...(value.attachment.name === undefined ? {} : { name: value.attachment.name }),
        },
      }
    case 'tool-call':
      return {
        ...value,
        id: brandString<Extract<ContentBlock, { type: 'tool-call' }>['id']>(value.id),
      }
  }
}

function artifactManifest(value: z.infer<typeof artifactManifestSchema>): GraphArtifactManifest {
  return {
    ...value,
    id: GraphArtifactManifestId(value.id),
    workId: GraphWorkId(value.workId),
    operationId: GraphControlOperationId(value.operationId),
    attemptId: GraphAttemptId(value.attemptId),
    runId: GraphRunId(value.runId),
    generationId: GraphRunGenerationId(value.generationId),
    entries: value.entries.map(({ baseSha256, ...entry }) => ({
      ...entry,
      ...baseSha256 === undefined ? {} : { baseSha256 },
    })),
  }
}

function result(value: z.infer<typeof resultSchema>): GraphWorkerResult {
  return {
    outcome: value.outcome,
    output: value.output.map(contentBlock),
    ...(value.structured === undefined ? {} : { structured: value.structured }),
    ...(value.childSessionId === undefined ? {} : { childSessionId: value.childSessionId }),
    ...(value.artifactManifest === undefined ? {} : { artifactManifest: artifactManifest(value.artifactManifest) }),
    ...(value.error === undefined ? {} : {
      error: {
        code: value.error.code,
        message: value.error.message,
        ...(value.error.retryable === undefined ? {} : { retryable: value.error.retryable }),
        ...(value.error.retryAfterMs === undefined ? {} : { retryAfterMs: value.error.retryAfterMs }),
      },
    }),
  }
}

function abortError(signal: AbortSignal, fallback: string): Error {
  return signal.reason instanceof Error ? signal.reason : new Error(fallback, { cause: signal.reason })
}

async function wait(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  await new Promise<void>((resolveWait, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(abortError(signal, 'remote Graph Worker wait aborted'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolveWait()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** Authenticated polling Graph Worker Provider over one HTTPS endpoint. */
export class HttpGraphWorkerProvider implements GraphWorkerProvider {
  readonly name: string
  readonly capabilities: GraphWorkerCapabilities
  private readonly transport: AuthenticatedGraphHttpTransport

  /**
   * Create a remote Provider from explicit deployment and transport policy.
   * @param options - endpoint, identities, secret resolver, capabilities, and bounds.
   */
  constructor(private readonly options: HttpGraphWorkerOptions) {
    validateOptions(options)
    this.name = options.providerName
    this.transport = new AuthenticatedGraphHttpTransport(options)
    this.capabilities = {
      protocolVersion: 1,
      remote: true,
      workspaceModes: [...options.workspaceModes],
      structuredOutput: true,
      toolFilter: true,
      artifactManifest: true,
      progress: false,
      cancellation: true,
    }
  }

  /** Accept one fenced assignment and publish its remote job handle. */
  async start(assignment: GraphWorkerAssignment): Promise<GraphWorkerRun> {
    const payload = { protocolVersion: 1, assignment: wireAssignment(assignment) }
    const parsed = await this.startRemote(payload, assignment.signal)
    const jobId = GraphWorkerRemoteJobId(parsed.jobId)
    const allocation = workspace(parsed.workspace)
    if (allocation.mode !== assignment.workspace.mode) throw new Error('remote Graph Worker returned a different workspace mode')
    let cancelFailure: unknown
    const localStop = new AbortController()
    let cancellation: Promise<void> | undefined
    const cancel = (reason: string, signal: AbortSignal): Promise<void> => {
      signal.throwIfAborted()
      if (!reason.trim()) throw new Error('graph worker cancellation reason must be non-empty')
      if (cancellation !== undefined) return cancellation
      cancellation = this.cancelRemote(assignment, jobId, reason, signal).then(() => {
        localStop.abort(new Error(reason))
      }, (error: unknown) => {
        cancelFailure = error
        localStop.abort(error)
        cancellation = undefined
        throw error
      })
      return cancellation
    }
    const onAssignmentAbort = (): void => {
      const reason = abortError(assignment.signal, 'graph worker assignment aborted').message
      void cancel(reason, AbortSignal.timeout(this.options.requestTimeoutMs)).catch(() => {})
    }
    assignment.signal.addEventListener('abort', onAssignmentAbort, { once: true })
    if (assignment.signal.aborted) onAssignmentAbort()
    const observed = this.observeUntilTerminal(assignment, jobId, localStop.signal).catch((error: unknown): GraphWorkerResult => ({
      outcome: cancelFailure === undefined && localStop.signal.aborted ? 'aborted' : 'unavailable',
      output: [],
      error: {
        code: cancelFailure === undefined && localStop.signal.aborted ? 'GRAPH_WORKER_REMOTE_ABORTED' : 'GRAPH_WORKER_REMOTE_TRANSPORT',
        message: error instanceof Error ? error.message : String(error),
      },
    })).finally(() => {
      assignment.signal.removeEventListener('abort', onAssignmentAbort)
    })
    return {
      id: GraphWorkerId(parsed.workerId),
      provider: this.name,
      workspace: allocation,
      result: observed,
      cancel,
    }
  }

  /** Reconcile one exact remote Worker reference without redispatching work. */
  async reconcile(request: GraphWorkerReconcileRequest, signal: AbortSignal): Promise<GraphWorkerReconcileResult> {
    const parsed = reconcileResponseSchema.parse(await this.post('reconcile', { protocolVersion: 1, request }, signal))
    return { status: parsed.status, evidence: parsed.evidence }
  }

  private async cancelRemote(
    assignment: GraphWorkerAssignment,
    jobId: GraphWorkerRemoteJobId,
    reason: string,
    signal: AbortSignal,
  ): Promise<void> {
    acknowledgmentSchema.parse(await this.post('cancel', { ...authority(assignment, jobId), reason }, signal))
  }

  private async observeUntilTerminal(
    assignment: GraphWorkerAssignment,
    jobId: GraphWorkerRemoteJobId,
    signal: AbortSignal,
  ): Promise<GraphWorkerResult> {
    let failures = 0
    while (true) {
      signal.throwIfAborted()
      if (Date.now() >= assignment.deadline) throw new Error('remote Graph Worker assignment deadline elapsed')
      try {
        const parsed = observeResponseSchema.parse(await this.post('observe', authority(assignment, jobId), signal))
        failures = 0
        if (parsed.state === 'terminal') return result(parsed.result)
      } catch (error) {
        signal.throwIfAborted()
        if (!(error instanceof GraphHttpError) || !error.retryable) throw error
        failures += 1
        if (failures > this.options.maxPollFailures) throw error
      }
      await wait(Math.min(this.options.pollIntervalMs, Math.max(1, assignment.deadline - Date.now())), signal)
    }
  }

  private async startRemote(payload: object, signal: AbortSignal): Promise<z.infer<typeof startResponseSchema>> {
    let failure: GraphHttpError | undefined
    for (let attempt = 1; attempt <= this.options.startAttempts; attempt += 1) {
      try {
        return startResponseSchema.parse(await this.post('start', payload, signal))
      } catch (error) {
        signal.throwIfAborted()
        if (!(error instanceof GraphHttpError) || !error.retryable) throw error
        failure = error
        if (attempt < this.options.startAttempts) await wait(this.options.pollIntervalMs, signal)
      }
    }
    throw failure ?? new Error('remote Graph Worker start exhausted without an attempt')
  }

  private async post(operation: 'start' | 'observe' | 'cancel' | 'reconcile', payload: object, signal: AbortSignal): Promise<unknown> {
    return this.transport.post(`/v1/${operation}`, payload, signal)
  }
}
