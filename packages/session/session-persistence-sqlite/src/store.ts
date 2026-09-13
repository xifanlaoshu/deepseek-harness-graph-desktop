/**
 * SQLite storage primitives: transactional append-batch packing, physical
 * reads, schema validation, revisions, repair, and lifecycle closure.
 * @module @deepseek-ai/dsh-session-persistence-sqlite/store
 */

import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { lstat, mkdir, open } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { DatabaseSync, StatementSync } from 'node:sqlite'
import {
  type SessionEvent,
  type SessionHeader,
  type SessionId,
} from '@deepseek-ai/dsh-session'
import {
  SessionPersistenceRevision,
  type PersistenceBackend,
  type SessionPersistenceRevision as PersistenceRevision,
  type SessionPersistenceSnapshot,
  type SessionEventPage,
  type SessionEventPageRequest,
  type SessionEventRangeRequest,
  type SessionEventSequenceRequest,
  type StoredPrefix,
  type StoredSuffix,
} from '@deepseek-ai/dsh-session-persistence'
import {
  MAX_PACKED_ROW_MEMBERS,
  packChunkRuns,
} from './codec.ts'
import {
  bindRecord,
  decodeRow,
  scanRows,
  type BoundRecord,
} from './compression.ts'
import {
  type EventRow,
  type JournalMode,
  decodeEventRow,
  decodeSessionRow,
  decodeStoreIdentity,
  openDatabase,
  validateSchemaForMutation,
  rowToMeta,
  type SessionRow,
} from './schema.ts'
import { sql } from './sql.ts'

const EVENT_PAGE_PHYSICAL_BATCH_SIZE = 256

/** Storage options resolved by the service provider. */
export interface SqliteStoreOptions {
  readonly path: string
  readonly journalMode: JournalMode
  readonly busyTimeoutMs: number
}

/** SQLite implementation of the coordinator's physical backend hooks. */
export class SqliteStore implements PersistenceBackend<number> {
  readonly name = 'session-persistence-sqlite'
  private db!: DatabaseSync
  private databaseConstructor!: typeof import('node:sqlite')['DatabaseSync']
  private storeIdentity!: string
  private databasePath!: string
  private opened = false
  private pathReady: Promise<void> | undefined
  private ready: Promise<void> | undefined

  constructor(private readonly options: SqliteStoreOptions) {}

  /**
   * Validate filesystem ownership without importing or opening Node SQLite.
   * @returns settlement of the store's one path-validation operation.
   */
  validatePath(): Promise<void> {
    this.pathReady ??= this.preparePath(this.options.path)
    return this.pathReady
  }

  /**
   * Lazily open and validate the database on first persistence use.
   * @returns settlement of the store's one database-open operation.
   */
  open(): Promise<void> {
    this.ready ??= this.openDb()
    return this.ready
  }

  private async preparePath(path: string): Promise<void> {
    const actual = path === ':memory:' ? path : resolve(path)
    if (actual !== ':memory:') {
      await mkdir(dirname(actual), { recursive: true, mode: 0o700 })
      await validateParentDirectory(dirname(actual))
      await validateDatabaseFileIfPresent(actual)
    }
    this.databasePath = actual
  }

  private async openDb(): Promise<void> {
    await this.validatePath()
    if (this.databasePath !== ':memory:') {
      await createDatabaseFile(this.databasePath)
      await validateDatabaseFile(this.databasePath)
    }
    const { DatabaseSync } = await loadNodeSqlite()
    this.databaseConstructor = DatabaseSync
    this.db = await openDatabase(
      DatabaseSync,
      this.databasePath,
      this.options.journalMode,
      this.options.busyTimeoutMs,
    )
    try {
      const row = this.db.prepare(sql('select-store-id')).get()
      if (row === undefined) {
        throw new Error(`session database at "${this.databasePath}" has no valid store identity`)
      }
      let storeId: string
      try {
        storeId = decodeStoreIdentity(row)
      } catch (error: unknown) {
        throw new Error(`session database at "${this.databasePath}" has no valid store identity`, { cause: error })
      }
      if (this.databasePath === ':memory:') {
        this.storeIdentity = `memory:store:${storeId}`
      } else {
        const identity = statSync(this.databasePath, { bigint: true })
        this.storeIdentity = `file:${identity.dev}:${identity.ino}:${identity.birthtimeNs}:store:${storeId}`
      }
      this.opened = true
    } catch (error: unknown) {
      this.db.close()
      throw error
    }
  }

