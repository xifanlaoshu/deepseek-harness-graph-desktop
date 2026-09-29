/** Durable authenticated HTTP server for remote Graph Worker jobs. @module */

import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, isAbsolute, join, posix, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {
  GraphArtifactCaptureRequest,
  GraphArtifactReconcileRequest,
  GraphArtifactRuntime,
} from '@deepseek-ai/dsh-graph-artifacts'
import {
  GraphAttemptId,
  GraphControlOperationId,
  GraphId,
  GraphNodeId,
  GraphRoleId,
  GraphRunGenerationId,
  GraphRunId,
  GraphWorkId,
  type GraphNode,
} from '@deepseek-ai/dsh-graph'
import {
  GraphArtifactManifestId,
  GraphWorkerId,
  GraphWorkspaceAllocationId,
  type GraphArtifactManifest,
  type GraphWorkerAssignment,
  type GraphWorkerReconcileRequest,
  type GraphWorkerResult,
  type GraphWorkerRun,
  type GraphWorkerRuntime,
  type GraphWorkspaceAllocation,
} from '@deepseek-ai/dsh-graph-worker'
import {
  GraphResourceReservationId,
  type GraphResourceDecision,
  type GraphResourceOutcome,
  type GraphResourceReconcileRequest,
  type GraphResourceReservationRequest,
  type GraphResourceRuntime,
  type GraphResourceSnapshot,
} from '@deepseek-ai/dsh-graph-resources'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import {
  GraphSchedulerLeaseId,
  GraphSchedulerOwnerId,
  type GraphSchedulerAcquireRequest,
  type GraphSchedulerDecision,
  type GraphSchedulerLease,
  type GraphSchedulerLeaseRequest,
  type GraphSchedulerRuntime,
} from '@deepseek-ai/dsh-graph-scheduler'
import { assertObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import {
  GraphWorkerRemoteAudienceId,
  GraphWorkerRemoteJobId,
  GraphWorkerRemotePrincipalId,
  GraphWorkerReplayGuard,
  type GraphWorkerAuthHeaders,
} from './wire.ts'

type WireAssignment = Omit<GraphWorkerAssignment, 'parent' | 'signal'>

function waitFor<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const rejectAborted = (): void => {
      signal.removeEventListener('abort', rejectAborted)
      rejectPromise(signal.reason instanceof Error ? signal.reason : new Error('remote Graph Worker operation aborted'))
    }
    if (signal.aborted) {
      rejectAborted()
      return
    }
    signal.addEventListener('abort', rejectAborted, { once: true })
    void promise.then(
      (value) => {
        signal.removeEventListener('abort', rejectAborted)
        resolvePromise(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', rejectAborted)
        rejectPromise(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

/** Deployment and persistence policy for one HTTP Worker service. */
export interface HttpGraphWorkerServerOptions {
  readonly audience: GraphWorkerRemoteAudienceId
  readonly basePath: string
  readonly journalPath: string
  readonly workerProvider: string
  readonly graphWorkers: Pick<GraphWorkerRuntime, 'start' | 'reconcile'>
  /** Optional cross-Host resource route delegated to one same-process authority. */
  readonly resource?: {
    readonly routeName: string
    readonly providerName: string
    readonly graphResources: Pick<GraphResourceRuntime, 'observe' | 'reserve' | 'report' | 'reconcile'>
  }
  /** Optional cross-Host Artifact route delegated through bounded private staging. */
  readonly artifact?: {
    readonly routeName: string
    readonly providerName: string
    readonly graphArtifacts: Pick<GraphArtifactRuntime, 'capture' | 'materialize' | 'reconcile'>
    readonly tempRoot: string
    readonly maxFiles: number
    readonly maxBytes: number
  }
  /** Optional cross-Host scheduler route delegated to one durable ownership authority. */
  readonly scheduler?: {
    readonly routeName: string
    readonly providerName: string
    readonly graphScheduler: Pick<GraphSchedulerRuntime, 'acquire' | 'heartbeat' | 'release'>
  }
  /** Resolve the current caller secret once per request. */
  readonly resolveSecret: (principal: GraphWorkerRemotePrincipalId) => Promise<string | undefined>
  /** Resolve the live service-owned delegating Agent for a newly accepted job. */
  readonly resolveParent: () => Agent | undefined
  readonly maxClockSkewMs: number
  readonly maxRequestBytes: number
  readonly maxResultBytes: number
  readonly maxReplayEntries: number
  readonly busyTimeoutMs: number
  readonly operationTimeoutMs: number
}

interface JobRow {
  readonly job_id: string
  readonly assignment_hash: string
  readonly state: 'accepted' | 'running' | 'canceling' | 'terminal'
  readonly authority_json: string
  readonly workspace_json: string
  readonly result_json: string | null
  readonly actual_worker_id: string | null
  readonly actual_workspace_json: string | null
  readonly service_epoch: number
}

interface ActiveJob {
  readonly abort: AbortController
  readonly run: GraphWorkerRun
}

interface ArtifactRow {
  readonly manifest_id: string
  readonly public_reference: string
  readonly public_json: string
  readonly internal_json: string
}

const APPLICATION_ID = 0x44534757
const SCHEMA_VERSION = 2
const boundedText = z.string().min(1).max(1_000_000)
const boundedId = z.string().min(1).max(4_000)
const safeNonNegative = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const safePositive = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
const workspaceMode = z.enum(['read-only-snapshot', 'isolated-copy', 'git-worktree', 'sandbox-mount', 'shared'])
const cleanupPolicy = z.enum(['delete-on-settlement', 'retain-on-failure', 'retain'])
const jsonSchema = z.record(z.string(), z.unknown())

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
      attachmentId: boundedId,
      mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
      bytes: safeNonNegative,
      width: safePositive,
      height: safePositive,
      name: z.string().max(1_000).optional(),
    }).strict(),
  }).strict(),
  z.object({ type: z.literal('tool-call'), id: boundedId, name: boundedId, arguments: z.string() }).strict(),
]))

const graphOutputSchema = z.object({
  id: boundedId,
  version: safePositive,
  maxBytes: safePositive,
  schema: jsonSchema,
}).strict()

const executionBudgetSchema = z.object({
  maxOutputTokens: safePositive,
  maxReasoningOnlyTokens: safePositive,
  firstDurableActionMs: safePositive,
  maxNoDurableProgressMs: safePositive,
  checkpointIntervalMs: safePositive,
  maxWallTimeMs: safePositive,
  maxContinuations: safeNonNegative,
}).strict()

const nodeSchema = z.object({
  id: boundedId,
  title: boundedText,
  objective: boundedText,
  kind: z.enum([
    'analysis', 'design', 'implementation', 'review', 'verification', 'documentation', 'integration',
    'specialist', 'expansion', 'subgraph',
  ]),
  roleId: boundedId,
  acceptanceCriteria: z.array(boundedText).min(1),
  outputSchema: graphOutputSchema,
  maxAttempts: safePositive,
  weight: z.number().positive(),
  executionBudget: executionBudgetSchema,
  expansion: z.object({
    mode: z.enum(['controller', 'map']),
    maxNodes: safePositive,
    itemPath: z.array(boundedText).optional(),
    itemKeyPath: z.array(boundedText).optional(),
  }).strict().optional(),
  subgraph: z.object({
    graphId: boundedId,
    revision: safePositive,
    input: z.record(z.string(), z.array(boundedText)),
    output: z.record(z.string(), z.array(boundedText)),
  }).strict().optional(),
  workspace: z.object({
    mode: workspaceMode,
    readRoots: z.array(z.string()),
    writeRoots: z.array(z.string()),
    cleanup: cleanupPolicy,
  }).strict().optional(),
  skippable: z.boolean(),
  effectPolicy: z.enum(['idempotent', 'reconcile', 'manual']),
}).strict()

