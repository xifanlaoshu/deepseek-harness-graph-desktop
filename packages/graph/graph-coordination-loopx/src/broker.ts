/** Persistent stdio transport for LoopX CLI invocations. @module @deepseek-ai/dsh-graph-coordination-loopx/broker */

import { Buffer } from 'node:buffer'
import { createInterface } from 'node:readline'
import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle, SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'
import { LOOPX_BROKER_SOURCE } from './broker-source.ts'

const BROKER_PROTOCOL = 1

interface BrokerResponse {
  readonly type: 'response'
  readonly protocol: number
  readonly id: string
  readonly exitCode?: number | null
  readonly timedOut?: boolean
  readonly cancelled?: boolean
  readonly spawnError?: string
  readonly stdout?: string
  readonly stderr?: string
  readonly stdoutLossy?: boolean
  readonly stderrLossy?: boolean
}

/** One completed CLI invocation returned through the persistent broker. */
export interface BrokerCommandResult {
  readonly exitCode: number | null
  readonly timedOut: boolean
  readonly stdout: string
  readonly stderr: string
  readonly stdoutLossy: boolean
  readonly stderrLossy: boolean
}

interface PendingRequest {
  readonly resolve: (response: BrokerResponse) => void
  readonly reject: (error: Error) => void
  readonly signal: AbortSignal
  readonly onAbort: () => void
}

interface BrokerState {
  readonly handle: SubprocessHandle
  readonly controller: AbortController
  readonly ready: Promise<void>
  readonly readyResolve: () => void
  readonly readyReject: (error: Error) => void
  readonly pending: Map<string, PendingRequest>
  readonly stdoutTail: ByteTail
  readonly stderrTail: ByteTail
  readySeen: boolean
  closed: boolean
}

class ByteTail {
  private value = Buffer.alloc(0)

  constructor(private readonly maximum: number) {}

  push(chunk: Buffer): void {
    this.value = Buffer.concat([this.value, chunk])
    if (this.value.length > this.maximum) this.value = this.value.subarray(this.value.length - this.maximum)
  }

  bytes(): Buffer { return this.value }
}

function decodedDiagnostic(bytes: Buffer): string {
  if (bytes.length === 0) return ''
  let zeroes = 0
  for (const byte of bytes) if (byte === 0) zeroes += 1
  const encoding: BufferEncoding = bytes.length % 2 === 0 && zeroes / bytes.length > 0.2 ? 'utf16le' : 'utf8'
  return bytes.toString(encoding).replaceAll('\0', '').trim()
}

function signedExitCode(exitCode: number | null): number | null {
  return exitCode !== null && exitCode > 0x7fff_ffff ? exitCode - 0x1_0000_0000 : exitCode
}

