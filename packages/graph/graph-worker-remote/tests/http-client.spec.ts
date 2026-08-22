import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { resolve } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
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
import { GraphWorkerId, GraphWorkspaceAllocationId, type GraphWorkerAssignment } from '@deepseek-ai/dsh-graph-worker'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it } from 'vitest'
import {
  GraphWorkerRemoteAudienceId,
  GraphWorkerRemotePrincipalId,
  GraphWorkerReplayGuard,
  HttpGraphWorkerProvider,
  type GraphWorkerAuthHeaders,
  type HttpGraphWorkerOptions,
} from '../src/index.ts'

const principal = GraphWorkerRemotePrincipalId('graph-host-east')
const audience = GraphWorkerRemoteAudienceId('worker-west')
const secret = '0123456789abcdef0123456789abcdef'
const servers: Server[] = []

const assignment = (): GraphWorkerAssignment => ({
  protocolVersion: 1,
  workId: GraphWorkId('work-http-1'),
  operationId: GraphControlOperationId('operation-http-1'),
  attemptId: GraphAttemptId('attempt-http-1'),
  activation: 0,
  runId: GraphRunId('run-http-1'),
  generationId: GraphRunGenerationId('generation-http-1'),
  ownerEpoch: 3,
  fencingToken: 7,
  parent: { id: SessionId('parent'), session: { header: { cwd: resolve('workspace') } } } as unknown as Agent,
  node: {
    id: GraphNodeId('node-http-1'), title: 'Remote task', objective: 'Execute remotely.', kind: 'implementation',
    roleId: GraphRoleId('engineer'), acceptanceCriteria: ['Return evidence.'], outputSchema: defaultGraphOutputSchema(),
    maxAttempts: 1, weight: 1, executionBudget: defaultGraphNodeExecutionBudget(), skippable: false, effectPolicy: 'idempotent',
  },
  role: {
    id: GraphRoleId('engineer'), label: 'Engineer', description: 'Implements.', controller: false, enabled: true,
    model: { provider: 'local', model: 'qwen', reasoningEffort: 'high' }, prompt: 'Implement only the assignment.', maxParallel: 1,
  },
  prompt: [{ type: 'text', text: 'Implement.' }],
  outputSchema: defaultGraphOutputSchema().schema,
  budget: defaultGraphNodeExecutionBudget(),
  workspace: {
    mode: 'isolated-copy', sourceRoot: resolve('workspace'), readRoots: ['.'], writeRoots: ['src'], cleanup: 'retain-on-failure',
  },
  deadline: Date.now() + 60_000,
  signal: new AbortController().signal,
})

function header(request: IncomingMessage, name: keyof GraphWorkerAuthHeaders): string {
  const value = request.headers[name]
  if (typeof value !== 'string') throw new Error(`missing ${name}`)
  return value
}

async function bodyOf(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  response.end(body)
}

async function listen(
  handler: (request: IncomingMessage, response: ServerResponse, body: string) => void | Promise<void>,
): Promise<string> {
  const replay = new GraphWorkerReplayGuard({ maxClockSkewMs: 30_000, maxBodyBytes: 1_000_000, maxEntries: 1_000 })
  const server = createServer((request, response) => {
    void bodyOf(request).then(async (body) => {
      replay.verify({
        method: request.method ?? '',
        path: request.url ?? '',
        body,
        headers: {
          'x-dsh-worker-principal': header(request, 'x-dsh-worker-principal'),
          'x-dsh-worker-audience': header(request, 'x-dsh-worker-audience'),
          'x-dsh-worker-timestamp': header(request, 'x-dsh-worker-timestamp'),
          'x-dsh-worker-nonce': header(request, 'x-dsh-worker-nonce'),
          'x-dsh-worker-signature': header(request, 'x-dsh-worker-signature'),
        },
        expectedAudience: audience,
        resolveSecret: candidate => candidate === principal ? secret : undefined,
      })
      await handler(request, response, body)
    }).catch((error: unknown) => {
      json(response, 401, { error: error instanceof Error ? error.message : String(error) })
    })
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
    providerName: 'http-remote',
    endpoint,
    principal,
    audience,
    workspaceModes: ['isolated-copy'],
    resolveSecret: async () => secret,
    pollIntervalMs: 1,
    startAttempts: 2,
    maxPollFailures: 2,
    requestTimeoutMs: 5_000,
    maxResponseBytes: 100_000,
    allowInsecureLoopback: true,
    ...overrides,
  }
}

function started() {
  return {
    protocolVersion: 1,
    jobId: 'job-http-1',
    workerId: 'worker-http-1',
    workspace: {
      id: 'workspace-http-1', mode: 'isolated-copy', root: '/remote/workspace',
      providerReference: 'worker-west:job-http-1', createdAt: Date.now(),
    },
  }
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolveClose) => {
    server.close(() => { resolveClose() })
  })))
})