  async loadStored(id: SessionId, signal?: AbortSignal): Promise<StoredPrefix<number> | undefined> {
    await this.observe(signal)
    const snapshot = this.readTransaction(() => {
      const row = this.rowFor(id)
      if (row === undefined) return undefined
      const eventRows = this.db.prepare(sql('select-events')).all(id).map(decodeEventRow)
      return { row, eventRows }
    })
    signal?.throwIfAborted()
    if (snapshot === undefined) return undefined
    const scanned = scanRows(snapshot.eventRows)
    return {
      meta: rowToMeta(snapshot.row),
      events: scanned.preserved,
      revision: sqliteRevision(this.storeIdentity, snapshot.row),
      ...scanned.tornFrom === undefined ? {} : { tornMarker: scanned.tornFrom },
    }
  }

  async readStoredRevision(id: SessionId, signal?: AbortSignal): Promise<PersistenceRevision | undefined> {
    await this.observe(signal)
    const row = this.rowFor(id)
    signal?.throwIfAborted()
    return row === undefined ? undefined : sqliteRevision(this.storeIdentity, row)
  }

  async loadStoredFrom(id: SessionId, fromSeq: number, signal?: AbortSignal): Promise<StoredSuffix | undefined> {
    await this.observe(signal)
    const snapshot = this.readTransaction(() => {
      const row = this.rowFor(id)
      if (row === undefined) return undefined
      return { row, ...this.physicalSpanFrom(id, fromSeq) }
    })
    signal?.throwIfAborted()
    if (snapshot === undefined) return undefined
    const { preserved } = scanRows(snapshot.eventRows, snapshot.base)
    return { meta: rowToMeta(snapshot.row), events: preserved.filter(event => event.seq >= fromSeq) }
  }

  /**
   * Read one bounded logical interval without materializing the complete session.
   * @param id - persisted session identity.
   * @param request - inclusive start and optional exclusive end sequence.
   * @param signal - optional cancellation around the synchronous query.
   * @returns the header and matching events, or `undefined` for an absent identity.
   */
  async readRange(
    id: SessionId,
    request: SessionEventRangeRequest,
    signal?: AbortSignal,
  ): Promise<{ meta: SessionHeader; events: SessionEvent[] } | undefined> {
    await this.observe(signal)
    const toSeq = request.toSeq ?? Number.MAX_SAFE_INTEGER
    const snapshot = this.readTransaction(() => {
      const row = this.rowFor(id)
      if (row === undefined) return undefined
      return { row, ...this.physicalSpanRange(id, request.fromSeq, toSeq) }
    })
    signal?.throwIfAborted()
    if (snapshot === undefined) return undefined
    const { preserved } = scanRows(snapshot.eventRows, snapshot.base)
    return {
      meta: rowToMeta(snapshot.row),
      events: preserved.filter(event => event.seq >= request.fromSeq && event.seq < toSeq),
    }
  }

  /**
   * Find newest matching logical positions from SQLite event metadata.
   * @param id - persisted session identity.
   * @param request - logical event types, exclusive upper sequence, and result limit.
   * @param signal - optional cancellation around the synchronous query.
   * @returns the header and newest-first positions, or `undefined` for an absent identity.
   */
  async findEventSequences(
    id: SessionId,
    request: SessionEventSequenceRequest,
    signal?: AbortSignal,
  ): Promise<{ meta: SessionHeader; sequences: number[] } | undefined> {
    await this.observe(signal)
    const beforeSeq = request.beforeSeq ?? Number.MAX_SAFE_INTEGER
    const snapshot = this.readTransaction(() => {
      const row = this.rowFor(id)
      if (row === undefined) return undefined
      const physicalTypes = new Set(request.types)
      if (physicalTypes.has('assistant/chunk')) {
        physicalTypes.add('text-chunks')
        physicalTypes.add('reasoning-chunks')
        physicalTypes.add('tool-call-chunks')
      }
      const rows = [...physicalTypes].flatMap(type => this.db.prepare(sql('select-event-sequences'))
        .all(
          id,
          type,
          beforeSeq,
          request.surfaceOp === undefined ? null : JSON.stringify(request.surfaceOp),
          request.surfaceOp === undefined ? null : JSON.stringify(request.surfaceOp),
          request.limit,
        )
        .map(decodeEventRow))
      return { row, rows }
    })
    signal?.throwIfAborted()
    if (snapshot === undefined) return undefined
    const accepted = new Set(request.types)
    const sequences = snapshot.rows
      .flatMap(row => decodeRow(row))
      .filter(event => accepted.has(event.type) && event.seq < beforeSeq
        && (request.surfaceOp === undefined
          || (event as { surfaceOp?: string }).surfaceOp === request.surfaceOp))
      .map(event => event.seq)
      .sort((left, right) => right - left)
      .filter((seq, index, values) => index === 0 || values[index - 1] !== seq)
      .slice(0, request.limit)
    return { meta: rowToMeta(snapshot.row), sequences }
  }

