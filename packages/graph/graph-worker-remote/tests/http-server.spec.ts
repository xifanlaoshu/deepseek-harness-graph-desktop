import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Context } from '@deepseek-ai/cordis'
import type {
  GraphArtifactCaptureRequest,
  GraphArtifactMaterializeRequest,
  GraphArtifactReconcileRequest,
} from '@deepseek-ai/dsh-graph-artifacts'
import {
  GraphAttemptId,
  GraphControlOperationId,
  GraphNodeId,
  GraphRoleId,
  GraphRunGenerationId,
  GraphRunId,
  GraphWorkId,
  defaultGraphNodeExecutionBudget,
  defaultGraphOutputSchema,
} from '@deepseek-ai/dsh-graph'
import {
  GraphArtifactManifestId,
  GraphWorkerId,
  GraphWorkspaceAllocationId,
  type GraphWorkerAssignment,
  type GraphWorkerReconcileRequest,
  type GraphWorkerResult,
  type GraphWorkerRun,
  type GraphWorkspaceAllocation,
  type GraphArtifactManifest,
} from '@deepseek-ai/dsh-graph-worker'
import {
  GraphResourceReservationId,
  type GraphResourceOutcome,
  type GraphResourceReconcileRequest,
  type GraphResourceReservationRequest,
  type GraphResourceRoute,
} from '@deepseek-ai/dsh-graph-resources'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  GraphSchedulerLeaseId,
  GraphSchedulerOwnerId,
  type GraphSchedulerAcquireRequest,
  type GraphSchedulerLease,
  type GraphSchedulerLeaseRequest,
} from '@deepseek-ai/dsh-graph-scheduler'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import {
  GraphWorkerRemoteAudienceId,
  GraphWorkerRemotePrincipalId,
  HttpGraphWorkerProvider,
  HttpGraphWorkerServer,
  HttpGraphArtifactProvider,
  HttpGraphResourceProvider,
  HttpGraphSchedulerProvider,
  type HttpGraphWorkerOptions,
} from '../src/index.ts'
import { createWorkerTestParent } from '../../graph-worker/tests/parent.ts'

const principal = GraphWorkerRemotePrincipalId('graph-host-east')
const audience = GraphWorkerRemoteAudienceId('worker-west')
const secret = '0123456789abcdef0123456789abcdef'
const roots: string[] = []
const servers: Server[] = []
const services: HttpGraphWorkerServer[] = []
const parentContext = new Context()
const workerParent = await createWorkerTestParent(parentContext, SessionId('worker-service-parent'))
afterAll(async () => { await parentContext.fiber.dispose() })

interface Pending {
  resolve: (result: GraphWorkerResult) => void
  result: Promise<GraphWorkerResult>
}

class WorkerStub {
  starts = 0
  cancels = 0
  reconciliations: GraphWorkerReconcileRequest[] = []
  pending: Pending | undefined
  workspaceMode: GraphWorkspaceAllocation['mode'] = 'isolated-copy'

  async start(_name: string, _assignment: GraphWorkerAssignment): Promise<GraphWorkerRun> {
    this.starts += 1
    let settle!: Pending['resolve']
    const result = new Promise<GraphWorkerResult>((resolveResult) => { settle = resolveResult })
    this.pending = { resolve: settle, result }
    return {
      id: GraphWorkerId('actual-worker-1'),
      provider: 'local-worker',
      workspace: {
        id: GraphWorkspaceAllocationId('actual-workspace-1'),
        mode: this.workspaceMode,
        root: resolve('actual-workspace'),
        providerReference: 'local-worker:actual-workspace-1',
        createdAt: Date.now(),
      },
      result,
      cancel: async () => {
        this.cancels += 1
        settle({ outcome: 'aborted', output: [] })
      },
    }
  }

  reconcile(_name: string, request: GraphWorkerReconcileRequest): Promise<{ status: 'deleted'; evidence: string }> {
    this.reconciliations.push(request)
    return Promise.resolve({ status: 'deleted', evidence: 'underlying isolated workspace deleted' })
  }
}

