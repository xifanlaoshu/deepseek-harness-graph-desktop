/**
 * Durable session-persistence Service Definition (`ctx.sessionPersistence`). Backends store
 * {@link SessionEvent}s as the event-sourced log and carry non-replayable
 * {@link SessionHeader} metadata separately.
 * @module @deepseek-ai/dsh-session-persistence
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { SessionPreparation } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionId, SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionPersistenceRevision } from './revision.ts'

// Re-export the metadata vocabulary so Consumers import it from the Service Definition.
export type { SessionHeader } from '@deepseek-ai/dsh-session'
export { SessionPersistenceRevision } from './revision.ts'

/** Lightweight immutable source identity returned without loading a full log. */
export interface SessionPersistenceSnapshot {
  /** Detached metadata for one materialized session. */
  header: SessionHeader
  /** Opaque source-qualified token that changes whenever this stored log changes. */
  revision: SessionPersistenceRevision
}

/** Immutable logical session prepared from persistence or a live owner. */
export interface SessionInspection {
  /** Validated immutable session metadata. */
  readonly meta: SessionHeader
  /** Validated contiguous logical event log. */
  readonly events: readonly SessionEvent[]
}

/** A backend's own raw artifact text for one session, verbatim. */
export interface SessionRawArtifact {
  /** The session header parsed from the artifact's own first line. */
  readonly meta: SessionHeader
  /** The artifact's base filename on disk, without any physical encoding suffix. */
  readonly filename: string
  /** The artifact's full text content, decoded from the backend's physical encoding. */
  readonly content: string
}

/** Bounds for a durable event-range read. */
export interface SessionEventRangeRequest {
  /** First logical sequence included in the result. */
  readonly fromSeq: number
  /** First logical sequence excluded from the result; omission reads through the durable tail. */
  readonly toSeq?: number
}

/** Index-only lookup for logical event positions. */
export interface SessionEventSequenceRequest {
  /** Event discriminants to match. */
  readonly types: readonly string[]
  /** First logical sequence excluded while scanning backward; omission starts after the durable tail. */
  readonly beforeSeq?: number
  /** Restrict matching surface events to append-origin records. */
  readonly surfaceOp?: 'append'
  /** Maximum matching positions returned. */
  readonly limit: number
}

/** Newest-first selection limits for a detached event page. */
export interface SessionEventPageRequest {
  /** First logical sequence eligible for the page. */
  readonly fromSeq: number
  /** First logical sequence excluded; omission starts after the durable tail. */
  readonly beforeSeq?: number
  /** Event-type prefixes omitted before payload decoding where the backend supports it. */
  readonly excludeTypePrefixes: readonly string[]
  /** Maximum logical events returned. */
  readonly maxEvents: number
  /** Soft maximum UTF-8 JSON bytes returned; one event may exceed it so pagination always advances. */
  readonly maxBytes: number
}

/** One bounded detached event page in ascending sequence order. */
export interface SessionEventPage {
  /** Persisted session metadata. */
  readonly meta: SessionHeader
  /** Selected events in ascending logical sequence order. */
  readonly events: SessionEvent[]
  /** Whether another matching event exists before this page within the requested interval. */
  readonly hasMore: boolean
}

// The backend-agnostic write-path orchestration first-party backends compose.
export {
  DEFAULT_PREPARED_SESSION_CACHE_SIZE,
  DEFAULT_WRITE_BATCH_MAX_DELAY_MS,
  MAX_WRITE_BATCH_DELAY_MS,
  PersistenceCoordinator,
  SessionFormatUnsupportedError,
  SessionPersistenceCorruptionError,
  sessionFormatVersionRefusal,
} from './coordinator.ts'
export type {
  PersistenceBackend,
  PersistenceCoordinatorOptions,
  StoredPrefix,
  StoredSuffix,
} from './coordinator.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionPersistence: SessionPersistence
  }
}

/**
 * A backend-resolved, per-session local artifact location. The path is an
 * absolute target path and can name an artifact that has not materialized yet.
 * Consumers must treat it as a location hint, never as an authorization token.
 */
export interface SessionLocation {
  /** Backend-specific artifact kind, for example `jsonl`. */
  readonly kind: string
  /** Absolute path to this session's backend-owned artifact. */
  readonly path: string
}

