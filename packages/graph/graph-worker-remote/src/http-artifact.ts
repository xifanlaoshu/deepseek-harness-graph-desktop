/** Authenticated content-addressed artifact transfer over a remote Worker service. @module */

import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, readdir, realpath, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, posix, resolve, sep } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type {
  GraphArtifactCaptureRequest,
  GraphArtifactMaterializeRequest,
  GraphArtifactMaterializeResult,
  GraphArtifactProvider,
  GraphArtifactReconcileRequest,
  GraphArtifactReconcileResult,
} from '@deepseek-ai/dsh-graph-artifacts'
import {
  GraphAttemptId,
  GraphControlOperationId,
  GraphRunGenerationId,
  GraphRunId,
  GraphWorkId,
} from '@deepseek-ai/dsh-graph'
import {
  GraphArtifactManifestId,
  type GraphArtifactManifest,
} from '@deepseek-ai/dsh-graph-worker'
import { z } from 'zod'
import { AuthenticatedGraphHttpTransport, type AuthenticatedGraphHttpOptions } from './http-transport.ts'

/** Local filesystem and transfer policy for one authenticated Artifact route. */
export interface HttpGraphArtifactOptions extends AuthenticatedGraphHttpOptions {
  readonly providerName: string
  readonly allowedCaptureRoots: readonly string[]
  readonly allowedMaterializeRoots: readonly string[]
  readonly maxTransferFiles: number
  readonly maxTransferBytes: number
}

interface TransferFile {
  readonly path: string
  readonly sha256: string
  readonly size: number
  readonly mode: number
  readonly bytes: string
}

interface TransferCollection {
  readonly files: Map<string, TransferFile>
  totalBytes: number
}

const text = z.string().min(1).max(4_000)
const safeNonNegative = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const safePositive = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
const entrySchema = z.object({
  path: text,
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  baseSha256: z.string().regex(/^[a-f0-9]{64}$/u).nullable().optional(),
  size: safeNonNegative,
  mode: safeNonNegative,
  kind: z.literal('file'),
}).strict()
const manifestSchema = z.object({
  id: text,
  algorithm: z.literal('sha256'),
  provider: text,
  workId: text,
  operationId: text,
  attemptId: text,
  runId: text,
  generationId: text,
  ownerEpoch: safePositive,
  fencingToken: safePositive,
  createdAt: safeNonNegative,
  totalBytes: safeNonNegative,
  entries: z.array(entrySchema),
  providerReference: text,
}).strict()
const fileSchema = z.object({
  path: text,
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  size: safeNonNegative,
  mode: safeNonNegative,
  bytes: z.string(),
}).strict()
const materializeResponseSchema = z.object({ protocolVersion: z.literal(1), files: z.array(fileSchema) }).strict()
const reconcileSchema = z.object({
  status: z.enum(['deleted', 'retained', 'absent', 'quarantined']),
  evidence: text,
}).strict()

function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
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

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code
}

/** Authenticated Artifact Provider that uploads and downloads bounded immutable files. */
export class HttpGraphArtifactProvider implements GraphArtifactProvider {
  readonly persistent = true
  readonly remote = true
  readonly name: string
  private readonly transport: AuthenticatedGraphHttpTransport

  /**
   * Create an authenticated artifact route with explicit local path policy.
   * @param options - service identity, credential resolver, filesystem allowlists, and transfer bounds.
   */
  constructor(private readonly options: HttpGraphArtifactOptions) {
    if (!options.providerName.trim()) throw new Error('HTTP graph artifact providerName must be non-empty')
    if (!Number.isSafeInteger(options.maxTransferFiles) || options.maxTransferFiles < 1) {
      throw new Error('HTTP graph artifact maxTransferFiles must be positive')
    }
    if (!Number.isSafeInteger(options.maxTransferBytes) || options.maxTransferBytes < 1) {
      throw new Error('HTTP graph artifact maxTransferBytes must be positive')
    }
    for (const root of [...options.allowedCaptureRoots, ...options.allowedMaterializeRoots]) {
      if (!isAbsolute(root)) throw new Error('HTTP graph artifact allowed roots must be absolute')
    }
    this.name = options.providerName
    this.transport = new AuthenticatedGraphHttpTransport(options)
  }

  /** Upload selected regular files and return the service-owned immutable manifest. */
  async capture(request: GraphArtifactCaptureRequest): Promise<GraphArtifactManifest> {
    request.signal.throwIfAborted()
    const sourceRoot = await realpath(request.sourceRoot)
    await this.assertAllowed(sourceRoot, this.options.allowedCaptureRoots, 'capture')
    const collection: TransferCollection = { files: new Map(), totalBytes: 0 }
    for (const path of request.paths) await this.collect(sourceRoot, safeRelative(path), collection, request)
    const ordered = [...collection.files.values()].sort((left, right) => left.path.localeCompare(right.path))
    const parsed = manifestSchema.parse(await this.transport.post('/v1/artifacts/capture', {
      protocolVersion: 1,
      request: {
        workId: request.workId,
        operationId: request.operationId,
        attemptId: request.attemptId,
        runId: request.runId,
        generationId: request.generationId,
        ownerEpoch: request.ownerEpoch,
        fencingToken: request.fencingToken,
        workspaceId: request.workspaceId,
        workspaceReference: request.workspaceReference,
        paths: ordered.map(file => file.path),
        ...request.baseContentHashes === undefined ? {} : { baseContentHashes: request.baseContentHashes },
        maxFiles: request.maxFiles,
        maxBytes: request.maxBytes,
        deadline: request.deadline,
      },
      files: ordered,
    }, request.signal))
    return {
      ...parsed,
      id: GraphArtifactManifestId(parsed.id),
      workId: GraphWorkId(parsed.workId),
      operationId: GraphControlOperationId(parsed.operationId),
      attemptId: GraphAttemptId(parsed.attemptId),
      runId: GraphRunId(parsed.runId),
      generationId: GraphRunGenerationId(parsed.generationId),
      entries: parsed.entries.map(({ baseSha256, ...entry }) => ({
        ...entry,
        ...baseSha256 === undefined ? {} : { baseSha256 },
      })),
    }
  }

