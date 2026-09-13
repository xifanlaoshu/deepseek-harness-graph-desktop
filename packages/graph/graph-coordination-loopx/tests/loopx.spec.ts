import { PassThrough, Writable } from 'node:stream'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import type { SubprocessHandle, SubprocessSpawnSpec, SubprocessTerminalHandle } from '@deepseek-ai/dsh-subprocess'
import { GraphActivationId, GraphControlOperationId, GraphRunId, GraphSettlementId, GraphWorkId } from '@deepseek-ai/dsh-graph'
import type { GraphRevision, GraphRole } from '@deepseek-ai/dsh-graph'
import LoopxGraphCoordination from '../src/index.ts'
import * as LoopxInvariant from '../src/invariant.ts'
import { PersistentLoopxBroker } from '../src/broker.ts'
import { runGraphCoordinationContract } from '../../graph-coordination/tests/contract.ts'

class FakeSubprocess extends SubprocessRuntime {
  readonly argv: readonly string[][] = []
  readonly specs: SubprocessSpawnSpec[] = []
  readonly responses: Array<{
    readonly stdout?: unknown
    readonly stderr?: string
    readonly exitCode?: number
    readonly omitStdout?: boolean
    readonly omitStderr?: boolean
    readonly doneWait?: Promise<void>
    readonly waitForAbort?: boolean
    readonly stdoutLossy?: boolean
    readonly stderrLossy?: boolean
  }> = []
  private leaseVersion = 0
  async resolveExecutable(command: string): Promise<string> { return command }
  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    ;(this.argv as string[][]).push([...spec.argv])
    this.specs.push(spec)
    const args = spec.argv.join(' ')
    const expectedVersionIndex = spec.argv.indexOf('--expected-version')
    const expectedVersion = expectedVersionIndex < 0 ? this.leaseVersion : Number(spec.argv[expectedVersionIndex + 1])
    let fallback: unknown = { changed: true }
    if (args.includes('todo list')) fallback = { todos: [] }
    else if (args.includes('todo add')) fallback = { todo_id: `todo-${String(this.argv.length)}` }
    else if (args.includes('todo claim')) fallback = { claimed_by: 'engineer-peer' }
    else if (args.includes('task-lease acquire')) {
      this.leaseVersion = 1
      fallback = { ok: true, lease: { version: this.leaseVersion, expires_at: '2099-01-01T00:00:00.000Z' } }
    } else if (args.includes('task-lease renew')) {
      this.leaseVersion = expectedVersion + 1
      fallback = { ok: true, lease: { version: this.leaseVersion, expires_at: '2099-01-01T00:00:00.000Z' } }
    } else if (args.includes('task-lease inspect')) {
      fallback = { ok: true, active: true, lease: { version: this.leaseVersion || 1, expires_at: '2099-01-01T00:00:00.000Z' } }
    }
    const response = this.responses.shift()
    const value = response !== undefined && 'stdout' in response ? response.stdout : fallback
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const lease = (value as Record<string, unknown>)['lease']
      if (typeof lease === 'object' && lease !== null && !Array.isArray(lease)) {
        const version = (lease as Record<string, unknown>)['version']
        if (Number.isSafeInteger(version)) this.leaseVersion = version as number
      }
    }
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    const stderr = response?.stderr ?? ''
    const stdoutReader = { readFrom: () => ({ text, nextOffset: text.length, lossy: response?.stdoutLossy ?? false }) }
    const done = response?.waitForAbort === true
      ? new Promise<{ exitCode: number; signal: NodeJS.Signals }>((resolve) => {
        spec.signal?.addEventListener('abort', () => { resolve({ exitCode: 1, signal: 'SIGTERM' }) }, { once: true })
      })
      : (response?.doneWait ?? Promise.resolve()).then(() => ({ exitCode: response?.exitCode ?? 0, signal: null }))
    return {
      pid: 1,
      stdin: undefined,
      stdout: undefined,
      stderr: undefined,
      collected: {
        ...response?.omitStdout === true ? {} : { stdout: stdoutReader },
        ...response?.omitStderr === true
          ? {}
          : { stderr: { readFrom: () => ({ text: stderr, nextOffset: stderr.length, lossy: response?.stderrLossy ?? false }) } },
      },
      done,
      terminate: () => {},
      waitForExit: () => Promise.resolve(true),
    }
  }
  async spawnTerminal(): Promise<SubprocessTerminalHandle> {
    return {
      pid: 1,
      output: new PassThrough(),
      done: Promise.resolve({ exitCode: 0, signal: null }),
      write: async () => {},
      inspectForeground: async () => ({ processGroupId: 1, inputWaiting: true }),
      signalForeground: async () => 1,
      terminate: async () => {},
    }
  }
}

class FakePersistentSubprocess extends SubprocessRuntime {
  readonly specs: SubprocessSpawnSpec[] = []
  readonly requests: Array<Record<string, unknown>> = []

  async resolveExecutable(command: string): Promise<string> { return command }

  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    this.specs.push(spec)
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const settled = Promise.withResolvers<{ exitCode: number; signal: null }>()
    let input = ''
    let closed = false
    const close = (): void => {
      if (closed) return
      closed = true
      stdout.end()
      stderr.end()
      settled.resolve({ exitCode: 0, signal: null })
    }
    stdin.setEncoding('utf8')
    stdin.on('data', (chunk: string) => {
      input += chunk
      let newline = input.indexOf('\n')
      while (newline >= 0) {
        const line = input.slice(0, newline)
        input = input.slice(newline + 1)
        const message = JSON.parse(line) as Record<string, unknown>
        if (message['type'] === 'request') {
          this.requests.push(message)
          const args = message['args'] as string[]
          const value = args.includes('list') ? { todos: [] } : { changed: true }
          stdout.write(`${JSON.stringify({
            type: 'response', protocol: 1, id: message['id'], exitCode: 0,
            timedOut: false, cancelled: false,
            stdout: Buffer.from(JSON.stringify(value)).toString('base64'),
            stderr: '', stdoutLossy: false, stderrLossy: false,
          })}\n`)
        }
        newline = input.indexOf('\n')
      }
    })
    stdin.on('finish', close)
    queueMicrotask(() => { stdout.write('{"type":"ready","protocol":1}\n') })
    return {
      pid: 1,
      stdin,
      stdout,
      stderr,
      collected: {},
      done: settled.promise,
      terminate: close,
      waitForExit: async (signal) => {
        if (closed) return true
        if (signal?.aborted) return false
        if (signal === undefined) {
          await settled.promise
          return true
        }
        const aborted = Promise.withResolvers<boolean>()
        const onAbort = (): void => { aborted.resolve(false) }
        signal.addEventListener('abort', onAbort, { once: true })
        try {
          return await Promise.race([settled.promise.then(() => true), aborted.promise])
        } finally {
          signal.removeEventListener('abort', onAbort)
        }
      },
    }
  }

  async spawnTerminal(): Promise<SubprocessTerminalHandle> {
    throw new Error('not used')
  }
}

class Utf16FailingPersistentSubprocess extends SubprocessRuntime {
  async resolveExecutable(command: string): Promise<string> { return command }