class HangingWorkerStub extends WorkerStub {
  override async start(_name: string, _assignment: GraphWorkerAssignment): Promise<GraphWorkerRun> {
    this.starts += 1
    return {
      id: GraphWorkerId('hanging-worker-1'),
      provider: 'local-worker',
      workspace: {
        id: GraphWorkspaceAllocationId('hanging-workspace-1'),
        mode: 'isolated-copy',
        root: resolve('hanging-workspace'),
        providerReference: 'local-worker:hanging-workspace-1',
        createdAt: Date.now(),
      },
      result: new Promise<GraphWorkerResult>(() => {}),
      cancel: () => new Promise<void>(() => {}),
    }
  }
}

class ResourceStub {
  reported: GraphResourceOutcome | undefined
  reconciled: GraphResourceReconcileRequest | undefined

  observe(_name: string, route: GraphResourceRoute) {
    return Promise.resolve({
      ...route,
      providerId: 'local-resources',
      observedAt: Date.now(),
      expiresAt: Date.now() + 30_000,
      status: 'available' as const,
      activeRequests: 0,
      concurrencyLimit: 2,
      availableDeviceBytes: 16_000_000_000,
    })
  }

  reserve(_name: string, request: GraphResourceReservationRequest) {
    const now = Date.now()
    return Promise.resolve({
      status: 'granted' as const,
      reservation: {
        id: GraphResourceReservationId('resource-reservation-1'),
        providerId: 'local-resources',
        workId: request.workId,
        operationId: request.operationId,
        ownerEpoch: request.ownerEpoch,
        weight: request.weight,
        fencingToken: 9,
        acquiredAt: now,
        expiresAt: now + 30_000,
        ...request.provider === undefined ? {} : { provider: request.provider },
        model: request.model,
        snapshot: {
          providerId: 'local-resources',
          observedAt: now,
          expiresAt: now + 30_000,
          status: 'available' as const,
          ...request.provider === undefined ? {} : { provider: request.provider },
          model: request.model,
          activeRequests: 1,
          concurrencyLimit: 2,
        },
      },
    })
  }

  report(outcome: GraphResourceOutcome): Promise<void> {
    this.reported = outcome
    return Promise.resolve()
  }

  reconcile(request: GraphResourceReconcileRequest) {
    this.reconciled = request
    return Promise.resolve({ status: 'released' as const, evidence: 'remote capacity released' })
  }
}

class ArtifactStub {
  reconciled: GraphArtifactReconcileRequest | undefined
  private readonly stored = new Map<string, Buffer>()

  capture(_name: string, request: GraphArtifactCaptureRequest): Promise<GraphArtifactManifest> {
    const entries = [...request.paths].sort().map((path) => {
      const bytes = readFileSync(join(request.sourceRoot, ...path.split('/')))
      this.stored.set(path, bytes)
      return { path, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.byteLength, mode: 0o100600, kind: 'file' as const }
    })
    return Promise.resolve({
      id: GraphArtifactManifestId('artifact:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
      algorithm: 'sha256',
      provider: 'local-artifacts',
      workId: request.workId,
      operationId: request.operationId,
      attemptId: request.attemptId,
      runId: request.runId,
      generationId: request.generationId,
      ownerEpoch: request.ownerEpoch,
      fencingToken: request.fencingToken,
      createdAt: Date.now(),
      totalBytes: entries.reduce((total, entry) => total + entry.size, 0),
      entries,
      providerReference: 'local-artifacts:manifest-1',
    })
  }

  materialize(_name: string, request: GraphArtifactMaterializeRequest) {
    for (const entry of request.manifest.entries) {
      const bytes = this.stored.get(entry.path)
      if (bytes === undefined) throw new Error('artifact stub lost bytes')
      const path = join(request.targetRoot, ...entry.path.split('/'))
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, bytes)
    }
    return Promise.resolve({ paths: request.manifest.entries.map(entry => entry.path), totalBytes: request.manifest.totalBytes })
  }

