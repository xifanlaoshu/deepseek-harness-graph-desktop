/** LoopX CLI provider for graph-worker coordination. @module @deepseek-ai/dsh-graph-coordination-loopx */

import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { GraphActivationId, GraphNode, GraphRevision, GraphRole } from '@deepseek-ai/dsh-graph'
import { GraphCoordination } from '@deepseek-ai/dsh-graph-coordination'
import type {
  GraphCoordinationCancellation,
  GraphCoordinationClaim,
  GraphCoordinationEvent,
  GraphCoordinationHeartbeat,
  GraphCoordinationHeartbeatResult,
  GraphCoordinationObservation,
  GraphCoordinationObserveRequest,
  GraphCoordinationProgress,
  GraphCoordinationReconcileRequest,
  GraphCoordinationReconcileResult,
  GraphCoordinationRequest,
  GraphCoordinationSettlement,
} from '@deepseek-ai/dsh-graph-coordination'
import type {} from '@deepseek-ai/dsh-subprocess'
import { PersistentLoopxBroker } from './broker.ts'
import { LoopxCoordinationJournal } from './journal.ts'

/** Deployment binding to one existing LoopX goal and its registered peer ids. */
export interface Config {
  /** Existing LoopX guided-goal identity that owns graph todos. */
  readonly goalId: string
  /** Graph role id to pre-registered LoopX peer-agent id mapping. */
  readonly roleAgents: Record<string, string>
  /** LoopX CLI command or executable path. */
  readonly executable?: string
  /** Arguments inserted after the executable and before LoopX CLI arguments. */
  readonly executableArgs?: string[]
  /** CLI launch mode: one process per operation or one persistent stdio broker. */
  readonly transport?: 'process' | 'persistent'
  /** Python executable inside the persistent broker's execution environment. */
  readonly brokerPythonExecutable?: string
  /** LoopX executable inside the persistent broker's execution environment. */
  readonly brokerCommand?: string
  /** Path syntax expected by the LoopX process. */
  readonly pathStyle?: 'native' | 'wsl'
  /** Optional LoopX registry path passed to every CLI invocation. */
  readonly registry?: string
  /** Subprocess termination grace period in milliseconds. */
  readonly graceMs?: number
  /** Maximum wall time for one LoopX CLI operation. */
  readonly operationTimeoutMs?: number
  /** Maximum captured stdout bytes for one LoopX JSON response. */
  readonly stdoutMaxBytes?: number
  /** Maximum captured stderr bytes for one LoopX CLI operation. */
  readonly stderrMaxBytes?: number
  /** LoopX hard-lease duration in seconds. */
  readonly leaseTtlSeconds?: number
  /** Fallback relative workspace scopes for nodes without precise write ownership. */
  readonly writeScopes?: string[]
  /** Durable local event-projection database or `:memory:` for an ephemeral deployment. */
  readonly journalPath?: string
  /** Maximum time the event journal waits for a competing transaction. */
  readonly journalBusyTimeoutMs?: number
  /** SQLite journal mode for the local event projection. */
  readonly journalMode?: 'wal' | 'delete' | 'truncate'
  /** Maximum recent event suffix retained in memory per work id. */
  readonly journalEventWindow?: number
  /** Additional bounded LoopX reads attempted by `watch` after transport failure. */
  readonly watchReconnectAttempts?: number
  /** Delay between bounded `watch` reconnect attempts. */
  readonly watchReconnectDelayMs?: number
}

class LoopxCommandError extends Error {}

/** LoopX provider configuration schema. */
export const Config: z<Config> = z.object({
  goalId: z.string().required(),
  roleAgents: z.dict(z.string()).required(),
  executable: z.string().default('loopx'),
  executableArgs: z.array(z.string()).default([]),
  transport: z.union(['process', 'persistent'] as const).default('process'),
  brokerPythonExecutable: z.string().default('python3'),
  brokerCommand: z.string(),
  pathStyle: z.union(['native', 'wsl'] as const).default('native'),
  registry: z.string(),
  graceMs: z.natural().min(1).max(60_000).default(10_000),
  operationTimeoutMs: z.natural().min(1).max(300_000).default(60_000),
  stdoutMaxBytes: z.natural().min(1_024).max(67_108_864).default(8_388_608),
  stderrMaxBytes: z.natural().min(1_024).max(67_108_864).default(1_048_576),
  leaseTtlSeconds: z.natural().min(30).max(86_400).default(2_700),
  writeScopes: z.array(z.string()).default(['**/*']),
  journalPath: z.string().default('.sessions/graph-coordination-loopx.sqlite'),
  journalBusyTimeoutMs: z.natural().min(1).max(300_000).default(5_000),
  journalMode: z.union(['wal', 'delete', 'truncate'] as const).default('wal'),
  journalEventWindow: z.natural().min(2).max(10_000).default(256),
  watchReconnectAttempts: z.natural().max(10).default(2),
  watchReconnectDelayMs: z.natural().min(1).max(10_000).default(50),
})

type JsonRecord = Record<string, unknown>

const terminalTodoStatus = (status: unknown): status is string => (
  status === 'done' || status === 'completed' || status === 'blocked' || status === 'canceled'
)

const record = (value: unknown, operation: string): JsonRecord => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`LoopX ${operation} returned non-object JSON`)
  return value as JsonRecord
}

const actionKind = (node: GraphNode): string => {
  switch (node.kind) {
    case 'verification': return 'validate'
    case 'review': return 'validate'
    case 'documentation': return 'writeback'
    case 'implementation': return 'rebuild'
    default: return 'run_eval'
  }
}

