import { resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import {
  GraphAttemptId,
  GraphControlOperationId,
  GraphRunGenerationId,
  GraphRunId,
  GraphWorkId,
} from '@deepseek-ai/dsh-graph'
import {
  GraphArtifactManifestId,
  GraphWorkspaceAllocationId,
  type GraphArtifactManifest,
} from '@deepseek-ai/dsh-graph-worker'
import { describe, expect, it } from 'vitest'
import GraphArtifactRuntime, { type GraphArtifactCaptureRequest, type GraphArtifactProvider } from '../src/index.ts'

const captureRequest = (): GraphArtifactCaptureRequest => ({
  workId: GraphWorkId('work-1'),
  operationId: GraphControlOperationId('operation-1'),
  attemptId: GraphAttemptId('attempt-1'),
  runId: GraphRunId('run-1'),
  generationId: GraphRunGenerationId('generation-1'),
  ownerEpoch: 1,
  fencingToken: 2,
  workspaceId: GraphWorkspaceAllocationId('workspace-1'),
  sourceRoot: resolve('workspace'),
  workspaceReference: 'worker:workspace-1',
  paths: ['result.txt'],
  maxFiles: 2,
  maxBytes: 100,
  deadline: Date.now() + 60_000,
  signal: new AbortController().signal,
})

const manifest = (request: GraphArtifactCaptureRequest): GraphArtifactManifest => ({
  id: GraphArtifactManifestId(`artifact:${'a'.repeat(64)}`),
  algorithm: 'sha256',
  provider: 'test',
  workId: request.workId,
  operationId: request.operationId,
  attemptId: request.attemptId,
  runId: request.runId,
  generationId: request.generationId,
  ownerEpoch: request.ownerEpoch,
  fencingToken: request.fencingToken,
  createdAt: Date.now(),
  totalBytes: 4,
  entries: [{ path: 'result.txt', sha256: 'b'.repeat(64), size: 4, mode: 0o600, kind: 'file' }],
  providerReference: 'test:artifact',
})

const provider = (): GraphArtifactProvider => ({
  name: 'test',
  persistent: true,
  remote: false,
  capture: request => Promise.resolve(manifest(request)),
  materialize: request => Promise.resolve({
    paths: request.manifest.entries.map(entry => entry.path),
    totalBytes: request.manifest.totalBytes,
  }),
  reconcile: () => Promise.resolve({ status: 'retained' as const, evidence: 'manifest remains referenced' }),
})

describe('graph artifact service', () => {
  it('registers, validates, dispatches, lists, and disposes Providers', async () => {
    const ctx = new Context()
    await ctx.plugin(GraphArtifactRuntime).await()
    const transport = provider()
    const dispose = ctx.graphArtifacts.register(transport)
    expect(ctx.graphArtifacts.list()).toEqual([{ name: 'test', persistent: true, remote: false }])
    const request = captureRequest()
    const captured = await ctx.graphArtifacts.capture('test', request)
    await expect(ctx.graphArtifacts.materialize('test', {
      manifest: captured,
      targetRoot: resolve('target'),
      overwrite: 'forbid',
      signal: new AbortController().signal,
    })).resolves.toEqual({ paths: ['result.txt'], totalBytes: 4 })
    await expect(ctx.graphArtifacts.reconcile('test', {
      manifestId: captured.id,
      providerReference: captured.providerReference,
      safeToDelete: false,
      signal: new AbortController().signal,
    })).resolves.toEqual({ status: 'retained', evidence: 'manifest remains referenced' })
    dispose()
    await expect(ctx.graphArtifacts.capture('test', request)).rejects.toThrow('unknown graph artifact provider')
  })

  it('rejects invalid bounds and Provider manifests at the service boundary', async () => {
    const ctx = new Context()
    await ctx.plugin(GraphArtifactRuntime).await()
    const bad = provider()
    bad.capture = request => Promise.resolve({ ...manifest(request), totalBytes: 3 })
    ctx.graphArtifacts.register(bad)
    await expect(ctx.graphArtifacts.capture('test', captureRequest())).rejects.toThrow('totalBytes')
    await expect(ctx.graphArtifacts.capture('test', { ...captureRequest(), maxFiles: 0 })).rejects.toThrow('maxFiles')
    await expect(ctx.graphArtifacts.capture('missing', captureRequest())).rejects.toThrow('unknown graph artifact provider')
  })

  it('rejects invalid registrations and capture requests before Provider dispatch', async () => {
    const ctx = new Context()
    await ctx.plugin(GraphArtifactRuntime).await()
    expect(() => { ctx.graphArtifacts.register({ ...provider(), name: ' ' }) }).toThrow('name must be non-empty')
    const transport = provider()
    const dispose = ctx.graphArtifacts.register(transport)
    expect(() => { ctx.graphArtifacts.register(provider()) }).toThrow('already registered')
    await expect(ctx.graphArtifacts.capture('test', { ...captureRequest(), maxFiles: Number.NaN })).rejects.toThrow('maxFiles')
    await expect(ctx.graphArtifacts.capture('test', { ...captureRequest(), maxBytes: 0 })).rejects.toThrow('maxBytes')
    await expect(ctx.graphArtifacts.capture('test', { ...captureRequest(), deadline: 1.5 })).rejects.toThrow('deadline')
    await expect(ctx.graphArtifacts.capture('test', { ...captureRequest(), deadline: Date.now() - 1 })).rejects.toThrow('deadline')
    await expect(ctx.graphArtifacts.capture('test', { ...captureRequest(), sourceRoot: '' })).rejects.toThrow('source references')
    await expect(ctx.graphArtifacts.capture('test', { ...captureRequest(), workspaceReference: '' })).rejects.toThrow('source references')
    await expect(ctx.graphArtifacts.capture('test', { ...captureRequest(), paths: ['a', 'b', 'c'] })).rejects.toThrow('exceeds maxFiles')
    dispose()
    dispose()
  })

  it('rejects mismatched Provider ownership and capture results over either bound', async () => {
    const ctx = new Context()
    await ctx.plugin(GraphArtifactRuntime).await()
    const transport = provider()
    ctx.graphArtifacts.register(transport)
    transport.capture = request => Promise.resolve({ ...manifest(request), provider: 'other' })
    await expect(ctx.graphArtifacts.capture('test', captureRequest())).rejects.toThrow('manifest for other')
    transport.capture = request => Promise.resolve({
      ...manifest(request),
      totalBytes: 8,
      entries: [
        { path: 'a.txt', sha256: 'a'.repeat(64), size: 4, mode: 0o600, kind: 'file' },
        { path: 'b.txt', sha256: 'b'.repeat(64), size: 4, mode: 0o600, kind: 'file' },
      ],
    })
    await expect(ctx.graphArtifacts.capture('test', { ...captureRequest(), maxFiles: 1, paths: ['result.txt'] })).rejects.toThrow('exceeded capture bounds')
    await expect(ctx.graphArtifacts.capture('test', { ...captureRequest(), maxBytes: 7 })).rejects.toThrow('exceeded capture bounds')
  })

  it('validates materialization reports and reconciliation references', async () => {
    const ctx = new Context()
    await ctx.plugin(GraphArtifactRuntime).await()
    const transport = provider()
    ctx.graphArtifacts.register(transport)
    const captured = manifest(captureRequest())
    const materialize = (targetRoot = resolve('target')) => ctx.graphArtifacts.materialize('test', {
      manifest: captured, targetRoot, overwrite: 'forbid', signal: new AbortController().signal,
    })
    await expect(materialize('')).rejects.toThrow('targetRoot')
    transport.materialize = () => Promise.resolve({ paths: ['result.txt'], totalBytes: Number.NaN })
    await expect(materialize()).rejects.toThrow('byte count')
    transport.materialize = () => Promise.resolve({ paths: ['result.txt'], totalBytes: 3 })
    await expect(materialize()).rejects.toThrow('byte count')
    transport.materialize = () => Promise.resolve({ paths: [], totalBytes: 4 })
    await expect(materialize()).rejects.toThrow('complete manifest')
    transport.materialize = () => Promise.resolve({ paths: ['wrong.txt'], totalBytes: 4 })
    await expect(materialize()).rejects.toThrow('complete manifest')

    const reconcile = (manifestId = captured.id, providerReference = captured.providerReference) => ctx.graphArtifacts.reconcile('test', {
      manifestId, providerReference, safeToDelete: false, signal: new AbortController().signal,
    })
    await expect(reconcile(GraphArtifactManifestId(''))).rejects.toThrow('references')
    await expect(reconcile(captured.id, '')).rejects.toThrow('references')
    transport.reconcile = () => Promise.resolve({ status: 'retained', evidence: '' })
    await expect(reconcile()).rejects.toThrow('evidence')
    transport.reconcile = () => Promise.resolve({ status: 'retained', evidence: 'x'.repeat(4_001) })
    await expect(reconcile()).rejects.toThrow('evidence')
  })
})