  reconcile(_name: string, request: GraphArtifactReconcileRequest) {
    this.reconciled = request
    return Promise.resolve({ status: 'deleted' as const, evidence: 'underlying artifact manifest deleted' })
  }
}

class SchedulerStub {
  heartbeatRequest: GraphSchedulerLeaseRequest | undefined
  releaseRequest: GraphSchedulerLeaseRequest | undefined
  private lease: GraphSchedulerLease | undefined

  acquire(_name: string, request: GraphSchedulerAcquireRequest) {
    const now = Date.now()
    this.lease = {
      id: GraphSchedulerLeaseId('local-scheduler-lease-1'),
      providerId: 'local-scheduler',
      sessionId: request.sessionId,
      runId: request.runId,
      generationId: request.generationId,
      ownerId: request.ownerId,
      ownerEpoch: request.minimumOwnerEpoch,
      fencingToken: 12,
      acquiredAt: now,
      expiresAt: now + 30_000,
    }
    return Promise.resolve({ status: 'granted' as const, lease: this.lease })
  }

  heartbeat(request: GraphSchedulerLeaseRequest) {
    this.heartbeatRequest = request
    if (this.lease === undefined) throw new Error('scheduler stub has no lease')
    this.lease = { ...this.lease, expiresAt: request.at + 30_000 }
    return Promise.resolve(this.lease)
  }

  release(request: GraphSchedulerLeaseRequest): Promise<void> {
    this.releaseRequest = request
    this.lease = undefined
    return Promise.resolve()
  }
}

function assignment(): GraphWorkerAssignment {
  return {
    protocolVersion: 1,
    workId: GraphWorkId('work-http-server-1'),
    operationId: GraphControlOperationId('operation-http-server-1'),
    attemptId: GraphAttemptId('attempt-http-server-1'),
    activation: 0,
    runId: GraphRunId('run-http-server-1'),
    generationId: GraphRunGenerationId('generation-http-server-1'),
    ownerEpoch: 3,
    fencingToken: 7,
    parent: parent(),
    node: {
      id: GraphNodeId('node-http-server-1'),
      title: 'Remote task',
      objective: 'Execute remotely.',
      kind: 'implementation',
      roleId: GraphRoleId('engineer'),
      acceptanceCriteria: ['Return evidence.'],
      outputSchema: defaultGraphOutputSchema(),
      maxAttempts: 1,
      weight: 1,
      executionBudget: defaultGraphNodeExecutionBudget(),
      skippable: false,
      effectPolicy: 'idempotent',
    },
    role: {
      id: GraphRoleId('engineer'),
      label: 'Engineer',
      description: 'Implements.',
      controller: false,
      enabled: true,
      model: { provider: 'local', model: 'qwen', reasoningEffort: 'high' },
      prompt: 'Implement only the assignment.',
      maxParallel: 1,
    },
    prompt: [{ type: 'text', text: 'Implement.' }],
    outputSchema: defaultGraphOutputSchema().schema,
    budget: defaultGraphNodeExecutionBudget(),
    workspace: {
      mode: 'isolated-copy',
      sourceRoot: resolve('workspace'),
      readRoots: ['.'],
      writeRoots: ['src'],
      cleanup: 'retain-on-failure',
    },
    deadline: Date.now() + 60_000,
    signal: new AbortController().signal,
  }
}

function parent(): Agent {
  return workerParent
}

function journal(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-graph-worker-http-'))
  roots.push(root)
  return join(root, 'jobs.sqlite')
}