/** LoopX-backed coordination over one pre-existing guided goal. */
export class LoopxGraphCoordination extends GraphCoordination {
  static inject = ['subprocess']

  private readonly goalId: string
  private readonly roleAgents: Readonly<Record<string, string>>
  private readonly executable: string
  private readonly executableArgs: readonly string[]
  private readonly transport: 'process' | 'persistent'
  private readonly broker: PersistentLoopxBroker | undefined
  private readonly pathStyle: 'native' | 'wsl'
  private readonly registry: string | undefined
  private readonly graceMs: number
  private readonly operationTimeoutMs: number
  private readonly stdoutMaxBytes: number
  private readonly stderrMaxBytes: number
  private readonly leaseTtlSeconds: number
  private readonly writeScopes: readonly string[]
  private resolvedExecutable: Promise<string> | undefined
  private readonly todos = new Map<string, string>()
  private readonly todoIndexes = new Map<string, JsonRecord[]>()
  private readonly claims = new Map<GraphActivationId, GraphCoordinationClaim>()
  private readonly terminals = new Map<GraphActivationId, { outcome: GraphCoordinationSettlement['outcome']; evidence: string; settlementId: string }>()
  private readonly progress = new Map<GraphActivationId, Map<number, string>>()
  private readonly cancelReasons = new Map<GraphActivationId, string>()
  private readonly claimOwners = new Map<GraphActivationId, string>()
  private readonly events = new Map<GraphActivationId, GraphCoordinationEvent[]>()
  private readonly hydrated = new Set<GraphActivationId>()
  private readonly needsExternalRefresh = new Set<GraphActivationId>()
  private readonly compactedWorks = new Set<GraphActivationId>()
  private readonly journal: LoopxCoordinationJournal
  private readonly journalEventWindow: number
  private readonly watchReconnectAttempts: number
  private readonly watchReconnectDelayMs: number
  private readonly settlementTails = new Map<GraphActivationId, Promise<void>>()

  /** Construct the provider without mutating LoopX state. */
  constructor(ctx: Context, config: Config) {
    super(ctx)
    if (!config.goalId.trim()) throw new Error('LoopX graph coordination requires goalId')
    if (Object.keys(config.roleAgents).length === 0) throw new Error('LoopX graph coordination requires roleAgents')
    this.goalId = config.goalId
    this.roleAgents = { ...config.roleAgents }
    this.executable = config.executable ?? 'loopx'
    this.executableArgs = [...config.executableArgs ?? []]
    this.transport = config.transport ?? 'process'
    this.pathStyle = config.pathStyle ?? 'native'
    this.registry = config.registry
    this.graceMs = config.graceMs ?? 10_000
    this.operationTimeoutMs = config.operationTimeoutMs ?? 60_000
    this.stdoutMaxBytes = config.stdoutMaxBytes ?? 8_388_608
    this.stderrMaxBytes = config.stderrMaxBytes ?? 1_048_576
    this.leaseTtlSeconds = config.leaseTtlSeconds ?? 2_700
    this.writeScopes = [...config.writeScopes ?? ['**/*']]
    if (this.writeScopes.length === 0 || this.writeScopes.some(scope => !scope.trim())) throw new Error('LoopX graph coordination requires normalized writeScopes')
    const journalPath = config.journalPath ?? '.sessions/graph-coordination-loopx.sqlite'
    this.journalEventWindow = config.journalEventWindow ?? 256
    this.watchReconnectAttempts = config.watchReconnectAttempts ?? 2
    this.watchReconnectDelayMs = config.watchReconnectDelayMs ?? 50
    if (this.transport === 'persistent' && !config.brokerCommand?.trim()) {
      throw new Error('LoopX persistent transport requires brokerCommand')
    }
    this.broker = this.transport === 'persistent'
      ? new PersistentLoopxBroker(ctx, {
        launcher: this.executable,
        launcherArgs: this.executableArgs,
        pythonExecutable: config.brokerPythonExecutable ?? 'python3',
        command: config.brokerCommand as string,
        graceMs: this.graceMs,
        startTimeoutMs: this.operationTimeoutMs,
        diagnosticMaxBytes: this.stderrMaxBytes,
      })
      : undefined
    this.journal = new LoopxCoordinationJournal(
      this.goalId,
      journalPath === ':memory:' ? journalPath : resolve(journalPath),
      config.journalBusyTimeoutMs ?? 5_000,
      config.journalMode ?? 'wal',
      this.journalEventWindow,
    )
    ctx.effect(() => async () => {
      try {
        await this.broker?.dispose()
      } finally {
        this.journal.close()
      }
    }, 'graph-coordination-loopx: broker and durable event journal')
  }

  /** Validate role bindings and confirm that the configured LoopX goal is readable. */
  async prepare(graph: GraphRevision, roles: readonly GraphRole[], cwd: string, signal: AbortSignal): Promise<void> {
    const enabledRoles = new Set(roles.filter(role => role.enabled).map(role => role.id))
    for (const node of graph.nodes) {
      if (!enabledRoles.has(node.roleId)) throw new Error(`LoopX prepare received unavailable graph role ${node.roleId}`)
      this.agentFor(node.roleId)
    }
    const listed = await this.run(cwd, signal, ['todo', 'list', '--goal-id', this.goalId])
    this.todoIndexes.set(cwd, this.todoItems(listed))
  }

  private scopesFor(request: GraphCoordinationRequest): readonly string[] {
    const workspace = request.node.workspace
    if (workspace === undefined || workspace.writeRoots.includes('.')) return this.writeScopes
    if (workspace.writeRoots.length === 0) {
      const activation = String(request.activationId).replaceAll(/[^A-Za-z0-9._-]/gu, '-')
      return [`.dsh-graph-read/${activation}`]
    }
    return [...new Set(workspace.writeRoots.flatMap(root => [root, `${root}/**`]))]
  }

