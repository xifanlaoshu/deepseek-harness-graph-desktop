/** SQLite authority for durable cross-process Graph model-resource reservations. @module @deepseek-ai/dsh-graph-resources-sqlite */

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  GraphResourceReservationId,
  type GraphResourceDecision,
  type GraphResourceOutcome,
  type GraphResourceProvider,
  type GraphResourceReconcileRequest,
  type GraphResourceReconcileResult,
  type GraphResourceReservation,
  type GraphResourceReservationRequest,
  type GraphResourceRoute,
  type GraphResourceSnapshot,
} from '@deepseek-ai/dsh-graph-resources'

export const name = 'graph-resources-sqlite'
export const inject = ['graphResources']

const APPLICATION_ID = 0x44534752
const SCHEMA_VERSION = 1
const MAX_EVIDENCE_CHARACTERS = 4_000

/** Optional deployment facts and lower ceilings for one exact model route. */
export interface RouteConfig {
  /** Optional model Provider id; omission addresses the default Provider. */
  readonly provider?: string
  /** Exact model id. */
  readonly model: string
  /** Optional deployment ceiling below every Graph request ceiling. */
  readonly concurrencyLimit?: number
  /** Optional deployment weight ceiling below every Graph request ceiling. */
  readonly weightLimit?: number
  /** Optional model context capacity exposed to planning snapshots. */
  readonly contextWindow?: number
  /** Optional maximum model output exposed to planning snapshots. */
  readonly maxOutputTokens?: number
  /** Optional deployment-defined memory class without device identity. */
  readonly memoryClass?: string
  /** Optional JSON telemetry file refreshed atomically by the model runtime or a trusted sidecar. */
  readonly telemetryPath?: string
  /** Available device bytes required for one unit of Graph request weight. */
  readonly minimumAvailableDeviceBytesPerWeight?: number
  /** Queue depth at which new work waits instead of entering the model server. */
  readonly maxQueueDepth?: number
}

/** Persistent resource-authority configuration. */
export interface Config {
  /** Registered Graph resource Provider name. */
  readonly providerName: string
  /** SQLite file path, resolved from the Host working directory. */
  readonly path: string
  /** Optional exact-route lower ceilings and planning facts. */
  readonly routes: RouteConfig[]
  /** Lifetime of one published capacity observation. */
  readonly observationTtlMs: number
  /** Maximum lifetime of one durable reservation. */
  readonly leaseMs: number
  /** Delay before a capacity waiter may ask again. */
  readonly retryMs: number
  /** Route backoff after a Worker reports OOM. */
  readonly oomBackoffMs: number
  /** Maximum time SQLite waits for a competing transaction. */
  readonly busyTimeoutMs: number
  /** Maximum bytes accepted from one telemetry snapshot file. */
  readonly telemetryMaxBytes: number
  /** SQLite journal mode selected after database identity validation. */
  readonly journalMode: 'wal' | 'delete' | 'truncate'
}

const RouteConfig: z<RouteConfig> = z.object({
  provider: z.string(), model: z.string().required(), concurrencyLimit: z.natural().min(1),
  weightLimit: z.number().min(0), contextWindow: z.natural().min(1),
  maxOutputTokens: z.natural().min(1), memoryClass: z.string(), telemetryPath: z.string(),
  minimumAvailableDeviceBytesPerWeight: z.natural().min(1), maxQueueDepth: z.natural(),
})

/** Plugin configuration schema. */
export const Config: z<Config> = z.object({
  providerName: z.string().default('sqlite-resources'),
  path: z.string().default('.sessions/graph-resources.sqlite'),
  routes: z.array(RouteConfig).default([]),
  observationTtlMs: z.natural().min(100).max(300_000).default(5_000),
  leaseMs: z.natural().min(1_000).max(86_400_000).default(60_000),
  retryMs: z.natural().min(10).max(300_000).default(250),
  oomBackoffMs: z.natural().min(100).max(86_400_000).default(30_000),
  busyTimeoutMs: z.natural().min(1).max(300_000).default(5_000),
  telemetryMaxBytes: z.natural().min(1).default(65_536),
  journalMode: z.union(['wal', 'delete', 'truncate'] as const).default('wal'),
})