describe('authenticated HTTP Graph Worker client', () => {
  it('retries idempotent start and transient observation, rotates credentials per operation, and returns terminal evidence', async () => {
    const calls: Array<{ path: string; body: string }> = []
    let starts = 0
    let observations = 0
    const endpoint = await listen((request, response, body) => {
      const path = request.url ?? ''
      calls.push({ path, body })
      if (path.endsWith('/start')) {
        starts += 1
        if (starts === 1) json(response, 503, { error: 'temporary' })
        else json(response, 200, started())
        return
      }
      if (path.endsWith('/observe')) {
        observations += 1
        if (observations === 1) json(response, 503, { error: 'temporary' })
        else if (observations === 2) json(response, 200, { protocolVersion: 1, state: 'running' })
        else {
          json(response, 200, {
            protocolVersion: 1,
            state: 'terminal',
            result: { outcome: 'completed', output: [{ type: 'text', text: 'done' }], structured: { summary: 'done' } },
          })
        }
        return
      }
      json(response, 404, { error: 'unknown' })
    })
    let resolutions = 0
    const provider = new HttpGraphWorkerProvider(options(endpoint, {
      resolveSecret: async () => { resolutions += 1; return secret },
    }))
    const run = await provider.start(assignment())

    await expect(run.result).resolves.toMatchObject({
      outcome: 'completed',
      output: [{ type: 'text', text: 'done' }],
      structured: { summary: 'done' },
    })
    expect(run.id).toBe('worker-http-1')
    expect(run.workspace).toMatchObject({ id: 'workspace-http-1', mode: 'isolated-copy' })
    expect(resolutions).toBe(calls.length)
    const startBodies = calls.filter(call => call.path.endsWith('/start')).map(call => call.body)
    expect(startBodies).toHaveLength(2)
    expect(startBodies[0]).toBe(startBodies[1])
    const sent = JSON.parse(startBodies[0] ?? '{}') as { assignment?: Record<string, unknown> }
    expect(sent.assignment).not.toHaveProperty('parent')
    expect(sent.assignment).not.toHaveProperty('signal')
    expect(sent.assignment).toMatchObject({ workId: 'work-http-1', ownerEpoch: 3, fencingToken: 7 })
  })

  it('sends an addressed cancellation and reports aborted only after the Worker acknowledges it', async () => {
    const paths: string[] = []
    const endpoint = await listen((request, response) => {
      const path = request.url ?? ''
      paths.push(path)
      if (path.endsWith('/start')) json(response, 200, started())
      else if (path.endsWith('/observe')) json(response, 200, { protocolVersion: 1, state: 'running' })
      else if (path.endsWith('/cancel')) json(response, 200, { protocolVersion: 1, accepted: true })
      else json(response, 404, { error: 'unknown' })
    })
    const provider = new HttpGraphWorkerProvider(options(endpoint, { pollIntervalMs: 100 }))
    const run = await provider.start(assignment())
    await run.cancel('user stopped the node', new AbortController().signal)

    await expect(run.result).resolves.toMatchObject({ outcome: 'aborted', error: { code: 'GRAPH_WORKER_REMOTE_ABORTED' } })
    expect(paths.some(path => path.endsWith('/cancel'))).toBe(true)
  })

  it('reconciles the exact remote Worker reference through the authenticated endpoint', async () => {
    const endpoint = await listen((request, response) => {
      if (request.url?.endsWith('/reconcile')) {
        json(response, 200, { protocolVersion: 1, status: 'retained', evidence: 'terminal job retained' })
        return
      }
      json(response, 404, { error: 'unknown' })
    })
    const provider = new HttpGraphWorkerProvider(options(endpoint))
    await expect(provider.reconcile({
      protocolVersion: 1,
      workId: GraphWorkId('work-http-1'),
      operationId: GraphControlOperationId('operation-http-1'),
      runId: GraphRunId('run-http-1'),
      generationId: GraphRunGenerationId('generation-http-1'),
      ownerEpoch: 3,
      workerId: GraphWorkerId('worker-http-1'),
      workspaceId: GraphWorkspaceAllocationId('workspace-http-1'),
      workspaceMode: 'isolated-copy',
      cleanup: 'retain-on-failure',
      safeToDelete: false,
    }, new AbortController().signal)).resolves.toEqual({ status: 'retained', evidence: 'terminal job retained' })
  })

  it('does not retry a malformed successful response', async () => {
    let calls = 0
    const endpoint = await listen((_request, response) => {
      calls += 1
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('not-json')
    })
    const provider = new HttpGraphWorkerProvider(options(endpoint, { startAttempts: 5 }))
    await expect(provider.start(assignment())).rejects.toThrow('returned invalid JSON')
    expect(calls).toBe(1)
  })

  it('rejects response overflow and a returned workspace mode that differs from the assignment', async () => {
    const oversized = await listen((_request, response) => {
      response.writeHead(200, { 'content-length': '1000' })
      response.end('{}')
    })
    await expect(new HttpGraphWorkerProvider(options(oversized, { maxResponseBytes: 10 })).start(assignment()))
      .rejects.toThrow('response exceeds the configured byte limit')

    const mismatch = await listen((_request, response) => {
      json(response, 200, { ...started(), workspace: { ...started().workspace, mode: 'shared' } })
    })
    await expect(new HttpGraphWorkerProvider(options(mismatch, { workspaceModes: ['isolated-copy', 'shared'] })).start(assignment()))
      .rejects.toThrow('returned a different workspace mode')
  })

  it('requires HTTPS except for an explicit loopback development route and validates all bounds', () => {
    expect(() => new HttpGraphWorkerProvider(options('http://example.com/worker'))).toThrow('requires HTTPS')
    expect(() => new HttpGraphWorkerProvider(options('http://127.0.0.1:1234/worker', { allowInsecureLoopback: false }))).toThrow('requires HTTPS')
    expect(() => new HttpGraphWorkerProvider(options('https://worker.example/worker?secret=no'))).toThrow('query')
    expect(() => new HttpGraphWorkerProvider(options('https://worker.example/worker', { workspaceModes: [] }))).toThrow('workspaceModes')
    expect(() => new HttpGraphWorkerProvider(options('https://worker.example/worker', { startAttempts: 0 }))).toThrow('startAttempts')
    expect(() => new HttpGraphWorkerProvider(options('https://worker.example/worker', { maxPollFailures: -1 }))).toThrow('maxPollFailures')
  })
})