  /**
   * Read one filtered newest page without decoding excluded event domains.
   * @param id - persisted session identity.
   * @param request - logical interval, excluded prefixes, and page budgets.
   * @param signal - optional cancellation around the synchronous query.
   * @returns the bounded page, or `undefined` for an absent identity.
   */
  async readEventPage(
    id: SessionId,
    request: SessionEventPageRequest,
    signal?: AbortSignal,
  ): Promise<SessionEventPage | undefined> {
    await this.observe(signal)
    const snapshot = this.readTransaction(() => {
      const row = this.rowFor(id)
      if (row === undefined) return undefined
      const packedFloor = Math.max(0, request.fromSeq - MAX_PACKED_ROW_MEMBERS + 1)
      const beforeSeq = request.beforeSeq ?? Number.MAX_SAFE_INTEGER
      const excluded = JSON.stringify(request.excludeTypePrefixes)
      const selected: SessionEvent[] = []
      const encoder = new TextEncoder()
      let bytes = 0
      let cursor = beforeSeq
      let hasMore = false
      outer: for (;;) {
        const rows = this.db.prepare(sql('select-event-page'))
          .all(id, packedFloor, cursor, excluded, EVENT_PAGE_PHYSICAL_BATCH_SIZE)
          .map(decodeEventRow)
        if (rows.length === 0) break
        for (const physical of rows) {
          const logical = decodeRow(physical).slice().reverse()
          for (const event of logical) {
            if (event.seq < request.fromSeq || event.seq >= beforeSeq
              || request.excludeTypePrefixes.some(prefix => event.type.startsWith(prefix))) continue
            const eventBytes = encoder.encode(JSON.stringify(event)).byteLength
            if (selected.length >= request.maxEvents
              || (selected.length > 0 && bytes + eventBytes > request.maxBytes)) {
              hasMore = true
              break outer
            }
            selected.push(event)
            bytes += eventBytes
          }
          cursor = physical.seq
        }
        if (rows.length < EVENT_PAGE_PHYSICAL_BATCH_SIZE) break
      }
      selected.reverse()
      return { row, events: selected, hasMore }
    })
    signal?.throwIfAborted()
    if (snapshot === undefined) return undefined
    return { meta: rowToMeta(snapshot.row), events: snapshot.events, hasMore: snapshot.hasMore }
  }

  async appendBatch(
    meta: SessionHeader,
    events: readonly SessionEvent[],
    isMaterialized: boolean,
  ): Promise<void> {
    await this.open()
    if (events.length === 0) return
    this.db.exec(sql('begin-immediate'))
    try {
      validateSchemaForMutation(this.databaseConstructor, this.db, this.databasePath)
      const tailRows = this.tailRows(meta.id)
      const currentLast = this.logicalLastEvent(meta.id, tailRows)
      const expected = currentLast === undefined ? 0 : currentLast.seq + 1
      const first = events[0] as SessionEvent
      if (first.seq !== expected) {
        throw new Error(`session ${meta.id} append starts at seq ${first.seq}, stored next seq is ${expected}`)
      }
      if (!isMaterialized) this.writeRow(meta)

      const insert = this.insertStatement()
      for (const record of packChunkRuns(events)) this.insertRecord(insert, meta.id, bindRecord(record))
      this.incrementRevision(meta.id)
      this.db.exec(sql('commit'))
    } catch (error: unknown) {
      this.rollback(error, 'append')
    }
  }

