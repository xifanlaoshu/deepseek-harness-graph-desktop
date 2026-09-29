/** Durable local projection for LoopX graph-coordination events. @module */

import { mkdirSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import type { GraphActivationId } from '@deepseek-ai/dsh-graph'
import type {
  GraphCoordinationClaim,
  GraphCoordinationEvent,
  GraphCoordinationSettlement,
} from '@deepseek-ai/dsh-graph-coordination'

const APPLICATION_ID = 0x4453474c
const SCHEMA_VERSION = 2

const claimSchema = z.object({
  claimId: z.string().min(1),
  todoId: z.string().min(1),
  leaseId: z.string().min(1),
  expiresAt: z.number(),
  fencingToken: z.number().int().positive(),
  observation: z.string(),
})

const eventSchema = z.object({
  id: z.string().min(1),
  cursor: z.string().min(1),
  kind: z.enum(['claimed', 'heartbeat', 'progress', 'cancel-requested', 'terminal']),
  at: z.number(),
  sequence: z.number().int().optional(),
  evidence: z.string().optional(),
})

const terminalSchema = z.object({
  outcome: z.enum(['succeeded', 'failed', 'blocked', 'skipped', 'canceled', 'exhausted', 'uncertain']),
  evidence: z.string(),
  settlementId: z.string().min(1),
})

type TerminalState = z.infer<typeof terminalSchema>
type SqlValue = string | number | null
type SqlRow = Record<string, SqlValue>

/** State restored before a Provider operation touches one coordination activation. */
export interface LoopxJournalSnapshot {
  readonly claim?: GraphCoordinationClaim
  readonly owner?: string
  readonly terminal?: TerminalState
  readonly cancelReason?: string
  readonly progress: ReadonlyMap<number, string>
  readonly events: readonly GraphCoordinationEvent[]
  /** Whether older audit events exist outside the returned runtime window. */
  readonly compacted: boolean
}

const row = (value: unknown): SqlRow => value as SqlRow
const optionalText = (value: SqlValue | undefined, subject: string): string | undefined => {
  if (value === null || value === undefined) return undefined
  if (typeof value !== 'string') throw new Error(`${subject} must be SQLite text`)
  return value
}
const requiredNumber = (value: SqlValue | undefined, subject: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${subject} must be a finite SQLite number`)
  return value
}
const parseJson = <T>(text: string | undefined, subject: string, schema: z.ZodType<T>): T | undefined => {
  if (text === undefined) return undefined
  try {
    return schema.parse(JSON.parse(text))
  } catch (error) {
    throw new Error(`LoopX coordination journal has invalid ${subject}`, { cause: error })
  }
}

/** SQLite journal that preserves one goal's ordered public-safe event projection. */
export class LoopxCoordinationJournal {
  private readonly db: DatabaseSync
  private closed = false

  /** Open and validate one journal file or an isolated `:memory:` database. */
  constructor(
    private readonly goalId: string,
    /** Absolute file path or `:memory:` for the journal database. */
    readonly path: string,
    busyTimeoutMs: number,
    journalMode: 'wal' | 'delete' | 'truncate',
    private readonly eventWindow: number,
  ) {
    if (path !== ':memory:' && !isAbsolute(path)) throw new Error('LoopX coordination journal path must be absolute or :memory:')
    if (!Number.isSafeInteger(eventWindow) || eventWindow < 1) throw new Error('LoopX coordination journal eventWindow must be positive')
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    try {
      this.open(busyTimeoutMs, journalMode)
    } catch (error) {
      this.db.close()
      throw error
    }
  }

  /**
   * Load and validate the complete bounded projection for one coordination activation.
   * @param activationId - stable Graph coordination activation identity.
   * @returns retained event suffix plus complete claim, progress, cancellation, and terminal state.
   */
  load(activationId: GraphActivationId): LoopxJournalSnapshot {
    this.assertOpen()
    const stateValue = this.db.prepare('SELECT * FROM graph_loopx_activation_state WHERE goal_id = ? AND activation_id = ?').get(this.goalId, activationId)
    const state = stateValue === undefined ? undefined : row(stateValue)
    const progress = new Map<number, string>()
    const progressCursors = new Map<number, string>()
    for (const value of this.db.prepare('SELECT sequence, evidence, cursor FROM graph_loopx_progress WHERE goal_id = ? AND activation_id = ? ORDER BY sequence').all(this.goalId, activationId)) {
      const item = row(value)
      const sequence = requiredNumber(item.sequence, 'progress sequence')
      const evidence = optionalText(item.evidence, 'progress evidence')
      const cursor = optionalText(item.cursor, 'progress cursor')
      if (!Number.isSafeInteger(sequence) || sequence < 1 || evidence === undefined || cursor === undefined) throw new Error('LoopX coordination journal has invalid progress state')
      progress.set(sequence, evidence)
      progressCursors.set(sequence, cursor)
    }
    const total = requiredNumber(row(this.db.prepare('SELECT COUNT(*) AS count FROM graph_loopx_events WHERE goal_id = ? AND activation_id = ?')
      .get(this.goalId, activationId)).count, 'event count')
    const eventRows = this.db.prepare('SELECT ordinal, event_json FROM graph_loopx_events WHERE goal_id = ? AND activation_id = ? ORDER BY ordinal DESC LIMIT ?')
      .all(this.goalId, activationId, this.eventWindow)
      .reverse()
    const events = eventRows.map((value, index) => {
      const item = row(value)
      const ordinal = requiredNumber(item.ordinal, 'event ordinal')
      const event = parseJson(optionalText(item.event_json, 'event JSON'), 'event', eventSchema) as GraphCoordinationEvent
      if (event.cursor !== String(ordinal)) throw new Error('LoopX coordination journal event cursor differs from its ordinal')
      if (index > 0 && ordinal !== requiredNumber(row(eventRows[index - 1]).ordinal, 'previous event ordinal') + 1) {
        throw new Error('LoopX coordination journal has a non-contiguous retained event window')
      }
      return event
    })
    for (const [sequence, evidence] of progress) {
      const cursor = progressCursors.get(sequence)
      const retained = events.find(item => item.cursor === cursor)
      const stored = retained === undefined && cursor !== undefined
        ? this.db.prepare('SELECT event_json FROM graph_loopx_events WHERE goal_id = ? AND activation_id = ? AND ordinal = ?')
          .get(this.goalId, activationId, Number.parseInt(cursor, 10))
        : undefined
      const event = retained ?? (stored === undefined
        ? undefined
        : parseJson(optionalText(row(stored).event_json, 'progress event JSON'), 'progress event', eventSchema))
      if (event?.kind !== 'progress' || event.sequence !== sequence || event.evidence !== evidence) {
        throw new Error(`LoopX coordination journal progress ${String(sequence)} has no matching event`)
      }
    }
    const claim = state === undefined
      ? undefined
      : parseJson(optionalText(state.claim_json, 'claim JSON'), 'claim', claimSchema)
    const owner = state === undefined ? undefined : optionalText(state.owner, 'claim owner')
    const terminal = state === undefined
      ? undefined
      : parseJson(optionalText(state.terminal_json, 'terminal JSON'), 'terminal', terminalSchema)
    const cancelReason = state === undefined ? undefined : optionalText(state.cancel_reason, 'cancel reason')
    return {
      ...claim === undefined ? {} : { claim },
      ...owner === undefined ? {} : { owner },
      ...terminal === undefined ? {} : { terminal },
      ...cancelReason === undefined ? {} : { cancelReason },
      progress,
      events,
      compacted: total > events.length,
    }
  }

  /**
   * Return the original cursor for an exact progress replay, including a compacted event.
   * @param activationId - stable Graph coordination activation identity.
   * @param sequence - positive progress sequence to replay.
   * @param evidence - exact evidence previously stored at that sequence.
   * @returns the durable event cursor first assigned to that progress record.
   */
  progressCursor(activationId: GraphActivationId, sequence: number, evidence: string): string {
    this.assertOpen()
    const value = this.db.prepare('SELECT evidence, cursor FROM graph_loopx_progress WHERE goal_id = ? AND activation_id = ? AND sequence = ?')
      .get(this.goalId, activationId, sequence)
    if (value === undefined) throw new Error(`LoopX progress sequence ${String(sequence)} is absent`)
    const item = row(value)
    const prior = optionalText(item.evidence, 'progress evidence')
    const cursor = optionalText(item.cursor, 'progress cursor')
    if (prior !== evidence) throw new Error(`LoopX progress sequence ${String(sequence)} conflicts`)
    if (cursor === undefined) throw new Error(`LoopX progress sequence ${String(sequence)} has no cursor`)
    return cursor
  }

  /**
   * Persist a fresh or recovered claim together with its stable claimed event.
   * @param activationId - stable Graph coordination activation identity.
   * @param claim - current fenced LoopX claim.
   * @param owner - Graph caller identity holding the claim.
   * @param at - event timestamp in Unix milliseconds.
   * @returns the existing or newly appended claimed event.
   */
  recordClaim(activationId: GraphActivationId, claim: GraphCoordinationClaim, owner: string, at = Date.now()): GraphCoordinationEvent {
    return this.transaction(() => {
      this.ensureActivation(activationId)
      this.db.prepare('UPDATE graph_loopx_activation_state SET claim_json = ?, owner = ? WHERE goal_id = ? AND activation_id = ?')
        .run(JSON.stringify(claim), owner, this.goalId, activationId)
      return this.append(activationId, `claimed:${claim.claimId}:${String(claim.fencingToken)}`, { kind: 'claimed', at })
    })
  }

  /**
   * Persist a renewed fenced claim and one event per externally visible lease version.
   * @param activationId - stable Graph coordination activation identity.
   * @param claim - renewed fenced LoopX claim.
   * @param sequence - optional external heartbeat sequence.
   * @param at - event timestamp in Unix milliseconds.
   * @returns the existing or newly appended heartbeat event.
   */
  recordHeartbeat(
    activationId: GraphActivationId,
    claim: GraphCoordinationClaim,
    sequence?: number,
    at = Date.now(),
  ): GraphCoordinationEvent {
    return this.transaction(() => {
      this.ensureActivation(activationId)
      this.db.prepare('UPDATE graph_loopx_activation_state SET claim_json = ? WHERE goal_id = ? AND activation_id = ?')
        .run(JSON.stringify(claim), this.goalId, activationId)
      return this.append(activationId, `heartbeat:${claim.leaseId}`, {
        kind: 'heartbeat',
        at,
        ...sequence === undefined ? {} : { sequence },
      })
    })
  }

  /**
   * Persist one exact progress sequence and reject a conflicting replay.
   * @param activationId - stable Graph coordination activation identity.
   * @param sequence - positive progress sequence.
   * @param evidence - bounded public-safe progress evidence.
   * @param at - event timestamp in Unix milliseconds.
   * @returns the existing or newly appended progress event.
   */
  recordProgress(activationId: GraphActivationId, sequence: number, evidence: string, at = Date.now()): GraphCoordinationEvent {
    return this.transaction(() => {
      this.ensureActivation(activationId)
      const priorValue = this.db.prepare('SELECT evidence FROM graph_loopx_progress WHERE goal_id = ? AND activation_id = ? AND sequence = ?')
        .get(this.goalId, activationId, sequence)
      if (priorValue !== undefined) {
        const prior = optionalText(row(priorValue).evidence, 'progress evidence')
        if (prior !== evidence) throw new Error(`LoopX progress sequence ${String(sequence)} conflicts`)
        return this.existingEvent(activationId, `progress:${String(sequence)}`)
      }
      const event = this.append(activationId, `progress:${String(sequence)}`, { kind: 'progress', at, sequence, evidence })
      this.db.prepare('INSERT INTO graph_loopx_progress(goal_id, activation_id, sequence, evidence, cursor) VALUES(?, ?, ?, ?, ?)')
        .run(this.goalId, activationId, sequence, evidence, event.cursor)
      return event
    })
  }

  /**
   * Persist one cooperative cancellation request and its ordered event.
   * @param activationId - stable Graph coordination activation identity.
   * @param reason - bounded cancellation reason.
   * @param sequence - external cancellation sequence retained in the event.
   * @param at - event timestamp in Unix milliseconds.
   * @returns the existing or newly appended cancellation event.
   */
  recordCancellation(activationId: GraphActivationId, reason: string, sequence: number, at = Date.now()): GraphCoordinationEvent {
    return this.transaction(() => {
      this.ensureActivation(activationId)
      const current = this.db.prepare('SELECT cancel_reason FROM graph_loopx_activation_state WHERE goal_id = ? AND activation_id = ?').get(this.goalId, activationId)
      const prior = current === undefined ? undefined : optionalText(row(current).cancel_reason, 'cancel reason')
      if (prior !== undefined && prior !== reason) throw new Error('LoopX claim already has a different cancellation reason')
      this.db.prepare('UPDATE graph_loopx_activation_state SET cancel_reason = ? WHERE goal_id = ? AND activation_id = ?')
        .run(reason, this.goalId, activationId)
      return this.append(activationId, 'cancel-requested', { kind: 'cancel-requested', at, sequence, evidence: reason })
    })
  }

  /**
   * Persist one exact settlement and its terminal event.
   * @param activationId - stable Graph coordination activation identity.
   * @param terminal - exact terminal outcome, evidence, and settlement identity.
   * @param at - event timestamp in Unix milliseconds.
   * @returns the existing or newly appended terminal event.
   */
  recordTerminal(activationId: GraphActivationId, terminal: TerminalState, at = Date.now()): GraphCoordinationEvent {
    return this.transaction(() => {
      this.ensureActivation(activationId)
      const current = this.db.prepare('SELECT terminal_json FROM graph_loopx_activation_state WHERE goal_id = ? AND activation_id = ?').get(this.goalId, activationId)
      const prior = current === undefined
        ? undefined
        : parseJson(optionalText(row(current).terminal_json, 'terminal JSON'), 'terminal', terminalSchema)
      if (prior !== undefined && JSON.stringify(prior) !== JSON.stringify(terminal)) {
        throw new Error(`LoopX graph activation ${activationId} already has a conflicting settlement`)
      }
      this.db.prepare('UPDATE graph_loopx_activation_state SET terminal_json = ? WHERE goal_id = ? AND activation_id = ?')
        .run(JSON.stringify(terminal), this.goalId, activationId)
      return this.append(activationId, `terminal:${terminal.settlementId}`, { kind: 'terminal', at, evidence: terminal.evidence })
    })
  }

  /** Close the database handle after the Cordis effect unregisters the Provider. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.db.close()
  }

  private open(busyTimeoutMs: number, journalMode: 'wal' | 'delete' | 'truncate'): void {
    this.db.exec(`PRAGMA busy_timeout = ${String(busyTimeoutMs)}`)
    const applicationId = requiredNumber(row(this.db.prepare('PRAGMA application_id').get()).application_id, 'application_id')
    const version = requiredNumber(row(this.db.prepare('PRAGMA user_version').get()).user_version, 'user_version')
    const objects = requiredNumber(row(this.db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'").get()).count, 'schema count')
    if (applicationId === 0 && version === 0 && objects === 0) this.initialize()
    else if (applicationId !== APPLICATION_ID || version !== SCHEMA_VERSION) {
      throw new Error(`LoopX coordination journal refuses database identity ${String(applicationId)} version ${String(version)}`)
    }
    this.db.exec(`PRAGMA journal_mode = ${journalMode.toUpperCase()}`)
  }

  private initialize(): void {
    this.db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE graph_loopx_activation_state (
        goal_id TEXT NOT NULL, activation_id TEXT NOT NULL, claim_json TEXT, owner TEXT,
        terminal_json TEXT, cancel_reason TEXT, PRIMARY KEY(goal_id, activation_id)
      );
      CREATE TABLE graph_loopx_events (
        goal_id TEXT NOT NULL, activation_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
        event_key TEXT NOT NULL, event_json TEXT NOT NULL,
        PRIMARY KEY(goal_id, activation_id, ordinal), UNIQUE(goal_id, activation_id, event_key)
      );
      CREATE TABLE graph_loopx_progress (
        goal_id TEXT NOT NULL, activation_id TEXT NOT NULL, sequence INTEGER NOT NULL,
        evidence TEXT NOT NULL, cursor TEXT NOT NULL,
        PRIMARY KEY(goal_id, activation_id, sequence)
      );
      PRAGMA application_id = ${String(APPLICATION_ID)};
      PRAGMA user_version = ${String(SCHEMA_VERSION)};
      COMMIT;`)
  }

  private transaction<T>(operation: () => T): T {
    this.assertOpen()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = operation()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  private ensureActivation(activationId: GraphActivationId): void {
    this.db.prepare('INSERT INTO graph_loopx_activation_state(goal_id, activation_id) VALUES(?, ?) ON CONFLICT(goal_id, activation_id) DO NOTHING')
      .run(this.goalId, activationId)
  }

  private append(
    activationId: GraphActivationId,
    eventKey: string,
    seed: Omit<GraphCoordinationEvent, 'id' | 'cursor'>,
  ): GraphCoordinationEvent {
    const prior = this.db.prepare('SELECT event_json FROM graph_loopx_events WHERE goal_id = ? AND activation_id = ? AND event_key = ?')
      .get(this.goalId, activationId, eventKey)
    if (prior !== undefined) return parseJson(optionalText(row(prior).event_json, 'event JSON'), 'event', eventSchema) as GraphCoordinationEvent
    const maximum = this.db.prepare('SELECT COALESCE(MAX(ordinal), 0) AS ordinal FROM graph_loopx_events WHERE goal_id = ? AND activation_id = ?')
      .get(this.goalId, activationId)
    const ordinal = requiredNumber(row(maximum).ordinal, 'event ordinal') + 1
    const cursor = String(ordinal)
    const event = { ...seed, id: `loopx:${this.goalId}:${activationId}:${cursor}`, cursor }
    this.db.prepare('INSERT INTO graph_loopx_events(goal_id, activation_id, ordinal, event_key, event_json) VALUES(?, ?, ?, ?, ?)')
      .run(this.goalId, activationId, ordinal, eventKey, JSON.stringify(event))
    return event
  }

  private existingEvent(activationId: GraphActivationId, eventKey: string): GraphCoordinationEvent {
    const value = this.db.prepare('SELECT event_json FROM graph_loopx_events WHERE goal_id = ? AND activation_id = ? AND event_key = ?')
      .get(this.goalId, activationId, eventKey)
    if (value === undefined) throw new Error(`LoopX coordination journal is missing event ${eventKey}`)
    return parseJson(optionalText(row(value).event_json, 'event JSON'), 'event', eventSchema) as GraphCoordinationEvent
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('LoopX coordination journal is closed')
  }
}

/** Terminal state accepted by the durable projection. */
export type LoopxJournalTerminal = Pick<GraphCoordinationSettlement, 'outcome' | 'evidence' | 'settlementId'>
