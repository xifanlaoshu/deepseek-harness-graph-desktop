/** SQLite authority for cross-process Graph scheduler ownership. @module @deepseek-ai/dsh-graph-scheduler-sqlite */

import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  GraphSchedulerAuthorityError,
  GraphSchedulerLeaseId,
  type GraphSchedulerAcquireRequest,
  type GraphSchedulerDecision,
  type GraphSchedulerLease,
  type GraphSchedulerLeaseRequest,
  type GraphSchedulerProvider,
} from '@deepseek-ai/dsh-graph-scheduler'

export const name = 'graph-scheduler-sqlite'
export const inject = ['graphScheduler']
const APPLICATION_ID = 0x44534753
const SCHEMA_VERSION = 1

/** Persistent scheduler ownership configuration. */
export interface Config {
  /** Registered Graph scheduler Provider name. */
  readonly providerName: string
  /** SQLite file path resolved from the Host working directory. */
  readonly path: string
  /** Lifetime renewed by each successful scheduler heartbeat. */
  readonly leaseMs: number
  /** Delay suggested to a competing scheduler while a run remains owned. */
  readonly retryMs: number
  /** Maximum time SQLite waits for a competing transaction. */
  readonly busyTimeoutMs: number
  /** SQLite journal mode selected after database identity validation. */
  readonly journalMode: 'wal' | 'delete' | 'truncate'
}

/** Plugin configuration schema. */
export const Config: z<Config> = z.object({
  providerName: z.string().default('sqlite-scheduler'),
  path: z.string().default('.sessions/graph-scheduler.sqlite'),
  leaseMs: z.natural().min(1_000).max(300_000).default(120_000),
  retryMs: z.natural().min(10).max(300_000).default(500),
  busyTimeoutMs: z.natural().min(1).max(300_000).default(30_000),
  journalMode: z.union(['wal', 'delete', 'truncate'] as const).default('wal'),
})