  /**
   * Atomically import one legacy session through a bounded batch producer.
   * An existing identity is left untouched; a producer failure rolls back the
   * metadata row and every imported event so the next startup can retry.
   * @param meta - legacy session header.
   * @param produce - source reader that publishes contiguous event batches.
   * @returns whether this call imported the session.
   */
  async importSession(
    meta: SessionHeader,
    produce: (accept: (events: readonly SessionEvent[]) => Promise<void>) => Promise<void>,
  ): Promise<boolean> {
    await this.open()
    if (this.rowFor(meta.id) !== undefined) return false
    this.db.exec(sql('begin-immediate'))
    try {
      validateSchemaForMutation(this.databaseConstructor, this.db, this.databasePath)
      if (this.rowFor(meta.id) !== undefined) {
        this.db.exec(sql('rollback'))
        return false
      }
      this.writeRow(meta)
      const insert = this.insertStatement()
      let nextSeq = 0
      await produce((events) => {
        if (events.length === 0) return Promise.resolve()
        for (const [index, event] of events.entries()) {
          if (event.seq !== nextSeq + index) {
            throw new Error(
              `session ${meta.id} import expected seq ${nextSeq + index}, got ${event.seq}`,
            )
          }
        }
        for (const record of packChunkRuns(events)) this.insertRecord(insert, meta.id, bindRecord(record))
        nextSeq += events.length
        return Promise.resolve()
      })
      this.incrementRevision(meta.id)
      this.db.exec(sql('commit'))
      return true
    } catch (error: unknown) {
      this.rollback(error, 'import')
    }
  }

  async commitRepair(
    meta: SessionHeader,
    tornMarker: number | undefined,
    closers: readonly SessionEvent[],
  ): Promise<void> {
    await this.open()
    if (tornMarker === undefined && closers.length === 0) return
    this.db.exec(sql('begin-immediate'))
    try {
      validateSchemaForMutation(this.databaseConstructor, this.db, this.databasePath)
      const row = this.rowFor(meta.id)
      if (row === undefined) throw new Error(`session ${meta.id} metadata row is missing`)
      const currentRows = this.db.prepare(sql('select-events')).all(meta.id).map(decodeEventRow)
      const current = scanRows(currentRows)
      if (tornMarker !== undefined) {
        if (current.tornFrom !== tornMarker) {
          throw new Error(`session ${meta.id} repair is stale: physical tail no longer starts at seq ${tornMarker}`)
        }
        this.db.prepare(sql('delete-events-from'))
          .run(meta.id, tornMarker)
      } else if (current.tornFrom !== undefined) {
        throw new Error(`session ${meta.id} repair omitted current torn tail at seq ${current.tornFrom}`)
      }
      if (closers.length > 0) {
        const expected = current.preserved.at(-1)?.seq === undefined
          ? 0
          : (current.preserved.at(-1) as SessionEvent).seq + 1
        if (closers[0]?.seq !== expected) {
          throw new Error(`session ${meta.id} repair is stale: closer starts at seq ${closers[0]?.seq}, stored next seq is ${expected}`)
        }
        const insert = this.insertStatement()
        for (const closer of closers) this.insertRecord(insert, meta.id, bindRecord(closer))
      }
      this.incrementRevision(meta.id)
      this.db.exec(sql('commit'))
    } catch (error: unknown) {
      this.rollback(error, 'repair')
    }
  }

  async list(signal?: AbortSignal): Promise<SessionHeader[]> {
    await this.observe(signal)
    const rows = this.sessionRows()
    signal?.throwIfAborted()
    return rows.map(rowToMeta)
  }

  /**
   * Return every materialized header with its source-qualified revision.
   * @param signal - optional cancellation before or after the metadata query.
   * @returns stored headers and revisions without loading event rows.
   */
  async listSnapshots(signal?: AbortSignal): Promise<SessionPersistenceSnapshot[]> {
    await this.observe(signal)
    const rows = this.sessionRows()
    signal?.throwIfAborted()
    return rows.map(row => ({
      header: rowToMeta(row),
      revision: sqliteRevision(this.storeIdentity, row),
    }))
  }