/**
 * Durable append-only session storage. Implementations preserve contiguous,
 * losslessly JSON-serializable events; {@link append} resolves only after
 * durability, and {@link load} balances a complete interrupted tail without
 * rewriting committed events.
 */
export abstract class SessionPersistence extends Service {
  constructor(ctx: Context) {
    super(ctx, 'sessionPersistence')
  }

  /**
   * Resolve this backend's independent local artifact for a session without
   * reading, creating, flushing, or otherwise materializing it. Backends such
   * as SQLite that do not own one artifact per session return `undefined`.
   * @param meta - the immutable session header whose artifact is requested.
   * @returns the backend-specific absolute location, when one exists.
   */
  abstract locate(meta: SessionHeader): SessionLocation | undefined

  /**
   * Whether this backend exposes one verbatim raw artifact per session.
   * A backend that declares `true` must override {@link readRaw}.
   */
  abstract readonly supportsRawArtifacts: boolean

  /**
   * Read a session's backend-owned artifact text verbatim — the exact durable
   * bytes the backend wrote (decoded from its physical encoding, e.g. a
   * decompressed JSONL). The returned `content` is the raw text, not a
   * reconstruction from parsed events, so it preserves backend-specific
   * serialization (chunk packing, key order, line breaks). Callers first test
   * {@link supportsRawArtifacts}; `undefined` then means only that the requested
   * session has no materialized artifact.
   * @param _id - the persisted session to read (unused by the default: no
   * per-session artifact).
   * @param signal - optional cancellation for backend read work.
   * @returns the raw artifact plus its parsed header, or `undefined` when the
   * session is absent.
   * @throws when this backend does not expose per-session raw artifacts.
   */
  readRaw(_id: SessionId, signal?: AbortSignal): Promise<SessionRawArtifact | undefined> {
    if (signal?.aborted === true) {
      return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
    }
    return Promise.reject(new Error('this session persistence backend does not expose raw artifacts'))
  }

  /**
   * Register a new session's metadata. A backend MAY defer the physical write
   * until the first {@link append} (lazy materialization), in which case a
   * created-but-never-appended session is absent from {@link list}
   * — abandoned sessions leave nothing behind.
   * @param meta - the immutable header (id, version, cwd, lineage) to record.
   */
  abstract create(meta: SessionHeader): Promise<void>

  /**
   * Durably persist a batch of events. Honors the append-only and contiguous-
   * seq contracts: the first event's `seq` MUST equal the stored next-seq
   * (after `load` has durably closed any interrupted turn). Rejects non-JSON-
   * serializable `event.data` with an error naming the offending event type.
   * @param id - the session the batch belongs to.
   * @param events - the contiguous batch to persist, in seq order.
   */
  abstract append(id: SessionId, events: readonly SessionEvent[]): Promise<void>

  /**
   * Prepare the exact unpublished Session used by resume. Implementations may
   * reuse object graphs retained by an earlier {@link inspect} after confirming
   * their durable revision is still current; disposal releases an unpublished
   * reservation. Revision retries require the durable log to remain unchanged
   * for one read/check round trip; continuous external writers may delay completion.
   * @param id - persisted session to prepare.
   * @param signal - optional cancellation for preparation work.
   * @returns one owned unpublished Session preparation.
   */
  async prepare(id: SessionId, signal?: AbortSignal): Promise<SessionPreparation> {
    signal?.throwIfAborted()
    const loaded = await this.load(id)
    signal?.throwIfAborted()
    const sessions = this.ctx.get('sessions')
    if (sessions === undefined) {
      throw new Error('cannot prepare a session: SessionStore is not configured')
    }
    return SessionPreparation.create(sessions.prepare(id, {
      seed: loaded.events.map(event => structuredClone(event)),
      meta: structuredClone(loaded.meta),
      seedSource: 'persistence',
    }))
  }

  /**
   * Load an immutable balanced logical view and commit any required cold
   * recovery. A complete interrupted final turn is preserved and durably
   * closed with missing tool errors plus any open step and turn boundaries;
   * only a torn final record is discarded. Unknown versions and corruption in
   * the committed prefix reject. Implementations MUST NOT crash-repair an
   * identity still bound to a live Session: a balanced live log may return as a
   * durable snapshot, while an open live turn rejects. Returned values may be
   * shared with immutable live or prepared state and must not be mutated.
   * Revision-based implementations may wait for one stable read/check round trip.
   * @param id - the persisted session to reload.
   * @returns the header and a log ending on a balanced `turn/end`.
   */
  abstract load(id: SessionId): Promise<SessionInspection>