  spawn(): SubprocessHandle {
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const done = Promise.withResolvers<{ exitCode: number; signal: null }>()
    queueMicrotask(() => {
      stdout.end(Buffer.from('由于系统缓冲区空间不足或队列已满，不能执行套接字上的操作。\r\n错误代码: Wsl/Service/0x80072747\r\n', 'utf16le'))
      stderr.end()
      done.resolve({ exitCode: 0xffff_ffff, signal: null })
    })
    return {
      pid: 1, stdin, stdout, stderr, collected: {}, done: done.promise,
      terminate: () => {}, waitForExit: () => Promise.resolve(true),
    }
  }

  async spawnTerminal(): Promise<SubprocessTerminalHandle> {
    throw new Error('not used')
  }
}

class PendingWritePersistentSubprocess extends SubprocessRuntime {
  readonly writeStarted = Promise.withResolvers<boolean>()
  private readonly writeCallbacks: Array<(error?: Error | null) => void> = []
  private stdin: Writable | undefined
  private releasePendingWrites = false

  async resolveExecutable(command: string): Promise<string> { return command }

  spawn(): SubprocessHandle {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const settled = Promise.withResolvers<{ exitCode: number; signal: null }>()
    let closed = false
    const stdin = new Writable({
      write: (_chunk, _encoding, callback) => {
        this.writeStarted.resolve(true)
        if (this.releasePendingWrites) callback()
        else this.writeCallbacks.push(callback)
      },
    })
    this.stdin = stdin
    const close = (): void => {
      if (closed) return
      closed = true
      this.releaseWrites()
      stdout.end()
      stderr.end()
      settled.resolve({ exitCode: 0, signal: null })
    }
    stdin.on('finish', close)
    queueMicrotask(() => { stdout.write('{"type":"ready","protocol":1}\n') })
    return {
      pid: 1, stdin, stdout, stderr, collected: {}, done: settled.promise,
      terminate: close,
      waitForExit: async (signal) => {
        if (closed) return true
        if (signal?.aborted) return false
        if (signal === undefined) {
          await settled.promise
          return true
        }
        const aborted = Promise.withResolvers<boolean>()
        const onAbort = (): void => { aborted.resolve(false) }
        signal.addEventListener('abort', onAbort, { once: true })
        try {
          return await Promise.race([settled.promise.then(() => true), aborted.promise])
        } finally {
          signal.removeEventListener('abort', onAbort)
        }
      },
    }
  }

  releaseWrites(error?: Error): void {
    this.releasePendingWrites = true
    for (const callback of this.writeCallbacks.splice(0)) callback(error)
  }

  emitStdinError(error: Error): void {
    if (this.stdin === undefined) throw new Error('persistent stdin is unavailable')
    this.stdin.emit('error', error)
  }

  async spawnTerminal(): Promise<SubprocessTerminalHandle> {
    throw new Error('not used')
  }
}

const brokerOptions = {
  launcher: 'wsl.exe',
  launcherArgs: ['-d', 'Ubuntu', '--exec'],
  pythonExecutable: 'python3',
  command: '/root/.local/bin/loopx',
  graceMs: 100,
  startTimeoutMs: 1_000,
  diagnosticMaxBytes: 8_192,
}

const role = {
  id: 'engineer', label: 'Engineer', description: 'implements', controller: false, enabled: true,
  model: {}, prompt: 'implement', maxParallel: 1,
} as unknown as GraphRole
const graph = {
  graphId: 'g1', revision: 1, objective: 'ship', createdAt: 1, userInput: 'ship',
  nodes: [{
    id: 'a', title: 'A', objective: 'implement', kind: 'implementation', roleId: 'engineer',
    acceptanceCriteria: ['done'], maxAttempts: 1, weight: 1,
  }],
  edges: [],
} as unknown as GraphRevision

const request = (node: GraphRevision['nodes'][number], selectedGraph = graph, cwd = 'D:/work', run = 'run-1') => {
  const workId = GraphWorkId(`work-${selectedGraph.graphId}-${node.id}-${cwd.replaceAll(/[^A-Za-z0-9]/g, '-')}`)
  const activationId = GraphActivationId(`activation-${workId}-${run}`)
  return {
    protocolVersion: 3 as const,
    graph: selectedGraph,
    node,
    role,
    runId: GraphRunId(run),
    cwd,
    workId,
    activationId,
    ownerEpoch: 1,
    operationId: GraphControlOperationId(`operation-${workId}`),
    callerId: 'graph-parent',
  }
}

async function setup(config: {
  goalId: string
  roleAgents: Record<string, string>
  executable?: string
  executableArgs?: string[]
  pathStyle?: 'native' | 'wsl'
  registry?: string
  graceMs?: number
  leaseTtlSeconds?: number
  writeScopes?: string[]
  journalPath?: string
  journalBusyTimeoutMs?: number
  journalMode?: 'wal' | 'delete' | 'truncate'
  journalEventWindow?: number
  watchReconnectAttempts?: number
  watchReconnectDelayMs?: number
  operationTimeoutMs?: number
  stdoutMaxBytes?: number
  stderrMaxBytes?: number
  transport?: 'process' | 'persistent'
  brokerPythonExecutable?: string
  brokerCommand?: string
} = { goalId: 'goal-1', roleAgents: { engineer: 'engineer-peer' } }) {
  const ctx = new Context()
  await ctx.plugin(FakeSubprocess).await()
  const runtime = ctx.subprocess as FakeSubprocess
  await ctx.plugin(LoopxGraphCoordination, { journalPath: ':memory:', ...config }).await()
  return { ctx, runtime, coordination: ctx.graphCoordination, signal: new AbortController().signal }
}

