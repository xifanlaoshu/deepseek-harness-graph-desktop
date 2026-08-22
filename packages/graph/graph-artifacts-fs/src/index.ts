/** Persistent filesystem Graph artifact transport Provider. @module @deepseek-ai/dsh-graph-artifacts-fs */

import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, readdir, realpath, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, posix, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type {
  GraphArtifactCaptureRequest,
  GraphArtifactMaterializeRequest,
  GraphArtifactMaterializeResult,
  GraphArtifactProvider,
  GraphArtifactReconcileRequest,
  GraphArtifactReconcileResult,
} from '@deepseek-ai/dsh-graph-artifacts'
import {
  GraphArtifactManifestId,
  type GraphArtifactEntry,
  type GraphArtifactManifest,
} from '@deepseek-ai/dsh-graph-worker'
import z from '@deepseek-ai/schemastery'

export const name = 'graph-artifacts-fs'
export const inject = ['graphArtifacts']

/** Filesystem storage and admission settings. */
export interface Config {
  /** Provider name selected by Worker adapters. */
  readonly providerName: string
  /** Private filesystem root for immutable blobs and manifests. */
  readonly storeRoot: string
  /** Optional absolute roots allowed as capture sources; empty trusts Graph deployment workspace policy. */
  readonly allowedWorkspaceRoots: string[]
  /** Provider hard ceiling for files in one manifest. */
  readonly maxFiles: number
  /** Provider hard ceiling for bytes in one manifest. */
  readonly maxBytes: number
}

/** Plugin configuration schema. */
export const Config: z<Config> = z.object({
  providerName: z.string().default('fs-artifacts'),
  storeRoot: z.string().default('.sessions/graph-artifacts'),
  allowedWorkspaceRoots: z.array(z.string()).default([]),
  maxFiles: z.natural().min(1).max(100_000).default(10_000),
  maxBytes: z.natural().min(1).default(536_870_912),
})

interface CapturedFile {
  readonly entry: GraphArtifactEntry
  readonly bytes: Uint8Array
}

const hash = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex')
const inside = (root: string, path: string): boolean => path === root || path.startsWith(`${root}${sep}`)
const errorCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException).code

const safeRelative = (value: string): string => {
  if (!value.trim() || value.includes('\\')) throw new Error('graph artifact path must be non-empty and use forward slashes')
  const normalized = posix.normalize(value)
  if (normalized !== value || normalized === '.' || normalized === '..' || normalized.startsWith('../') || normalized.startsWith('/')) {
    throw new Error(`graph artifact path is not normalized and source-relative: ${value}`)
  }
  return normalized
}

class FilesystemGraphArtifactProvider implements GraphArtifactProvider {
  readonly persistent = true
  readonly remote = false
  private readonly root: string

  constructor(readonly name: string, private readonly config: Config) {
    this.root = resolve(config.storeRoot)
  }

  async capture(request: GraphArtifactCaptureRequest): Promise<GraphArtifactManifest> {
    request.signal.throwIfAborted()
    const sourceRoot = await realpath(request.sourceRoot)
    if (!(await lstat(sourceRoot)).isDirectory()) throw new Error('graph artifact sourceRoot must be an accessible directory')
    await this.assertAllowedSource(sourceRoot)
    const selected = new Map<string, CapturedFile>()
    for (const path of request.paths) await this.capturePath(sourceRoot, safeRelative(path), selected, request)
    const captured = [...selected.values()].sort((left, right) => left.entry.path.localeCompare(right.entry.path))
    const limitBytes = Math.min(request.maxBytes, this.config.maxBytes)
    let totalBytes = 0
    for (const item of captured) {
      totalBytes += item.entry.size
      if (totalBytes > limitBytes) throw new Error(`graph artifact capture exceeds the ${String(limitBytes)} byte limit`)
      request.signal.throwIfAborted()
      await this.writeBlob(item.entry.sha256, item.bytes)
    }
    const entries = captured.map(item => ({
      ...item.entry,
      ...request.baseContentHashes?.[item.entry.path] === undefined
        ? {}
        : { baseSha256: request.baseContentHashes[item.entry.path] },
    }))
    const digest = hash(JSON.stringify({
      workId: request.workId,
      operationId: request.operationId,
      attemptId: request.attemptId,
      runId: request.runId,
      generationId: request.generationId,
      ownerEpoch: request.ownerEpoch,
      fencingToken: request.fencingToken,
      entries,
    }))
    const id = GraphArtifactManifestId(`artifact:${digest}`)
    const manifestPath = this.manifestPath(id)
    const existing = await this.readManifestIfPresent(manifestPath)
    if (existing !== undefined) return existing
    const manifest: GraphArtifactManifest = {
      id,
      algorithm: 'sha256',
      provider: this.name,
      workId: request.workId,
      operationId: request.operationId,
      attemptId: request.attemptId,
      runId: request.runId,
      generationId: request.generationId,
      ownerEpoch: request.ownerEpoch,
      fencingToken: request.fencingToken,
      createdAt: Date.now(),
      totalBytes,
      entries,
      providerReference: `fs:${manifestPath}`,
    }
    await this.writeImmutable(manifestPath, Buffer.from(JSON.stringify(manifest)), true)
    const stored = await this.readManifestIfPresent(manifestPath)
    /* v8 ignore next -- the writer lock keeps the published manifest present until this same capture returns. */
    if (stored === undefined) throw new Error('graph artifact manifest disappeared after publication')
    return stored
  }