function errorOf(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

function brokerMessage(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('LoopX broker returned non-object JSON')
  return value as Record<string, unknown>
}

/** Configuration for one provider-owned persistent CLI bridge. */
export interface PersistentLoopxBrokerOptions {
  readonly launcher: string
  readonly launcherArgs: readonly string[]
  readonly pythonExecutable: string
  readonly command: string
  readonly graceMs: number
  readonly startTimeoutMs: number
  readonly diagnosticMaxBytes: number
}

/**
 * Owns one persistent launcher process and multiplexes bounded CLI requests.
 * Unexpected exit rejects every in-flight request; a later request starts a
 * fresh broker. Caller cancellation rejects only that request, including while
 * its stdin write is pending. Stdio failures are contained as broker failures.
 * Disposal closes stdin, waits for exit, then escalates the complete launcher
 * tree before returning.
 */
export class PersistentLoopxBroker {
  private state: BrokerState | undefined
  private starting: Promise<BrokerState> | undefined
  private sequence = 0
  private disposed = false

  constructor(
    private readonly ctx: Context,
    private readonly options: PersistentLoopxBrokerOptions,
  ) {}

  /**
   * Execute one LoopX CLI operation through the shared broker.
   * @param cwd - working directory expressed in the broker execution environment.
   * @param args - LoopX CLI arguments without the configured executable.
   * @param timeoutMs - complete operation deadline enforced inside the broker.
   * @param stdoutMaxBytes - retained stdout byte limit.
   * @param stderrMaxBytes - retained stderr byte limit.
   * @param signal - caller cancellation and outer operation deadline.
   * @returns CLI exit, timeout, output, and truncation facts.
   */
  async run(
    cwd: string,
    args: readonly string[],
    timeoutMs: number,
    stdoutMaxBytes: number,
    stderrMaxBytes: number,
    signal: AbortSignal,
  ): Promise<BrokerCommandResult> {
    if (this.disposed) throw new Error('LoopX broker is disposed')
    const state = await this.start(signal)
    signal.throwIfAborted()
    const id = `request-${String(++this.sequence)}`
    const response = await this.request(state, {
      type: 'request', protocol: BROKER_PROTOCOL, id, cwd, args,
      timeoutMs, stdoutMaxBytes, stderrMaxBytes, graceMs: this.options.graceMs,
    }, signal)
    if (response.spawnError !== undefined) throw new Error(`LoopX broker could not start the CLI: ${response.spawnError}`)
    if (response.cancelled === true) throw new Error('LoopX broker operation was cancelled')
    return {
      exitCode: response.exitCode ?? null,
      timedOut: response.timedOut === true,
      stdout: Buffer.from(response.stdout ?? '', 'base64').toString('utf8'),
      stderr: Buffer.from(response.stderr ?? '', 'base64').toString('utf8'),
      stdoutLossy: response.stdoutLossy === true,
      stderrLossy: response.stderrLossy === true,
    }
  }

  /** Stop the broker and every command it owns before returning. */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    const state = this.state ?? await this.starting?.catch(() => undefined)
    if (state === undefined || state.closed) return
    this.rejectPending(state, new Error('LoopX broker is disposing'))
    state.handle.stdin?.end()
    const exited = await state.handle.waitForExit(AbortSignal.timeout(this.options.graceMs))
    if (exited) return
    state.handle.terminate()
    await state.handle.waitForExit()
  }

  private async start(signal: AbortSignal): Promise<BrokerState> {
    if (this.state !== undefined && !this.state.closed) {
      await this.waitReady(this.state, signal)
      return this.state
    }
    const starting = this.starting ??= this.spawn()
    let state: BrokerState
    try {
      state = await starting
      await this.waitReady(state, signal)
    } finally {
      if (this.starting === starting) this.starting = undefined
    }
    return state
  }

  private async spawn(): Promise<BrokerState> {
    const executable = await this.ctx.subprocess.resolveExecutable(this.options.launcher)
    const controller = new AbortController()
    const ready = Promise.withResolvers<void>()
    const handle = this.ctx.subprocess.spawn({
      argv: [
        executable,
        ...this.options.launcherArgs,
        this.options.pythonExecutable,
        '-u', '-c', LOOPX_BROKER_SOURCE,
        this.options.command,
      ],
      cwd: process.cwd(),
      stdio: {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      },
      graceMs: this.options.graceMs,
      signal: controller.signal,
    })
    if (handle.stdin === undefined || handle.stdout === undefined || handle.stderr === undefined) {
      handle.terminate()
      throw new Error('LoopX broker launcher did not expose piped stdio')
    }
    const state: BrokerState = {
      handle, controller,
      ready: ready.promise,
      readyResolve: ready.resolve,
      readyReject: ready.reject,
      pending: new Map(),
      stdoutTail: new ByteTail(this.options.diagnosticMaxBytes),
      stderrTail: new ByteTail(this.options.diagnosticMaxBytes),
      readySeen: false,
      closed: false,
    }
    this.state = state
    const startTimer = setTimeout(() => {
      this.fail(state, new Error(`LoopX broker did not become ready within ${String(this.options.startTimeoutMs)}ms`))
    }, this.options.startTimeoutMs)
    void state.ready.then(
      () => { clearTimeout(startTimer) },
      () => { clearTimeout(startTimer) },
    )
    handle.stdout.on('data', (chunk: Buffer) => { state.stdoutTail.push(chunk) })
    handle.stderr.on('data', (chunk: Buffer) => { state.stderrTail.push(chunk) })
    const lines = createInterface({ input: handle.stdout, crlfDelay: Infinity })
    lines.on('line', (line) => { this.receive(state, line) })
    handle.stdin.on('error', (error) => {
      if (!this.disposed) this.fail(state, errorOf(error))
    })
    handle.stdout.on('error', (error) => { this.fail(state, errorOf(error)) })
    handle.stderr.on('error', (error) => { this.fail(state, errorOf(error)) })
    void handle.done.then(
      (outcome) => { this.closed(state, outcome) },
      (error: unknown) => { this.fail(state, errorOf(error)) },
    )
    return state
  }

  private receive(state: BrokerState, line: string): void {
    let message: Record<string, unknown>
    try {
      message = brokerMessage(JSON.parse(line))
    } catch (error) {
      if (state.readySeen) this.fail(state, new Error('LoopX broker returned invalid protocol JSON', { cause: error }))
      return
    }
    if (message['protocol'] !== BROKER_PROTOCOL) {
      this.fail(state, new Error('LoopX broker returned an unsupported protocol version'))
      return
    }
    if (message['type'] === 'ready') {
      if (!state.readySeen) {
        state.readySeen = true
        state.readyResolve()
      }
      return
    }
    if (message['type'] === 'protocolError') {
      const detail = typeof message['message'] === 'string' ? message['message'] : 'unknown error'
      this.fail(state, new Error(`LoopX broker protocol error: ${detail}`))
      return
    }
    if (message['type'] !== 'response' || typeof message['id'] !== 'string') {
      this.fail(state, new Error('LoopX broker returned an invalid protocol message'))
      return
    }
    const pending = state.pending.get(message['id'])
    if (pending === undefined) return
    state.pending.delete(message['id'])
    pending.signal.removeEventListener('abort', pending.onAbort)
    pending.resolve(message as unknown as BrokerResponse)
  }

  private async request(state: BrokerState, message: Record<string, unknown>, signal: AbortSignal): Promise<BrokerResponse> {
    const id = message['id'] as string
    const result = Promise.withResolvers<BrokerResponse>()
    const onAbort = (): void => {
      const pending = state.pending.get(id)
      if (pending === undefined) return
      state.pending.delete(id)
      this.writeBestEffort(state, { type: 'cancel', protocol: BROKER_PROTOCOL, id })
      result.reject(errorOf(signal.reason ?? 'LoopX broker operation aborted'))
    }
    const pending: PendingRequest = { resolve: result.resolve, reject: result.reject, signal, onAbort }
    state.pending.set(id, pending)
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
    if (!state.pending.has(id)) return await result.promise
    void this.write(state, message).catch((error: unknown) => {
      if (state.pending.get(id) !== pending) return
      state.pending.delete(id)
      signal.removeEventListener('abort', onAbort)
      result.reject(errorOf(error))
    })
    return await result.promise
  }

  private write(state: BrokerState, message: Record<string, unknown>): Promise<void> {
    const stdin = state.handle.stdin
    if (state.closed || stdin === undefined) return Promise.reject(new Error('LoopX broker is not running'))
    return new Promise((resolve, reject) => {
      stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error === null || error === undefined) resolve()
        else reject(error)
      })
    })
  }

  private writeBestEffort(state: BrokerState, message: Record<string, unknown>): void {
    void this.write(state, message).catch(() => {
      // The broker exit path rejects the original request and every peer request.
    })
  }

  private waitReady(state: BrokerState, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(errorOf(signal.reason ?? 'LoopX broker start aborted'))
    const aborted = Promise.withResolvers<void>()
    const onAbort = (): void => { aborted.reject(errorOf(signal.reason ?? 'LoopX broker start aborted')) }
    signal.addEventListener('abort', onAbort, { once: true })
    return Promise.race([state.ready, aborted.promise]).finally(() => {
      signal.removeEventListener('abort', onAbort)
    })
  }

  private closed(state: BrokerState, outcome: SubprocessOutcome): void {
    const stderr = decodedDiagnostic(state.stderrTail.bytes())
    const stdout = state.readySeen ? '' : decodedDiagnostic(state.stdoutTail.bytes())
    const detail = stderr || stdout
    const exitCode = signedExitCode(outcome.exitCode)
    this.fail(state, new Error(`LoopX broker exited (${String(exitCode)})${detail ? `: ${detail}` : ''}`))
  }

  private fail(state: BrokerState, error: Error): void {
    if (state.closed) return
    state.closed = true
    state.readyReject(error)
    this.rejectPending(state, error)
    if (this.state === state) this.state = undefined
    state.handle.terminate()
  }

  private rejectPending(state: BrokerState, error: Error): void {
    for (const pending of state.pending.values()) {
      pending.signal.removeEventListener('abort', pending.onAbort)
      pending.reject(error)
    }
    state.pending.clear()
  }
}