type SqlValue = string | number | null
type SqlRow = Record<string, SqlValue>

// DatabaseSync.get() owns the row container; individual durable fields remain validated below.
const row = (value: unknown, _subject?: string): SqlRow => value as SqlRow

const textValue = (value: SqlValue | undefined, subject: string): string => {
  if (typeof value !== 'string') throw new Error(`${subject} must be SQLite text`)
  return value
}

const numberValue = (value: SqlValue | undefined, subject: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${subject} must be a finite SQLite number`)
  return value
}

const optionalNumber = (value: SqlValue | undefined, subject: string): number | undefined => value === null || value === undefined
  ? undefined
  : numberValue(value, subject)

const routeKey = (route: GraphResourceRoute): string => JSON.stringify([route.provider ?? null, route.model])
const providerKey = (route: GraphResourceRoute): string => route.provider ?? ''
const stableReservationId = (operationId: string, ownerEpoch: number): GraphResourceReservationId => GraphResourceReservationId(
  `reservation:${createHash('sha256').update(JSON.stringify([operationId, ownerEpoch])).digest('hex')}`,
)

const validateRoute = (route: RouteConfig): void => {
  if (!route.model.trim() || (route.provider !== undefined && !route.provider.trim())
    || (route.memoryClass !== undefined && !route.memoryClass.trim())) {
    throw new Error('graph-resources-sqlite routes require normalized provider, model, and memoryClass values')
  }
  if (route.weightLimit !== undefined && (!Number.isFinite(route.weightLimit) || route.weightLimit <= 0)) {
    throw new Error(`graph resource route ${route.model} weightLimit must be positive`)
  }
  if (route.telemetryPath !== undefined && !route.telemetryPath.trim()) {
    throw new Error(`graph resource route ${route.model} telemetryPath must be non-empty`)
  }
}

interface RouteTelemetry {
  readonly observedAt: number
  readonly expiresAt: number
  readonly status: GraphResourceSnapshot['status']
  readonly activeRequests?: number
  readonly queueDepth?: number
  readonly concurrencyLimit?: number
  readonly availableDeviceBytes?: number
}

const configFingerprint = (config: Config): string => createHash('sha256').update(JSON.stringify({
  providerName: config.providerName,
  routes: [...config.routes].sort((left, right) => routeKey(left).localeCompare(routeKey(right))),
  observationTtlMs: config.observationTtlMs,
  leaseMs: config.leaseMs,
  retryMs: config.retryMs,
  oomBackoffMs: config.oomBackoffMs,
  telemetryMaxBytes: config.telemetryMaxBytes,
})).digest('hex')

/** SQLite Provider sharing exact-route leases, fencing, and runtime backoff across Host processes. */
export class SqliteGraphResourceProvider implements GraphResourceProvider {
  readonly protocolVersion = 1 as const
  private readonly db: DatabaseSync
  private readonly routes = new Map<string, RouteConfig>()
  private readonly fingerprint: string
  private closed = false

  constructor(readonly name: string, readonly path: string, private readonly config: Config) {
    if (!name.trim()) throw new Error('graph-resources-sqlite providerName must be non-empty')
    if (!isAbsolute(path)) throw new Error('graph-resources-sqlite path must resolve to an absolute path')
    for (const route of config.routes) {
      validateRoute(route)
      const key = routeKey(route)
      if (this.routes.has(key)) throw new Error(`duplicate graph resource route ${key}`)
      this.routes.set(key, route.telemetryPath === undefined ? route : { ...route, telemetryPath: resolve(route.telemetryPath) })
    }
    this.fingerprint = configFingerprint(config)
    mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    try {
      this.open()
    } catch (error) {
      this.db.close()
      throw error
    }
  }

  observe(route: GraphResourceRoute, signal: AbortSignal): Promise<GraphResourceSnapshot> {
    return Promise.resolve().then(() => {
      signal.throwIfAborted()
      const telemetry = this.readTelemetry(route)
      return this.transaction(() => {
        const now = Date.now()
        this.expire(now)
        return this.snapshot(route, now, undefined, telemetry)
      })
    })
  }

  reserve(request: GraphResourceReservationRequest, signal: AbortSignal): Promise<GraphResourceDecision> {
    return Promise.resolve().then(() => {
      signal.throwIfAborted()
      const telemetry = this.readTelemetry(request)
      return this.transaction(() => this.reserveInTransaction(request, telemetry))
    })
  }

  report(outcome: GraphResourceOutcome, signal: AbortSignal): Promise<void> {
    return Promise.resolve().then(() => {
      signal.throwIfAborted()
      this.transaction(() => { this.reportInTransaction(outcome) })
    })
  }

  reconcile(request: GraphResourceReconcileRequest, signal: AbortSignal): Promise<GraphResourceReconcileResult> {
    return Promise.resolve().then(() => {
      signal.throwIfAborted()
      return this.transaction(() => this.reconcileInTransaction(request))
    })
  }

  /** Close this Provider's database handle after unregistering it. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.db.close()
  }

  private open(): void {
    this.db.exec(`PRAGMA busy_timeout = ${String(this.config.busyTimeoutMs)}`)
    const applicationId = numberValue(row(this.db.prepare('PRAGMA application_id').get(), 'application_id').application_id, 'application_id')
    const version = numberValue(row(this.db.prepare('PRAGMA user_version').get(), 'user_version').user_version, 'user_version')
    const objects = numberValue(row(this.db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'").get(), 'schema count').count, 'schema count')
    if (applicationId === 0 && version === 0 && objects === 0) {
      this.initialize()
    } else if (applicationId !== APPLICATION_ID || version !== SCHEMA_VERSION) {
      throw new Error(`graph-resources-sqlite refuses database identity ${String(applicationId)} version ${String(version)}`)
    }
    this.db.exec(`PRAGMA journal_mode = ${this.config.journalMode.toUpperCase()}`)
    this.transaction(() => {
      this.expire(Date.now())
      const stored = this.db.prepare("SELECT value FROM graph_resource_meta WHERE key = 'config_hash'").get()
      const hash = stored === undefined ? undefined : textValue(row(stored, 'config hash').value, 'config hash')
      if (hash === this.fingerprint) return
      const active = numberValue(row(this.db.prepare('SELECT COUNT(*) AS count FROM graph_resource_reservations').get(), 'active reservation count').count, 'active reservation count')
      if (active > 0) throw new Error('graph-resources-sqlite configuration differs while durable reservations are active')
      this.db.prepare("INSERT INTO graph_resource_meta(key, value) VALUES('config_hash', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(this.fingerprint)
    }, false)
  }

  private initialize(): void {
    this.db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE graph_resource_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE graph_resource_reservations (
        fencing_token INTEGER PRIMARY KEY AUTOINCREMENT,
        reservation_id TEXT NOT NULL,
        provider_key TEXT NOT NULL,
        model TEXT NOT NULL,
        work_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        owner_epoch INTEGER NOT NULL,
        weight REAL NOT NULL,
        hard_max_parallel INTEGER NOT NULL,
        hard_max_weight REAL,
        acquired_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        UNIQUE(operation_id, owner_epoch)
      );
      CREATE INDEX graph_resource_reservations_route ON graph_resource_reservations(provider_key, model, expires_at);
      CREATE TABLE graph_resource_outcomes (
        reservation_id TEXT NOT NULL,
        fencing_token INTEGER NOT NULL,
        provider_id TEXT NOT NULL,
        work_id TEXT NOT NULL,
        owner_epoch INTEGER NOT NULL,
        outcome TEXT NOT NULL,
        at INTEGER NOT NULL,
        retry_after_ms INTEGER,
        evidence TEXT,
        PRIMARY KEY(reservation_id, fencing_token)
      );
      CREATE TABLE graph_resource_route_state (
        provider_key TEXT NOT NULL,
        model TEXT NOT NULL,
        recent_oom_at INTEGER,
        rate_limited_until INTEGER,
        PRIMARY KEY(provider_key, model)
      );
      PRAGMA application_id = ${String(APPLICATION_ID)};
      PRAGMA user_version = ${String(SCHEMA_VERSION)};
      COMMIT;`)
  }

  private transaction<T>(operation: () => T, verifyConfig = true): T {
    if (this.closed) throw new Error('graph-resources-sqlite Provider is closed')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      if (verifyConfig) this.verifyConfig()
      const result = operation()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  private verifyConfig(): void {
    const value = this.db.prepare("SELECT value FROM graph_resource_meta WHERE key = 'config_hash'").get()
    if (value === undefined || textValue(row(value, 'config hash').value, 'config hash') !== this.fingerprint) {
      throw new Error('graph-resources-sqlite configuration changed in another process')
    }
  }

  private reserveInTransaction(request: GraphResourceReservationRequest, telemetry: RouteTelemetry | undefined): GraphResourceDecision {
    const now = Date.now()
    this.expire(now)
    const existingValue = this.db.prepare('SELECT * FROM graph_resource_reservations WHERE operation_id = ? AND owner_epoch = ?')
      .get(String(request.operationId), request.ownerEpoch)
    if (existingValue !== undefined) {
      const existing = row(existingValue, 'existing reservation')
      this.assertReservationRequest(existing, request)
      return {
        status: 'granted',
        reservation: this.reservation(existing, request, this.snapshot(request, now, request, telemetry)),
      }
    }
    const snapshot = this.snapshot(request, now, request, telemetry)
    const configured = this.routes.get(routeKey(request))
    const retryAt = Math.max(now, request.requestedAt) + this.config.retryMs
    if (configured?.telemetryPath !== undefined && snapshot.status !== 'available') {
      return { status: 'wait', reason: snapshot.status === 'unknown' ? 'unknown' : 'provider-degraded', retryAt, snapshot }
    }
    if (configured?.maxQueueDepth !== undefined && (snapshot.queueDepth ?? 0) >= configured.maxQueueDepth) {
      return { status: 'wait', reason: 'queue', retryAt, snapshot }
    }
    if (configured?.minimumAvailableDeviceBytesPerWeight !== undefined) {
      const available = snapshot.availableDeviceBytes
      if (available === undefined) return { status: 'wait', reason: 'unknown', retryAt, snapshot }
      if (request.weight * configured.minimumAvailableDeviceBytesPerWeight > available) {
        return { status: 'wait', reason: 'memory', retryAt, snapshot }
      }
    }
    const stateValue = this.db.prepare('SELECT recent_oom_at, rate_limited_until FROM graph_resource_route_state WHERE provider_key = ? AND model = ?')
      .get(providerKey(request), request.model)
    const state = stateValue === undefined ? undefined : row(stateValue, 'route state')
    const rateLimitedUntil = optionalNumber(state?.rate_limited_until, 'rate_limited_until')
    const recentOomAt = optionalNumber(state?.recent_oom_at, 'recent_oom_at')
    if (rateLimitedUntil !== undefined && rateLimitedUntil > now) return { status: 'wait', reason: 'rate-limit', retryAt: rateLimitedUntil, snapshot }
    if (recentOomAt !== undefined && recentOomAt + this.config.oomBackoffMs > now) {
      return { status: 'wait', reason: 'oom-backoff', retryAt: recentOomAt + this.config.oomBackoffMs, snapshot }
    }
    const activeRequests = snapshot.activeRequests as number
    const concurrencyLimit = snapshot.concurrencyLimit as number
    if (activeRequests >= concurrencyLimit) return { status: 'wait', reason: 'concurrency', retryAt: now + this.config.retryMs, snapshot }
    const weightLimit = snapshot.weightLimit
    if (weightLimit !== undefined && request.weight > weightLimit) return { status: 'rejected', reason: 'request-impossible', snapshot }
    if (weightLimit !== undefined && (snapshot.activeWeight as number) + request.weight > weightLimit) {
      return { status: 'wait', reason: 'weight', retryAt: now + this.config.retryMs, snapshot }
    }
    const reservationId = stableReservationId(String(request.operationId), request.ownerEpoch)
    const expiresAt = Math.min(request.deadline, now + this.config.leaseMs)
    const inserted = this.db.prepare(`INSERT INTO graph_resource_reservations(
      reservation_id, provider_key, model, work_id, operation_id, owner_epoch, weight,
      hard_max_parallel, hard_max_weight, acquired_at, expires_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      String(reservationId), providerKey(request), request.model, String(request.workId), String(request.operationId),
      request.ownerEpoch, request.weight, request.hardMaxParallel, request.hardMaxWeight ?? null, now, expiresAt,
    )
    return {
      status: 'granted',
      reservation: {
        id: reservationId,
        providerId: this.name,
        workId: request.workId,
        operationId: request.operationId,
        ownerEpoch: request.ownerEpoch,
        weight: request.weight,
        fencingToken: Number(inserted.lastInsertRowid),
        acquiredAt: now,
        expiresAt,
        snapshot,
        ...request.provider === undefined ? {} : { provider: request.provider },
        model: request.model,
      },
    }
  }

  private snapshot(
    route: GraphResourceRoute,
    now: number,
    request?: GraphResourceReservationRequest,
    telemetry?: RouteTelemetry,
  ): GraphResourceSnapshot {
    const configured = this.routes.get(routeKey(route))
    const aggregate = row(this.db.prepare(`SELECT COUNT(*) AS active_requests, COALESCE(SUM(weight), 0) AS active_weight,
      MIN(hard_max_parallel) AS minimum_parallel, MIN(hard_max_weight) AS minimum_weight
      FROM graph_resource_reservations WHERE provider_key = ? AND model = ?`).get(providerKey(route), route.model), 'route aggregate')
    const stateValue = this.db.prepare('SELECT recent_oom_at, rate_limited_until FROM graph_resource_route_state WHERE provider_key = ? AND model = ?')
      .get(providerKey(route), route.model)
    const state = stateValue === undefined ? undefined : row(stateValue, 'route state')
    const recentOomAt = optionalNumber(state?.recent_oom_at, 'recent_oom_at')
    const rateLimitedUntil = optionalNumber(state?.rate_limited_until, 'rate_limited_until')
    const parallelCandidates = [
      configured?.concurrencyLimit,
      telemetry?.concurrencyLimit,
      optionalNumber(aggregate.minimum_parallel, 'minimum_parallel'),
      request?.hardMaxParallel,
    ]
      .filter((value): value is number => value !== undefined)
    const weightCandidates = [configured?.weightLimit, optionalNumber(aggregate.minimum_weight, 'minimum_weight'), request?.hardMaxWeight]
      .filter((value): value is number => value !== undefined)
    const degraded = (recentOomAt !== undefined && recentOomAt + this.config.oomBackoffMs > now)
      || (rateLimitedUntil !== undefined && rateLimitedUntil > now)
    const telemetryStatus = configured?.telemetryPath === undefined
      ? undefined
      : telemetry === undefined ? 'unknown' : telemetry.expiresAt <= now ? 'unavailable' : telemetry.status
    const durableActiveRequests = numberValue(aggregate.active_requests, 'active_requests')
    return {
      ...route,
      providerId: this.name,
      observedAt: telemetry?.observedAt ?? now,
      expiresAt: telemetry?.expiresAt ?? now + this.config.observationTtlMs,
      status: degraded ? 'degraded' : telemetryStatus ?? 'available',
      activeRequests: Math.max(durableActiveRequests, telemetry?.activeRequests ?? 0),
      activeWeight: numberValue(aggregate.active_weight, 'active_weight'),
      ...telemetry?.queueDepth === undefined ? {} : { queueDepth: telemetry.queueDepth },
      ...parallelCandidates.length === 0 ? {} : { concurrencyLimit: Math.min(...parallelCandidates) },
      ...weightCandidates.length === 0 ? {} : { weightLimit: Math.min(...weightCandidates) },
      ...configured?.contextWindow === undefined ? {} : { contextWindow: configured.contextWindow },
      ...configured?.maxOutputTokens === undefined ? {} : { maxOutputTokens: configured.maxOutputTokens },
      ...configured?.memoryClass === undefined ? {} : { memoryClass: configured.memoryClass },
      ...telemetry?.availableDeviceBytes === undefined ? {} : { availableDeviceBytes: telemetry.availableDeviceBytes },
      ...recentOomAt === undefined ? {} : { recentOomAt },
      ...rateLimitedUntil === undefined ? {} : { rateLimitedUntil },
    }
  }

  private readTelemetry(route: GraphResourceRoute): RouteTelemetry | undefined {
    const configured = this.routes.get(routeKey(route))
    if (configured?.telemetryPath === undefined) return undefined
    let bytes: Buffer
    try {
      bytes = readFileSync(configured.telemetryPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    if (bytes.byteLength > this.config.telemetryMaxBytes) throw new Error('graph resource telemetry exceeds telemetryMaxBytes')
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('graph resource telemetry must be an object')
    }
    const item = value as Record<string, unknown>
    if (item.protocolVersion !== 1 || item.model !== route.model || (item.provider ?? '') !== (route.provider ?? '')) {
      throw new Error('graph resource telemetry targets another protocol or model route')
    }
    const integer = (name: string, required = false): number | undefined => {
      const field = item[name]
      if (field === undefined && !required) return undefined
      if (!Number.isSafeInteger(field) || (field as number) < 0) {
        throw new Error(`graph resource telemetry ${name} is invalid`)
      }
      return field as number
    }
    const observedAt = integer('observedAt', true) as number
    const expiresAt = integer('expiresAt', true) as number
    if (expiresAt <= observedAt) throw new Error('graph resource telemetry lifetime is invalid')
    const status = item.status
    if (!['available', 'degraded', 'unavailable', 'unknown'].includes(String(status))) {
      throw new Error('graph resource telemetry status is invalid')
    }
    const activeRequests = integer('activeRequests')
    const queueDepth = integer('queueDepth')
    const concurrencyLimit = integer('concurrencyLimit')
    const availableDeviceBytes = integer('availableDeviceBytes')
    return {
      observedAt,
      expiresAt,
      status: status as RouteTelemetry['status'],
      ...activeRequests === undefined ? {} : { activeRequests },
      ...queueDepth === undefined ? {} : { queueDepth },
      ...concurrencyLimit === undefined ? {} : { concurrencyLimit },
      ...availableDeviceBytes === undefined ? {} : { availableDeviceBytes },
    }
  }

  private assertReservationRequest(existing: SqlRow, request: GraphResourceReservationRequest): void {
    const matches = textValue(existing.provider_key, 'provider_key') === providerKey(request)
      && textValue(existing.model, 'model') === request.model
      && textValue(existing.work_id, 'work_id') === String(request.workId)
      && numberValue(existing.weight, 'weight') === request.weight
      && numberValue(existing.hard_max_parallel, 'hard_max_parallel') === request.hardMaxParallel
      && optionalNumber(existing.hard_max_weight, 'hard_max_weight') === request.hardMaxWeight
    if (!matches) throw new Error(`conflicting Graph resource reservation for ${String(request.operationId)}`)
  }

  private reservation(
    existing: SqlRow,
    request: GraphResourceReservationRequest,
    snapshot: GraphResourceSnapshot,
  ): GraphResourceReservation {
    return {
      id: GraphResourceReservationId(textValue(existing.reservation_id, 'reservation_id')),
      providerId: this.name,
      workId: request.workId,
      operationId: request.operationId,
      ownerEpoch: request.ownerEpoch,
      weight: request.weight,
      fencingToken: numberValue(existing.fencing_token, 'fencing_token'),
      acquiredAt: numberValue(existing.acquired_at, 'acquired_at'),
      expiresAt: numberValue(existing.expires_at, 'expires_at'),
      snapshot,
      ...request.provider === undefined ? {} : { provider: request.provider },
      model: request.model,
    }
  }

  private reportInTransaction(outcome: GraphResourceOutcome): void {
    if (outcome.providerId !== this.name) throw new Error(`Graph resource outcome targets ${outcome.providerId}, not ${this.name}`)
    if (outcome.evidence !== undefined && outcome.evidence.length > MAX_EVIDENCE_CHARACTERS) throw new Error('Graph resource outcome evidence exceeds 4000 characters')
    const priorValue = this.db.prepare('SELECT * FROM graph_resource_outcomes WHERE reservation_id = ? AND fencing_token = ?')
      .get(String(outcome.reservationId), outcome.fencingToken)
    if (priorValue !== undefined) {
      const prior = row(priorValue, 'resource outcome')
      const matches = textValue(prior.provider_id, 'provider_id') === outcome.providerId
        && textValue(prior.work_id, 'work_id') === String(outcome.workId)
        && numberValue(prior.owner_epoch, 'owner_epoch') === outcome.ownerEpoch
        && textValue(prior.outcome, 'outcome') === outcome.outcome
      if (matches) return
      throw new Error(`conflicting Graph resource outcome for ${String(outcome.reservationId)}`)
    }
    const reservationValue = this.db.prepare('SELECT * FROM graph_resource_reservations WHERE reservation_id = ? AND fencing_token = ?')
      .get(String(outcome.reservationId), outcome.fencingToken)
    if (reservationValue === undefined) throw new Error(`Graph resource outcome is absent or fenced for ${String(outcome.reservationId)}`)
    const reservation = row(reservationValue, 'resource reservation')
    if (textValue(reservation.work_id, 'work_id') !== String(outcome.workId)
      || numberValue(reservation.owner_epoch, 'owner_epoch') !== outcome.ownerEpoch) {
      throw new Error(`Graph resource outcome is absent or fenced for ${String(outcome.reservationId)}`)
    }
    this.insertOutcome(outcome)
    this.db.prepare('DELETE FROM graph_resource_reservations WHERE reservation_id = ? AND fencing_token = ?')
      .run(String(outcome.reservationId), outcome.fencingToken)
    this.updateRouteState(reservation, outcome)
  }

  private reconcileInTransaction(request: GraphResourceReconcileRequest): GraphResourceReconcileResult {
    if (request.providerId !== this.name) return { status: 'conflict', evidence: `reservation ${String(request.reservationId)} targets another Provider` }
    const priorValue = this.db.prepare('SELECT * FROM graph_resource_outcomes WHERE reservation_id = ? AND fencing_token = ?')
      .get(String(request.reservationId), request.fencingToken)
    if (priorValue !== undefined) {
      const prior = row(priorValue, 'resource outcome')
      const matches = textValue(prior.provider_id, 'provider_id') === request.providerId
        && textValue(prior.work_id, 'work_id') === String(request.workId)
        && numberValue(prior.owner_epoch, 'owner_epoch') === request.ownerEpoch
      return matches
        ? { status: 'already-released', evidence: `reservation ${String(request.reservationId)} already has terminal outcome ${textValue(prior.outcome, 'outcome')}` }
        : { status: 'conflict', evidence: `reservation ${String(request.reservationId)} has a differently fenced terminal outcome` }
    }
    const reservationValue = this.db.prepare('SELECT * FROM graph_resource_reservations WHERE reservation_id = ? AND fencing_token = ?')
      .get(String(request.reservationId), request.fencingToken)
    if (reservationValue === undefined) {
      const replacement = this.db.prepare('SELECT fencing_token FROM graph_resource_reservations WHERE reservation_id = ?')
        .get(String(request.reservationId))
      return replacement === undefined
        ? { status: 'absent', evidence: `reservation ${String(request.reservationId)} is absent` }
        : { status: 'conflict', evidence: `reservation ${String(request.reservationId)} has a newer fencing token` }
    }
    const reservation = row(reservationValue, 'resource reservation')
    if (textValue(reservation.work_id, 'work_id') !== String(request.workId)
      || numberValue(reservation.owner_epoch, 'owner_epoch') !== request.ownerEpoch) {
      return { status: 'conflict', evidence: `reservation ${String(request.reservationId)} belongs to different fenced work` }
    }
    const outcome: GraphResourceOutcome = {
      reservationId: request.reservationId,
      providerId: request.providerId,
      workId: request.workId,
      ownerEpoch: request.ownerEpoch,
      fencingToken: request.fencingToken,
      outcome: 'worker-lost',
      at: request.at,
      evidence: request.evidence,
    }
    this.insertOutcome(outcome)
    this.db.prepare('DELETE FROM graph_resource_reservations WHERE reservation_id = ? AND fencing_token = ?')
      .run(String(request.reservationId), request.fencingToken)
    return { status: 'released', evidence: `reservation ${String(request.reservationId)} released as worker-lost` }
  }

  private insertOutcome(outcome: GraphResourceOutcome): void {
    this.db.prepare(`INSERT INTO graph_resource_outcomes(
      reservation_id, fencing_token, provider_id, work_id, owner_epoch, outcome, at, retry_after_ms, evidence
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      String(outcome.reservationId), outcome.fencingToken, outcome.providerId, String(outcome.workId), outcome.ownerEpoch,
      outcome.outcome, outcome.at, outcome.retryAfterMs ?? null, outcome.evidence ?? null,
    )
  }

  private updateRouteState(reservation: SqlRow, outcome: GraphResourceOutcome): void {
    if (outcome.outcome !== 'oom' && outcome.outcome !== 'rate-limited') return
    const provider = textValue(reservation.provider_key, 'provider_key')
    const model = textValue(reservation.model, 'model')
    const currentValue = this.db.prepare('SELECT recent_oom_at, rate_limited_until FROM graph_resource_route_state WHERE provider_key = ? AND model = ?')
      .get(provider, model)
    const current = currentValue === undefined ? undefined : row(currentValue, 'route state')
    const recentOomAt = outcome.outcome === 'oom'
      ? Math.max(optionalNumber(current?.recent_oom_at, 'recent_oom_at') ?? 0, outcome.at)
      : optionalNumber(current?.recent_oom_at, 'recent_oom_at')
    const rateLimitedUntil = outcome.outcome === 'rate-limited'
      ? Math.max(optionalNumber(current?.rate_limited_until, 'rate_limited_until') ?? 0, outcome.at + (outcome.retryAfterMs ?? this.config.retryMs))
      : optionalNumber(current?.rate_limited_until, 'rate_limited_until')
    this.db.prepare(`INSERT INTO graph_resource_route_state(provider_key, model, recent_oom_at, rate_limited_until)
      VALUES(?, ?, ?, ?) ON CONFLICT(provider_key, model) DO UPDATE SET
      recent_oom_at = excluded.recent_oom_at, rate_limited_until = excluded.rate_limited_until`)
      .run(provider, model, recentOomAt ?? null, rateLimitedUntil ?? null)
  }

  private expire(now: number): void {
    this.db.prepare('DELETE FROM graph_resource_reservations WHERE expires_at <= ?').run(now)
  }
}

/** Register one durable SQLite resource Provider. */
export function apply(ctx: Context, config: Config): void {
  const path = resolve(config.path)
  const provider = new SqliteGraphResourceProvider(config.providerName, path, config)
  ctx.effect(() => {
    const dispose = ctx.graphResources.register(provider)
    return () => {
      dispose()
      provider.close()
    }
  }, 'graph-resources-sqlite: provider registration')
}