  async materialize(request: GraphArtifactMaterializeRequest): Promise<GraphArtifactMaterializeResult> {
    request.signal.throwIfAborted()
    const stored = await this.loadManifest(request.manifest.id)
    if (JSON.stringify(stored) !== JSON.stringify(request.manifest)) throw new Error('graph artifact manifest differs from immutable Provider storage')
    const targetRoot = await realpath(request.targetRoot)
    if (!(await lstat(targetRoot)).isDirectory()) throw new Error('graph artifact targetRoot must be an accessible directory')
    for (const entry of stored.entries) {
      request.signal.throwIfAborted()
      const destination = join(targetRoot, ...entry.path.split('/'))
      const parent = dirname(destination)
      await mkdir(parent, { recursive: true })
      const realParent = await realpath(parent)
      if (!inside(targetRoot, realParent)) throw new Error(`graph artifact target path escapes through a link: ${entry.path}`)
      await this.prepareDestination(destination, request.overwrite)
      const bytes = await readFile(this.blobPath(entry.sha256))
      if (bytes.byteLength !== entry.size || hash(bytes) !== entry.sha256) throw new Error(`graph artifact blob failed verification: ${entry.path}`)
      if (entry.kind !== 'file') throw new Error(`filesystem Graph artifact Provider cannot materialize ${entry.kind} entries`)
      await this.writeImmutable(destination, bytes)
      await chmod(destination, entry.mode & 0o777)
    }
    return { paths: stored.entries.map(entry => entry.path), totalBytes: stored.totalBytes }
  }

  async reconcile(request: GraphArtifactReconcileRequest): Promise<GraphArtifactReconcileResult> {
    request.signal.throwIfAborted()
    const path = this.manifestPath(request.manifestId)
    if (request.providerReference !== `fs:${path}`) return { status: 'quarantined', evidence: `artifact ${request.manifestId} has a mismatched filesystem reference` }
    try {
      await lstat(path)
    } catch (error) {
      /* v8 ignore else -- non-ENOENT lstat failures require a host filesystem fault. */
      if (errorCode(error) === 'ENOENT') return { status: 'absent', evidence: `artifact manifest ${request.manifestId} is absent` }
      /* v8 ignore next -- the original host filesystem failure remains authoritative. */
      throw error
    }
    if (!request.safeToDelete) return { status: 'retained', evidence: `artifact manifest ${request.manifestId} remains referenced by Graph evidence` }
    await unlink(path)
    return { status: 'deleted', evidence: `deleted unreferenced artifact manifest ${request.manifestId}; shared content blobs were retained` }
  }