const roleSchema = z.object({
  id: boundedId,
  label: boundedText,
  description: boundedText,
  controller: z.boolean(),
  enabled: z.boolean(),
  model: z.object({
    provider: boundedId.optional(),
    model: boundedId.optional(),
    reasoningEffort: boundedId.optional(),
  }).strict(),
  prompt: boundedText,
  workerProvider: boundedId.optional(),
  maxParallel: safePositive,
}).strict()

const wireAssignmentSchema = z.object({
  protocolVersion: z.literal(1),
  workId: boundedId,
  operationId: boundedId,
  attemptId: boundedId,
  activation: safeNonNegative,
  runId: boundedId,
  generationId: boundedId,
  ownerEpoch: safePositive,
  fencingToken: safePositive,
  activeSubagentLimit: safePositive.optional(),
  node: nodeSchema,
  role: roleSchema,
  prompt: z.array(contentBlockSchema),
  outputSchema: jsonSchema,
  budget: executionBudgetSchema,
  workspace: z.object({
    mode: workspaceMode,
    sourceRoot: boundedText,
    readRoots: z.array(z.string()),
    writeRoots: z.array(z.string()),
    cleanup: cleanupPolicy,
    sourceRevision: z.string().max(4_000).optional(),
    baseContentHash: z.string().max(4_000).optional(),
  }).strict(),
  deadline: safePositive,
  toolFilter: z.object({ allow: z.array(boundedId).optional(), deny: z.array(boundedId).optional() }).strict().optional(),
}).strict()

const authoritySchema = z.object({
  protocolVersion: z.literal(1),
  jobId: z.string().min(1).max(512),
  workId: boundedId,
  operationId: boundedId,
  attemptId: boundedId,
  runId: boundedId,
  generationId: boundedId,
  ownerEpoch: safePositive,
  fencingToken: safePositive,
}).strict()

const reconcileSchema = z.object({
  protocolVersion: z.literal(1),
  request: z.object({
    protocolVersion: z.literal(1),
    workId: boundedId,
    operationId: boundedId,
    runId: boundedId,
    generationId: boundedId,
    ownerEpoch: safePositive,
    workerId: boundedId,
    workspaceId: boundedId,
    workspaceMode,
    cleanup: cleanupPolicy,
    safeToDelete: z.boolean(),
  }).strict(),
}).strict()

const resourceRouteSchema = z.object({ provider: boundedId.optional(), model: boundedId }).strict()
const resourceReservationSchema = resourceRouteSchema.extend({
  protocolVersion: z.literal(1),
  workId: boundedId,
  operationId: boundedId,
  ownerEpoch: safePositive,
  weight: z.number().positive(),
  hardMaxParallel: safePositive,
  hardMaxWeight: z.number().positive().optional(),
  requestedAt: safeNonNegative,
  deadline: safePositive,
}).strict()
const resourceOutcomeSchema = z.object({
  reservationId: boundedId,
  providerId: boundedId,
  workId: boundedId,
  ownerEpoch: safePositive,
  fencingToken: safePositive,
  outcome: z.enum(['released', 'completed', 'capacity', 'oom', 'rate-limited', 'worker-lost']),
  at: safeNonNegative,
  retryAfterMs: safePositive.optional(),
  evidence: z.string().max(4_000).optional(),
}).strict()
const resourceReconcileSchema = z.object({
  protocolVersion: z.literal(1),
  reservationId: boundedId,
  providerId: boundedId,
  workId: boundedId,
  ownerEpoch: safePositive,
  fencingToken: safePositive,
  at: safeNonNegative,
  evidence: z.string().min(1).max(4_000),
}).strict()
const schedulerAcquireSchema = z.object({
  protocolVersion: z.literal(1),
  request: z.object({
    protocolVersion: z.literal(1),
    sessionId: boundedId,
    runId: boundedId,
    generationId: boundedId,
    ownerId: boundedId,
    minimumOwnerEpoch: safePositive,
    requestedAt: safeNonNegative,
  }).strict(),
}).strict()
const schedulerLeaseRequestSchema = z.object({
  protocolVersion: z.literal(1),
  request: z.object({
    protocolVersion: z.literal(1),
    providerId: boundedId,
    leaseId: boundedId,
    runId: boundedId,
    generationId: boundedId,
    ownerId: boundedId,
    ownerEpoch: safePositive,
    fencingToken: safePositive,
    at: safeNonNegative,
  }).strict(),
}).strict()

const artifactEntrySchema = z.object({
  path: boundedId,
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  baseSha256: z.string().regex(/^[a-f0-9]{64}$/u).nullable().optional(),
  size: safeNonNegative,
  mode: safeNonNegative,
  kind: z.literal('file'),
}).strict()
const artifactManifestSchema = z.object({
  id: boundedId,
  algorithm: z.literal('sha256'),
  provider: boundedId,
  workId: boundedId,
  operationId: boundedId,
  attemptId: boundedId,
  runId: boundedId,
  generationId: boundedId,
  ownerEpoch: safePositive,
  fencingToken: safePositive,
  createdAt: safeNonNegative,
  totalBytes: safeNonNegative,
  entries: z.array(artifactEntrySchema),
  providerReference: boundedText,
}).strict()
const artifactTransferFileSchema = z.object({
  path: boundedId,
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  size: safeNonNegative,
  mode: safeNonNegative,
  bytes: z.string(),
}).strict()
const artifactCaptureSchema = z.object({
  protocolVersion: z.literal(1),
  request: z.object({
    workId: boundedId,
    operationId: boundedId,
    attemptId: boundedId,
    runId: boundedId,
    generationId: boundedId,
    ownerEpoch: safePositive,
    fencingToken: safePositive,
    workspaceId: boundedId,
    workspaceReference: boundedText,
    paths: z.array(boundedId),
    baseContentHashes: z.record(boundedId, z.string().regex(/^[a-f0-9]{64}$/u).nullable()).optional(),
    maxFiles: safePositive,
    maxBytes: safePositive,
    deadline: safePositive,
  }).strict(),
  files: z.array(artifactTransferFileSchema),
}).strict()
const artifactMaterializeSchema = z.object({
  protocolVersion: z.literal(1),
  manifest: artifactManifestSchema,
}).strict()
const artifactReconcileSchema = z.object({
  protocolVersion: z.literal(1),
  request: z.object({
    manifestId: boundedId,
    providerReference: boundedText,
    safeToDelete: z.boolean(),
  }).strict(),
}).strict()
const durableWorkspaceSchema = z.object({
  id: boundedId,
  mode: workspaceMode,
  root: boundedText,
  providerReference: boundedText,
  createdAt: safeNonNegative,
  sourceRevision: z.string().max(4_000).optional(),
  baseContentHash: z.string().max(4_000).optional(),
}).strict()
const durableResultSchema = z.object({
  outcome: z.enum(['completed', 'aborted', 'max-tokens', 'stalled', 'error', 'capacity', 'oom', 'unavailable']),
  output: z.array(contentBlockSchema),
  childSessionId: boundedId.optional(),
  structured: z.unknown().optional(),
  artifactManifest: artifactManifestSchema.optional(),
  error: z.object({
    code: boundedId,
    message: boundedText,
    retryable: z.boolean().optional(),
    retryAfterMs: safePositive.optional(),
  }).strict().optional(),
}).strict()
const durableAuthoritySchema = z.object({
  workId: boundedId,
  operationId: boundedId,
  attemptId: boundedId,
  runId: boundedId,
  generationId: boundedId,
  ownerEpoch: safePositive,
  fencingToken: safePositive,
  workerId: boundedId,
  workspaceId: boundedId,
}).strict()

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid SQLite row')
  return value as Record<string, unknown>
}