  /**
   * Inspect an immutable logical session without committing recovery or
   * publishing it. A cold complete interrupted turn receives synthetic closers
   * in memory and a torn physical tail remains untouched. An already-live
   * Session instead yields its current immutable snapshot, which may contain an
   * open turn and its `session/end-seed` boundary. Coordinator-backed
   * implementations retain the exact cold unpublished Session for bounded
   * reuse by a later {@link prepare}. A stale ready source is reloaded; a source
   * already committing or reserved for resume remains exclusive, and inspection
   * may borrow its immutable view. Callers borrow only the immutable header and
   * log. Continuous external writers may delay revision convergence.
   * @param id - the persisted session to inspect.
   * @param signal - optional cancellation for queued and backend read work.
   * @returns the validated header and current logical event log.
   */
  abstract inspect(id: SessionId, signal?: AbortSignal): Promise<SessionInspection>

  /**
   * Read the stored events from `fromSeq` onward — the read-from-seq
   * primitive for read models that resume from a watermark (e.g. a persisted
   * projection cache folding only the tail past its checkpoint). Unlike
   * {@link inspect}, it is a detached physical suffix read: no preparation
   * cache, torn-tail truncation, synthetic closers, or coordinator-state
   * publication. Only events from the valid contiguous stored prefix are
   * returned, so a torn fragment never reaches the caller. `fromSeq` at or
   * beyond the stored prefix returns an empty event list (never an error).
   * Backends whose medium can seek by seq
   * (SQLite) read only the suffix; sequential media (JSONL, both encodings)
   * still parse the whole artifact and skip forward — the primitive bounds
   * what is RETURNED and refolded, not every backend's physical read.
   * @param id - the persisted session to read.
   * @param fromSeq - first event seq to include; a non-negative safe integer.
   * @param signal - optional cancellation for queued and backend read work.
   * @returns the header and the stored events with `seq >= fromSeq`.
   */
  abstract readFrom(id: SessionId, fromSeq: number, signal?: AbortSignal):
  Promise<{ meta: SessionHeader; events: SessionEvent[] }>

  /**
   * Read one bounded contiguous logical event interval without preparing or
   * publishing a Session. Backends with range indexes override this method;
   * the default preserves correctness by filtering one immutable inspection.
   * @param id - persisted session to read.
   * @param request - inclusive start and optional exclusive end sequence.
   * @param signal - optional cancellation for queued and backend read work.
   * @returns stored header and events within the requested interval.
   */
  async readRange(
    id: SessionId,
    request: SessionEventRangeRequest,
    signal?: AbortSignal,
  ): Promise<{ meta: SessionHeader; events: SessionEvent[] }> {
    validateSessionEventRangeRequest(request)
    const inspected = await this.inspect(id, signal)
    signal?.throwIfAborted()
    return {
      meta: inspected.meta,
      events: inspected.events.filter(event => event.seq >= request.fromSeq
        && (request.toSeq === undefined || event.seq < request.toSeq)),
    }
  }