function service(
  worker: WorkerStub,
  journalPath: string,
  resources?: ResourceStub,
  artifacts?: ArtifactStub,
  scheduler?: SchedulerStub,
  operationTimeoutMs = 30_000,
): HttpGraphWorkerServer {
  const value = new HttpGraphWorkerServer({
    audience,
    basePath: '/graph-worker',
    journalPath,
    workerProvider: 'local-worker',
    graphWorkers: worker,
    ...resources === undefined ? {} : {
      resource: {
        routeName: 'remote-resources',
        providerName: 'local-resources',
        graphResources: resources,
      },
    },
    ...artifacts === undefined ? {} : {
      artifact: {
        routeName: 'remote-artifacts',
        providerName: 'local-artifacts',
        graphArtifacts: artifacts,
        tempRoot: join(dirname(journalPath), 'artifact-staging'),
        maxFiles: 100,
        maxBytes: 1_000_000,
      },
    },
    ...scheduler === undefined ? {} : {
      scheduler: {
        routeName: 'remote-scheduler',
        providerName: 'local-scheduler',
        graphScheduler: scheduler,
      },
    },
    resolveSecret: async candidate => candidate === principal ? secret : undefined,
    resolveParent: parent,
    maxClockSkewMs: 30_000,
    maxRequestBytes: 1_000_000,
    maxResultBytes: 1_000_000,
    maxReplayEntries: 1_000,
    busyTimeoutMs: 5_000,
    operationTimeoutMs,
  })
  services.push(value)
  return value
}