  private async capturePath(
    root: string,
    path: string,
    output: Map<string, CapturedFile>,
    request: GraphArtifactCaptureRequest,
  ): Promise<void> {
    request.signal.throwIfAborted()
    const absolute = join(root, ...path.split('/'))
    const stat = await lstat(absolute)
    if (stat.isDirectory()) {
      const children = (await readdir(absolute)).sort()
      for (const child of children) await this.capturePath(root, `${path}/${child}`, output, request)
      return
    }
    let bytes: Uint8Array
    let kind: GraphArtifactEntry['kind']
    if (stat.isFile()) {
      bytes = await readFile(absolute)
      kind = 'file'
    } else {
      throw new Error(`graph artifact path is not a regular file or directory: ${path}`)
    }
    output.set(path, { entry: { path, sha256: hash(bytes), size: bytes.byteLength, mode: stat.mode, kind }, bytes })
    if (output.size > Math.min(request.maxFiles, this.config.maxFiles)) throw new Error('graph artifact capture exceeds its file limit')
  }

  private async assertAllowedSource(sourceRoot: string): Promise<void> {
    if (this.config.allowedWorkspaceRoots.length === 0) return
    const allowed = await Promise.all(this.config.allowedWorkspaceRoots.map(path => realpath(resolve(path))))
    if (!allowed.some(root => inside(root, sourceRoot))) throw new Error('graph artifact sourceRoot is outside allowedWorkspaceRoots')
  }

  private blobPath(digest: string): string {
    return join(this.root, 'blobs', 'sha256', digest.slice(0, 2), digest)
  }

  private manifestPath(id: GraphArtifactManifestId): string {
    const match = /^artifact:([a-f0-9]{64})$/u.exec(String(id))
    if (match?.[1] === undefined) throw new Error('graph artifact manifest id is invalid')
    return join(this.root, 'manifests', `${match[1]}.json`)
  }

  private async writeBlob(digest: string, bytes: Uint8Array): Promise<void> {
    const path = this.blobPath(digest)
    await this.writeImmutable(path, bytes, true)
    const stored = await readFile(path)
    if (stored.byteLength !== bytes.byteLength || hash(stored) !== digest) throw new Error(`graph artifact blob storage is corrupt: ${digest}`)
  }

  private async writeImmutable(path: string, bytes: Uint8Array, acceptExisting = false): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await withFileLock(path, async () => {
      let existing: Buffer | undefined
      try {
        existing = await readFile(path)
      } catch (error) {
        /* v8 ignore next -- non-ENOENT reads require a host filesystem fault; the original error remains authoritative. */
        if (errorCode(error) !== 'ENOENT') throw error
      }
      if (existing !== undefined) {
        /* v8 ignore else -- only a second writer racing the caller's adjacent destination probe reaches the false arm. */
        if (acceptExisting) return
        /* v8 ignore next -- the racing destination is never overwritten. */
        throw new Error(`graph artifact immutable destination differs: ${path}`)
      }
      await writeFileAtomic(path, bytes, { mode: 0o600, dirMode: 0o700 })
    })
  }

  private async readManifestIfPresent(path: string): Promise<GraphArtifactManifest | undefined> {
    try {
      return JSON.parse(await readFile(path, 'utf8')) as GraphArtifactManifest
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return undefined
      throw error
    }
  }

  private async loadManifest(id: GraphArtifactManifestId): Promise<GraphArtifactManifest> {
    const manifest = await this.readManifestIfPresent(this.manifestPath(id))
    if (manifest === undefined) throw new Error(`graph artifact manifest ${id} is absent`)
    return manifest
  }

  private async prepareDestination(path: string, overwrite: GraphArtifactMaterializeRequest['overwrite']): Promise<void> {
    try {
      const stat = await lstat(path)
      if (overwrite === 'forbid') throw new Error(`graph artifact destination already exists: ${path}`)
      if (stat.isDirectory() && !stat.isSymbolicLink()) throw new Error(`graph artifact destination is an existing directory: ${path}`)
      await unlink(path)
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error
    }
  }
}

/** Register the persistent filesystem artifact Provider. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  if (!config.providerName.trim()) throw new Error('graph-artifacts-fs providerName must be non-empty')
  if (!config.storeRoot.trim()) throw new Error('graph-artifacts-fs storeRoot must be non-empty')
  for (const root of config.allowedWorkspaceRoots) {
    if (!root.trim() || !isAbsolute(root)) throw new Error('graph-artifacts-fs allowedWorkspaceRoots must contain absolute paths')
  }
  const provider = new FilesystemGraphArtifactProvider(config.providerName, config)
  await mkdir(resolve(config.storeRoot), { recursive: true })
  ctx.effect(() => ctx.graphArtifacts.register(provider), 'graph-artifacts-fs: provider registration')
}