  async close(): Promise<void> {
    if (this.ready === undefined) {
      if (this.pathReady !== undefined) await Promise.allSettled([this.pathReady])
      return
    }
    await Promise.allSettled([this.ready])
    if (!this.opened) return
    this.opened = false
    this.db.close()
  }

  private rowFor(id: SessionId): SessionRow | undefined {
    const value = this.db.prepare(sql('select-session')).get(id)
    return value === undefined ? undefined : decodeSessionRow(value)
  }

  private async observe(signal: AbortSignal | undefined): Promise<void> {
    signal?.throwIfAborted()
    await this.open()
    signal?.throwIfAborted()
  }

  private readTransaction<T>(read: () => T): T {
    this.db.exec(sql('begin'))
    try {
      const value = read()
      this.db.exec(sql('commit'))
      return value
    } catch (error: unknown) {
      this.rollback(error, 'read')
    }
  }

  private sessionRows(): SessionRow[] {
    return this.db.prepare(sql('select-sessions')).all().map(decodeSessionRow)
  }

  private rollback(error: unknown, operation: string): never {
    try {
      this.db.exec(sql('rollback'))
    } catch (rollbackError: unknown) {
      /* v8 ignore next -- requires SQLite to fail both an operation and its immediate rollback. */
      throw new AggregateError([error, rollbackError], `${this.name} ${operation} failed and rollback also failed`)
    }
    throw error
  }

  private incrementRevision(id: SessionId): void {
    const updated = this.db.prepare(sql('update-session-revision'))
      .run(id)
    /* v8 ignore next -- materialized writes follow coordinator create(); other writes upsert in this transaction. */
    if (Number(updated.changes) !== 1) throw new Error(`session ${id} metadata row is missing`)
  }

  private tailRows(id: SessionId): EventRow[] {
    const tail = this.db.prepare(sql('select-tail-events')).all(id, 2).map(decodeEventRow).reverse()
    if (tail.length === 0) return []
    return this.physicalSpanFrom(id, (tail[0] as EventRow).seq).eventRows
  }

  /** Select the bounded physical span that may represent `fromSeq`. */
  private physicalSpanFrom(
    id: SessionId,
    fromSeq: number,
  ): { readonly base: number; readonly eventRows: EventRow[] } {
    const packedFloor = Math.max(0, fromSeq - MAX_PACKED_ROW_MEMBERS + 1)
    const packedPredecessors = this.db.prepare(sql('select-packed-predecessors'))
      .all(id, packedFloor, fromSeq)
      .map(decodeEventRow)
    let base = fromSeq
    for (const predecessor of packedPredecessors) {
      try {
        const last = decodeRow(predecessor).at(-1)
        if (last !== undefined && last.seq >= fromSeq) base = Math.min(base, predecessor.seq)
      } catch {
        // A malformed bounded predecessor may cover fromSeq; include it so the scanner fails closed.
        base = Math.min(base, predecessor.seq)
      }
    }
    const eventRows = this.db.prepare(sql('select-events-from')).all(id, base).map(decodeEventRow)
    return { base, eventRows }
  }

  /** Select the bounded physical span that may represent one logical interval. */
  private physicalSpanRange(
    id: SessionId,
    fromSeq: number,
    toSeq: number,
  ): { readonly base: number; readonly eventRows: EventRow[] } {
    const packedFloor = Math.max(0, fromSeq - MAX_PACKED_ROW_MEMBERS + 1)
    const packedPredecessors = this.db.prepare(sql('select-packed-predecessors'))
      .all(id, packedFloor, fromSeq)
      .map(decodeEventRow)
    let base = fromSeq
    for (const predecessor of packedPredecessors) {
      try {
        const last = decodeRow(predecessor).at(-1)
        if (last !== undefined && last.seq >= fromSeq) base = Math.min(base, predecessor.seq)
      } catch {
        // A malformed bounded predecessor may cover fromSeq; include it so the scanner fails closed.
        base = Math.min(base, predecessor.seq)
      }
    }
    const eventRows = this.db.prepare(sql('select-events-range')).all(id, base, toSeq).map(decodeEventRow)
    return { base, eventRows }
  }