type SqlValue = string | number | null
type SqlRow = Record<string, SqlValue>
const row = (value: unknown): SqlRow => value as SqlRow
const textValue = (value: SqlValue | undefined, subject: string): string => {
  if (typeof value !== 'string') throw new Error(`${subject} must be SQLite text`)
  return value
}
const numberValue = (value: SqlValue | undefined, subject: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${subject} must be a finite SQLite number`)
  return value
}
const fingerprint = (config: Config): string => createHash('sha256').update(JSON.stringify({
  providerName: config.providerName, leaseMs: config.leaseMs, retryMs: config.retryMs,
})).digest('hex')

/** SQLite Provider that serializes ownership acquisition with `BEGIN IMMEDIATE`. */
export class SqliteGraphSchedulerProvider implements GraphSchedulerProvider {
  readonly protocolVersion = 1 as const
  private readonly db: DatabaseSync
  private readonly fingerprint: string
  private closed = false

  constructor(readonly name: string, readonly path: string, private readonly config: Config) {
    if (!name.trim()) throw new Error('graph-scheduler-sqlite providerName must be non-empty')
    if (!isAbsolute(path)) throw new Error('graph-scheduler-sqlite path must resolve to an absolute path')
    this.fingerprint = fingerprint(config)
    mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    try { this.open() } catch (error) { this.db.close(); throw error }
  }

  acquire(request: GraphSchedulerAcquireRequest, signal: AbortSignal): Promise<GraphSchedulerDecision> {
    return Promise.resolve().then(() => {
      signal.throwIfAborted()
      return this.transaction(() => this.acquireInTransaction(request))
    })
  }

  heartbeat(request: GraphSchedulerLeaseRequest, signal: AbortSignal): Promise<GraphSchedulerLease> {
    return Promise.resolve().then(() => {
      signal.throwIfAborted()
      return this.transaction(() => {
        const current = this.exactLease(request)
        const expiresAt = request.at + this.config.leaseMs
        this.db.prepare('UPDATE graph_scheduler_leases SET expires_at = ? WHERE run_id = ?').run(expiresAt, String(request.runId))
        return this.lease({ ...current, expires_at: expiresAt })
      })
    })
  }

  release(request: GraphSchedulerLeaseRequest, signal: AbortSignal): Promise<void> {
    return Promise.resolve().then(() => {
      signal.throwIfAborted()
      this.transaction(() => {
        const value = this.db.prepare('SELECT * FROM graph_scheduler_leases WHERE run_id = ?').get(String(request.runId))
        if (value === undefined) return
        this.assertExact(row(value), request)
        this.db.prepare('DELETE FROM graph_scheduler_leases WHERE run_id = ?').run(String(request.runId))
      })
    })
  }

  /** Close this Provider's database handle after unregistering it. */
  close(): void { if (!this.closed) { this.closed = true; this.db.close() } }

  private open(): void {
    this.db.exec(`PRAGMA busy_timeout = ${String(this.config.busyTimeoutMs)}`)
    const applicationId = numberValue(row(this.db.prepare('PRAGMA application_id').get()).application_id, 'application_id')
    const version = numberValue(row(this.db.prepare('PRAGMA user_version').get()).user_version, 'user_version')
    const objects = numberValue(row(this.db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'").get()).count, 'schema count')
    if (applicationId === 0 && version === 0 && objects === 0) this.initialize()
    else if (applicationId !== APPLICATION_ID || version !== SCHEMA_VERSION) throw new Error(`graph-scheduler-sqlite refuses database identity ${String(applicationId)} version ${String(version)}`)
    this.db.exec(`PRAGMA journal_mode = ${this.config.journalMode.toUpperCase()}`)
    this.transaction(() => {
      const stored = this.db.prepare("SELECT value FROM graph_scheduler_meta WHERE key = 'config_hash'").get()
      const current = stored === undefined ? undefined : textValue(row(stored).value, 'config hash')
      if (current === this.fingerprint) return
      const active = numberValue(row(this.db.prepare('SELECT COUNT(*) AS count FROM graph_scheduler_leases WHERE expires_at > ?').get(Date.now())).count, 'active lease count')
      if (active > 0) throw new Error('graph-scheduler-sqlite configuration differs while leases are active')
      this.db.prepare("INSERT INTO graph_scheduler_meta(key, value) VALUES('config_hash', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(this.fingerprint)
    }, false)
  }

  private initialize(): void {
    this.db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE graph_scheduler_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE graph_scheduler_runs (run_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, last_fencing_token INTEGER NOT NULL);
      CREATE TABLE graph_scheduler_leases (
        run_id TEXT PRIMARY KEY, lease_id TEXT NOT NULL UNIQUE, session_id TEXT NOT NULL,
        generation_id TEXT NOT NULL, owner_id TEXT NOT NULL, owner_epoch INTEGER NOT NULL,
        fencing_token INTEGER NOT NULL, acquired_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
      );
      PRAGMA application_id = ${String(APPLICATION_ID)};
      PRAGMA user_version = ${String(SCHEMA_VERSION)};
      COMMIT;`)
  }

  private transaction<T>(operation: () => T, verify = true): T {
    if (this.closed) throw new Error('graph-scheduler-sqlite Provider is closed')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      if (verify) this.verifyConfig()
      const result = operation()
      this.db.exec('COMMIT')
      return result
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  private verifyConfig(): void {
    const stored = this.db.prepare("SELECT value FROM graph_scheduler_meta WHERE key = 'config_hash'").get()
    if (stored === undefined || textValue(row(stored).value, 'config hash') !== this.fingerprint) throw new Error('graph-scheduler-sqlite configuration changed in another process')
  }

  private acquireInTransaction(request: GraphSchedulerAcquireRequest): GraphSchedulerDecision {
    const now = Date.now()
    const activeValue = this.db.prepare('SELECT * FROM graph_scheduler_leases WHERE run_id = ?').get(String(request.runId))
    if (activeValue !== undefined) {
      const active = row(activeValue)
      if (textValue(active.session_id, 'session_id') !== request.sessionId) {
        throw new Error(`graph run ${String(request.runId)} belongs to another session`)
      }
      if (numberValue(active.expires_at, 'expires_at') > now) {
        if (textValue(active.generation_id, 'generation_id') === String(request.generationId)
          && textValue(active.owner_id, 'owner_id') === String(request.ownerId)
          && numberValue(active.owner_epoch, 'owner_epoch') >= request.minimumOwnerEpoch) {
          return { status: 'granted', lease: this.lease(active) }
        }
        return { status: 'busy', retryAt: numberValue(active.expires_at, 'expires_at'), evidence: `run ${String(request.runId)} is owned by another live scheduler` }
      }
      this.db.prepare('DELETE FROM graph_scheduler_leases WHERE run_id = ?').run(String(request.runId))
    }
    const runValue = this.db.prepare('SELECT * FROM graph_scheduler_runs WHERE run_id = ?').get(String(request.runId))
    let lastToken = 0
    if (runValue === undefined) {
      this.db.prepare('INSERT INTO graph_scheduler_runs(run_id, session_id, last_fencing_token) VALUES(?, ?, 0)').run(String(request.runId), request.sessionId)
    } else {
      const run = row(runValue)
      if (textValue(run.session_id, 'session_id') !== request.sessionId) throw new Error(`graph run ${String(request.runId)} belongs to another session`)
      lastToken = numberValue(run.last_fencing_token, 'last_fencing_token')
    }
    const token = Math.max(lastToken + 1, request.minimumOwnerEpoch)
    const leaseId = GraphSchedulerLeaseId(`scheduler:${createHash('sha256').update(JSON.stringify([request.runId, request.generationId, request.ownerId, token])).digest('hex')}`)
    const expiresAt = now + this.config.leaseMs
    this.db.prepare('UPDATE graph_scheduler_runs SET last_fencing_token = ? WHERE run_id = ?').run(token, String(request.runId))
    this.db.prepare(`INSERT INTO graph_scheduler_leases(run_id, lease_id, session_id, generation_id, owner_id, owner_epoch, fencing_token, acquired_at, expires_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(String(request.runId), String(leaseId), request.sessionId, String(request.generationId), String(request.ownerId), token, token, now, expiresAt)
    return { status: 'granted', lease: { id: leaseId, providerId: this.name, sessionId: request.sessionId, runId: request.runId, generationId: request.generationId, ownerId: request.ownerId, ownerEpoch: token, fencingToken: token, acquiredAt: now, expiresAt } }
  }

  private exactLease(request: GraphSchedulerLeaseRequest): SqlRow {
    const value = this.db.prepare('SELECT * FROM graph_scheduler_leases WHERE run_id = ?').get(String(request.runId))
    if (value === undefined) throw new GraphSchedulerAuthorityError('graph scheduler lease is absent or fenced')
    const current = row(value)
    this.assertExact(current, request)
    if (numberValue(current.expires_at, 'expires_at') <= request.at) throw new GraphSchedulerAuthorityError('graph scheduler lease expired')
    return current
  }

  private assertExact(current: SqlRow, request: GraphSchedulerLeaseRequest): void {
    if (textValue(current.lease_id, 'lease_id') !== String(request.leaseId)
      || textValue(current.generation_id, 'generation_id') !== String(request.generationId)
      || textValue(current.owner_id, 'owner_id') !== String(request.ownerId)
      || numberValue(current.owner_epoch, 'owner_epoch') !== request.ownerEpoch
      || numberValue(current.fencing_token, 'fencing_token') !== request.fencingToken) {
      throw new GraphSchedulerAuthorityError('graph scheduler lease is absent or fenced')
    }
  }

  private lease(current: SqlRow): GraphSchedulerLease {
    return {
      id: GraphSchedulerLeaseId(textValue(current.lease_id, 'lease_id')),
      providerId: this.name,
      sessionId: textValue(current.session_id, 'session_id'),
      runId: textValue(current.run_id, 'run_id') as GraphSchedulerLease['runId'],
      generationId: textValue(current.generation_id, 'generation_id') as GraphSchedulerLease['generationId'],
      ownerId: textValue(current.owner_id, 'owner_id') as GraphSchedulerLease['ownerId'],
      ownerEpoch: numberValue(current.owner_epoch, 'owner_epoch'),
      fencingToken: numberValue(current.fencing_token, 'fencing_token'),
      acquiredAt: numberValue(current.acquired_at, 'acquired_at'),
      expiresAt: numberValue(current.expires_at, 'expires_at'),
    }
  }
}

/** Register the SQLite scheduler authority for its Cordis lifetime. */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolve(config.path)
  const provider = new SqliteGraphSchedulerProvider(config.providerName, resolved, config)
  ctx.effect(() => {
    const dispose = ctx.graphScheduler.register(provider)
    return () => { dispose(); provider.close() }
  }, 'graph-scheduler-sqlite: provider registration')
}