  /** Create and claim the node's todo only when the graph schedules that node. */
  async claim(request: GraphCoordinationRequest, signal: AbortSignal): Promise<GraphCoordinationClaim> {
    this.hydrate(request.activationId)
    const agentId = this.agentFor(request.role.id)
    const key = this.key(request.cwd, request.activationId)
    let todoId = this.todos.get(key)
    const durableTerminal = this.terminals.get(request.activationId)
    const durableClaim = this.claims.get(request.activationId)
    if (durableTerminal !== undefined && durableClaim !== undefined) {
      return this.terminalDisposition(durableClaim.todoId, durableTerminal, durableClaim)
    }
    if (todoId === undefined) {
      const existing = this.findActivationTodo(this.todoIndexes.get(request.cwd) ?? [], request.activationId)
      if (existing !== undefined) {
        todoId = this.todoId(existing)
        this.todos.set(key, todoId)
        if (terminalTodoStatus(existing['status'])) {
          const persistedEvidence = this.todoEvidence(existing)
          const terminal = this.recoveredTerminal(request.activationId, existing['status'], persistedEvidence)
          this.terminals.set(request.activationId, terminal)
          this.rememberEvent(request.activationId, this.journal.recordTerminal(request.activationId, terminal))
          return this.terminalDisposition(todoId, terminal, durableClaim)
        }
      }
    }
    if (todoId === undefined) {
      const result = await this.run(request.cwd, signal, [
        'todo', 'add', '--goal-id', this.goalId,
        '--role', 'agent', '--task-class', 'advancement_task', '--action-kind', actionKind(request.node),
        '--text', `[dsh-activation:${request.activationId}] [dsh-work:${request.workId}] graph ${request.graph.graphId} revision ${String(request.graph.revision)} node ${request.node.id} role ${request.node.roleId}`,
      ])
      if (typeof result['todo_id'] !== 'string' || result['todo_id'] === '') throw new Error('LoopX todo add returned no todo_id')
      todoId = result['todo_id']
      this.todos.set(key, todoId)
      const items = this.todoIndexes.get(request.cwd) ?? []
      items.push({ todo_id: todoId, text: `[dsh-activation:${request.activationId}] [dsh-work:${request.workId}]`, status: 'open' })
      this.todoIndexes.set(request.cwd, items)
    }
    const claimed = await this.run(request.cwd, signal, [
      'todo', 'claim', '--goal-id', this.goalId, '--todo-id', todoId,
      '--claimed-by', agentId, '--agent-id', agentId,
    ])
    if (claimed['claimed_by'] !== agentId && claimed['changed'] !== false) throw new Error(`LoopX did not confirm claim by ${agentId}`)
    let leased: JsonRecord
    try {
      leased = await this.run(request.cwd, signal, [
        'task-lease', 'acquire', '--goal-id', this.goalId, '--todo-id', todoId,
        '--owner', agentId, '--idempotency-key', request.operationId,
        '--ttl-seconds', String(this.leaseTtlSeconds),
        ...this.scopesFor(request).flatMap(scope => ['--write-scope', scope]),
      ])
    } catch (error) {
      if (claimed['claimed_by'] === agentId) {
        try {
          await this.run(request.cwd, AbortSignal.timeout(this.operationTimeoutMs), [
            'todo', 'update', '--goal-id', this.goalId, '--todo-id', todoId,
            '--agent-id', agentId, '--clear-claim', '--status', 'blocked', '--task-class', 'blocker',
            '--reason', 'Graph hard lease acquisition failed before Worker dispatch.',
          ])
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], `LoopX hard lease acquisition and todo compensation failed for ${todoId}`)
        }
      }
      throw error
    }
    const lease = record(leased['lease'], 'task-lease acquire lease')
    const fencingToken = lease['version']
    const expiresAtText = lease['expires_at']
    const expiresAt = typeof expiresAtText === 'string' ? Date.parse(expiresAtText) : Number.NaN
    if (leased['ok'] !== true || !Number.isSafeInteger(fencingToken) || (fencingToken as number) < 1 || !Number.isFinite(expiresAt)) {
      throw new Error('LoopX task-lease acquire returned no valid lease version or expiry')
    }
    const observation = JSON.stringify({
      schema: 'dsh-loopx-observation-v1',
      goalId: this.goalId,
      todoId,
      agentId,
      status: claimed['status'],
      claimedBy: claimed['claimed_by'],
      taskClass: claimed['task_class'],
      actionKind: claimed['action_kind'],
    })
    const result = {
      claimId: todoId,
      todoId,
      leaseId: `${todoId}:${String(fencingToken)}`,
      expiresAt,
      fencingToken: fencingToken as number,
      observation: observation.slice(0, 8_000),
    }
    this.claims.set(request.activationId, result)
    this.claimOwners.set(request.activationId, agentId)
    this.rememberEvent(request.activationId, this.journal.recordClaim(request.activationId, result, agentId))
    return result
  }

  /** Renew the exact LoopX hard task lease and preserve its fencing version. */
  async heartbeat(request: GraphCoordinationHeartbeat, signal: AbortSignal): Promise<GraphCoordinationHeartbeatResult> {
    this.hydrate(request.activationId)
    const claim = this.requireLease(request)
    const agentId = this.agentFor(request.role.id)
    const renewed = await this.run(request.cwd, signal, [
      'task-lease', 'renew', '--goal-id', this.goalId, '--todo-id', claim.todoId,
      '--owner', agentId, '--idempotency-key', request.operationId,
      '--ttl-seconds', String(this.leaseTtlSeconds), '--expected-version', String(request.fencingToken),
    ])
    const lease = record(renewed['lease'], 'task-lease renew lease')
    const fencingToken = lease['version']
    const expiresAt = typeof lease['expires_at'] === 'string' ? Date.parse(lease['expires_at']) : Number.NaN
    if (renewed['ok'] !== true || !Number.isSafeInteger(fencingToken)
      || (fencingToken as number) <= request.fencingToken || !Number.isFinite(expiresAt)) {
      throw new Error('LoopX task-lease renew returned no newer lease version or valid expiry')
    }
    const leaseId = `${claim.todoId}:${String(fencingToken)}`
    const next = { ...claim, leaseId, expiresAt, fencingToken: fencingToken as number }
    this.claims.set(request.activationId, next)
    const event = this.journal.recordHeartbeat(request.activationId, next, request.progressSequence)
    this.rememberEvent(request.activationId, event)
    return {
      leaseId,
      expiresAt,
      fencingToken: fencingToken as number,
      progressCursor: event.cursor,
      cancelRequested: this.cancelReasons.has(request.activationId),
    }
  }

  /** Read cached exact references and refresh an existing lease from LoopX. */
  async observe(request: GraphCoordinationObserveRequest, signal: AbortSignal): Promise<GraphCoordinationObservation> {
    signal.throwIfAborted()
    this.hydrate(request.activationId)
    let claim = this.claims.get(request.activationId)
    let terminal = this.terminals.get(request.activationId)
    let leaseInspected = false
    if (this.needsExternalRefresh.delete(request.activationId)) {
      const listed = await this.run(request.cwd, signal, ['todo', 'list', '--goal-id', this.goalId])
      const items = this.todoItems(listed)
      this.todoIndexes.set(request.cwd, items)
      const todo = this.findActivationTodo(items, request.activationId)
      if (todo !== undefined) {
        const status = typeof todo['status'] === 'string' ? todo['status'] : 'open'
        const persistedEvidence = this.todoEvidence(todo)
        this.recoverTaggedEvidence(request.activationId, persistedEvidence)
        if (status === 'done' || status === 'completed' || status === 'blocked' || status === 'canceled') {
          const recovered = this.recoveredTerminal(request.activationId, status, persistedEvidence)
          terminal = recovered
          this.terminals.set(request.activationId, recovered)
          this.rememberEvent(request.activationId, this.journal.recordTerminal(request.activationId, recovered))
        }
      }
    }
    if (claim === undefined && terminal === undefined) {
      const listed = await this.run(request.cwd, signal, ['todo', 'list', '--goal-id', this.goalId])
      const items = this.todoItems(listed)
      this.todoIndexes.set(request.cwd, items)
      const todo = this.findActivationTodo(items, request.activationId)
      if (todo !== undefined) {
        const todoId = this.todoId(todo)
        const status = typeof todo['status'] === 'string' ? todo['status'] : 'open'
        const persistedEvidence = this.todoEvidence(todo)
        this.recoverTaggedEvidence(request.activationId, persistedEvidence)
        if (status === 'done' || status === 'completed' || status === 'blocked' || status === 'canceled') {
          const recovered = this.recoveredTerminal(request.activationId, status, persistedEvidence)
          terminal = recovered
          this.terminals.set(request.activationId, terminal)
          this.rememberEvent(request.activationId, this.journal.recordTerminal(request.activationId, recovered))
        } else {
          const inspected = await this.run(request.cwd, signal, ['task-lease', 'inspect', '--goal-id', this.goalId, '--todo-id', todoId])
          leaseInspected = true
          const lease = inspected['lease'] === null || inspected['lease'] === undefined
            ? undefined
            : record(inspected['lease'], 'task-lease inspect lease')
          if (inspected['ok'] === true && inspected['active'] !== false && lease !== undefined) {
            const version = lease['version']
            const expiresAt = typeof lease['expires_at'] === 'string' ? Date.parse(lease['expires_at']) : Number.NaN
            if (Number.isSafeInteger(version) && (version as number) > 0 && Number.isFinite(expiresAt)) {
              claim = {
                claimId: todoId,
                todoId,
                leaseId: `${todoId}:${String(version)}`,
                expiresAt,
                fencingToken: version as number,
                observation: JSON.stringify({ schema: 'dsh-loopx-observation-v1', goalId: this.goalId, todoId, recovered: true }),
              }
              this.claims.set(request.activationId, claim)
              const owner = lease['owner']
              const recoveredOwner = typeof owner === 'string' && owner.trim() ? owner : request.callerId
              this.claimOwners.set(request.activationId, recoveredOwner)
              this.rememberEvent(request.activationId, this.journal.recordClaim(request.activationId, claim, recoveredOwner))
            }
          }
        }
      }
    }
    if (claim === undefined && terminal === undefined) return { status: 'absent', cursor: '0', events: [], compacted: false }
    if (claim !== undefined && terminal === undefined && !leaseInspected) {
      const inspected = await this.run(request.cwd, signal, ['task-lease', 'inspect', '--goal-id', this.goalId, '--todo-id', claim.todoId])
      if (inspected['ok'] !== true) return { status: 'unknown', cursor: this.cursor(request.activationId), events: this.eventsAfter(request), compacted: this.compacted(request), claim }
      const lease = inspected['lease'] === null || inspected['lease'] === undefined
        ? undefined
        : record(inspected['lease'], 'task-lease inspect lease')
      if (inspected['active'] === false || lease === undefined) {
        return { status: 'unknown', cursor: this.cursor(request.activationId), events: this.eventsAfter(request), compacted: this.compacted(request), claim }
      }
      const version = lease['version']
      const expiresAt = typeof lease['expires_at'] === 'string' ? Date.parse(lease['expires_at']) : Number.NaN
      if (!Number.isSafeInteger(version) || (version as number) < claim.fencingToken || !Number.isFinite(expiresAt)) {
        throw new Error('LoopX task-lease inspect returned a stale version or invalid expiry')
      }
      const leaseId = `${claim.todoId}:${String(version)}`
      const identityAdvanced = (version as number) > claim.fencingToken || leaseId !== claim.leaseId
      if (identityAdvanced || expiresAt !== claim.expiresAt) {
        claim = { ...claim, leaseId, expiresAt, fencingToken: version as number }
        this.claims.set(request.activationId, claim)
        const owner = lease['owner']
        const currentOwner = typeof owner === 'string' && owner.trim()
          ? owner
          : this.claimOwners.get(request.activationId) ?? request.callerId
        this.claimOwners.set(request.activationId, currentOwner)
        this.rememberEvent(request.activationId, identityAdvanced
          ? this.journal.recordHeartbeat(request.activationId, claim)
          : this.journal.recordClaim(request.activationId, claim, currentOwner))
      }
    }
    return this.localObservation(request)
  }

  /** Poll LoopX evidence before returning the ordered local protocol suffix. */
  async watch(request: GraphCoordinationObserveRequest, signal: AbortSignal): Promise<GraphCoordinationObservation> {
    let failure: unknown
    for (let attempt = 0; attempt <= this.watchReconnectAttempts; attempt += 1) {
      try {
        this.hydrate(request.activationId)
        const claim = this.claims.get(request.activationId)
        const owner = this.claimOwners.get(request.activationId)
        if (claim !== undefined && owner !== undefined) {
          await this.run(request.cwd, signal, [
            'evidence-log', '--goal-id', this.goalId, '--agent-id', owner,
            '--todo-id', claim.todoId, '--limit', '24', '--thin',
          ])
        }
        return await this.observe(request, signal)
      } catch (error) {
        signal.throwIfAborted()
        if (!(error instanceof LoopxCommandError)) throw error
        failure = error
        if (attempt === this.watchReconnectAttempts) break
        await this.waitForReconnect(signal)
      }
    }
    throw failure
  }

  /** Append an idempotent ordered public-safe progress note to the LoopX todo. */
  async publishProgress(request: GraphCoordinationProgress, signal: AbortSignal): Promise<{ readonly cursor: string }> {
    this.hydrate(request.activationId)
    const claim = this.requireLease(request)
    if (!Number.isSafeInteger(request.progressSequence) || request.progressSequence < 1
      || !request.evidence.trim() || request.evidence.length > 2_000) throw new Error('LoopX progress requires a positive sequence and 1..2,000 characters')
    const entries = this.progress.get(request.activationId) ?? new Map<number, string>()
    const prior = entries.get(request.progressSequence)
    if (prior !== undefined && prior !== request.evidence) throw new Error(`LoopX progress sequence ${String(request.progressSequence)} conflicts`)
    if (prior !== undefined) {
      return { cursor: this.journal.progressCursor(request.activationId, request.progressSequence, request.evidence) }
    }
    const agentId = this.agentFor(request.role.id)
    await this.run(request.cwd, signal, [
      'todo', 'update', '--goal-id', this.goalId, '--todo-id', claim.todoId,
      '--agent-id', agentId, '--note', `[dsh-progress:${String(request.progressSequence)}] ${request.evidence}`,
    ])
    entries.set(request.progressSequence, request.evidence)
    this.progress.set(request.activationId, entries)
    const event = this.journal.recordProgress(request.activationId, request.progressSequence, request.evidence)
    this.rememberEvent(request.activationId, event)
    return { cursor: event.cursor }
  }

  /** Record one node result and its LoopX lifecycle effects without interleaving settlements. */
  async settle(request: GraphCoordinationSettlement, signal: AbortSignal): Promise<void> {
    await this.serializeSettlement(request.activationId, signal, async () => {
      this.hydrate(request.activationId)
      const prior = this.terminals.get(request.activationId)
      if (prior !== undefined) {
        if (prior.settlementId === request.settlementId && prior.outcome === request.outcome && prior.evidence === request.evidence) return
        throw new Error(`LoopX graph activation ${request.activationId} already has a conflicting settlement`)
      }
      const agentId = this.agentFor(request.role.id)
      const claim = this.requireLease(request)
      const todoId = claim.todoId
      if (todoId !== request.claimId) throw new Error(`LoopX claim ${request.claimId} does not match activation todo ${todoId}`)
      if (request.outcome === 'succeeded') {
        await this.run(request.cwd, signal, [
          'todo', 'complete', '--goal-id', this.goalId, '--todo-id', todoId,
          '--agent-id', agentId, '--evidence', this.terminalEvidence(request), '--no-follow-up',
          '--task-lease-idempotency-key', request.operationId,
          '--task-lease-expected-version', String(request.fencingToken),
        ])
      } else {
        await this.run(request.cwd, signal, [
          'todo', 'update', '--goal-id', this.goalId, '--todo-id', todoId,
          '--agent-id', agentId, '--status', 'blocked', '--task-class', 'blocker',
          '--reason', this.terminalEvidence(request),
        ])
        await this.run(request.cwd, signal, [
          'task-lease', 'release', '--goal-id', this.goalId, '--todo-id', todoId,
          '--owner', agentId, '--idempotency-key', request.operationId,
          '--expected-version', String(request.fencingToken),
        ])
      }
      const terminal = { outcome: request.outcome, evidence: request.evidence, settlementId: request.settlementId }
      this.terminals.set(request.activationId, terminal)
      this.rememberEvent(request.activationId, this.journal.recordTerminal(request.activationId, terminal))
    })
  }

  /** Record a cooperative cancellation request without accepting terminal state. */
  async cancel(request: GraphCoordinationCancellation, signal: AbortSignal): Promise<void> {
    this.hydrate(request.activationId)
    const claim = this.requireLease(request)
    if (!request.reason.trim()) throw new Error('LoopX cancellation reason must be non-empty')
    const prior = this.cancelReasons.get(request.activationId)
    if (prior !== undefined && prior !== request.reason) throw new Error('LoopX claim already has a different cancellation reason')
    if (prior !== undefined) return
    const agentId = this.agentFor(request.role.id)
    await this.run(request.cwd, signal, [
      'todo', 'update', '--goal-id', this.goalId, '--todo-id', claim.todoId,
      '--agent-id', agentId, '--note', `[dsh-cancel-request:${String(request.progressSequence)}] ${request.reason}`,
    ])
    this.cancelReasons.set(request.activationId, request.reason)
    this.rememberEvent(request.activationId, this.journal.recordCancellation(
      request.activationId,
      request.reason,
      request.progressSequence,
    ))
  }

  /** Compare Graph expectations with the exact cached and LoopX-observed claim. */
  async reconcile(request: GraphCoordinationReconcileRequest, signal: AbortSignal): Promise<GraphCoordinationReconcileResult> {
    const observation = await this.observe(request, signal)
    if (observation.status === 'absent') return { status: 'absent', observation, evidence: 'LoopX has no known Graph-tagged claim' }
    const terminal = this.terminals.get(request.activationId)
    if (terminal !== undefined) {
      const status = request.expectedOutcome === undefined || request.expectedOutcome === terminal.outcome ? 'confirmed-terminal' : 'conflict'
      return { status, observation, evidence: status === 'conflict' ? 'LoopX terminal outcome differs from Graph' : 'LoopX terminal outcome confirmed' }
    }
    const claim = observation.claim
    if (claim === undefined) return { status: 'unknown', observation, evidence: 'LoopX lease inspection returned no claim identity' }
    const staleOrConflictingLease = request.fencingToken !== undefined
      ? claim.fencingToken < request.fencingToken
        || (claim.fencingToken === request.fencingToken && request.leaseId !== undefined && claim.leaseId !== request.leaseId)
      : request.leaseId !== undefined && claim.leaseId !== request.leaseId
    if ((request.claimId !== undefined && request.claimId !== claim.claimId) || staleOrConflictingLease) {
      return { status: 'conflict', observation, evidence: 'LoopX claim or fencing identity differs from Graph' }
    }
    if (observation.status === 'unknown') {
      return {
        status: 'unknown',
        observation,
        evidence: claim.expiresAt <= Date.now()
          ? 'LoopX hard lease expired without terminal evidence'
          : 'LoopX lease inspection was inconclusive',
      }
    }
    return { status: claim.expiresAt > Date.now() ? 'confirmed-running' : 'unknown', observation, evidence: claim.expiresAt > Date.now() ? 'LoopX hard lease is live' : 'LoopX hard lease expired without terminal evidence' }
  }

  private async serializeSettlement(activationId: GraphActivationId, signal: AbortSignal, operation: () => Promise<void>): Promise<void> {
    const previous = this.settlementTails.get(activationId) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => { release = resolve })
    this.settlementTails.set(activationId, current)
    await previous
    try {
      signal.throwIfAborted()
      await operation()
    } finally {
      release()
      if (this.settlementTails.get(activationId) === current) this.settlementTails.delete(activationId)
    }
  }

  private key(cwd: string, activationId: GraphActivationId): string {
    return `${cwd}\u0000${activationId}`
  }

  private todoItems(payload: JsonRecord): JsonRecord[] {
    const todos = payload['todos']
    if (todos === undefined) return []
    if (!Array.isArray(todos)) throw new Error('LoopX todo list returned a non-array todos field')
    return todos.map(item => record(item, 'todo list item'))
  }

  private findActivationTodo(items: readonly JsonRecord[], activationId: GraphActivationId): JsonRecord | undefined {
    const marker = `[dsh-activation:${activationId}]`
    const matches = items.filter(item => typeof item['text'] === 'string' && item['text'].includes(marker))
    if (matches.length > 1) throw new Error(`LoopX has multiple todos for graph activation ${activationId}`)
    return matches[0]
  }

  private todoId(todo: JsonRecord): string {
    const id = todo['todo_id']
    if (typeof id !== 'string' || !id.trim()) throw new Error('LoopX tagged todo has no todo_id')
    return id
  }

  private todoEvidence(todo: JsonRecord): string {
    for (const key of ['evidence', 'completion_evidence', 'reason', 'note']) {
      const value = todo[key]
      if (typeof value === 'string' && value.trim()) return value.slice(0, 4_000)
    }
    const status = todo['status']
    return `LoopX todo ${this.todoId(todo)} is ${typeof status === 'string' ? status : 'terminal'}`
  }

  private terminalEvidence(request: GraphCoordinationSettlement): string {
    return `[dsh-settlement:${request.settlementId}] [dsh-outcome:${request.outcome}] ${request.evidence}`
  }

  private recoveredTerminal(
    activationId: GraphActivationId,
    status: string,
    persistedEvidence: string,
  ): { outcome: GraphCoordinationSettlement['outcome']; evidence: string; settlementId: string } {
    const settlement = /\[dsh-settlement:([^\]]+)\]/.exec(persistedEvidence)?.[1]
    const taggedOutcome = /\[dsh-outcome:(succeeded|failed|blocked|skipped|canceled|exhausted|uncertain)\]/.exec(persistedEvidence)?.[1]
    const fallbackOutcome = status === 'done' || status === 'completed'
      ? 'succeeded'
      : status === 'canceled' || persistedEvidence.includes('[canceled]') ? 'canceled' : 'failed'
    const outcome = (taggedOutcome ?? fallbackOutcome) as GraphCoordinationSettlement['outcome']
    const evidence = persistedEvidence
      .replace(/\[dsh-settlement:[^\]]+\]\s*/, '')
      .replace(/\[dsh-outcome:[^\]]+\]\s*/, '')
      .trim()
    return {
      outcome,
      evidence: evidence || `LoopX terminal evidence recovered for ${activationId}`,
      settlementId: settlement ?? `recovered:${activationId}`,
    }
  }

  private terminalDisposition(
    todoId: string,
    terminal: { outcome: GraphCoordinationSettlement['outcome']; evidence: string },
    claim?: GraphCoordinationClaim,
  ): GraphCoordinationClaim {
    return {
      claimId: claim?.claimId ?? todoId,
      todoId,
      leaseId: claim?.leaseId ?? `${todoId}:terminal`,
      expiresAt: claim?.expiresAt ?? 0,
      fencingToken: claim?.fencingToken ?? 0,
      observation: claim?.observation ?? JSON.stringify({ schema: 'dsh-loopx-observation-v1', goalId: this.goalId, todoId, terminal: true }),
      terminal: { outcome: terminal.outcome, evidence: terminal.evidence },
    }
  }

  private requireLease(request: Pick<GraphCoordinationHeartbeat, 'activationId' | 'claimId' | 'leaseId' | 'fencingToken'>): GraphCoordinationClaim {
    const claim = this.claims.get(request.activationId)
    if (claim === undefined || claim.claimId !== request.claimId || claim.leaseId !== request.leaseId
      || claim.fencingToken !== request.fencingToken) throw new Error(`LoopX claim for graph activation ${request.activationId} is absent or fenced`)
    return claim
  }

  private hydrate(activationId: GraphActivationId): void {
    if (this.hydrated.has(activationId)) return
    const snapshot = this.journal.load(activationId)
    if (snapshot.claim !== undefined) this.claims.set(activationId, snapshot.claim)
    if (snapshot.owner !== undefined) this.claimOwners.set(activationId, snapshot.owner)
    if (snapshot.terminal !== undefined) this.terminals.set(activationId, snapshot.terminal)
    if (snapshot.cancelReason !== undefined) this.cancelReasons.set(activationId, snapshot.cancelReason)
    if (snapshot.progress.size > 0) this.progress.set(activationId, new Map(snapshot.progress))
    if (snapshot.events.length > 0) this.events.set(activationId, [...snapshot.events])
    if (snapshot.compacted) this.compactedWorks.add(activationId)
    if (snapshot.claim !== undefined || snapshot.terminal !== undefined || snapshot.cancelReason !== undefined
      || snapshot.progress.size > 0 || snapshot.events.length > 0) this.needsExternalRefresh.add(activationId)
    this.hydrated.add(activationId)
  }

  private rememberEvent(activationId: GraphActivationId, event: GraphCoordinationEvent): void {
    const events = this.events.get(activationId) ?? []
    if (!events.some(item => item.id === event.id)) {
      events.push(event)
      events.sort((left, right) => Number.parseInt(left.cursor, 10) - Number.parseInt(right.cursor, 10))
      if (events.length > this.journalEventWindow) {
        events.splice(0, events.length - this.journalEventWindow)
        this.compactedWorks.add(activationId)
      }
      this.events.set(activationId, events)
    }
  }

  private recoverTaggedEvidence(activationId: GraphActivationId, evidence: string): void {
    const progress = /\[dsh-progress:(\d+)\]\s+([\s\S]+)/.exec(evidence)
    if (progress?.[1] !== undefined && progress[2]?.trim()) {
      const sequence = Number.parseInt(progress[1], 10)
      if (Number.isSafeInteger(sequence) && sequence > 0) {
        const value = progress[2].trim().slice(0, 2_000)
        const entries = this.progress.get(activationId) ?? new Map<number, string>()
        const prior = entries.get(sequence)
        if (prior !== undefined && prior !== value) throw new Error(`LoopX progress sequence ${String(sequence)} conflicts`)
        if (prior === undefined) {
          entries.set(sequence, value)
          this.progress.set(activationId, entries)
          this.rememberEvent(activationId, this.journal.recordProgress(activationId, sequence, value))
        }
      }
    }
    const cancellation = /\[dsh-cancel-request(?::(\d+))?\]\s+([\s\S]+)/.exec(evidence)
    if (cancellation?.[2]?.trim()) {
      const sequence = cancellation[1] === undefined ? 1 : Number.parseInt(cancellation[1], 10)
      const reason = cancellation[2].trim().slice(0, 2_000)
      const prior = this.cancelReasons.get(activationId)
      if (prior !== undefined && prior !== reason) throw new Error('LoopX claim already has a different cancellation reason')
      this.cancelReasons.set(activationId, reason)
      this.rememberEvent(activationId, this.journal.recordCancellation(activationId, reason, sequence))
    }
  }

  private cursor(activationId: GraphActivationId): string {
    return this.events.get(activationId)?.at(-1)?.cursor ?? '0'
  }

  private eventsAfter(request: GraphCoordinationObserveRequest): readonly GraphCoordinationEvent[] {
    const after = request.afterCursor === undefined ? 0 : Number.parseInt(request.afterCursor, 10)
    const events = this.events.get(request.activationId) ?? []
    return Number.isSafeInteger(after) && after >= 0
      ? events.filter(event => Number.parseInt(event.cursor, 10) > after)
      : events
  }

  private localObservation(request: GraphCoordinationObserveRequest): GraphCoordinationObservation {
    const claim = this.claims.get(request.activationId)
    const terminal = this.terminals.get(request.activationId)
    return {
      status: terminal !== undefined
        ? 'terminal'
        : this.cancelReasons.has(request.activationId) ? 'cancel-requested' : claim !== undefined ? 'claimed' : 'absent',
      cursor: this.cursor(request.activationId),
      events: this.eventsAfter(request),
      compacted: this.compacted(request),
      ...claim === undefined ? {} : { claim },
      ...terminal === undefined ? {} : { terminal: { outcome: terminal.outcome, evidence: terminal.evidence } },
    }
  }

  private agentFor(roleId: string): string {
    const agent = this.roleAgents[roleId]
    if (agent === undefined || !agent.trim()) throw new Error(`LoopX has no registered peer mapping for graph role ${roleId}`)
    return agent
  }

  private compacted(request: GraphCoordinationObserveRequest): boolean {
    if (!this.compactedWorks.has(request.activationId)) return false
    const first = Number.parseInt(this.events.get(request.activationId)?.[0]?.cursor ?? '0', 10)
    const after = request.afterCursor === undefined ? 0 : Number.parseInt(request.afterCursor, 10)
    return !Number.isSafeInteger(after) || after < first - 1
  }

  private waitForReconnect(signal: AbortSignal): Promise<void> {
    return new Promise((resolveWait, reject) => {
      const onAbort = (): void => {
        clearTimeout(timer)
        reject(signal.reason instanceof Error ? signal.reason : new Error('LoopX watch reconnect aborted', { cause: signal.reason }))
      }
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort)
        resolveWait()
      }, this.watchReconnectDelayMs)
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  private runtimePath(value: string): string {
    if (this.pathStyle === 'native') return value
    const match = /^([A-Za-z]):[\\/](.*)$/.exec(value)
    if (match === null) return value
    const drive = match[1] as string
    const rest = match[2] as string
    return `/mnt/${drive.toLowerCase()}/${rest.replaceAll('\\', '/')}`
  }

  private async run(cwd: string, signal: AbortSignal, args: readonly string[]): Promise<JsonRecord> {
    const deadline = AbortSignal.timeout(this.operationTimeoutMs)
    const operationSignal = AbortSignal.any([signal, deadline])
    const cliArgs = [
      ...this.registry === undefined ? [] : ['--registry', this.runtimePath(this.registry)],
      '--format', 'json', ...args,
    ]
    let exitCode: number | null
    let stdout: string
    let stderr: string
    let stdoutLossy: boolean
    if (this.broker !== undefined) {
      let result
      try {
        result = await this.broker.run(
          this.runtimePath(cwd), cliArgs, this.operationTimeoutMs,
          this.stdoutMaxBytes, this.stderrMaxBytes, operationSignal,
        )
      } catch (error) {
        signal.throwIfAborted()
        if (deadline.aborted) throw new LoopxCommandError(`LoopX ${args.slice(0, 2).join(' ')} timed out after ${String(this.operationTimeoutMs)}ms`)
        throw error
      }
      exitCode = result.exitCode
      stdout = result.stdout
      stderr = result.stderr
      stdoutLossy = result.stdoutLossy
      if (result.timedOut) throw new LoopxCommandError(`LoopX ${args.slice(0, 2).join(' ')} timed out after ${String(this.operationTimeoutMs)}ms`)
    } else {
      this.resolvedExecutable ??= this.ctx.subprocess.resolveExecutable(this.executable, undefined, operationSignal)
      const executable = await this.resolvedExecutable
      const handle = this.ctx.subprocess.spawn({
        argv: [executable, ...this.executableArgs, ...cliArgs],
        cwd,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: this.stdoutMaxBytes },
          stderr: { maxBytes: this.stderrMaxBytes },
        },
        graceMs: this.graceMs,
        signal: operationSignal,
      })
      const outcome = await handle.done
      const stdoutRead = handle.collected.stdout?.readFrom(0)
      const stderrRead = handle.collected.stderr?.readFrom(0)
      exitCode = outcome.exitCode
      stdout = stdoutRead?.text ?? ''
      stderr = stderrRead?.text ?? ''
      stdoutLossy = stdoutRead?.lossy === true
    }
    signal.throwIfAborted()
    if (deadline.aborted) throw new LoopxCommandError(`LoopX ${args.slice(0, 2).join(' ')} timed out after ${String(this.operationTimeoutMs)}ms`)
    if (exitCode !== 0) throw new LoopxCommandError(`LoopX ${args.slice(0, 2).join(' ')} failed (${String(exitCode)}): ${stderr || stdout}`)
    if (stdoutLossy) {
      throw new LoopxCommandError(`LoopX ${args.slice(0, 2).join(' ')} response exceeded stdoutMaxBytes=${String(this.stdoutMaxBytes)}`)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(stdout)
    } catch {
      throw new LoopxCommandError(`LoopX ${args.slice(0, 2).join(' ')} returned invalid JSON`)
    }
    try {
      return record(parsed, args.slice(0, 2).join(' '))
    } catch (error) {
      throw new LoopxCommandError(`LoopX ${args.slice(0, 2).join(' ')} returned an invalid response`, { cause: error })
    }
  }
}

export default LoopxGraphCoordination
