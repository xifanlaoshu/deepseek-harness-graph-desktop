/**
 * Opt-in SQLite persistence provider. Logical sessions remain unchanged;
 * the physical backend packs eligible chunk runs into schema-17 rows.
 * @module @deepseek-ai/dsh-session-persistence-sqlite
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import SessionStore, {
  type SessionEvent,
  type SessionHeader,
  type SessionId,
  type SessionPreparation,
} from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence, { type JsonlCompression } from '@deepseek-ai/dsh-session-persistence-jsonl'
import {
  DEFAULT_PREPARED_SESSION_CACHE_SIZE,
  DEFAULT_WRITE_BATCH_MAX_DELAY_MS,
  MAX_WRITE_BATCH_DELAY_MS,
  PersistenceCoordinator,
  SessionPersistence,
  type SessionInspection,
  type SessionLocation,
  type SessionPersistenceSnapshot,
  type SessionEventPage,
  type SessionEventPageRequest,
  type SessionEventRangeRequest,
  type SessionEventSequenceRequest,
  validateSessionEventRangeRequest,
  validateSessionEventPageRequest,
  validateSessionEventSequenceRequest,
} from '@deepseek-ai/dsh-session-persistence'
import type { JournalMode } from './schema.ts'
import { SqliteStore } from './store.ts'

export { SCHEMA_VERSION } from './schema.ts'

/** Default wait for another SQLite connection's write reservation. */
export const DEFAULT_BUSY_TIMEOUT_MS = 5_000
/** Largest busy timeout accepted by SQLite's signed millisecond interface. */
export const MAX_BUSY_TIMEOUT_MS = 2_147_483_647

/** Plugin configuration. */
export interface Config {
  /** SQLite database path, or `:memory:` for an in-process database. */
  path: string
  /** Durable SQLite journal mode; defaults to `wal`. */
  journalMode?: JournalMode
  /** Maximum wait for another SQLite connection's lock; defaults to 5,000 ms. */
  busyTimeoutMs?: number
  /** Maximum cold Session preparations retained for history-to-resume reuse. */
  preparedSessionCacheSize?: number
  /** Fixed live-event coalescing window; not a backend completion deadline. */
  writeBatchMaxDelayMs?: number
  /** Legacy JSONL root imported transactionally before this provider serves. */
  legacyJsonlRoot?: string
  /** Encoding used by the legacy root; defaults to `zstd`. */
  legacyJsonlCompression?: JsonlCompression
}

/**
 * SQLite `SessionPersistence` provider with a schema-owned physical codec.
 */
export class SqliteSessionPersistence extends SessionPersistence {
  override readonly supportsRawArtifacts = false
  override readonly name = 'session-persistence-sqlite'

  static inject = ['sessions']

  static Config: z<Config> = z.object({
    path: z.string().required(),
    journalMode: z.union(['wal', 'delete', 'truncate', 'persist'] as const).default('wal'),
    busyTimeoutMs: z.number().step(1).min(0).max(MAX_BUSY_TIMEOUT_MS).default(DEFAULT_BUSY_TIMEOUT_MS),
    preparedSessionCacheSize: z.number().step(1).min(1).default(DEFAULT_PREPARED_SESSION_CACHE_SIZE),
    writeBatchMaxDelayMs: z.number().step(1).min(1).max(MAX_WRITE_BATCH_DELAY_MS)
      .default(DEFAULT_WRITE_BATCH_MAX_DELAY_MS),
    legacyJsonlRoot: z.string(),
    legacyJsonlCompression: z.union(['zstd', 'none'] as const).default('zstd'),
  })

  private readonly store: SqliteStore
  private readonly coordinator: PersistenceCoordinator<number>

  constructor(ctx: Context, public config: Config) {
    super(ctx)
    const preparedSessionCacheSize = config.preparedSessionCacheSize
      ?? DEFAULT_PREPARED_SESSION_CACHE_SIZE
    const writeBatchMaxDelayMs = config.writeBatchMaxDelayMs
      ?? DEFAULT_WRITE_BATCH_MAX_DELAY_MS
    this.store = new SqliteStore({
      path: config.path,
      journalMode: config.journalMode ?? 'wal',
      busyTimeoutMs: config.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS,
    })
    this.coordinator = new PersistenceCoordinator(this.ctx, this.store, {
      preparedSessionCacheSize,
      writeBatchMaxDelayMs,
    })
  }