  /** Download, verify, and atomically materialize every manifest file locally. */
  async materialize(request: GraphArtifactMaterializeRequest): Promise<GraphArtifactMaterializeResult> {
    request.signal.throwIfAborted()
    const parsed = materializeResponseSchema.parse(await this.transport.post('/v1/artifacts/materialize', {
      protocolVersion: 1,
      manifest: request.manifest,
    }, request.signal))
    const targetRoot = await realpath(request.targetRoot)
    await this.assertAllowed(targetRoot, this.options.allowedMaterializeRoots, 'materialize')
    if (parsed.files.length !== request.manifest.entries.length) throw new Error('remote Graph artifact download is incomplete')
    if (parsed.files.length > this.options.maxTransferFiles || request.manifest.totalBytes > this.options.maxTransferBytes) {
      throw new Error('remote Graph artifact download exceeds local transfer bounds')
    }
    for (const [index, file] of parsed.files.entries()) {
      request.signal.throwIfAborted()
      const entry = request.manifest.entries[index]
      if (entry === undefined || entry.path !== file.path || entry.sha256 !== file.sha256
        || entry.size !== file.size || entry.mode !== file.mode || entry.kind !== 'file') {
        throw new Error('remote Graph artifact download differs from its manifest')
      }
      const bytes = Buffer.from(file.bytes, 'base64')
      if (bytes.byteLength !== file.size || hash(bytes) !== file.sha256) {
        throw new Error(`remote Graph artifact download failed verification: ${file.path}`)
      }
      await this.write(targetRoot, safeRelative(file.path), bytes, file.mode, request.overwrite)
    }
    return { paths: parsed.files.map(file => file.path), totalBytes: request.manifest.totalBytes }
  }

  /** Reconcile one exact service-owned manifest reference. */
  async reconcile(request: GraphArtifactReconcileRequest): Promise<GraphArtifactReconcileResult> {
    return reconcileSchema.parse(await this.transport.post('/v1/artifacts/reconcile', {
      protocolVersion: 1,
      request: { ...request, signal: undefined },
    }, request.signal))
  }

  private async collect(
    root: string,
    path: string,
    output: TransferCollection,
    request: GraphArtifactCaptureRequest,
  ): Promise<void> {
    request.signal.throwIfAborted()
    const absolute = join(root, ...path.split('/'))
    const stat = await lstat(absolute)
    if (stat.isDirectory()) {
      for (const child of (await readdir(absolute)).sort()) await this.collect(root, `${path}/${child}`, output, request)
      return
    }
    if (!stat.isFile()) throw new Error(`remote Graph artifact path is not a regular file or directory: ${path}`)
    const bytes = await readFile(absolute)
    if (output.files.has(path)) return
    const total = output.totalBytes + bytes.byteLength
    if (output.files.size + 1 > Math.min(request.maxFiles, this.options.maxTransferFiles)) {
      throw new Error('remote Graph artifact upload exceeds its file limit')
    }
    if (total > Math.min(request.maxBytes, this.options.maxTransferBytes)) {
      throw new Error('remote Graph artifact upload exceeds its byte limit')
    }
    output.files.set(path, {
      path,
      sha256: hash(bytes),
      size: bytes.byteLength,
      mode: stat.mode,
      bytes: bytes.toString('base64'),
    })
    output.totalBytes = total
  }

  private async assertAllowed(path: string, roots: readonly string[], operation: string): Promise<void> {
    if (roots.length === 0) return
    const allowed = await Promise.all(roots.map(root => realpath(resolve(root))))
    if (!allowed.some(root => inside(root, path))) throw new Error(`remote Graph artifact ${operation} path is outside its allowlist`)
  }

  private async write(
    root: string,
    path: string,
    bytes: Uint8Array,
    mode: number,
    overwrite: GraphArtifactMaterializeRequest['overwrite'],
  ): Promise<void> {
    const destination = join(root, ...path.split('/'))
    const parent = dirname(destination)
    await mkdir(parent, { recursive: true })
    const realParent = await realpath(parent)
    if (!inside(root, realParent)) throw new Error(`remote Graph artifact target escapes through a link: ${path}`)
    try {
      const existing = await lstat(destination)
      if (overwrite === 'forbid') throw new Error(`remote Graph artifact target already exists: ${path}`)
      if (existing.isDirectory()) throw new Error(`remote Graph artifact target is a directory: ${path}`)
      await unlink(destination)
    } catch (error) {
      if (errno(error) !== 'ENOENT') throw error
    }
    await writeFileAtomic(destination, bytes, { mode: 0o600, dirMode: 0o700 })
    await chmod(destination, mode & 0o777)
  }
}