function jobRow(value: unknown): JobRow {
  const item = record(value)
  const text = (key: keyof JobRow, nullable = false): string | null => {
    const field = item[key]
    if (nullable && field === null) return null
    if (typeof field !== 'string') throw new Error(`remote Graph Worker journal has invalid ${key}`)
    return field
  }
  const requiredText = (key: keyof JobRow): string => {
    const value = text(key)
    if (value === null) throw new Error(`remote Graph Worker journal has null ${key}`)
    return value
  }
  return {
    job_id: requiredText('job_id'),
    assignment_hash: requiredText('assignment_hash'),
    state: z.enum(['accepted', 'running', 'canceling', 'terminal']).parse(requiredText('state')),
    authority_json: requiredText('authority_json'),
    workspace_json: requiredText('workspace_json'),
    result_json: text('result_json', true),
    actual_worker_id: text('actual_worker_id', true),
    actual_workspace_json: text('actual_workspace_json', true),
    service_epoch: safePositive.parse(item.service_epoch),
  }
}

function artifactRow(value: unknown): ArtifactRow {
  const item = record(value)
  return z.object({
    manifest_id: boundedId,
    public_reference: boundedText,
    public_json: z.string().min(1),
    internal_json: z.string().min(1),
  }).strict().parse(item)
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function hashBytes(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function safeRelative(value: string): string {
  if (!value || value.includes('\\')) throw new Error('remote Graph artifact path must be non-empty and use forward slashes')
  const normalized = posix.normalize(value)
  if (normalized !== value || normalized === '.' || normalized === '..' || normalized.startsWith('../') || normalized.startsWith('/')) {
    throw new Error(`remote Graph artifact path is not normalized and source-relative: ${value}`)
  }
  return normalized
}

function inside(root: string, path: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`)
}

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  response.end(body)
}

function validatePath(value: string): string {
  if (!value.startsWith('/') || value.endsWith('/') || value.includes('?') || value.includes('#')) {
    throw new Error('remote Graph Worker basePath must be an absolute path without a trailing slash, query, or fragment')
  }
  return value
}

function parseWorkspace(value: string): GraphWorkspaceAllocation {
  const parsed = durableWorkspaceSchema.parse(JSON.parse(value))
  return {
    id: GraphWorkspaceAllocationId(parsed.id),
    mode: parsed.mode,
    root: parsed.root,
    providerReference: parsed.providerReference,
    createdAt: parsed.createdAt,
    ...parsed.sourceRevision === undefined ? {} : { sourceRevision: parsed.sourceRevision },
    ...parsed.baseContentHash === undefined ? {} : { baseContentHash: parsed.baseContentHash },
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

function parseResult(value: string): GraphWorkerResult {
  const parsed = durableResultSchema.parse(JSON.parse(value))
  return {
    outcome: parsed.outcome,
    output: parsed.output.map(contentBlock),
    ...(parsed.structured === undefined ? {} : { structured: parsed.structured }),
    ...(parsed.childSessionId === undefined ? {} : { childSessionId: parsed.childSessionId }),
    ...(parsed.artifactManifest === undefined ? {} : { artifactManifest: artifactManifest(parsed.artifactManifest) }),
    ...(parsed.error === undefined ? {} : {
      error: {
        code: parsed.error.code,
        message: parsed.error.message,
        ...(parsed.error.retryable === undefined ? {} : { retryable: parsed.error.retryable }),
        ...(parsed.error.retryAfterMs === undefined ? {} : { retryAfterMs: parsed.error.retryAfterMs }),
      },
    }),
  }
}

function parseAuthority(value: string): z.infer<typeof durableAuthoritySchema> {
  return durableAuthoritySchema.parse(JSON.parse(value))
}

function publicFailure(code: string, message: string): GraphWorkerResult {
  return { outcome: 'unavailable', output: [], error: { code, message } }
}

/**
 * Authenticated HTTP request handler and SQLite authority for remote Worker jobs.
 * Accepted identities are durable before execution starts; nonterminal rows are
 * quarantined on restart instead of being dispatched a second time.
 */
export class HttpGraphWorkerServer {
  private readonly database: DatabaseSync
  private readonly replay: GraphWorkerReplayGuard
  private readonly active = new Map<GraphWorkerRemoteJobId, ActiveJob>()
  private readonly launching = new Map<GraphWorkerRemoteJobId, Promise<void>>()
  private readonly basePath: string
  private readonly serviceEpoch: number
  private closing = false
  private databaseOpen = true

  /**
   * Open the durable job journal and quarantine uncertain work from an earlier process.
   * @param options - service identity, Worker route, credential resolver, journal, and bounds.
   */
  constructor(private readonly options: HttpGraphWorkerServerOptions) {
    GraphWorkerRemoteAudienceId(options.audience)
    this.basePath = validatePath(options.basePath)
    if (!isAbsolute(options.journalPath)) throw new Error('remote Graph Worker journalPath must be absolute')
    if (!options.workerProvider.trim()) throw new Error('remote Graph Worker workerProvider must be non-empty')
    if (!Number.isSafeInteger(options.maxResultBytes) || options.maxResultBytes < 1) {
      throw new Error('remote Graph Worker maxResultBytes must be positive')
    }
    if (!Number.isSafeInteger(options.busyTimeoutMs) || options.busyTimeoutMs < 1) {
      throw new Error('remote Graph Worker busyTimeoutMs must be positive')
    }
    if (!Number.isSafeInteger(options.operationTimeoutMs) || options.operationTimeoutMs < 1) {
      throw new Error('remote Graph Worker operationTimeoutMs must be positive')
    }
    if (options.artifact !== undefined) {
      if (!options.artifact.routeName.trim() || !options.artifact.providerName.trim()) {
        throw new Error('remote Graph artifact route and Provider names must be non-empty')
      }
      if (!isAbsolute(options.artifact.tempRoot)) throw new Error('remote Graph artifact tempRoot must be absolute')
      if (!Number.isSafeInteger(options.artifact.maxFiles) || options.artifact.maxFiles < 1
        || !Number.isSafeInteger(options.artifact.maxBytes) || options.artifact.maxBytes < 1) {
        throw new Error('remote Graph artifact transfer bounds must be positive')
      }
    }
    if (options.scheduler !== undefined
      && (!options.scheduler.routeName.trim() || !options.scheduler.providerName.trim())) {
      throw new Error('remote Graph scheduler route and Provider names must be non-empty')
    }
    this.replay = new GraphWorkerReplayGuard({
      maxClockSkewMs: options.maxClockSkewMs,
      maxBodyBytes: options.maxRequestBytes,
      maxEntries: options.maxReplayEntries,
    })
    this.database = new DatabaseSync(options.journalPath)
    this.database.exec(`PRAGMA busy_timeout = ${String(options.busyTimeoutMs)}`)
    this.serviceEpoch = this.prepareJournal()
    this.quarantineInterruptedJobs()
  }

  /**
   * Authenticate and serve one exact `/v1/*` request below the configured base path.
   * @param request - incoming Node HTTP request owned by the Web Server route.
   * @param response - response completed by this handler.
   */
  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (this.closing) {
      json(response, 503, { error: 'remote Graph Worker service is stopping' })
      return
    }
    const path = request.url ?? ''
    if (request.method !== 'POST' || !path.startsWith(`${this.basePath}/v1/`)) {
      json(response, 404, { error: 'not found' })
      return
    }
    let body: string
    try {
      body = await this.readBody(request)
      await this.authenticate(request, path, body)
    } catch {
      json(response, 401, { error: 'remote Graph Worker request authentication failed' })
      return
    }
    if (path !== `${this.basePath}/v1/observe`) {
      try {
        this.assertCurrentEpoch()
      } catch {
        json(response, 503, { error: 'remote Graph Worker service was superseded by a newer journal owner' })
        return
      }
    }
    try {
      const payload: unknown = JSON.parse(body)
      switch (path) {
        case `${this.basePath}/v1/start`: await this.start(payload, response); return
        case `${this.basePath}/v1/observe`: this.observe(payload, response); return
        case `${this.basePath}/v1/cancel`: await this.cancel(payload, response); return
        case `${this.basePath}/v1/reconcile`: await this.reconcile(payload, response); return
        case `${this.basePath}/v1/resources/observe`: await this.resourceObserve(payload, response); return
        case `${this.basePath}/v1/resources/reserve`: await this.resourceReserve(payload, response); return
        case `${this.basePath}/v1/resources/report`: await this.resourceReport(payload, response); return
        case `${this.basePath}/v1/resources/reconcile`: await this.resourceReconcile(payload, response); return
        case `${this.basePath}/v1/scheduler/acquire`: await this.schedulerAcquire(payload, response); return
        case `${this.basePath}/v1/scheduler/heartbeat`: await this.schedulerHeartbeat(payload, response); return
        case `${this.basePath}/v1/scheduler/release`: await this.schedulerRelease(payload, response); return
        case `${this.basePath}/v1/artifacts/capture`: await this.artifactCapture(payload, response); return
        case `${this.basePath}/v1/artifacts/materialize`: await this.artifactMaterialize(payload, response); return
        case `${this.basePath}/v1/artifacts/reconcile`: await this.artifactReconcile(payload, response); return
        default: json(response, 404, { error: 'not found' })
      }
    } catch (error) {
      json(response, 400, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** Stop accepting work, cancel and drain live jobs, then close the journal. */
  async close(): Promise<void> {
    if (this.closing) return
    this.closing = true
    const signal = this.operationSignal()
    await Promise.allSettled([...this.active.values()].map(async ({ abort, run }) => {
      try {
        await waitFor(run.cancel('remote Worker service is stopping', signal), signal)
      } finally {
        abort.abort(new Error('remote Worker service is stopping'))
      }
      await waitFor(run.result, signal)
    }))
    await Promise.allSettled([
      waitFor(Promise.allSettled(this.launching.values()), signal),
    ])
    this.databaseOpen = false
    this.database.close()
  }

  private prepareJournal(): number {
    const objects = Number(record(this.database.prepare(
      "SELECT COUNT(*) AS count FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'",
    ).get()).count)
    const applicationId = Number(record(this.database.prepare('PRAGMA application_id').get()).application_id)
    const version = Number(record(this.database.prepare('PRAGMA user_version').get()).user_version)
    if (objects === 0) {
      this.database.exec(`
        PRAGMA application_id = ${String(APPLICATION_ID)};
        PRAGMA user_version = ${String(SCHEMA_VERSION)};
        CREATE TABLE jobs (
          job_id TEXT PRIMARY KEY,
          assignment_hash TEXT NOT NULL,
          state TEXT NOT NULL,
          authority_json TEXT NOT NULL,
          workspace_json TEXT NOT NULL,
          result_json TEXT,
          actual_worker_id TEXT,
          actual_workspace_json TEXT,
          service_epoch INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE service_meta (
          singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
          config_hash TEXT NOT NULL,
          epoch INTEGER NOT NULL
        );
        INSERT INTO service_meta(singleton, config_hash, epoch)
        VALUES (1, '${this.configurationFingerprint()}', 1);
        CREATE TABLE artifacts (
          manifest_id TEXT PRIMARY KEY,
          public_reference TEXT UNIQUE NOT NULL,
          public_json TEXT NOT NULL,
          internal_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX jobs_remote_worker ON jobs(json_extract(authority_json, '$.workerId'));
      `)
      return 1
    } else if (applicationId !== APPLICATION_ID || version !== SCHEMA_VERSION) {
      throw new Error(`remote Graph Worker refuses journal identity ${String(applicationId)} version ${String(version)}`)
    }
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const meta = record(this.database.prepare('SELECT config_hash, epoch FROM service_meta WHERE singleton = 1').get())
      if (meta.config_hash !== this.configurationFingerprint()) {
        throw new Error('remote Graph Worker journal belongs to a different service configuration')
      }
      const previous = safePositive.parse(meta.epoch)
      const epoch = previous + 1
      if (!Number.isSafeInteger(epoch)) throw new Error('remote Graph Worker service epoch is exhausted')
      this.database.prepare('UPDATE service_meta SET epoch = ? WHERE singleton = 1').run(epoch)
      this.database.exec('COMMIT')
      return epoch
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  private quarantineInterruptedJobs(): void {
    const result = JSON.stringify(publicFailure(
      'GRAPH_WORKER_REMOTE_RESTART_QUARANTINED',
      'the Worker service restarted before terminal settlement; reconcile the retained workspace before retrying',
    ))
    this.database.prepare(`
      UPDATE jobs SET state = 'terminal', result_json = ?, service_epoch = ?, updated_at = ?
      WHERE state IN ('accepted', 'running', 'canceling')
    `).run(result, this.serviceEpoch, Date.now())
  }

  private configurationFingerprint(): string {
    return sha256(JSON.stringify({
      audience: this.options.audience,
      basePath: this.basePath,
      workerProvider: this.options.workerProvider,
      resource: this.options.resource === undefined
        ? undefined
        : { routeName: this.options.resource.routeName, providerName: this.options.resource.providerName },
      artifact: this.options.artifact === undefined
        ? undefined
        : { routeName: this.options.artifact.routeName, providerName: this.options.artifact.providerName },
      scheduler: this.options.scheduler === undefined
        ? undefined
        : { routeName: this.options.scheduler.routeName, providerName: this.options.scheduler.providerName },
    }))
  }

  private assertCurrentEpoch(): void {
    const value = record(this.database.prepare('SELECT epoch FROM service_meta WHERE singleton = 1').get()).epoch
    if (value !== this.serviceEpoch) throw new Error('remote Graph Worker service journal ownership changed')
  }

  private async readBody(request: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = []
    let bytes = 0
    for await (const chunk of request) {
      const part = chunk as Buffer
      bytes += part.byteLength
      if (bytes > this.options.maxRequestBytes) throw new Error('request body too large')
      chunks.push(part)
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
  }

  private async authenticate(request: IncomingMessage, path: string, body: string): Promise<void> {
    const header = (name: keyof GraphWorkerAuthHeaders): string => {
      const value = request.headers[name]
      if (typeof value !== 'string') throw new Error('missing authentication header')
      return value
    }
    const headers: GraphWorkerAuthHeaders = {
      'x-dsh-worker-principal': header('x-dsh-worker-principal'),
      'x-dsh-worker-audience': header('x-dsh-worker-audience'),
      'x-dsh-worker-timestamp': header('x-dsh-worker-timestamp'),
      'x-dsh-worker-nonce': header('x-dsh-worker-nonce'),
      'x-dsh-worker-signature': header('x-dsh-worker-signature'),
    }
    const asserted = GraphWorkerRemotePrincipalId(headers['x-dsh-worker-principal'])
    const secret = await this.options.resolveSecret(asserted)
    this.replay.verify({
      method: request.method ?? '',
      path,
      body,
      headers,
      expectedAudience: this.options.audience,
      resolveSecret: principal => principal === asserted ? secret : undefined,
    })
  }

  private async start(payload: unknown, response: ServerResponse): Promise<void> {
    const parsed = z.object({ protocolVersion: z.literal(1), assignment: wireAssignmentSchema }).strict().parse(payload)
    const assignment = this.assignment(parsed.assignment)
    const serialized = JSON.stringify(parsed.assignment)
    const assignmentHash = sha256(serialized)
    const jobId = GraphWorkerRemoteJobId(`job-${sha256(JSON.stringify([
      assignment.workId,
      assignment.operationId,
      assignment.attemptId,
      assignment.activation,
      assignment.runId,
      assignment.generationId,
      assignment.ownerEpoch,
      assignment.fencingToken,
    ]))}`)
    let row = this.findJob(jobId)
    if (row !== undefined && row.assignment_hash !== assignmentHash) throw new Error('remote Graph Worker job identity conflicts with another assignment')
    if (row === undefined) {
      const remoteWorkerId = GraphWorkerId(`worker-${jobId}`)
      const workspace: GraphWorkspaceAllocation = {
        id: GraphWorkspaceAllocationId(`workspace-${jobId}`),
        mode: assignment.workspace.mode,
        root: assignment.workspace.sourceRoot,
        providerReference: `${this.options.audience}:${jobId}`,
        createdAt: Date.now(),
        ...assignment.workspace.sourceRevision === undefined ? {} : { sourceRevision: assignment.workspace.sourceRevision },
        ...assignment.workspace.baseContentHash === undefined ? {} : { baseContentHash: assignment.workspace.baseContentHash },
      }
      const authority = {
        workId: assignment.workId,
        operationId: assignment.operationId,
        attemptId: assignment.attemptId,
        runId: assignment.runId,
        generationId: assignment.generationId,
        ownerEpoch: assignment.ownerEpoch,
        fencingToken: assignment.fencingToken,
        workerId: remoteWorkerId,
        workspaceId: workspace.id,
      }
      const inserted = this.database.prepare(`
        INSERT INTO jobs(job_id, assignment_hash, state, authority_json, workspace_json, service_epoch, updated_at)
        SELECT ?, ?, 'accepted', ?, ?, ?, ?
        WHERE (SELECT epoch FROM service_meta WHERE singleton = 1) = ?
      `).run(
        jobId,
        assignmentHash,
        JSON.stringify(authority),
        JSON.stringify(workspace),
        this.serviceEpoch,
        Date.now(),
        this.serviceEpoch,
      )
      if (inserted.changes !== 1) throw new Error('remote Graph Worker service was superseded before acceptance')
      row = this.findJob(jobId)
      if (row === undefined) throw new Error('remote Graph Worker journal lost the accepted job')
      await this.launch(jobId, assignment)
      row = this.findJob(jobId)
      if (row === undefined) throw new Error('remote Graph Worker journal lost the launched job')
    } else if (row.state !== 'terminal' && !this.active.has(jobId)) {
      await this.launch(jobId, assignment)
      row = this.findJob(jobId)
      if (row === undefined) throw new Error('remote Graph Worker journal lost the relaunched job')
    }
    const authority = parseAuthority(row.authority_json)
    json(response, 200, {
      protocolVersion: 1,
      jobId,
      workerId: authority.workerId,
      workspace: parseWorkspace(row.workspace_json),
    })
  }

  private assignment(value: z.infer<typeof wireAssignmentSchema>): WireAssignment {
    assertObjectJsonSchema(value.outputSchema)
    assertObjectJsonSchema(value.node.outputSchema.schema)
    if (value.role.id !== value.node.roleId) throw new Error('remote Graph Worker role does not own the assigned node')
    if (Date.now() >= value.deadline) throw new Error('remote Graph Worker assignment deadline elapsed')
    const node: GraphNode = {
      id: GraphNodeId(value.node.id),
      title: value.node.title,
      objective: value.node.objective,
      kind: value.node.kind,
      roleId: GraphRoleId(value.node.roleId),
      acceptanceCriteria: value.node.acceptanceCriteria,
      outputSchema: {
        id: value.node.outputSchema.id,
        version: value.node.outputSchema.version,
        maxBytes: value.node.outputSchema.maxBytes,
        schema: value.node.outputSchema.schema,
      },
      maxAttempts: value.node.maxAttempts,
      weight: value.node.weight,
      executionBudget: value.node.executionBudget,
      skippable: value.node.skippable,
      effectPolicy: value.node.effectPolicy,
      ...(value.node.expansion === undefined ? {} : { expansion: {
        mode: value.node.expansion.mode,
        maxNodes: value.node.expansion.maxNodes,
        ...(value.node.expansion.itemPath === undefined ? {} : { itemPath: value.node.expansion.itemPath }),
        ...(value.node.expansion.itemKeyPath === undefined ? {} : { itemKeyPath: value.node.expansion.itemKeyPath }),
      } }),
      ...(value.node.subgraph === undefined ? {} : { subgraph: {
        graphId: GraphId(value.node.subgraph.graphId),
        revision: value.node.subgraph.revision,
        input: value.node.subgraph.input,
        output: value.node.subgraph.output,
      } }),
      ...(value.node.workspace === undefined ? {} : { workspace: {
        mode: value.node.workspace.mode,
        readRoots: value.node.workspace.readRoots,
        writeRoots: value.node.workspace.writeRoots,
        cleanup: value.node.workspace.cleanup,
      } }),
    }
    return {
      protocolVersion: value.protocolVersion,
      workId: GraphWorkId(value.workId),
      operationId: GraphControlOperationId(value.operationId),
      attemptId: GraphAttemptId(value.attemptId),
      runId: GraphRunId(value.runId),
      generationId: GraphRunGenerationId(value.generationId),
      activation: value.activation,
      ownerEpoch: value.ownerEpoch,
      fencingToken: value.fencingToken,
      ...(value.activeSubagentLimit === undefined ? {} : { activeSubagentLimit: value.activeSubagentLimit }),
      node,
      role: {
        id: GraphRoleId(value.role.id),
        label: value.role.label,
        description: value.role.description,
        controller: value.role.controller,
        enabled: value.role.enabled,
        model: {
          ...(value.role.model.provider === undefined ? {} : { provider: value.role.model.provider }),
          ...(value.role.model.model === undefined ? {} : { model: value.role.model.model }),
          ...(value.role.model.reasoningEffort === undefined ? {} : { reasoningEffort: value.role.model.reasoningEffort }),
        },
        prompt: value.role.prompt,
        ...(value.role.workerProvider === undefined ? {} : { workerProvider: value.role.workerProvider }),
        maxParallel: value.role.maxParallel,
      },
      prompt: value.prompt.map(contentBlock),
      outputSchema: value.outputSchema,
      budget: value.budget,
      workspace: {
        mode: value.workspace.mode,
        sourceRoot: value.workspace.sourceRoot,
        readRoots: value.workspace.readRoots,
        writeRoots: value.workspace.writeRoots,
        cleanup: value.workspace.cleanup,
        ...(value.workspace.sourceRevision === undefined ? {} : { sourceRevision: value.workspace.sourceRevision }),
        ...(value.workspace.baseContentHash === undefined ? {} : { baseContentHash: value.workspace.baseContentHash }),
      },
      deadline: value.deadline,
      ...(value.toolFilter === undefined ? {} : { toolFilter: {
        ...(value.toolFilter.allow === undefined ? {} : { allow: value.toolFilter.allow }),
        ...(value.toolFilter.deny === undefined ? {} : { deny: value.toolFilter.deny }),
      } }),
    }
  }

  private async launch(jobId: GraphWorkerRemoteJobId, wire: WireAssignment): Promise<void> {
    const existing = this.launching.get(jobId)
    if (existing !== undefined) return existing
    const promise = this.startUnderlying(jobId, wire).finally(() => { this.launching.delete(jobId) })
    this.launching.set(jobId, promise)
    return promise
  }

  private async startUnderlying(jobId: GraphWorkerRemoteJobId, wire: WireAssignment): Promise<void> {
    const parent = this.options.resolveParent()
    if (parent === undefined) {
      this.settle(jobId, publicFailure('GRAPH_WORKER_REMOTE_PARENT_UNAVAILABLE', 'the Worker service parent Agent is unavailable'))
      return
    }
    const abort = new AbortController()
    try {
      const run = await this.options.graphWorkers.start(this.options.workerProvider, { ...wire, parent, signal: abort.signal })
      if (!this.databaseOpen) {
        abort.abort(new Error('remote Worker service is closed'))
        void run.cancel('remote Worker service is closed', this.operationSignal()).catch(() => {})
        void run.result.catch(() => {})
        return
      }
      if (run.workspace.mode !== wire.workspace.mode) {
        await run.cancel('remote Worker allocated an incompatible workspace mode', this.operationSignal())
        abort.abort(new Error('remote Worker allocated an incompatible workspace mode'))
        await run.result
        this.settle(jobId, publicFailure(
          'GRAPH_WORKER_REMOTE_WORKSPACE_MODE',
          `the Worker Provider allocated ${run.workspace.mode} for requested ${wire.workspace.mode}`,
        ))
        return
      }
      const published = this.database.prepare(`
        UPDATE jobs SET state = 'running', actual_worker_id = ?, actual_workspace_json = ?, updated_at = ?
        WHERE job_id = ? AND service_epoch = ?
      `).run(run.id, JSON.stringify(run.workspace), Date.now(), jobId, this.serviceEpoch)
      if (published.changes !== 1) {
        await run.cancel('remote Worker service journal ownership changed', this.operationSignal())
        abort.abort(new Error('remote Worker service journal ownership changed'))
        await run.result
        return
      }
      this.active.set(jobId, { abort, run })
      void run.result.then(
        (result) => { this.settle(jobId, result) },
        (error: unknown) => {
          this.settle(jobId, publicFailure(
            'GRAPH_WORKER_REMOTE_PROVIDER_FAILURE',
            error instanceof Error ? error.message : String(error),
          ))
        },
      ).finally(() => { this.active.delete(jobId) })
    } catch (error) {
      this.settle(jobId, publicFailure(
        'GRAPH_WORKER_REMOTE_START_FAILURE',
        error instanceof Error ? error.message : String(error),
      ))
    }
  }

  private settle(jobId: GraphWorkerRemoteJobId, result: GraphWorkerResult): void {
    if (!this.databaseOpen) return
    let serialized = JSON.stringify(result)
    if (Buffer.byteLength(serialized) > this.options.maxResultBytes) {
      serialized = JSON.stringify(publicFailure(
        'GRAPH_WORKER_REMOTE_RESULT_LIMIT',
        'the terminal Worker result exceeded the configured byte limit',
      ))
    }
    this.database.prepare(`
      UPDATE jobs SET state = 'terminal', result_json = ?, updated_at = ?
      WHERE job_id = ? AND service_epoch = ?
    `).run(serialized, Date.now(), jobId, this.serviceEpoch)
  }

  private observe(payload: unknown, response: ServerResponse): void {
    const authority = authoritySchema.parse(payload)
    const row = this.addressed(authority)
    if (row.state === 'terminal') {
      if (row.result_json === null) throw new Error('remote Graph Worker terminal job has no result')
      json(response, 200, { protocolVersion: 1, state: 'terminal', result: parseResult(row.result_json) })
      return
    }
    json(response, 200, { protocolVersion: 1, state: 'running' })
  }

  private async cancel(payload: unknown, response: ServerResponse): Promise<void> {
    const parsed = authoritySchema.extend({ reason: boundedText }).parse(payload)
    const row = this.addressed(parsed)
    if (row.state !== 'terminal') {
      this.database.prepare(`
        UPDATE jobs SET state = 'canceling', updated_at = ?
        WHERE job_id = ? AND service_epoch = ?
      `).run(Date.now(), parsed.jobId, this.serviceEpoch)
      const active = this.active.get(GraphWorkerRemoteJobId(parsed.jobId))
      if (active !== undefined) {
        await active.run.cancel(parsed.reason, this.operationSignal())
        active.abort.abort(new Error(parsed.reason))
      } else {
        this.settle(GraphWorkerRemoteJobId(parsed.jobId), publicFailure(
          'GRAPH_WORKER_REMOTE_CANCEL_QUARANTINED',
          'the accepted Worker was not attached to this process and was quarantined',
        ))
      }
    }
    json(response, 200, { protocolVersion: 1, accepted: true })
  }

  private async reconcile(payload: unknown, response: ServerResponse): Promise<void> {
    const parsed = reconcileSchema.parse(payload).request
    const rowValue = this.database.prepare(
      "SELECT * FROM jobs WHERE json_extract(authority_json, '$.workerId') = ?",
    ).get(parsed.workerId)
    if (rowValue === undefined) {
      json(response, 200, { protocolVersion: 1, status: 'absent', evidence: `remote Worker ${parsed.workerId} is absent` })
      return
    }
    const row = jobRow(rowValue)
    const authority = parseAuthority(row.authority_json)
    for (const key of ['workId', 'operationId', 'runId', 'generationId', 'ownerEpoch', 'workerId', 'workspaceId'] as const) {
      if (authority[key] !== parsed[key]) throw new Error(`remote Graph Worker reconcile ${key} does not match the durable job`)
    }
    const workspace = parseWorkspace(row.workspace_json)
    if (workspace.mode !== parsed.workspaceMode) throw new Error('remote Graph Worker reconcile workspaceMode does not match')
    const active = this.active.get(GraphWorkerRemoteJobId(row.job_id))
    if (active !== undefined) {
      await active.run.cancel('scheduler recovery superseded this remote Worker', this.operationSignal())
      active.abort.abort(new Error('scheduler recovery superseded this remote Worker'))
      await active.run.result
    }
    if (row.actual_worker_id !== null && row.actual_workspace_json !== null) {
      const actualWorkspace = parseWorkspace(row.actual_workspace_json)
      const request: GraphWorkerReconcileRequest = {
        ...parsed,
        workId: GraphWorkId(parsed.workId),
        operationId: GraphControlOperationId(parsed.operationId),
        runId: GraphRunId(parsed.runId),
        generationId: GraphRunGenerationId(parsed.generationId),
        workerId: GraphWorkerId(row.actual_worker_id),
        workspaceId: actualWorkspace.id,
      }
      const result = await this.options.graphWorkers.reconcile(
        this.options.workerProvider,
        request,
        this.operationSignal(),
      )
      json(response, 200, { protocolVersion: 1, ...result })
      return
    }
    json(response, 200, {
      protocolVersion: 1,
      status: 'quarantined',
      evidence: `remote job ${row.job_id} has no published underlying Worker reference`,
    })
  }

  private async resourceObserve(payload: unknown, response: ServerResponse): Promise<void> {
    const resource = this.requireResource()
    const route = z.object({ protocolVersion: z.literal(1), route: resourceRouteSchema }).strict().parse(payload).route
    const snapshot = await resource.graphResources.observe(
      resource.providerName,
      { model: route.model, ...route.provider === undefined ? {} : { provider: route.provider } },
      this.operationSignal(),
    )
    json(response, 200, this.publicSnapshot(snapshot, resource.routeName))
  }

  private async resourceReserve(payload: unknown, response: ServerResponse): Promise<void> {
    const resource = this.requireResource()
    const parsed = z.object({ protocolVersion: z.literal(1), request: resourceReservationSchema }).strict().parse(payload).request
    const request: GraphResourceReservationRequest = {
      protocolVersion: 1,
      workId: GraphWorkId(parsed.workId),
      operationId: GraphControlOperationId(parsed.operationId),
      ownerEpoch: parsed.ownerEpoch,
      weight: parsed.weight,
      hardMaxParallel: parsed.hardMaxParallel,
      requestedAt: parsed.requestedAt,
      deadline: parsed.deadline,
      model: parsed.model,
      ...parsed.provider === undefined ? {} : { provider: parsed.provider },
      ...parsed.hardMaxWeight === undefined ? {} : { hardMaxWeight: parsed.hardMaxWeight },
    }
    const decision = await resource.graphResources.reserve(
      resource.providerName,
      request,
      this.operationSignal(),
    )
    json(response, 200, this.publicDecision(decision, resource.routeName))
  }

  private async resourceReport(payload: unknown, response: ServerResponse): Promise<void> {
    const resource = this.requireResource()
    const parsed = z.object({ protocolVersion: z.literal(1), outcome: resourceOutcomeSchema }).strict().parse(payload).outcome
    if (parsed.providerId !== resource.routeName) throw new Error('remote Graph resource outcome targets another route')
    const outcome: GraphResourceOutcome = {
      reservationId: GraphResourceReservationId(parsed.reservationId),
      providerId: resource.providerName,
      workId: GraphWorkId(parsed.workId),
      ownerEpoch: parsed.ownerEpoch,
      fencingToken: parsed.fencingToken,
      outcome: parsed.outcome,
      at: parsed.at,
      ...parsed.retryAfterMs === undefined ? {} : { retryAfterMs: parsed.retryAfterMs },
      ...parsed.evidence === undefined ? {} : { evidence: parsed.evidence },
    }
    await resource.graphResources.report(outcome, this.operationSignal())
    json(response, 200, { protocolVersion: 1, accepted: true })
  }

  private async resourceReconcile(payload: unknown, response: ServerResponse): Promise<void> {
    const resource = this.requireResource()
    const parsed = z.object({ protocolVersion: z.literal(1), request: resourceReconcileSchema }).strict().parse(payload).request
    if (parsed.providerId !== resource.routeName) throw new Error('remote Graph resource reconciliation targets another route')
    const request: GraphResourceReconcileRequest = {
      ...parsed,
      reservationId: GraphResourceReservationId(parsed.reservationId),
      providerId: resource.providerName,
      workId: GraphWorkId(parsed.workId),
    }
    const result = await resource.graphResources.reconcile(request, this.operationSignal())
    json(response, 200, result)
  }

  private async schedulerAcquire(payload: unknown, response: ServerResponse): Promise<void> {
    const scheduler = this.requireScheduler()
    const parsed = schedulerAcquireSchema.parse(payload).request
    const request: GraphSchedulerAcquireRequest = {
      ...parsed,
      runId: GraphRunId(parsed.runId),
      generationId: GraphRunGenerationId(parsed.generationId),
      ownerId: GraphSchedulerOwnerId(parsed.ownerId),
    }
    const decision = await scheduler.graphScheduler.acquire(scheduler.providerName, request, this.operationSignal())
    json(response, 200, this.publicSchedulerDecision(decision, scheduler.routeName))
  }

  private async schedulerHeartbeat(payload: unknown, response: ServerResponse): Promise<void> {
    const scheduler = this.requireScheduler()
    const request = this.schedulerLeaseRequest(schedulerLeaseRequestSchema.parse(payload).request, scheduler)
    const lease = await scheduler.graphScheduler.heartbeat(request, this.operationSignal())
    json(response, 200, this.publicSchedulerLease(lease, scheduler.routeName))
  }

  private async schedulerRelease(payload: unknown, response: ServerResponse): Promise<void> {
    const scheduler = this.requireScheduler()
    const request = this.schedulerLeaseRequest(schedulerLeaseRequestSchema.parse(payload).request, scheduler)
    await scheduler.graphScheduler.release(request, this.operationSignal())
    json(response, 200, { protocolVersion: 1, accepted: true })
  }

  private schedulerLeaseRequest(
    value: z.infer<typeof schedulerLeaseRequestSchema>['request'],
    scheduler: NonNullable<HttpGraphWorkerServerOptions['scheduler']>,
  ): GraphSchedulerLeaseRequest {
    if (value.providerId !== scheduler.routeName) throw new Error('remote Graph scheduler lease targets another route')
    return {
      ...value,
      providerId: scheduler.providerName,
      leaseId: GraphSchedulerLeaseId(value.leaseId),
      runId: GraphRunId(value.runId),
      generationId: GraphRunGenerationId(value.generationId),
      ownerId: GraphSchedulerOwnerId(value.ownerId),
    }
  }

  private publicSchedulerDecision(decision: GraphSchedulerDecision, routeName: string): GraphSchedulerDecision {
    return decision.status === 'busy'
      ? decision
      : { status: 'granted', lease: this.publicSchedulerLease(decision.lease, routeName) }
  }

  private publicSchedulerLease(lease: GraphSchedulerLease, routeName: string): GraphSchedulerLease {
    return { ...lease, providerId: routeName }
  }

  private async artifactCapture(payload: unknown, response: ServerResponse): Promise<void> {
    const artifact = this.requireArtifact()
    const parsed = artifactCaptureSchema.parse(payload)
    if (parsed.request.deadline <= Date.now()) throw new Error('remote Graph artifact capture deadline elapsed')
    const limitFiles = Math.min(parsed.request.maxFiles, artifact.maxFiles)
    const limitBytes = Math.min(parsed.request.maxBytes, artifact.maxBytes)
    if (parsed.files.length > limitFiles || parsed.request.paths.length !== parsed.files.length) {
      throw new Error('remote Graph artifact upload exceeds its file limit or selection')
    }
    let totalBytes = 0
    const paths = parsed.files.map(file => safeRelative(file.path))
    if (paths.some((path, index) => {
      const previous = paths[index - 1]
      return path !== parsed.request.paths[index] || (previous !== undefined && path <= previous)
    })) {
      throw new Error('remote Graph artifact upload paths must be unique, lexical, and match the selection')
    }
    const decoded = parsed.files.map((file) => {
      const bytes = Buffer.from(file.bytes, 'base64')
      if (bytes.toString('base64') !== file.bytes || bytes.byteLength !== file.size || hashBytes(bytes) !== file.sha256) {
        throw new Error(`remote Graph artifact upload failed verification: ${file.path}`)
      }
      totalBytes += bytes.byteLength
      if (totalBytes > limitBytes) throw new Error('remote Graph artifact upload exceeds its byte limit')
      return { ...file, bytes }
    })
    const manifest = await this.withArtifactTemp(async (root) => {
      for (const file of decoded) await this.writeArtifactTemp(root, file.path, file.bytes, file.mode)
      const request: GraphArtifactCaptureRequest = {
        workId: GraphWorkId(parsed.request.workId),
        operationId: GraphControlOperationId(parsed.request.operationId),
        attemptId: GraphAttemptId(parsed.request.attemptId),
        runId: GraphRunId(parsed.request.runId),
        generationId: GraphRunGenerationId(parsed.request.generationId),
        ownerEpoch: parsed.request.ownerEpoch,
        fencingToken: parsed.request.fencingToken,
        workspaceId: GraphWorkspaceAllocationId(parsed.request.workspaceId),
        sourceRoot: root,
        workspaceReference: parsed.request.workspaceReference,
        paths,
        ...parsed.request.baseContentHashes === undefined ? {} : { baseContentHashes: parsed.request.baseContentHashes },
        maxFiles: limitFiles,
        maxBytes: limitBytes,
        deadline: parsed.request.deadline,
        signal: this.operationSignal(),
      }
      return artifact.graphArtifacts.capture(artifact.providerName, request)
    })
    const publicManifest: GraphArtifactManifest = {
      ...manifest,
      provider: artifact.routeName,
      providerReference: `dsh-http-artifact:v1:${sha256(JSON.stringify(manifest))}`,
    }
    json(response, 200, this.publishArtifact(publicManifest, manifest))
  }

  private async artifactMaterialize(payload: unknown, response: ServerResponse): Promise<void> {
    const artifact = this.requireArtifact()
    const parsed = artifactMaterializeSchema.parse(payload).manifest
    if (parsed.provider !== artifact.routeName) throw new Error('remote Graph artifact manifest targets another route')
    if (parsed.entries.length > artifact.maxFiles || parsed.totalBytes > artifact.maxBytes) {
      throw new Error('remote Graph artifact manifest exceeds service transfer bounds')
    }
    let declaredBytes = 0
    for (const [index, entry] of parsed.entries.entries()) {
      safeRelative(entry.path)
      const previous = parsed.entries[index - 1]
      if (previous !== undefined && entry.path <= previous.path) {
        throw new Error('remote Graph artifact manifest entries must be unique and lexical')
      }
      declaredBytes += entry.size
    }
    if (declaredBytes !== parsed.totalBytes) throw new Error('remote Graph artifact manifest byte total is inconsistent')
    const internal = this.internalArtifactManifest(parsed)
    const files = await this.withArtifactTemp(async (root) => {
      await artifact.graphArtifacts.materialize(artifact.providerName, {
        manifest: internal,
        targetRoot: root,
        overwrite: 'forbid',
        signal: this.operationSignal(),
      })
      const transferred = []
      let totalBytes = 0
      for (const entry of parsed.entries) {
        const absolute = join(root, ...entry.path.split('/'))
        const stat = await lstat(absolute)
        if (!stat.isFile()) throw new Error(`remote Graph artifact Provider materialized a non-file: ${entry.path}`)
        const bytes = await readFile(absolute)
        totalBytes += bytes.byteLength
        if (totalBytes > artifact.maxBytes || bytes.byteLength !== entry.size || hashBytes(bytes) !== entry.sha256) {
          throw new Error(`remote Graph artifact Provider materialization failed verification: ${entry.path}`)
        }
        transferred.push({ path: entry.path, sha256: entry.sha256, size: entry.size, mode: entry.mode, bytes: bytes.toString('base64') })
      }
      return transferred
    })
    json(response, 200, { protocolVersion: 1, files })
  }

  private async artifactReconcile(payload: unknown, response: ServerResponse): Promise<void> {
    const artifact = this.requireArtifact()
    const parsed = artifactReconcileSchema.parse(payload).request
    const row = this.findArtifact(parsed.manifestId)
    if (row === undefined) {
      json(response, 200, { status: 'absent', evidence: `remote artifact manifest ${parsed.manifestId} is absent` })
      return
    }
    if (row.public_reference !== parsed.providerReference) throw new Error('remote Graph artifact reference does not match the durable manifest')
    const internal = artifactManifestSchema.parse(JSON.parse(row.internal_json))
    if (internal.provider !== artifact.providerName) throw new Error('remote Graph artifact reference targets another Provider')
    const request: GraphArtifactReconcileRequest = {
      manifestId: GraphArtifactManifestId(parsed.manifestId),
      providerReference: internal.providerReference,
      safeToDelete: parsed.safeToDelete,
      signal: this.operationSignal(),
    }
    const result = await artifact.graphArtifacts.reconcile(artifact.providerName, request)
    if (result.status === 'deleted' || result.status === 'absent') {
      this.database.prepare('DELETE FROM artifacts WHERE manifest_id = ? AND public_reference = ?')
        .run(parsed.manifestId, parsed.providerReference)
    }
    json(response, 200, result)
  }

  private internalArtifactManifest(value: z.infer<typeof artifactManifestSchema>): GraphArtifactManifest {
    const row = this.findArtifact(value.id)
    if (row === undefined || row.public_reference !== value.providerReference || row.public_json !== JSON.stringify(value)) {
      throw new Error('remote Graph artifact manifest differs from its durable public record')
    }
    return artifactManifest(artifactManifestSchema.parse(JSON.parse(row.internal_json)))
  }

  private publishArtifact(publicManifest: GraphArtifactManifest, internalManifest: GraphArtifactManifest): GraphArtifactManifest {
    const publicJson = JSON.stringify(artifactManifestSchema.parse(publicManifest))
    const internalJson = JSON.stringify(artifactManifestSchema.parse(internalManifest))
    this.database.prepare(`
      INSERT OR IGNORE INTO artifacts(manifest_id, public_reference, public_json, internal_json, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(publicManifest.id, publicManifest.providerReference, publicJson, internalJson, Date.now())
    const row = this.findArtifact(publicManifest.id)
    if (row === undefined || row.public_reference !== publicManifest.providerReference
      || row.public_json !== publicJson || row.internal_json !== internalJson) {
      throw new Error('remote Graph artifact identity conflicts with durable storage')
    }
    return artifactManifest(artifactManifestSchema.parse(JSON.parse(row.public_json)))
  }

  private findArtifact(manifestId: string): ArtifactRow | undefined {
    const value = this.database.prepare(`
      SELECT manifest_id, public_reference, public_json, internal_json
      FROM artifacts WHERE manifest_id = ?
    `).get(manifestId)
    return value === undefined ? undefined : artifactRow(value)
  }

  private async withArtifactTemp<T>(action: (root: string) => Promise<T>): Promise<T> {
    const artifact = this.requireArtifact()
    await mkdir(artifact.tempRoot, { recursive: true, mode: 0o700 })
    const privateRoot = await realpath(resolve(artifact.tempRoot))
    const root = await mkdtemp(join(privateRoot, 'transfer-'))
    if (!inside(privateRoot, root)) throw new Error('remote Graph artifact temporary path escaped its private root')
    try {
      return await action(root)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }

  private async writeArtifactTemp(root: string, path: string, bytes: Uint8Array, mode: number): Promise<void> {
    const destination = join(root, ...safeRelative(path).split('/'))
    const parent = dirname(destination)
    await mkdir(parent, { recursive: true, mode: 0o700 })
    if (!inside(root, await realpath(parent))) throw new Error(`remote Graph artifact upload path escapes through a link: ${path}`)
    await writeFileAtomic(destination, bytes, { mode: 0o600, dirMode: 0o700 })
    await chmod(destination, mode & 0o777)
  }

  private publicSnapshot(snapshot: GraphResourceSnapshot, routeName: string): GraphResourceSnapshot {
    return { ...snapshot, providerId: routeName }
  }

  private publicDecision(decision: GraphResourceDecision, routeName: string): GraphResourceDecision {
    if (decision.status !== 'granted') {
      return { ...decision, snapshot: this.publicSnapshot(decision.snapshot, routeName) }
    }
    return {
      status: 'granted',
      reservation: {
        ...decision.reservation,
        providerId: routeName,
        snapshot: this.publicSnapshot(decision.reservation.snapshot, routeName),
      },
    }
  }

  private requireResource(): NonNullable<HttpGraphWorkerServerOptions['resource']> {
    const resource = this.options.resource
    if (resource === undefined) throw new Error('remote Graph resource route is not configured')
    return resource
  }

  private requireArtifact(): NonNullable<HttpGraphWorkerServerOptions['artifact']> {
    const artifact = this.options.artifact
    if (artifact === undefined) throw new Error('remote Graph artifact route is not configured')
    return artifact
  }

  private requireScheduler(): NonNullable<HttpGraphWorkerServerOptions['scheduler']> {
    const scheduler = this.options.scheduler
    if (scheduler === undefined) throw new Error('remote Graph scheduler route is not configured')
    return scheduler
  }

  private operationSignal(): AbortSignal {
    return AbortSignal.timeout(this.options.operationTimeoutMs)
  }

  private addressed(value: z.infer<typeof authoritySchema>): JobRow {
    const row = this.findJob(GraphWorkerRemoteJobId(value.jobId))
    if (row === undefined) throw new Error('remote Graph Worker job is absent')
    const authority = parseAuthority(row.authority_json)
    for (const key of ['workId', 'operationId', 'attemptId', 'runId', 'generationId', 'ownerEpoch', 'fencingToken'] as const) {
      if (authority[key] !== value[key]) throw new Error(`remote Graph Worker ${key} does not match the durable job`)
    }
    return row
  }

  private findJob(jobId: GraphWorkerRemoteJobId): JobRow | undefined {
    const value = this.database.prepare('SELECT * FROM jobs WHERE job_id = ?').get(jobId)
    return value === undefined ? undefined : jobRow(value)
  }
}