describe('LoopxGraphCoordination', () => {
  it('reserves package invariant ownership', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await ctx.plugin(LoopxInvariant).await()
    expect(() => {
      ctx.invariants.register('@deepseek-ai/dsh-graph-coordination-loopx', () => {})
    }).toThrow(/already registered/)
  })

  it('recovers the claimed todo so staged output can settle immediately after restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-loopx-settlement-restart-'))
    const journalPath = join(directory, 'coordination.sqlite')
    let first: Awaited<ReturnType<typeof setup>> | undefined
    let restored: Awaited<ReturnType<typeof setup>> | undefined
    try {
      first = await setup({ goalId: 'goal-1', roleAgents: { engineer: 'engineer-peer' }, journalPath })
      const base = request(graph.nodes[0]!)
      await first.coordination.prepare(graph, [role], base.cwd, first.signal)
      const claim = await first.coordination.claim(base, first.signal)
      const settlement = {
        ...base,
        claimId: claim.claimId,
        leaseId: claim.leaseId,
        fencingToken: claim.fencingToken,
        settlementId: GraphSettlementId('restart-settlement'),
        outcome: 'succeeded' as const,
        evidence: 'restart-safe evidence',
      }
      await first.ctx.fiber.dispose()
      first = undefined

      restored = await setup({ goalId: 'goal-1', roleAgents: { engineer: 'engineer-peer' }, journalPath })
      await expect(restored.coordination.settle(settlement, restored.signal)).resolves.toBeUndefined()
      const completion = restored.runtime.argv.find(args => args.includes('complete'))
      expect(completion).toEqual(expect.arrayContaining(['--todo-id', claim.todoId]))
      await expect(restored.coordination.settle(settlement, restored.signal)).resolves.toBeUndefined()
      await expect(restored.coordination.settle({ ...settlement, evidence: 'different' }, restored.signal)).rejects.toThrow(/conflicting/)
    } finally {
      await first?.ctx.fiber.dispose()
      await restored?.ctx.fiber.dispose()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('prepares, claims, and settles a graph node through the official CLI lifecycle', async () => {
    const { ctx, runtime, signal } = await setup()
    await ctx.graphCoordination.prepare(graph, [role], 'D:/work', signal)
    const node = graph.nodes[0]
    if (node === undefined) throw new Error('fixture node missing')
    const base = request(node)
    const claim = await ctx.graphCoordination.claim(base, signal)
    expect(claim).toMatchObject({ claimId: 'todo-2' })
    expect(JSON.parse(claim.observation)).toMatchObject({ goalId: 'goal-1', agentId: 'engineer-peer' })
    await ctx.graphCoordination.settle({
      ...base, claimId: claim.claimId, leaseId: claim.leaseId, fencingToken: claim.fencingToken,
      settlementId: GraphSettlementId('settlement-1'), outcome: 'succeeded', evidence: 'validated',
    }, signal)
    const claimCommands = runtime.argv.filter(args => args.includes('claim')).length
    await expect(ctx.graphCoordination.claim(base, signal)).resolves.toMatchObject({
      claimId: claim.claimId,
      terminal: { outcome: 'succeeded', evidence: 'validated' },
    })
    expect(runtime.argv.filter(args => args.includes('claim'))).toHaveLength(claimCommands)
    expect(runtime.argv.map(args => args.join(' '))).toEqual(expect.arrayContaining([
      expect.stringContaining('todo add'),
      expect.stringContaining('todo claim'),
      expect.stringContaining('todo complete'),
    ]))
    expect(runtime.argv.every(args => !args.includes('--project'))).toBe(true)
    const completion = runtime.argv.find(args => args.includes('complete'))
    expect(completion).not.toContain('--claimed-by')
    expect(completion).toContain('--no-follow-up')
    const commands = runtime.argv.map(args => args.join(' '))
    expect(commands.some(command => command.includes('quota '))).toBe(false)
    expect(commands.some(command => command.includes('refresh-state'))).toBe(false)
  })

  it('derives hard-lease scopes from precise node workspace ownership', async () => {
    const { ctx, runtime, signal } = await setup({
      goalId: 'goal-1', roleAgents: { engineer: 'engineer-peer' }, writeScopes: ['**/*'],
    })
    const node = {
      ...graph.nodes[0]!,
      workspace: {
        mode: 'isolated-copy', readRoots: ['.'], writeRoots: ['backend'], cleanup: 'retain-on-failure',
      },
    } as GraphRevision['nodes'][number]
    await ctx.graphCoordination.claim(request(node), signal)

    const acquire = runtime.argv.find(args => args.includes('acquire'))
    expect(acquire).toEqual(expect.arrayContaining([
      '--write-scope', 'backend', '--write-scope', 'backend/**',
    ]))
    expect(acquire).not.toContain('**/*')
  })

  it('uses fallback and activation-private scopes for whole-workspace and read-only nodes', async () => {
    const whole = await setup({
      goalId: 'goal-1', roleAgents: { engineer: 'engineer-peer' }, writeScopes: ['project/**'],
    })
    const wholeNode = {
      ...graph.nodes[0]!,
      workspace: { mode: 'shared', readRoots: ['.'], writeRoots: ['.'], cleanup: 'retain' },
    } as GraphRevision['nodes'][number]
    await whole.coordination.claim(request(wholeNode), whole.signal)
    expect(whole.runtime.argv.find(args => args.includes('acquire'))).toEqual(expect.arrayContaining([
      '--write-scope', 'project/**',
    ]))

    const readOnly = await setup()
    const readOnlyNode = {
      ...graph.nodes[0]!,
      workspace: { mode: 'read-only-snapshot', readRoots: ['.'], writeRoots: [], cleanup: 'retain' },
    } as GraphRevision['nodes'][number]
    const readOnlyRequest = request(readOnlyNode)
    await readOnly.coordination.claim(readOnlyRequest, readOnly.signal)
    const acquire = readOnly.runtime.argv.find(args => args.includes('acquire'))
    expect(acquire).toContain(`.dsh-graph-read/${String(readOnlyRequest.activationId).replaceAll(/[^A-Za-z0-9._-]/gu, '-')}`)
    expect(acquire).not.toContain('**/*')
  })

  it('carries the renewed LoopX lease version into terminal settlement', async () => {
    const { ctx, runtime, signal } = await setup()
    const node = graph.nodes[0]!
    const base = request(node)
    const claim = await ctx.graphCoordination.claim(base, signal)
    runtime.responses.push({ stdout: { ok: true, lease: { version: 2, expires_at: '2099-01-01T00:00:00.000Z' } } })
    const heartbeat = await ctx.graphCoordination.heartbeat({
      ...base,
      claimId: claim.claimId,
      leaseId: claim.leaseId,
      fencingToken: claim.fencingToken,
      progressSequence: 1,
    }, signal)
    await ctx.graphCoordination.settle({
      ...base,
      claimId: claim.claimId,
      leaseId: heartbeat.leaseId,
      fencingToken: heartbeat.fencingToken,
      settlementId: GraphSettlementId('settlement-renewed'),
      outcome: 'succeeded',
      evidence: 'validated after renewal',
    }, signal)

    expect(heartbeat).toMatchObject({ leaseId: `${claim.todoId}:2`, fencingToken: 2 })
    const completion = runtime.argv.find(args => args.includes('complete'))
    expect(completion).toEqual(expect.arrayContaining(['--task-lease-expected-version', '2']))
  })

  it('reconciles a durably older lease as the same monotonically renewed claim', async () => {
    const { ctx, runtime, signal } = await setup()
    const base = request(graph.nodes[0]!)
    const claim = await ctx.graphCoordination.claim(base, signal)
    runtime.responses.push({ stdout: { ok: true, lease: { version: 2, expires_at: '2099-01-01T00:00:00.000Z' } } })
    await ctx.graphCoordination.heartbeat({
      ...base,
      claimId: claim.claimId,
      leaseId: claim.leaseId,
      fencingToken: claim.fencingToken,
      progressSequence: 1,
    }, signal)

    await expect(ctx.graphCoordination.reconcile({
      protocolVersion: 3,
      workId: base.workId,
      activationId: base.activationId,
      cwd: base.cwd,
      callerId: base.callerId,
      claimId: claim.claimId,
      leaseId: claim.leaseId,
      fencingToken: claim.fencingToken,
    }, signal)).resolves.toMatchObject({
      status: 'confirmed-running',
      observation: { claim: { claimId: claim.claimId, fencingToken: 2 } },
    })

    await expect(ctx.graphCoordination.reconcile({
      protocolVersion: 3,
      workId: base.workId,
      activationId: base.activationId,
      cwd: base.cwd,
      callerId: base.callerId,
      claimId: claim.claimId,
      leaseId: `${claim.todoId}:3`,
      fencingToken: 3,
    }, signal)).resolves.toMatchObject({ status: 'conflict' })
  })

  it('rediscovers tagged work and hard leases after provider restart', async () => {
    const prepared = await setup()
    const node = graph.nodes[0]!
    const base = request(node)
    prepared.runtime.responses.push({
      stdout: {
        todos: [{
          todo_id: 'todo-recovered',
          text: `[dsh-activation:${base.activationId}] [dsh-work:${base.workId}] graph g1 revision 1 node a role engineer`,
          status: 'open',
        }],
      },
    })
    await prepared.coordination.prepare(graph, [role], base.cwd, prepared.signal)
    const claim = await prepared.coordination.claim(base, prepared.signal)
    expect(claim.claimId).toBe('todo-recovered')
    expect(prepared.runtime.argv.some(args => args.includes('add'))).toBe(false)

    const restored = await setup()
    restored.runtime.responses.push(
      { stdout: { todos: [{ todo_id: 'todo-recovered', text: `[dsh-activation:${base.activationId}] [dsh-work:${base.workId}]`, status: 'open' }] } },
      { stdout: { ok: true, active: true, lease: { owner: 'engineer-peer', version: 7, expires_at: '2099-01-01T00:00:00.000Z' } } },
    )
    const observation = await restored.coordination.observe({
      protocolVersion: 3,
      workId: base.workId,
      activationId: base.activationId,
      cwd: base.cwd,
      callerId: base.callerId,
    }, restored.signal)
    expect(observation).toMatchObject({
      status: 'claimed',
      claim: { claimId: 'todo-recovered', fencingToken: 7 },
    })
    const reconciled = await restored.coordination.reconcile({
      protocolVersion: 3,
      workId: base.workId,
      activationId: base.activationId,
      cwd: base.cwd,
      callerId: base.callerId,
      claimId: 'todo-recovered',
      leaseId: 'todo-recovered:7',
      fencingToken: 7,
    }, restored.signal)
    expect(reconciled.status).toBe('confirmed-running')
  })

  it('restores ordered cursors and progress idempotency from the durable journal', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-loopx-journal-'))
    const journalPath = join(directory, 'coordination.sqlite')
    let first: Awaited<ReturnType<typeof setup>> | undefined
    let restored: Awaited<ReturnType<typeof setup>> | undefined
    try {
      first = await setup({
        goalId: 'goal-1',
        roleAgents: { engineer: 'engineer-peer' },
        journalPath,
        journalEventWindow: 3,
      })
      const base = request(graph.nodes[0]!)
      await first.coordination.prepare(graph, [role], base.cwd, first.signal)
      const claim = await first.coordination.claim(base, first.signal)
      const progress = await first.coordination.publishProgress({
        ...base,
        claimId: claim.claimId,
        leaseId: claim.leaseId,
        fencingToken: claim.fencingToken,
        progressSequence: 1,
        evidence: 'durable progress',
      }, first.signal)
      const heartbeat = await first.coordination.heartbeat({
        ...base,
        claimId: claim.claimId,
        leaseId: claim.leaseId,
        fencingToken: claim.fencingToken,
        progressSequence: 1,
      }, first.signal)
      expect(progress.cursor).toBe('2')
      expect(heartbeat.progressCursor).toBe('3')
      await first.ctx.fiber.dispose()
      first = undefined

      restored = await setup({
        goalId: 'goal-1',
        roleAgents: { engineer: 'engineer-peer' },
        journalPath,
        journalEventWindow: 3,
      })
      restored.runtime.responses.push(
        {
          stdout: {
            todos: [{
              todo_id: claim.todoId,
              text: `[dsh-activation:${base.activationId}] [dsh-work:${base.workId}]`,
              status: 'open',
              note: '[dsh-progress:2] external progress committed before the journal write',
            }],
          },
        },
        {
          stdout: {
            ok: true,
            active: true,
            lease: {
              owner: 'engineer-peer',
              version: heartbeat.fencingToken,
              expires_at: '2099-01-01T00:00:00.000Z',
            },
          },
        },
      )
      const observation = await restored.coordination.observe({
        protocolVersion: 3,
        workId: base.workId,
        activationId: base.activationId,
        cwd: base.cwd,
        callerId: base.callerId,
        afterCursor: '0',
      }, restored.signal)
      expect(observation).toMatchObject({
        status: 'claimed',
        cursor: '4',
        compacted: true,
        events: [
          { cursor: '2', kind: 'progress', sequence: 1, evidence: 'durable progress' },
          { cursor: '3', kind: 'heartbeat', sequence: 1 },
          {
            cursor: '4',
            kind: 'progress',
            sequence: 2,
            evidence: 'external progress committed before the journal write',
          },
        ],
      })
      await expect(restored.coordination.publishProgress({
        ...base,
        claimId: claim.claimId,
        leaseId: heartbeat.leaseId,
        fencingToken: heartbeat.fencingToken,
        progressSequence: 1,
        evidence: 'durable progress',
      }, restored.signal)).resolves.toEqual({ cursor: '2' })
      await expect(restored.coordination.publishProgress({
        ...base,
        claimId: claim.claimId,
        leaseId: heartbeat.leaseId,
        fencingToken: heartbeat.fencingToken,
        progressSequence: 1,
        evidence: 'conflicting progress',
      }, restored.signal)).rejects.toThrow(/conflicts/)
      await expect(restored.coordination.publishProgress({
        ...base,
        claimId: claim.claimId,
        leaseId: heartbeat.leaseId,
        fencingToken: heartbeat.fencingToken,
        progressSequence: 2,
        evidence: 'external progress committed before the journal write',
      }, restored.signal)).resolves.toEqual({ cursor: '4' })
    } finally {
      await first?.ctx.fiber.dispose()
      await restored?.ctx.fiber.dispose()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('reports a compacted prefix while preserving progress replay identity', async () => {
    const run = await setup({
      goalId: 'goal-1',
      roleAgents: { engineer: 'engineer-peer' },
      journalEventWindow: 3,
    })
    const base = request(graph.nodes[0]!)
    const claim = await run.coordination.claim(base, run.signal)
    await run.coordination.publishProgress({
      ...base,
      claimId: claim.claimId,
      leaseId: claim.leaseId,
      fencingToken: claim.fencingToken,
      progressSequence: 1,
      evidence: 'first progress',
    }, run.signal)
    const firstHeartbeat = await run.coordination.heartbeat({
      ...base,
      claimId: claim.claimId,
      leaseId: claim.leaseId,
      fencingToken: claim.fencingToken,
      progressSequence: 1,
    }, run.signal)
    await run.coordination.publishProgress({
      ...base,
      claimId: claim.claimId,
      leaseId: firstHeartbeat.leaseId,
      fencingToken: firstHeartbeat.fencingToken,
      progressSequence: 2,
      evidence: 'second progress',
    }, run.signal)
    const secondHeartbeat = await run.coordination.heartbeat({
      ...base,
      claimId: claim.claimId,
      leaseId: firstHeartbeat.leaseId,
      fencingToken: firstHeartbeat.fencingToken,
      progressSequence: 2,
    }, run.signal)

    await expect(run.coordination.observe({
      protocolVersion: 3,
      workId: base.workId,
      activationId: base.activationId,
      cwd: base.cwd,
      callerId: base.callerId,
      afterCursor: '0',
    }, run.signal)).resolves.toMatchObject({
      cursor: '5',
      compacted: true,
      events: [
        { cursor: '3', kind: 'heartbeat' },
        { cursor: '4', kind: 'progress', sequence: 2 },
        { cursor: '5', kind: 'heartbeat' },
      ],
    })
    await expect(run.coordination.observe({
      protocolVersion: 3,
      workId: base.workId,
      activationId: base.activationId,
      cwd: base.cwd,
      callerId: base.callerId,
      afterCursor: '3',
    }, run.signal)).resolves.toMatchObject({
      cursor: '5',
      compacted: false,
      events: [{ cursor: '4' }, { cursor: '5' }],
    })
    await expect(run.coordination.publishProgress({
      ...base,
      claimId: claim.claimId,
      leaseId: secondHeartbeat.leaseId,
      fencingToken: secondHeartbeat.fencingToken,
      progressSequence: 1,
      evidence: 'first progress',
    }, run.signal)).resolves.toEqual({ cursor: '2' })
  })

  it('reconnects bounded watch reads and surfaces exhausted transport failures', async () => {
    const recovered = await setup({
      goalId: 'goal-1',
      roleAgents: { engineer: 'engineer-peer' },
      watchReconnectAttempts: 1,
      watchReconnectDelayMs: 1,
    })
    const base = request(graph.nodes[0]!)
    await recovered.coordination.claim(base, recovered.signal)
    recovered.runtime.responses.push({ exitCode: 9, stderr: 'temporary LoopX loss' })
    await expect(recovered.coordination.watch({
      protocolVersion: 3,
      workId: base.workId,
      activationId: base.activationId,
      cwd: base.cwd,
      callerId: base.callerId,
      afterCursor: '0',
    }, recovered.signal)).resolves.toMatchObject({ status: 'claimed' })
    expect(recovered.runtime.argv.filter(args => args.includes('evidence-log'))).toHaveLength(2)

    const exhausted = await setup({
      goalId: 'goal-1',
      roleAgents: { engineer: 'engineer-peer' },
      watchReconnectAttempts: 1,
      watchReconnectDelayMs: 1,
    })
    const exhaustedBase = request(graph.nodes[0]!, graph, 'D:/exhausted')
    await exhausted.coordination.claim(exhaustedBase, exhausted.signal)
    exhausted.runtime.responses.push(
      { exitCode: 9, stderr: 'first transport failure' },
      { exitCode: 9, stderr: 'second transport failure' },
    )
    await expect(exhausted.coordination.watch({
      protocolVersion: 3,
      workId: exhaustedBase.workId,
      activationId: exhaustedBase.activationId,
      cwd: exhaustedBase.cwd,
      callerId: exhaustedBase.callerId,
    }, exhausted.signal)).rejects.toThrow(/second transport failure/)
  })

  it('times out a LoopX process that honors the operation abort signal', async () => {
    const run = await setup({
      goalId: 'goal-1', roleAgents: { engineer: 'engineer-peer' }, operationTimeoutMs: 10,
    })
    run.runtime.responses.push({ waitForAbort: true })
    await expect(run.coordination.claim(request(graph.nodes[0]!), run.signal))
      .rejects.toThrow(/timed out after 10ms/)
  })

  it('bounds large LoopX responses with configurable collection limits', async () => {
    const configured = await setup({
      goalId: 'goal-1', roleAgents: { engineer: 'engineer-peer' },
      stdoutMaxBytes: 4_194_304, stderrMaxBytes: 262_144,
    })
    await configured.coordination.prepare(graph, [role], 'D:/work', configured.signal)
    expect(configured.runtime.specs[0]?.stdio).toEqual({
      stdin: 'ignore',
      stdout: { maxBytes: 4_194_304 },
      stderr: { maxBytes: 262_144 },
    })

    const truncated = await setup()
    truncated.runtime.responses.push({ stdout: '{"todos":[', stdoutLossy: true })
    await expect(truncated.coordination.prepare(graph, [role], 'D:/work', truncated.signal))
      .rejects.toThrow('LoopX todo list response exceeded stdoutMaxBytes=8388608')
  })

  it('reuses one persistent broker for independent LoopX operations', async () => {
    const ctx = new Context()
    await ctx.plugin(FakePersistentSubprocess).await()
    const runtime = ctx.subprocess as FakePersistentSubprocess
    await ctx.plugin(LoopxGraphCoordination, {
      goalId: 'goal-1', roleAgents: { engineer: 'engineer-peer' }, journalPath: ':memory:',
      executable: 'wsl.exe', executableArgs: ['-d', 'Ubuntu', '--exec'], pathStyle: 'wsl',
      transport: 'persistent', brokerPythonExecutable: 'python3', brokerCommand: '/root/.local/bin/loopx',
    }).await()
    const signal = new AbortController().signal
    await ctx.graphCoordination.prepare(graph, [role], 'D:\\work\\one', signal)
    await ctx.graphCoordination.prepare(graph, [role], 'D:\\work\\two', signal)
    expect(runtime.specs).toHaveLength(1)
    expect(runtime.specs[0]?.stdio).toEqual({ stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
    expect(runtime.specs[0]?.argv).toEqual(expect.arrayContaining([
      'wsl.exe', '-d', 'Ubuntu', '--exec', 'python3', '/root/.local/bin/loopx',
    ]))
    expect(runtime.requests.map(item => item['cwd'])).toEqual(['/mnt/d/work/one', '/mnt/d/work/two'])
    await ctx.fiber.dispose()
  })

  it('contains caller cancellation while a persistent stdin write is pending', async () => {
    const ctx = new Context()
    await ctx.plugin(PendingWritePersistentSubprocess).await()
    const runtime = ctx.subprocess as PendingWritePersistentSubprocess
    const broker = new PersistentLoopxBroker(ctx, brokerOptions)
    const controller = new AbortController()
    const unhandled: unknown[] = []
    const onUnhandled = (error: unknown): void => { unhandled.push(error) }
    process.on('unhandledRejection', onUnhandled)
    try {
      const operation = broker.run('/mnt/d/work', ['todo', 'list'], 1_000, 1_024, 1_024, controller.signal)
      await runtime.writeStarted.promise
      controller.abort()
      await expect(operation).rejects.toMatchObject({ name: 'AbortError' })
      await new Promise(resolve => setImmediate(resolve))
      expect(unhandled).toEqual([])
      runtime.releaseWrites()
      await broker.dispose()
    } finally {
      process.off('unhandledRejection', onUnhandled)
      await ctx.fiber.dispose()
    }
  })

  it('turns a persistent stdin EPIPE into the active broker request failure', async () => {
    const ctx = new Context()
    await ctx.plugin(PendingWritePersistentSubprocess).await()
    const runtime = ctx.subprocess as PendingWritePersistentSubprocess
    const broker = new PersistentLoopxBroker(ctx, brokerOptions)
    const operation = broker.run('/mnt/d/work', ['todo', 'list'], 1_000, 1_024, 1_024, new AbortController().signal)
    await runtime.writeStarted.promise
    expect(() => { runtime.emitStdinError(new Error('write EPIPE')) }).not.toThrow()
    await expect(operation).rejects.toThrow('write EPIPE')
    await broker.dispose()
    await ctx.fiber.dispose()
  })

  it('rejects persistent transport without an execution-world LoopX command', async () => {
    const ctx = new Context()
    await ctx.plugin(FakeSubprocess).await()
    expect(() => {
      new LoopxGraphCoordination(ctx, {
        goalId: 'goal-1', roleAgents: { engineer: 'engineer-peer' }, transport: 'persistent',
      })
    }).toThrow(/requires brokerCommand/)
  })

  it('decodes WSL UTF-16 diagnostics and normalizes its unsigned failure code', async () => {
    const ctx = new Context()
    await ctx.plugin(Utf16FailingPersistentSubprocess).await()
    await ctx.plugin(LoopxGraphCoordination, {
      goalId: 'goal-1', roleAgents: { engineer: 'engineer-peer' }, journalPath: ':memory:',
      executable: 'wsl.exe', executableArgs: ['-d', 'Ubuntu', '--exec'], pathStyle: 'wsl',
      transport: 'persistent', brokerCommand: '/root/.local/bin/loopx',
    }).await()
    await expect(ctx.graphCoordination.prepare(graph, [role], 'D:\\work', new AbortController().signal))
      .rejects.toThrow('LoopX broker exited (-1): 由于系统缓冲区空间不足或队列已满，不能执行套接字上的操作')
  })

  it('serializes settlement per activation without blocking another activation', async () => {
    const run = await setup()
    const firstBase = request(graph.nodes[0]!, graph, 'D:/work-a', 'run-a')
    const secondBase = request(graph.nodes[0]!, graph, 'D:/work-b', 'run-b')
    const firstClaim = await run.coordination.claim(firstBase, run.signal)
    const secondClaim = await run.coordination.claim(secondBase, run.signal)
    let releaseFirst!: () => void
    const firstWait = new Promise<void>((resolve) => { releaseFirst = resolve })
    run.runtime.responses.push({ doneWait: firstWait }, {})
    const firstSettlement = run.coordination.settle({
      ...firstBase,
      claimId: firstClaim.claimId,
      leaseId: firstClaim.leaseId,
      fencingToken: firstClaim.fencingToken,
      settlementId: GraphSettlementId('parallel-settlement-a'),
      outcome: 'succeeded',
      evidence: 'first activation complete',
    }, run.signal)
    const secondSettlement = run.coordination.settle({
      ...secondBase,
      claimId: secondClaim.claimId,
      leaseId: secondClaim.leaseId,
      fencingToken: secondClaim.fencingToken,
      settlementId: GraphSettlementId('parallel-settlement-b'),
      outcome: 'succeeded',
      evidence: 'second activation complete',
    }, run.signal)
    await new Promise(resolve => setImmediate(resolve))
    expect(run.runtime.argv.filter(args => args.includes('complete'))).toHaveLength(2)
    await expect(secondSettlement).resolves.toBeUndefined()
    releaseFirst()
    await expect(firstSettlement).resolves.toBeUndefined()
  })

  it('recovers a renewed lease after LoopX succeeds and the local journal write loses its process', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-loopx-heartbeat-loss-'))
    const journalPath = join(directory, 'coordination.sqlite')
    let first: Awaited<ReturnType<typeof setup>> | undefined
    let restored: Awaited<ReturnType<typeof setup>> | undefined
    let blocker: DatabaseSync | undefined
    try {
      first = await setup({
        goalId: 'goal-1',
        roleAgents: { engineer: 'engineer-peer' },
        journalPath,
        journalBusyTimeoutMs: 1,
      })
      const base = request(graph.nodes[0]!)
      const claim = await first.coordination.claim(base, first.signal)
      blocker = new DatabaseSync(journalPath)
      blocker.exec('BEGIN IMMEDIATE')
      await expect(first.coordination.heartbeat({
        ...base,
        claimId: claim.claimId,
        leaseId: claim.leaseId,
        fencingToken: claim.fencingToken,
        progressSequence: 1,
      }, first.signal)).rejects.toThrow(/locked|busy/i)
      blocker.exec('ROLLBACK')
      blocker.close()
      blocker = undefined
      await first.ctx.fiber.dispose()
      first = undefined

      restored = await setup({
        goalId: 'goal-1',
        roleAgents: { engineer: 'engineer-peer' },
        journalPath,
      })
      restored.runtime.responses.push(
        { stdout: { todos: [{ todo_id: claim.todoId, text: `[dsh-activation:${base.activationId}] [dsh-work:${base.workId}]`, status: 'open' }] } },
        {
          stdout: {
            ok: true,
            active: true,
            lease: { owner: 'engineer-peer', version: 2, expires_at: '2099-01-01T00:00:00.000Z' },
          },
        },
      )
      await expect(restored.coordination.observe({
        protocolVersion: 3,
        workId: base.workId,
        activationId: base.activationId,
        cwd: base.cwd,
        callerId: base.callerId,
      }, restored.signal)).resolves.toMatchObject({
        status: 'claimed',
        cursor: '2',
        claim: { leaseId: `${claim.todoId}:2`, fencingToken: 2 },
        events: [{ cursor: '1', kind: 'claimed' }, { cursor: '2', kind: 'heartbeat' }],
      })
    } finally {
      if (blocker !== undefined) {
        try { blocker.exec('ROLLBACK') } catch (error) {
          if (!(error instanceof Error) || !/no transaction is active/i.test(error.message)) throw error
        }
        blocker.close()
      }
      await first?.ctx.fiber.dispose()
      await restored?.ctx.fiber.dispose()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('recovers terminal settlement after LoopX succeeds and the local journal write loses its process', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-loopx-settlement-loss-'))
    const journalPath = join(directory, 'coordination.sqlite')
    let first: Awaited<ReturnType<typeof setup>> | undefined
    let restored: Awaited<ReturnType<typeof setup>> | undefined
    let blocker: DatabaseSync | undefined
    try {
      first = await setup({
        goalId: 'goal-1',
        roleAgents: { engineer: 'engineer-peer' },
        journalPath,
        journalBusyTimeoutMs: 1,
      })
      const base = request(graph.nodes[0]!)
      const claim = await first.coordination.claim(base, first.signal)
      const settlement = {
        ...base,
        claimId: claim.claimId,
        leaseId: claim.leaseId,
        fencingToken: claim.fencingToken,
        settlementId: GraphSettlementId('lost-process-settlement'),
        outcome: 'succeeded' as const,
        evidence: 'external terminal evidence',
      }
      blocker = new DatabaseSync(journalPath)
      blocker.exec('BEGIN IMMEDIATE')
      await expect(first.coordination.settle(settlement, first.signal)).rejects.toThrow(/locked|busy/i)
      const completion = first.runtime.argv.find(args => args.includes('complete'))
      const evidenceIndex = completion?.indexOf('--evidence') ?? -1
      const persistedEvidence = evidenceIndex < 0 ? undefined : completion?.[evidenceIndex + 1]
      expect(persistedEvidence).toContain('[dsh-settlement:lost-process-settlement]')
      blocker.exec('ROLLBACK')
      blocker.close()
      blocker = undefined
      await first.ctx.fiber.dispose()
      first = undefined

      restored = await setup({
        goalId: 'goal-1',
        roleAgents: { engineer: 'engineer-peer' },
        journalPath,
      })
      restored.runtime.responses.push({
        stdout: {
          todos: [{
            todo_id: claim.todoId,
            text: `[dsh-activation:${base.activationId}] [dsh-work:${base.workId}]`,
            status: 'done',
            completion_evidence: persistedEvidence,
          }],
        },
      })
      await expect(restored.coordination.observe({
        protocolVersion: 3,
        workId: base.workId,
        activationId: base.activationId,
        cwd: base.cwd,
        callerId: base.callerId,
      }, restored.signal)).resolves.toMatchObject({
        status: 'terminal',
        terminal: { outcome: 'succeeded', evidence: 'external terminal evidence' },
      })
      await expect(restored.coordination.settle(settlement, restored.signal)).resolves.toBeUndefined()
    } finally {
      if (blocker !== undefined) {
        try { blocker.exec('ROLLBACK') } catch (error) {
          if (!(error instanceof Error) || !/no transaction is active/i.test(error.message)) throw error
        }
        blocker.close()
      }
      await first?.ctx.fiber.dispose()
      await restored?.ctx.fiber.dispose()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('rejects malformed durable event records at the journal boundary', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-loopx-journal-invalid-'))
    const journalPath = join(directory, 'coordination.sqlite')
    const base = request(graph.nodes[0]!)
    let first: Awaited<ReturnType<typeof setup>> | undefined
    let restored: Awaited<ReturnType<typeof setup>> | undefined
    try {
      first = await setup({ goalId: 'goal-1', roleAgents: { engineer: 'engineer-peer' }, journalPath })
      await first.coordination.prepare(graph, [role], base.cwd, first.signal)
      await first.coordination.claim(base, first.signal)
      await first.ctx.fiber.dispose()
      first = undefined
      const database = new DatabaseSync(journalPath)
      database.prepare('UPDATE graph_loopx_events SET event_json = ?').run('{}')
      database.close()

      restored = await setup({ goalId: 'goal-1', roleAgents: { engineer: 'engineer-peer' }, journalPath })
      await expect(restored.coordination.observe({
        protocolVersion: 3,
        workId: base.workId,
        activationId: base.activationId,
        cwd: base.cwd,
        callerId: base.callerId,
      }, restored.signal)).rejects.toThrow(/invalid event/)
    } finally {
      await first?.ctx.fiber.dispose()
      await restored?.ctx.fiber.dispose()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('recovers terminal settlement evidence from a tagged todo', async () => {
    const restored = await setup()
    const base = request(graph.nodes[0]!)
    restored.runtime.responses.push({
      stdout: {
        todos: [{
          todo_id: 'todo-done',
          text: `[dsh-activation:${base.activationId}] [dsh-work:${base.workId}]`,
          status: 'done',
          completion_evidence: 'tests passed',
        }],
      },
    })
    const result = await restored.coordination.reconcile({
      protocolVersion: 3,
      workId: base.workId,
      activationId: base.activationId,
      cwd: base.cwd,
      callerId: base.callerId,
      expectedOutcome: 'succeeded',
    }, restored.signal)
    expect(result).toMatchObject({ status: 'confirmed-terminal', evidence: 'LoopX terminal outcome confirmed' })
    expect(result.observation).toMatchObject({ status: 'terminal', terminal: { outcome: 'succeeded', evidence: 'tests passed' } })
  })

  it('lazily maps every graph task kind and scopes the node-todo cache by working directory', async () => {
    const { coordination, runtime, signal } = await setup({
      goalId: 'goal-1',
      roleAgents: { engineer: 'engineer-peer' },
      executable: 'loopx-custom',
      registry: 'D:/registry.sqlite',
      graceMs: 500,
    })
    const kinds = ['verification', 'review', 'documentation', 'implementation', 'analysis'] as const
    const expanded = {
      ...graph,
      nodes: kinds.map((kind, index) => ({ ...graph.nodes[0]!, id: `node-${String(index)}`, kind })),
    } as unknown as GraphRevision
    await coordination.prepare(expanded, [role], 'D:/work', signal)
    for (const node of expanded.nodes) {
      await coordination.claim(request(node, expanded, 'D:/work', 'run-1'), signal)
    }
    const firstAddCount = runtime.argv.filter(args => args.includes('add')).length
    for (const node of expanded.nodes) {
      await coordination.claim(request(node, expanded, 'D:/work', 'run-1'), signal)
    }
    expect(runtime.argv.filter(args => args.includes('add'))).toHaveLength(firstAddCount)
    for (const node of expanded.nodes) {
      await coordination.claim(request(node, expanded, 'D:/other-work', 'run-3'), signal)
    }
    expect(runtime.argv.filter(args => args.includes('add'))).toHaveLength(firstAddCount * 2)
    const commands = runtime.argv.map(args => args.join(' '))
    expect(commands).toEqual(expect.arrayContaining([
      expect.stringContaining('--action-kind validate'),
      expect.stringContaining('--action-kind writeback'),
      expect.stringContaining('--action-kind rebuild'),
      expect.stringContaining('--action-kind run_eval'),
      expect.stringContaining('loopx-custom --registry D:/registry.sqlite --format json'),
    ]))
  })

  it('launches LoopX through WSL and keeps every todo in the configured goal state', async () => {
    const { coordination, runtime, signal } = await setup({
      goalId: 'goal-1',
      roleAgents: { engineer: 'engineer-peer' },
      executable: 'wsl.exe',
      executableArgs: ['-d', 'Ubuntu', '--', '/root/.local/bin/loopx'],
      pathStyle: 'wsl',
      registry: 'D:\\state\\registry.json',
    })
    await coordination.prepare(graph, [role], 'D:\\work\\repo', signal)
    expect(runtime.argv[0]).toEqual([
      'wsl.exe', '-d', 'Ubuntu', '--', '/root/.local/bin/loopx',
      '--registry', '/mnt/d/state/registry.json', '--format', 'json',
      'todo', 'list', '--goal-id', 'goal-1',
    ])
    await coordination.claim(request(graph.nodes[0]!, graph, 'D:\\work\\repo'), signal)
    expect(runtime.argv[1]).toEqual([
      'wsl.exe', '-d', 'Ubuntu', '--', '/root/.local/bin/loopx',
      '--registry', '/mnt/d/state/registry.json', '--format', 'json',
      'todo', 'add', '--goal-id', 'goal-1',
      '--role', 'agent', '--task-class', 'advancement_task', '--action-kind', 'rebuild',
      '--text', '[dsh-activation:activation-work-g1-a-D--work-repo-run-1] [dsh-work:work-g1-a-D--work-repo] graph g1 revision 1 node a role engineer',
    ])
  })

  it('leaves non-Windows registry paths unchanged for a WSL executable', async () => {
    const { coordination, runtime, signal } = await setup({
      goalId: 'goal-1',
      roleAgents: { engineer: 'engineer-peer' },
      executable: 'wsl.exe',
      pathStyle: 'wsl',
      registry: '/var/lib/loopx/registry.json',
    })
    await coordination.prepare(graph, [role], 'D:/work', signal)
    expect(runtime.argv[0]).toContain('/var/lib/loopx/registry.json')
  })

  it('rejects missing deployment identity and unavailable role mappings', async () => {
    const ctx = new Context()
    await ctx.plugin(FakeSubprocess).await()
    expect(() => { new LoopxGraphCoordination(ctx, { goalId: ' ', roleAgents: { engineer: 'peer' } }) })
      .toThrow(/requires goalId/)

    const empty = new Context()
    await empty.plugin(FakeSubprocess).await()
    expect(() => { new LoopxGraphCoordination(empty, { goalId: 'goal', roleAgents: {} }) })
      .toThrow(/requires roleAgents/)

    const unavailable = await setup()
    await expect(unavailable.coordination.prepare(graph, [{ ...role, enabled: false }], 'D:/work', unavailable.signal))
      .rejects.toThrow(/unavailable graph role/)
    const missing = await setup({ goalId: 'goal', roleAgents: { reviewer: 'peer' } })
    await expect(missing.coordination.prepare(graph, [role], 'D:/work', missing.signal))
      .rejects.toThrow(/no registered peer mapping/)
    const blank = await setup({ goalId: 'goal', roleAgents: { engineer: ' ' } })
    await expect(blank.coordination.prepare(graph, [role], 'D:/work', blank.signal))
      .rejects.toThrow(/no registered peer mapping/)
  })

  it('rejects malformed todo creation responses', async () => {
    for (const response of [
      { stdout: { changed: true } },
      { stdout: { todo_id: '' } },
      { stdout: null },
      { stdout: [] },
      { stdout: 'not-json' },
    ]) {
      const run = await setup()
      await run.coordination.prepare(graph, [role], 'D:/work', run.signal)
      run.runtime.responses.push(response)
      await expect(run.coordination.claim(request(graph.nodes[0]!), run.signal)).rejects.toThrow(/LoopX/)
    }
  })

  it('reports subprocess failure using stderr or captured stdout', async () => {
    const stderrFailure = await setup()
    stderrFailure.runtime.responses.push({ exitCode: 2, stderr: 'denied', omitStdout: true })
    await expect(stderrFailure.coordination.prepare(graph, [role], 'D:/work', stderrFailure.signal))
      .rejects.toThrow(/denied/)

    const stdoutFailure = await setup()
    stdoutFailure.runtime.responses.push({ exitCode: 3, stdout: 'stdout failure', omitStderr: true })
    await expect(stdoutFailure.coordination.prepare(graph, [role], 'D:/work', stdoutFailure.signal))
      .rejects.toThrow(/stdout failure/)
  })

  it('enforces claim acknowledgements and reports claimed todo metadata', async () => {
    const node = graph.nodes[0]!
    const missingTodo = await setup()
    await expect(missingTodo.coordination.settle({
      ...request(node), claimId: 'missing', leaseId: 'missing', fencingToken: 1,
      settlementId: GraphSettlementId('settlement-missing'), outcome: 'succeeded', evidence: 'none',
    }, missingTodo.signal)).rejects.toThrow(/absent or fenced/)

    const rejected = await setup()
    await rejected.coordination.prepare(graph, [role], 'D:/work', rejected.signal)
    rejected.runtime.responses.push(
      { stdout: { todo_id: 'todo-rejected' } },
      { stdout: { claimed_by: 'other', changed: true } },
    )
    await expect(rejected.coordination.claim(request(node), rejected.signal)).rejects.toThrow(/did not confirm claim/)

    const unchanged = await setup()
    await unchanged.coordination.prepare(graph, [role], 'D:/work', unchanged.signal)
    unchanged.runtime.responses.push(
      { stdout: { todo_id: 'todo-unchanged' } },
      { stdout: { claimed_by: 'other', changed: false, status: 'open', task_class: 'advancement_task' } },
    )
    const claim = await unchanged.coordination.claim(request(node), unchanged.signal)
    expect(JSON.parse(claim.observation)).toMatchObject({
      todoId: 'todo-unchanged', claimedBy: 'other', status: 'open', taskClass: 'advancement_task',
    })
  })

  it('blocks and clears a soft claim when hard lease acquisition fails', async () => {
    const run = await setup()
    const node = graph.nodes[0]!
    await run.coordination.prepare(graph, [role], 'D:/work', run.signal)
    run.runtime.responses.push(
      { stdout: { todo_id: 'todo-lease-conflict' } },
      { stdout: { claimed_by: 'engineer-peer', changed: true } },
      { exitCode: 2, stderr: 'write_scope_conflict' },
      { stdout: { changed: true } },
    )
    await expect(run.coordination.claim(request(node), run.signal)).rejects.toThrow('write_scope_conflict')
    expect(run.runtime.argv.at(-1)).toEqual(expect.arrayContaining([
      'todo', 'update', '--todo-id', 'todo-lease-conflict', '--agent-id', 'engineer-peer',
      '--clear-claim', '--status', 'blocked', '--task-class', 'blocker',
    ]))
  })

  it('writes blocker settlements without spending a success slot', async () => {
    const run = await setup()
    const node = graph.nodes[0]!
    await run.coordination.prepare(graph, [role], 'D:/work', run.signal)
    const base = request(node)
    const claim = await run.coordination.claim(base, run.signal)
    await expect(run.coordination.settle({
      ...base, claimId: 'wrong', leaseId: claim.leaseId, fencingToken: claim.fencingToken,
      settlementId: GraphSettlementId('settlement-wrong'), outcome: 'failed', evidence: 'blocked',
    }, run.signal)).rejects.toThrow(/absent or fenced/)
    await run.coordination.settle({
      ...base, claimId: claim.claimId, leaseId: claim.leaseId, fencingToken: claim.fencingToken,
      settlementId: GraphSettlementId('settlement-failed'), outcome: 'failed', evidence: 'blocked',
    }, run.signal)
    const commands = run.runtime.argv.map(args => args.join(' '))
    expect(commands.some(command => command.includes('todo update'))).toBe(true)
    expect(commands.some(command => command.includes('quota spend-slot'))).toBe(false)
  })
})

runGraphCoordinationContract('loopx-cli', async () => {
  const run = await setup()
  return { coordination: run.coordination, signal: run.signal }
})