  /** Reject self-contained path and ownership failures without loading Node SQLite. */
  protected async [Service.init](): Promise<void> {
    await this.store.validatePath()
    if (this.config.legacyJsonlRoot !== undefined) await this.importLegacyJsonl()
  }

  /** Import every missing legacy identity without retaining a complete log in memory. */
  private async importLegacyJsonl(): Promise<void> {
    const legacyCtx = new Context()
    await legacyCtx.plugin(SessionStore)
    const legacy = new JsonlSessionPersistence(legacyCtx, {
      root: this.config.legacyJsonlRoot as string,
      compression: this.config.legacyJsonlCompression ?? 'zstd',
    })
    for (const meta of await legacy.list()) {
      const imported = await this.store.importSession(meta, async (accept) => {
        const observed = await legacy.visitEventBatches(meta.id, accept)
        if (observed === undefined) throw new Error(`legacy session "${meta.id}" disappeared during import`)
      })
      if (imported) this.ctx.logger.info(`imported legacy JSONL session "${meta.id}" into SQLite`)
    }
  }

  /** SQLite has one database, not an independent per-session artifact. */
  locate(_meta: SessionHeader): SessionLocation | undefined {
    return undefined
  }

  create(meta: SessionHeader): Promise<void> {
    return this.coordinator.create(meta)
  }

  append(id: SessionId, events: readonly SessionEvent[]): Promise<void> {
    return this.coordinator.append(id, events)
  }

  override prepare(id: SessionId, signal?: AbortSignal): Promise<SessionPreparation> {
    return this.coordinator.prepare(id, signal)
  }

  load(id: SessionId): Promise<SessionInspection> {
    return this.coordinator.load(id)
  }

  inspect(id: SessionId, signal?: AbortSignal): Promise<SessionInspection> {
    return this.coordinator.inspect(id, signal)
  }

  readFrom(
    id: SessionId,
    fromSeq: number,
    signal?: AbortSignal,
  ): Promise<{ meta: SessionHeader; events: SessionEvent[] }> {
    return this.coordinator.readFrom(id, fromSeq, signal)
  }

  override async readRange(
    id: SessionId,
    request: SessionEventRangeRequest,
    signal?: AbortSignal,
  ): Promise<{ meta: SessionHeader; events: SessionEvent[] }> {
    validateSessionEventRangeRequest(request)
    const live = this.ctx.sessions.get(id)
    if (live !== undefined) {
      signal?.throwIfAborted()
      return {
        meta: live.header,
        events: live.events.filter(event => event.seq >= request.fromSeq
          && (request.toSeq === undefined || event.seq < request.toSeq)),
      }
    }
    const stored = await this.store.readRange(id, request, signal)
    if (stored === undefined) throw new Error(`session "${id}" not found`)
    return stored
  }

  override async findEventSequences(
    id: SessionId,
    request: SessionEventSequenceRequest,
    signal?: AbortSignal,
  ): Promise<{ meta: SessionHeader; sequences: number[] }> {
    validateSessionEventSequenceRequest(request)
    const live = this.ctx.sessions.get(id)
    if (live !== undefined) {
      signal?.throwIfAborted()
      const accepted = new Set(request.types)
      return {
        meta: live.header,
        sequences: live.events
          .filter(event => accepted.has(event.type)
            && (request.beforeSeq === undefined || event.seq < request.beforeSeq)
            && (request.surfaceOp === undefined
              || (event as { surfaceOp?: string }).surfaceOp === request.surfaceOp))
          .slice()
          .reverse()
          .slice(0, request.limit)
          .map(event => event.seq),
      }
    }
    const stored = await this.store.findEventSequences(id, request, signal)
    if (stored === undefined) throw new Error(`session "${id}" not found`)
    return stored
  }

  override async readEventPage(
    id: SessionId,
    request: SessionEventPageRequest,
    signal?: AbortSignal,
  ): Promise<SessionEventPage> {
    validateSessionEventPageRequest(request)
    const live = this.ctx.sessions.get(id)
    if (live !== undefined) return super.readEventPage(id, request, signal)
    const stored = await this.store.readEventPage(id, request, signal)
    if (stored === undefined) throw new Error(`session "${id}" not found`)
    return stored
  }

  list(signal?: AbortSignal): Promise<SessionHeader[]> {
    return this.store.list(signal)
  }

  listSnapshots(signal?: AbortSignal): Promise<SessionPersistenceSnapshot[]> {
    return this.store.listSnapshots(signal)
  }
}

export default SqliteSessionPersistence
