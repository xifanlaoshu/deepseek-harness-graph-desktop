import { mkdtemp, mkdir, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import {
  GraphAttemptId,
  GraphControlOperationId,
  GraphRunGenerationId,
  GraphRunId,
  GraphWorkId,
} from '@deepseek-ai/dsh-graph'
import GraphArtifactRuntime, { type GraphArtifactCaptureRequest } from '@deepseek-ai/dsh-graph-artifacts'
import { runGraphArtifactProviderContract } from '../../graph-artifacts/tests/contract.ts'
import { GraphArtifactManifestId, GraphWorkspaceAllocationId } from '@deepseek-ai/dsh-graph-worker'
import { afterEach, describe, expect, it } from 'vitest'
import * as FilesystemArtifacts from '../src/index.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

runGraphArtifactProviderContract('filesystem', async () => {
  const mounted = await fixture()
  return {
    runtime: mounted.ctx.graphArtifacts,
    providerName: 'fs',
    capture: mounted.request,
    targetRoot: mounted.target,
    dispose: async () => { await mounted.ctx.fiber.dispose() },
  }
})

async function fixture(overrides: Partial<FilesystemArtifacts.Config> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-graph-artifacts-test-'))
  roots.push(root)
  const source = join(root, 'source')
  const target = join(root, 'target')
  const store = join(root, 'store')
  await mkdir(join(source, 'nested'), { recursive: true })
  await mkdir(target)
  await writeFile(join(source, 'result.txt'), 'done')
  await writeFile(join(source, 'nested', 'evidence.json'), '{"passed":true}')
  const ctx = new Context()
  await ctx.plugin(GraphArtifactRuntime).await()
  await ctx.plugin(FilesystemArtifacts, {
    providerName: 'fs', storeRoot: store, allowedWorkspaceRoots: [source], maxFiles: 10, maxBytes: 1_000,
    ...overrides,
  }).await()
  const request: GraphArtifactCaptureRequest = {
    workId: GraphWorkId('work-1'),
    operationId: GraphControlOperationId('operation-1'),
    attemptId: GraphAttemptId('attempt-1'),
    runId: GraphRunId('run-1'),
    generationId: GraphRunGenerationId('generation-1'),
    ownerEpoch: 1,
    fencingToken: 3,
    workspaceId: GraphWorkspaceAllocationId('workspace-1'),
    sourceRoot: source,
    workspaceReference: 'remote:workspace-1',
    paths: ['result.txt', 'nested'],
    maxFiles: 10,
    maxBytes: 1_000,
    deadline: Date.now() + 60_000,
    signal: new AbortController().signal,
  }
  return { ctx, request, root, source, target, store }
}

describe('filesystem Graph artifact Provider', () => {
  it('captures directories idempotently and materializes verified immutable blobs', async () => {
    const { ctx, request, target } = await fixture()
    const captureRequest = { ...request, baseContentHashes: { 'result.txt': null } }
    const first = await ctx.graphArtifacts.capture('fs', captureRequest)
    const second = await ctx.graphArtifacts.capture('fs', captureRequest)
    expect(second).toEqual(first)
    expect(first.entries.map(entry => entry.path)).toEqual(['nested/evidence.json', 'result.txt'])
    expect(first.entries.find(entry => entry.path === 'result.txt')?.baseSha256).toBeNull()
    expect(first.totalBytes).toBe(19)
    await expect(ctx.graphArtifacts.materialize('fs', {
      manifest: first, targetRoot: target, overwrite: 'forbid', signal: new AbortController().signal,
    })).resolves.toEqual({ paths: ['nested/evidence.json', 'result.txt'], totalBytes: 19 })
    await expect(readFile(join(target, 'result.txt'), 'utf8')).resolves.toBe('done')
    await expect(readFile(join(target, 'nested', 'evidence.json'), 'utf8')).resolves.toBe('{"passed":true}')
    await expect(ctx.graphArtifacts.materialize('fs', {
      manifest: first, targetRoot: target, overwrite: 'forbid', signal: new AbortController().signal,
    })).rejects.toThrow('already exists')
  })

  it('enforces workspace, path, file, and byte limits', async () => {
    const { ctx, request, root } = await fixture()
    await expect(ctx.graphArtifacts.capture('fs', { ...request, paths: ['../outside'] })).rejects.toThrow('source-relative')
    await expect(ctx.graphArtifacts.capture('fs', { ...request, maxFiles: 1 })).rejects.toThrow('exceeds maxFiles')
    await expect(ctx.graphArtifacts.capture('fs', { ...request, maxBytes: 3 })).rejects.toThrow('byte limit')
    const outside = join(root, 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'result.txt'), 'done')
    await expect(ctx.graphArtifacts.capture('fs', { ...request, sourceRoot: outside, paths: ['result.txt'] })).rejects.toThrow('allowedWorkspaceRoots')
  })

  it('rejects malformed selections and inaccessible source roots', async () => {
    const { ctx, request, root } = await fixture()
    await expect(ctx.graphArtifacts.capture('fs', { ...request, paths: [''] })).rejects.toThrow('non-empty')
    await expect(ctx.graphArtifacts.capture('fs', { ...request, paths: ['nested\\evidence.json'] })).rejects.toThrow('forward slashes')
    await expect(ctx.graphArtifacts.capture('fs', { ...request, paths: ['nested/../result.txt'] })).rejects.toThrow('normalized')
    const sourceFile = join(root, 'source-file')
    await writeFile(sourceFile, 'not a directory')
    await expect(ctx.graphArtifacts.capture('fs', { ...request, sourceRoot: sourceFile })).rejects.toThrow('accessible directory')
  })

  it('applies Provider ceilings below request ceilings and can trust deployment workspace policy', async () => {
    const fileLimited = await fixture({ maxFiles: 1 })
    await writeFile(join(fileLimited.source, 'nested', 'second.txt'), 'second')
    await expect(fileLimited.ctx.graphArtifacts.capture('fs', { ...fileLimited.request, paths: ['nested'] })).rejects.toThrow('file limit')
    const byteLimited = await fixture({ maxBytes: 3 })
    await expect(byteLimited.ctx.graphArtifacts.capture('fs', { ...byteLimited.request, paths: ['result.txt'] })).rejects.toThrow('byte limit')
    const unrestricted = await fixture({ allowedWorkspaceRoots: [] })
    await expect(unrestricted.ctx.graphArtifacts.capture('fs', unrestricted.request)).resolves.toMatchObject({ totalBytes: 19 })
  })

  it('detects corrupt blobs before materialization', async () => {
    const { ctx, request, target, store } = await fixture()
    const manifest = await ctx.graphArtifacts.capture('fs', request)
    const entry = manifest.entries[0]
    if (entry === undefined) throw new Error('fixture must produce an artifact')
    await writeFile(join(store, 'blobs', 'sha256', entry.sha256.slice(0, 2), entry.sha256), 'corrupt')
    await expect(ctx.graphArtifacts.materialize('fs', {
      manifest, targetRoot: target, overwrite: 'forbid', signal: new AbortController().signal,
    })).rejects.toThrow('failed verification')
  })

  it('detects an existing corrupt blob during idempotent recapture', async () => {
    const { ctx, request, store } = await fixture()
    const manifest = await ctx.graphArtifacts.capture('fs', request)
    const entry = manifest.entries[0]
    if (entry === undefined) throw new Error('fixture must produce an artifact')
    await writeFile(join(store, 'blobs', 'sha256', entry.sha256.slice(0, 2), entry.sha256), 'corrupt')
    await expect(ctx.graphArtifacts.capture('fs', request)).rejects.toThrow('blob storage is corrupt')
  })

  it('rejects missing, changed, or malformed immutable manifests', async () => {
    const { ctx, request, target, root } = await fixture()
    const manifest = await ctx.graphArtifacts.capture('fs', request)
    await expect(ctx.graphArtifacts.materialize('fs', {
      manifest: { ...manifest, createdAt: manifest.createdAt + 1 }, targetRoot: target, overwrite: 'forbid', signal: new AbortController().signal,
    })).rejects.toThrow('differs from immutable')
    const missing = { ...manifest, id: GraphArtifactManifestId(`artifact:${'f'.repeat(64)}`) }
    await expect(ctx.graphArtifacts.materialize('fs', {
      manifest: missing, targetRoot: target, overwrite: 'forbid', signal: new AbortController().signal,
    })).rejects.toThrow('is absent')
    const targetFile = join(root, 'target-file')
    await writeFile(targetFile, 'not a directory')
    await expect(ctx.graphArtifacts.materialize('fs', {
      manifest, targetRoot: targetFile, overwrite: 'forbid', signal: new AbortController().signal,
    })).rejects.toThrow('accessible directory')
    await writeFile(manifest.providerReference.slice(3), '{broken json')
    await expect(ctx.graphArtifacts.materialize('fs', {
      manifest, targetRoot: target, overwrite: 'forbid', signal: new AbortController().signal,
    })).rejects.toThrow()
  })

  it('rejects linked target parents and non-file entries during materialization', async () => {
    const { ctx, request, target, root } = await fixture()
    const manifest = await ctx.graphArtifacts.capture('fs', { ...request, paths: ['nested/evidence.json'] })
    const outside = join(root, 'outside-target')
    await mkdir(outside)
    await symlink(outside, join(target, 'nested'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(ctx.graphArtifacts.materialize('fs', {
      manifest, targetRoot: target, overwrite: 'forbid', signal: new AbortController().signal,
    })).rejects.toThrow('escapes through a link')
    await unlink(join(target, 'nested'))
    const entry = manifest.entries[0]
    if (entry === undefined) throw new Error('fixture must produce an artifact')
    const linked = { ...manifest, entries: [{ ...entry, kind: 'symlink' as const }] }
    await writeFile(manifest.providerReference.slice(3), JSON.stringify(linked))
    await expect(ctx.graphArtifacts.materialize('fs', {
      manifest: linked, targetRoot: target, overwrite: 'forbid', signal: new AbortController().signal,
    })).rejects.toThrow('cannot materialize symlink')
  })

  it('supports explicit replacement but refuses to replace a directory', async () => {
    const { ctx, request, target } = await fixture()
    const manifest = await ctx.graphArtifacts.capture('fs', { ...request, paths: ['result.txt'] })
    await ctx.graphArtifacts.materialize('fs', { manifest, targetRoot: target, overwrite: 'forbid', signal: new AbortController().signal })
    await writeFile(join(target, 'result.txt'), 'changed')
    await expect(ctx.graphArtifacts.materialize('fs', {
      manifest, targetRoot: target, overwrite: 'replace', signal: new AbortController().signal,
    })).resolves.toMatchObject({ totalBytes: 4 })
    await rm(join(target, 'result.txt'))
    await mkdir(join(target, 'result.txt'))
    await expect(ctx.graphArtifacts.materialize('fs', {
      manifest, targetRoot: target, overwrite: 'replace', signal: new AbortController().signal,
    })).rejects.toThrow('existing directory')
  })

  it('rejects symlinks instead of transporting execution-world-specific targets', async () => {
    const { ctx, request, source } = await fixture()
    const linkPath = join(source, 'link')
    await symlink(join(source, 'nested'), linkPath, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(ctx.graphArtifacts.capture('fs', { ...request, paths: ['link'] })).rejects.toThrow('not a regular file or directory')
  })

  it('reconciles only the exact unreferenced manifest and retains shared blobs', async () => {
    const { ctx, request } = await fixture()
    const manifest = await ctx.graphArtifacts.capture('fs', request)
    const base = { manifestId: manifest.id, providerReference: manifest.providerReference, signal: new AbortController().signal }
    await expect(ctx.graphArtifacts.reconcile('fs', { ...base, safeToDelete: false })).resolves.toMatchObject({ status: 'retained' })
    await expect(ctx.graphArtifacts.reconcile('fs', { ...base, providerReference: 'fs:wrong', safeToDelete: true })).resolves.toMatchObject({ status: 'quarantined' })
    await expect(ctx.graphArtifacts.reconcile('fs', { ...base, safeToDelete: true })).resolves.toMatchObject({ status: 'deleted' })
    await expect(ctx.graphArtifacts.reconcile('fs', { ...base, safeToDelete: true })).resolves.toMatchObject({ status: 'absent' })
    await expect(ctx.graphArtifacts.reconcile('fs', {
      ...base, manifestId: GraphArtifactManifestId('invalid'), safeToDelete: true,
    })).rejects.toThrow('manifest id is invalid')
  })

  it('fails loud on invalid Provider deployment configuration', async () => {
    const ctx = new Context()
    await ctx.plugin(GraphArtifactRuntime).await()
    const config = (providerName: string, storeRoot: string, allowedWorkspaceRoots: string[]): FilesystemArtifacts.Config => ({
      providerName, storeRoot, allowedWorkspaceRoots, maxFiles: 1, maxBytes: 1,
    })
    await expect(FilesystemArtifacts.apply(ctx, config(' ', '.sessions/test-artifacts', []))).rejects.toThrow('providerName')
    await expect(FilesystemArtifacts.apply(ctx, config('fs', ' ', []))).rejects.toThrow('storeRoot')
    await expect(FilesystemArtifacts.apply(ctx, config('fs', '.sessions/test-artifacts', ['relative']))).rejects.toThrow('absolute paths')
  })
})