async function listen(workerService: HttpGraphWorkerServer): Promise<string> {
  const server = createServer((request, response) => {
    void workerService.handle(request, response)
  })
  servers.push(server)
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolveListen()
    })
  })
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/graph-worker`
}

function options(endpoint: string, overrides: Partial<HttpGraphWorkerOptions> = {}): HttpGraphWorkerOptions {
  return {
    providerName: 'remote-http',
    endpoint,
    principal,
    audience,
    workspaceModes: ['isolated-copy'],
    resolveSecret: async () => secret,
    pollIntervalMs: 1,
    startAttempts: 2,
    maxPollFailures: 2,
    requestTimeoutMs: 5_000,
    maxResponseBytes: 1_000_000,
    allowInsecureLoopback: true,
    ...overrides,
  }
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolveClose) => {
    server.close(() => { resolveClose() })
  })))
  await Promise.all(services.splice(0).map(async (workerService) => { await workerService.close() }))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('durable authenticated HTTP Graph Worker server', () => {
  it('bounds shutdown when an underlying Worker ignores cancellation', async () => {
    const worker = new HangingWorkerStub()
    const workerService = service(worker, journal(), undefined, undefined, undefined, 10)
    const provider = new HttpGraphWorkerProvider(options(await listen(workerService)))
    const run = await provider.start(assignment())
    void run.result.catch(() => {})

    const startedAt = Date.now()
    await workerService.close()

    expect(Date.now() - startedAt).toBeLessThan(1_000)
  })

  it('deduplicates a start whose accepted response was lost and publishes one terminal result', async () => {
    const worker = new WorkerStub()
    const endpoint = await listen(service(worker, journal()))
    let loseFirstStart = true
    const provider = new HttpGraphWorkerProvider(options(endpoint, {
      fetcher: async (input, init) => {
        const response = await fetch(input, init)
        const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input
        if (loseFirstStart && url.endsWith('/v1/start')) {
          loseFirstStart = false
          await response.text()
          throw new Error('simulated lost response')
        }
        return response
      },
    }))
    const run = await provider.start(assignment())
    expect(worker.starts).toBe(1)
    worker.pending?.resolve({
      outcome: 'completed',
      output: [{ type: 'text', text: 'done' }],
      structured: { summary: 'done', artifacts: [] },
    })

    await expect(run.result).resolves.toMatchObject({ outcome: 'completed', structured: { summary: 'done' } })
    expect(run.id).toMatch(/^worker-job-/u)
    expect(run.workspace.id).toMatch(/^workspace-job-/u)
  })

  it('quarantines an uncertain nonterminal job on restart instead of dispatching it again', async () => {
    const worker = new WorkerStub()
    const journalPath = journal()
    const work = assignment()
    const firstProvider = new HttpGraphWorkerProvider(options(await listen(service(worker, journalPath))))
    const firstRun = await firstProvider.start(work)
    expect(worker.starts).toBe(1)

    const restartedProvider = new HttpGraphWorkerProvider(options(await listen(service(worker, journalPath))))
    const restartedRun = await restartedProvider.start(work)
    await expect(restartedRun.result).resolves.toMatchObject({
      outcome: 'unavailable',
      error: { code: 'GRAPH_WORKER_REMOTE_RESTART_QUARANTINED' },
    })
    expect(worker.starts).toBe(1)
    await expect(firstRun.result).resolves.toMatchObject({ error: { code: 'GRAPH_WORKER_REMOTE_RESTART_QUARANTINED' } })
  })

  it('maps logical remote references to the underlying Provider during reconciliation', async () => {
    const worker = new WorkerStub()
    const provider = new HttpGraphWorkerProvider(options(await listen(service(worker, journal()))))
    const run = await provider.start(assignment())
    worker.pending?.resolve({ outcome: 'completed', output: [], structured: { summary: 'done', artifacts: [] } })
    await run.result

    await expect(provider.reconcile({
      protocolVersion: 1,
      workId: GraphWorkId('work-http-server-1'),
      operationId: GraphControlOperationId('operation-http-server-1'),
      runId: GraphRunId('run-http-server-1'),
      generationId: GraphRunGenerationId('generation-http-server-1'),
      ownerEpoch: 3,
      workerId: run.id,
      workspaceId: run.workspace.id,
      workspaceMode: 'isolated-copy',
      cleanup: 'retain-on-failure',
      safeToDelete: true,
    }, new AbortController().signal)).resolves.toEqual({
      status: 'deleted',
      evidence: 'underlying isolated workspace deleted',
    })
    expect(worker.reconciliations).toHaveLength(1)
    expect(worker.reconciliations[0]).toMatchObject({
      workerId: 'actual-worker-1',
      workspaceId: 'actual-workspace-1',
    })
  })

  it('rejects requests signed for another secret without dispatching work', async () => {
    const worker = new WorkerStub()
    const endpoint = await listen(service(worker, journal()))
    const provider = new HttpGraphWorkerProvider(options(endpoint, {
      resolveSecret: async () => 'abcdef0123456789abcdef0123456789',
      startAttempts: 1,
    }))
    await expect(provider.start(assignment())).rejects.toThrow('HTTP 401')
    expect(worker.starts).toBe(0)
  })

  it('rejects an underlying workspace mode that differs from the accepted assignment', async () => {
    const worker = new WorkerStub()
    worker.workspaceMode = 'shared'
    const provider = new HttpGraphWorkerProvider(options(await listen(service(worker, journal()))))
    const run = await provider.start(assignment())
    await expect(run.result).resolves.toMatchObject({
      outcome: 'unavailable',
      error: { code: 'GRAPH_WORKER_REMOTE_WORKSPACE_MODE' },
    })
    expect(worker.cancels).toBe(1)
  })

  it('provides one authenticated cross-Host resource reservation authority', async () => {
    const worker = new WorkerStub()
    const resources = new ResourceStub()
    const endpoint = await listen(service(worker, journal(), resources))
    const provider = new HttpGraphResourceProvider({
      providerName: 'remote-resources',
      endpoint,
      principal,
      audience,
      resolveSecret: async () => secret,
      requestTimeoutMs: 5_000,
      maxResponseBytes: 1_000_000,
      allowInsecureLoopback: true,
    })
    await expect(provider.observe({ provider: 'local', model: 'qwen' }, new AbortController().signal))
      .resolves.toMatchObject({
        providerId: 'remote-resources',
        provider: 'local',
        model: 'qwen',
        availableDeviceBytes: 16_000_000_000,
      })
    const decision = await provider.reserve({
      protocolVersion: 1,
      workId: GraphWorkId('resource-work-1'),
      operationId: GraphControlOperationId('resource-operation-1'),
      ownerEpoch: 2,
      weight: 1,
      hardMaxParallel: 2,
      requestedAt: Date.now(),
      deadline: Date.now() + 60_000,
      provider: 'local',
      model: 'qwen',
    }, new AbortController().signal)
    if (decision.status !== 'granted') throw new Error('remote resource reservation was not granted')
    expect(decision.reservation).toMatchObject({
      providerId: 'remote-resources',
      fencingToken: 9,
      snapshot: { providerId: 'remote-resources' },
    })
    await provider.report({
      reservationId: decision.reservation.id,
      providerId: 'remote-resources',
      workId: decision.reservation.workId,
      ownerEpoch: 2,
      fencingToken: 9,
      outcome: 'completed',
      at: Date.now(),
    }, new AbortController().signal)
    expect(resources.reported?.providerId).toBe('local-resources')
    await expect(provider.reconcile({
      protocolVersion: 1,
      reservationId: decision.reservation.id,
      providerId: 'remote-resources',
      workId: decision.reservation.workId,
      ownerEpoch: 2,
      fencingToken: 9,
      at: Date.now(),
      evidence: 'scheduler recovered the run',
    }, new AbortController().signal)).resolves.toEqual({ status: 'released', evidence: 'remote capacity released' })
    expect(resources.reconciled?.providerId).toBe('local-resources')
  })

  it('provides one authenticated cross-Host scheduler ownership authority', async () => {
    const scheduler = new SchedulerStub()
    const endpoint = await listen(service(new WorkerStub(), journal(), undefined, undefined, scheduler))
    const provider = new HttpGraphSchedulerProvider({
      providerName: 'remote-scheduler',
      endpoint,
      principal,
      audience,
      resolveSecret: async () => secret,
      requestTimeoutMs: 5_000,
      maxResponseBytes: 1_000_000,
      allowInsecureLoopback: true,
    })
    const ownerId = GraphSchedulerOwnerId('graph-host-east-owner')
    const decision = await provider.acquire({
      protocolVersion: 1,
      sessionId: 'scheduler-session-1',
      runId: GraphRunId('scheduler-run-1'),
      generationId: GraphRunGenerationId('scheduler-generation-1'),
      ownerId,
      minimumOwnerEpoch: 4,
      requestedAt: Date.now(),
    }, new AbortController().signal)
    if (decision.status !== 'granted') throw new Error('remote scheduler ownership was not granted')
    expect(decision.lease).toMatchObject({ providerId: 'remote-scheduler', fencingToken: 12, ownerEpoch: 4 })
    const request: GraphSchedulerLeaseRequest = {
      protocolVersion: 1,
      providerId: 'remote-scheduler',
      leaseId: decision.lease.id,
      runId: decision.lease.runId,
      generationId: decision.lease.generationId,
      ownerId,
      ownerEpoch: decision.lease.ownerEpoch,
      fencingToken: decision.lease.fencingToken,
      at: Date.now(),
    }
    await expect(provider.heartbeat(request, new AbortController().signal))
      .resolves.toMatchObject({ providerId: 'remote-scheduler', fencingToken: 12 })
    expect(scheduler.heartbeatRequest?.providerId).toBe('local-scheduler')
    await provider.release(request, new AbortController().signal)
    expect(scheduler.releaseRequest?.providerId).toBe('local-scheduler')
  })

  it('transfers authenticated content-addressed artifacts without exposing server paths', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-graph-worker-artifact-'))
    roots.push(root)
    const source = join(root, 'source')
    const target = join(root, 'target')
    const tamperedTarget = join(root, 'tampered-target')
    mkdirSync(join(source, 'src'), { recursive: true })
    mkdirSync(target, { recursive: true })
    mkdirSync(tamperedTarget, { recursive: true })
    writeFileSync(join(source, 'src', 'answer.txt'), 'verified remote artifact')
    const artifacts = new ArtifactStub()
    const journalPath = journal()
    const endpoint = await listen(service(new WorkerStub(), journalPath, undefined, artifacts))
    const provider = new HttpGraphArtifactProvider({
      providerName: 'remote-artifacts',
      endpoint,
      principal,
      audience,
      resolveSecret: async () => secret,
      requestTimeoutMs: 5_000,
      maxResponseBytes: 1_000_000,
      allowInsecureLoopback: true,
      allowedCaptureRoots: [source],
      allowedMaterializeRoots: [target],
      maxTransferFiles: 100,
      maxTransferBytes: 1_000_000,
    })
    const captureRequest: GraphArtifactCaptureRequest = {
      workId: GraphWorkId('artifact-work-1'),
      operationId: GraphControlOperationId('artifact-operation-1'),
      attemptId: GraphAttemptId('artifact-attempt-1'),
      runId: GraphRunId('artifact-run-1'),
      generationId: GraphRunGenerationId('artifact-generation-1'),
      ownerEpoch: 2,
      fencingToken: 5,
      workspaceId: GraphWorkspaceAllocationId('artifact-workspace-1'),
      sourceRoot: source,
      workspaceReference: 'client-workspace:1',
      paths: ['src/answer.txt'],
      maxFiles: 100,
      maxBytes: 1_000_000,
      deadline: Date.now() + 60_000,
      signal: new AbortController().signal,
    }
    await expect(provider.capture({ ...captureRequest, paths: ['../answer.txt'] }))
      .rejects.toThrow('not normalized and source-relative')
    const manifest = await provider.capture(captureRequest)
    expect(manifest).toMatchObject({
      provider: 'remote-artifacts',
      entries: [{ path: 'src/answer.txt', size: 24 }],
    })
    expect(manifest.providerReference).toMatch(/^dsh-http-artifact:v1:/u)
    expect(manifest.providerReference).not.toContain('local-artifacts:manifest-1')
    const restartedEndpoint = await listen(service(new WorkerStub(), journalPath, undefined, artifacts))
    const restartedProvider = new HttpGraphArtifactProvider({
      providerName: 'remote-artifacts',
      endpoint: restartedEndpoint,
      principal,
      audience,
      resolveSecret: async () => secret,
      requestTimeoutMs: 5_000,
      maxResponseBytes: 1_000_000,
      allowInsecureLoopback: true,
      allowedCaptureRoots: [source],
      allowedMaterializeRoots: [target],
      maxTransferFiles: 100,
      maxTransferBytes: 1_000_000,
    })
    await expect(restartedProvider.materialize({
      manifest,
      targetRoot: target,
      overwrite: 'forbid',
      signal: new AbortController().signal,
    })).resolves.toEqual({ paths: ['src/answer.txt'], totalBytes: 24 })
    expect(readFileSync(join(target, 'src', 'answer.txt'), 'utf8')).toBe('verified remote artifact')
    const tamperingProvider = new HttpGraphArtifactProvider({
      providerName: 'remote-artifacts',
      endpoint: restartedEndpoint,
      principal,
      audience,
      resolveSecret: async () => secret,
      requestTimeoutMs: 5_000,
      maxResponseBytes: 1_000_000,
      allowInsecureLoopback: true,
      allowedCaptureRoots: [source],
      allowedMaterializeRoots: [tamperedTarget],
      maxTransferFiles: 100,
      maxTransferBytes: 1_000_000,
      fetcher: async (input, init) => {
        const fetched = await fetch(input, init)
        const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input
        if (!url.endsWith('/v1/artifacts/materialize')) return fetched
        const body = await fetched.json() as { files: Array<{ bytes: string }> }
        body.files[0]!.bytes = Buffer.from('tampered').toString('base64')
        return new Response(JSON.stringify(body), { status: fetched.status, headers: { 'content-type': 'application/json' } })
      },
    })
    await expect(tamperingProvider.materialize({
      manifest,
      targetRoot: tamperedTarget,
      overwrite: 'forbid',
      signal: new AbortController().signal,
    })).rejects.toThrow('failed verification')
    await expect(restartedProvider.reconcile({
      manifestId: manifest.id,
      providerReference: manifest.providerReference,
      safeToDelete: true,
      signal: new AbortController().signal,
    })).resolves.toEqual({ status: 'deleted', evidence: 'underlying artifact manifest deleted' })
    expect(artifacts.reconciled).toMatchObject({ providerReference: 'local-artifacts:manifest-1', safeToDelete: true })
  })
})