  /**
   * Find matching logical event positions in newest-first order without
   * returning payloads. Backends with metadata indexes override this method;
   * the default scans one immutable inspection.
   * @param id - persisted session to search.
   * @param request - event types, exclusive upper sequence, and result bound.
   * @param signal - optional cancellation for queued and backend read work.
   * @returns stored header and newest-first matching sequence numbers.
   */
  async findEventSequences(
    id: SessionId,
    request: SessionEventSequenceRequest,
    signal?: AbortSignal,
  ): Promise<{ meta: SessionHeader; sequences: number[] }> {
    validateSessionEventSequenceRequest(request)
    const inspected = await this.inspect(id, signal)
    signal?.throwIfAborted()
    const accepted = new Set(request.types)
    return {
      meta: inspected.meta,
      sequences: inspected.events
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

  /**
   * Read the newest event page that satisfies explicit event-count and
   * serialized-byte budgets. Backends with indexed filtering override this
   * method so excluded domains are never decoded; the default preserves the
   * result contract over one immutable inspection.
   * @param id - persisted session to read.
   * @param request - sequence interval, excluded prefixes, and page budgets.
   * @param signal - optional cancellation for queued and backend read work.
   * @returns one ascending page plus whether an older matching event remains.
   */
  async readEventPage(
    id: SessionId,
    request: SessionEventPageRequest,
    signal?: AbortSignal,
  ): Promise<SessionEventPage> {
    validateSessionEventPageRequest(request)
    const inspected = await this.inspect(id, signal)
    signal?.throwIfAborted()
    const selected = selectSessionEventPage(inspected.events, request)
    return { meta: inspected.meta, ...selected }
  }

  /**
   * Lightweight listing from metadata, without a full-log parse.
   * @param signal - optional cancellation for backend listing work.
   * @returns one header per materialized session.
   */
  abstract list(signal?: AbortSignal): Promise<SessionHeader[]>

  /**
   * List materialized sessions with cheap per-log change tokens.
   *
   * Repeated observations of an unchanged log return the same revision. A
   * successful mutating {@link load} repair changes the next listed revision.
   * Revisions also distinguish independently backed stores so backend-local
   * counters cannot compare equal across different persistence sources.
   * @param signal - optional cancellation for backend snapshot-listing work.
   * @returns one header and opaque revision per materialized session without loading full logs.
   */
  abstract listSnapshots(signal?: AbortSignal): Promise<SessionPersistenceSnapshot[]>
}

/**
 * Validate one bounded event-range request at a provider boundary.
 * @param request - range request to validate.
 */
export function validateSessionEventRangeRequest(request: SessionEventRangeRequest): void {
  if (!Number.isSafeInteger(request.fromSeq) || request.fromSeq < 0
    || (request.toSeq !== undefined
      && (!Number.isSafeInteger(request.toSeq) || request.toSeq < request.fromSeq))) {
    throw new RangeError('session event range requires non-negative safe integers with toSeq at or after fromSeq')
  }
}

/**
 * Validate one event-position query at a provider boundary.
 * @param request - sequence query to validate.
 */
export function validateSessionEventSequenceRequest(request: SessionEventSequenceRequest): void {
  if (request.types.length === 0 || request.types.some(type => type.trim().length === 0)
    || !Number.isSafeInteger(request.limit) || request.limit < 1
    || (request.beforeSeq !== undefined
      && (!Number.isSafeInteger(request.beforeSeq) || request.beforeSeq < 0))) {
    throw new RangeError('session event sequence query requires event types, a positive safe limit, and an optional non-negative beforeSeq')
  }
}

/**
 * Validate one detached event-page request at a provider boundary.
 * @param request - page request to validate.
 */
export function validateSessionEventPageRequest(request: SessionEventPageRequest): void {
  if (!Number.isSafeInteger(request.fromSeq) || request.fromSeq < 0
    || (request.beforeSeq !== undefined
      && (!Number.isSafeInteger(request.beforeSeq) || request.beforeSeq < request.fromSeq))
    || request.excludeTypePrefixes.some(prefix => prefix.length === 0)
    || !Number.isSafeInteger(request.maxEvents) || request.maxEvents < 1
    || !Number.isSafeInteger(request.maxBytes) || request.maxBytes < 1) {
    throw new RangeError('session event page requires a valid interval, non-empty excluded prefixes, and positive safe budgets')
  }
}

/**
 * Select the newest bounded logical page from an already materialized event set.
 * @param events - immutable logical events.
 * @param request - validated event-page request.
 * @returns ascending selected events and an older-match indicator.
 */
export function selectSessionEventPage(
  events: readonly SessionEvent[],
  request: SessionEventPageRequest,
): Pick<SessionEventPage, 'events' | 'hasMore'> {
  validateSessionEventPageRequest(request)
  const selected: SessionEvent[] = []
  const encoder = new TextEncoder()
  let bytes = 0
  let hasMore = false
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as SessionEvent
    if (event.seq < request.fromSeq
      || (request.beforeSeq !== undefined && event.seq >= request.beforeSeq)
      || request.excludeTypePrefixes.some(prefix => event.type.startsWith(prefix))) continue
    const eventBytes = encoder.encode(JSON.stringify(event)).byteLength
    if (selected.length >= request.maxEvents
      || (selected.length > 0 && bytes + eventBytes > request.maxBytes)) {
      hasMore = true
      break
    }
    selected.push(event)
    bytes += eventBytes
  }
  selected.reverse()
  return { events: selected, hasMore }
}

export default SessionPersistence