  private logicalLastEvent(id: SessionId, tailRows: readonly EventRow[]): SessionEvent | undefined {
    if (tailRows.length === 0) return undefined
    const { preserved, tornFrom } = scanRows(tailRows, (tailRows[0] as EventRow).seq)
    if (tornFrom !== undefined) throw new Error(`session ${id} has an invalid physical tail at seq ${tornFrom}`)
    return preserved.at(-1)
  }

  private insertStatement(): StatementSync {
    return this.db.prepare(sql('insert-event'))
  }

  private insertRecord(insert: StatementSync, id: SessionId, record: BoundRecord): void {
    insert.run(
      id,
      record.seq,
      record.type,
      record.time,
      record.data,
      record.sourceEventSeqs,
      record.surfaceOp,
      record.ignorable,
    )
  }

  private writeRow(meta: SessionHeader): void {
    this.db.prepare(sql('upsert-session')).run(
      meta.id,
      meta.version,
      meta.createdAt,
      meta.cwd ?? null,
      meta.parentSession ?? null,
      meta.seedLength ?? null,
      meta.origin ?? null,
      meta.delegationDepth ?? null,
      meta.agentPreset ?? null,
      randomUUID(),
    )
  }
}

function sqliteRevision(storeIdentity: string, row: SessionRow): PersistenceRevision {
  return SessionPersistenceRevision(
    `${storeIdentity}:incarnation:${row.incarnation}:revision:${row.revision}`,
  )
}

async function createDatabaseFile(path: string): Promise<void> {
  try {
    const handle = await open(path, 'wx', 0o600)
    await handle.close()
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
}

async function validateParentDirectory(path: string): Promise<void> {
  const parent = await lstat(path)
  if (parent.isSymbolicLink() || !parent.isDirectory()) {
    throw new Error(`session database parent "${path}" must be a real directory`)
  }
  const uid = process.getuid?.()
  /* v8 ignore start -- Windows exposes neither process.getuid nor meaningful
   * uid/mode bits; POSIX tests cover owner and mode rejection. */
  if (uid !== undefined && (parent.uid !== uid || (parent.mode & 0o022) !== 0)) {
    throw new Error(`session database parent "${path}" must be owned by the current user and not group/world-writable`)
  }
  /* v8 ignore stop */
}

async function validateDatabaseFile(path: string): Promise<void> {
  const file = await lstat(path)
  if (file.isSymbolicLink() || !file.isFile()) {
    throw new Error(`session database "${path}" must be a regular file, not a symbolic link`)
  }
  const uid = process.getuid?.()
  /* v8 ignore start -- Windows exposes neither process.getuid nor meaningful
   * uid/mode bits; POSIX tests cover owner and mode rejection. */
  if (uid !== undefined && (file.uid !== uid || (file.mode & 0o077) !== 0)) {
    throw new Error(`session database "${path}" must be owned by the current user and accessible only by that user`)
  }
  /* v8 ignore stop */
}

async function validateDatabaseFileIfPresent(path: string): Promise<void> {
  try {
    await validateDatabaseFile(path)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

let nodeSqlite: Promise<typeof import('node:sqlite')> | undefined

/** Load Node SQLite once so concurrent stores share one warning-filter lifetime. */
function loadNodeSqlite(): Promise<typeof import('node:sqlite')> {
  nodeSqlite ??= importNodeSqlite()
  return nodeSqlite
}

/** Import Node 22's SQLite dependency without its process-wide experimental warning. */
async function importNodeSqlite(): Promise<typeof import('node:sqlite')> {
  const emitWarning = Reflect.get(process, 'emitWarning')
  /* v8 ignore start -- Node 22 alone emits this warning; primary coverage runs on Node 24. */
  const filteredEmitWarning = (warning: string | Error, ...args: unknown[]): void => {
    const message = warning instanceof Error ? warning.message : warning
    const first = args[0]
    const type = warning instanceof Error
      ? warning.name
      : typeof first === 'string'
        ? first
        : typeof first === 'object' && first !== null && 'type' in first
          ? first.type
          : undefined
    if (message === 'SQLite is an experimental feature and might change at any time'
      && type === 'ExperimentalWarning') return
    Reflect.apply(emitWarning, process, [warning, ...args])
  }
  Reflect.set(process, 'emitWarning', filteredEmitWarning)
  try {
    return await import('node:sqlite')
  } finally {
    Reflect.set(process, 'emitWarning', emitWarning)
  }
  /* v8 ignore stop */
}
