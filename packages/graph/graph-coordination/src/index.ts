/** Service Definition for external graph-worker coordination. @module @deepseek-ai/dsh-graph-coordination */

import { Context, Service } from '@deepseek-ai/cordis'
import type {
  GraphActivationId,
  GraphControlOperationId,
  GraphNode,
  GraphRevision,
  GraphRole,
  GraphRunId,
  GraphSettlementId,
  GraphWorkId,
} from '@deepseek-ai/dsh-graph'

declare module '@deepseek-ai/cordis' {
  interface Context {
    graphCoordination: GraphCoordination
  }
}

/** Shared context for one graph coordination operation. */
export interface GraphCoordinationRequest {
  readonly protocolVersion: 3
  readonly graph: GraphRevision
  readonly node: GraphNode
  readonly role: GraphRole
  readonly runId: GraphRunId
  readonly cwd: string
  readonly workId: GraphWorkId
  /** Physical coordination identity; a higher Graph generation receives a new activation. */
  readonly activationId: GraphActivationId
  readonly ownerEpoch: number
  readonly operationId: GraphControlOperationId
  readonly callerId: string
}

/** Claim acknowledgement plus the compact fresh packet shown to the worker. */
export interface GraphCoordinationClaim {
  readonly claimId: string
  readonly todoId: string
  readonly leaseId: string
  readonly expiresAt: number
  readonly fencingToken: number
  readonly observation: string
  /** Existing terminal result returned instead of reacquiring a completed activation. */
  readonly terminal?: { readonly outcome: GraphCoordinationSettlement['outcome']; readonly evidence: string }
}

/** Result facts safe to write to the coordination control plane. */
export interface GraphCoordinationSettlement extends GraphCoordinationRequest {
  readonly claimId: string
  readonly leaseId: string
  readonly fencingToken: number
  readonly settlementId: GraphSettlementId
  readonly outcome: 'succeeded' | 'failed' | 'blocked' | 'skipped' | 'canceled' | 'exhausted' | 'uncertain'
  /** Public-safe evidence; raw transcripts and credentials are forbidden. */
  readonly evidence: string
}

/** Lease renewal and progress cursor for a live claim. */
export interface GraphCoordinationHeartbeat extends GraphCoordinationRequest {
  readonly claimId: string
  readonly leaseId: string
  readonly fencingToken: number
  readonly progressSequence: number
}

/** Confirmed lease state returned after a heartbeat. */
export interface GraphCoordinationHeartbeatResult {
  readonly leaseId: string
  readonly expiresAt: number
  readonly fencingToken: number
  readonly progressCursor: string
  readonly cancelRequested: boolean
}

/** Consistent observation request that never acquires ownership. */
export interface GraphCoordinationObserveRequest {
  readonly protocolVersion: 3
  readonly workId: GraphWorkId
  readonly activationId: GraphActivationId
  readonly cwd: string
  readonly callerId: string
  readonly afterCursor?: string
}

/** Public-safe coordination event delivered through observe or watch. */
export interface GraphCoordinationEvent {
  readonly id: string
  readonly cursor: string
  readonly kind: 'claimed' | 'heartbeat' | 'progress' | 'cancel-requested' | 'terminal'
  readonly at: number
  readonly sequence?: number
  readonly evidence?: string
}

/** Snapshot and ordered event suffix for one work identity. */
export interface GraphCoordinationObservation {
  readonly status: 'absent' | 'open' | 'claimed' | 'cancel-requested' | 'terminal' | 'unknown'
  readonly cursor: string
  readonly events: readonly GraphCoordinationEvent[]
  readonly compacted: boolean
  readonly claim?: GraphCoordinationClaim
  readonly terminal?: { readonly outcome: GraphCoordinationSettlement['outcome']; readonly evidence: string }
}

/** Bounded public-safe progress append. */
export interface GraphCoordinationProgress extends GraphCoordinationHeartbeat {
  readonly evidence: string
}

/** Cooperative cancellation request for a live claim. */
export interface GraphCoordinationCancellation extends GraphCoordinationHeartbeat {
  readonly reason: string
}

/** Exact ledger comparison request used at startup and after transport loss. */
export interface GraphCoordinationReconcileRequest extends GraphCoordinationObserveRequest {
  readonly claimId?: string
  readonly leaseId?: string
  readonly fencingToken?: number
  readonly expectedOutcome?: GraphCoordinationSettlement['outcome']
}

/** Provider evidence for one reconciliation decision. */
export interface GraphCoordinationReconcileResult {
  readonly status: 'confirmed-running' | 'confirmed-terminal' | 'absent' | 'conflict' | 'unknown'
  readonly observation: GraphCoordinationObservation
  readonly evidence: string
}

/** Provider-neutral external coordination seam. */
export abstract class GraphCoordination extends Service {
  private readonly quiescenceConsumers = new Set<{
    readonly callback: () => Promise<void>
    quiescence?: Promise<void>
  }>()
  private consumersDraining = false
  private consumerQuiescence: Promise<void> | undefined

  constructor(ctx: Context) {
    super(ctx, 'graphCoordination')
  }

  /**
   * Register a consumer shutdown callback that providers await before disposing owned resources.
   * @param callback Consumer work that must settle before provider resources close.
   * @returns An asynchronous disposer that waits for the callback before unregistering it.
   */
  registerQuiescence(callback: () => Promise<void>): () => Promise<void> {
    if (this.consumersDraining) throw new Error('graph coordination provider is quiescing and no longer accepts consumers')
    const registration = { callback }
    this.quiescenceConsumers.add(registration)
    return async (): Promise<void> => {
      await this.quiesceRegistration(registration)
    }
  }

  /** Stop accepting consumers and await every registered consumer before provider disposal. */
  async quiesceConsumers(): Promise<void> {
    if (this.consumerQuiescence !== undefined) {
      await this.consumerQuiescence
      return
    }
    this.consumersDraining = true
    this.consumerQuiescence = (async (): Promise<void> => {
      const results = await Promise.allSettled([...this.quiescenceConsumers].map(registration => this.quiesceRegistration(registration)))
      const failures: unknown[] = []
      for (const result of results) if (result.status === 'rejected') failures.push(result.reason)
      if (failures.length > 0) throw new AggregateError(failures, 'graph coordination consumers failed to quiesce')
    })()
    await this.consumerQuiescence
  }

  private async quiesceRegistration(registration: {
    readonly callback: () => Promise<void>
    quiescence?: Promise<void>
  }): Promise<void> {
    registration.quiescence ??= Promise.resolve().then(registration.callback)
    try {
      await registration.quiescence
    } finally {
      this.quiescenceConsumers.delete(registration)
    }
  }

  /**
   * Validate external coordination identity for one immutable revision.
   * @param graph immutable revision being admitted.
   * @param roles configured roles available to its nodes.
   * @param cwd session working directory used by the provider.
   * @param signal caller cancellation.
   */
  abstract prepare(graph: GraphRevision, roles: readonly GraphRole[], cwd: string, signal: AbortSignal): Promise<void>
  /**
   * Claim a ready node and return a compact fresh observation.
   * @param request graph, run, node, role, and working-directory identity.
   * @param signal caller cancellation.
   * @returns provider claim and bounded observation for the worker.
   */
  abstract claim(request: GraphCoordinationRequest, signal: AbortSignal): Promise<GraphCoordinationClaim>
  /**
   * Renew one exact live lease and return its fresh cursor.
   * @param request fenced claim and monotonic progress sequence.
   * @param signal caller cancellation.
   * @returns renewed lease, fencing, progress, and cancellation state.
   */
  abstract heartbeat(request: GraphCoordinationHeartbeat, signal: AbortSignal): Promise<GraphCoordinationHeartbeatResult>
  /**
   * Read a consistent public-safe snapshot without taking ownership.
   * @param request stable work identity and optional event cursor.
   * @param signal caller cancellation.
   * @returns current claim state and ordered event suffix.
   */
  abstract observe(request: GraphCoordinationObserveRequest, signal: AbortSignal): Promise<GraphCoordinationObservation>
  /**
   * Wait for or poll ordered public-safe changes after a durable cursor.
   * @param request stable work identity and optional event cursor.
   * @param signal caller cancellation or wait deadline.
   * @returns current claim state and ordered event suffix.
   */
  abstract watch(request: GraphCoordinationObserveRequest, signal: AbortSignal): Promise<GraphCoordinationObservation>
  /**
   * Append one idempotent bounded progress record.
   * @param request fenced claim, sequence, and public-safe evidence.
   * @param signal caller cancellation.
   * @returns durable cursor assigned to the progress record.
   */
  abstract publishProgress(request: GraphCoordinationProgress, signal: AbortSignal): Promise<{ readonly cursor: string }>
  /**
   * Write terminal progress and public-safe evidence.
   * @param request claim identity, terminal outcome, and public-safe evidence.
   * @param signal settlement cancellation; Consumers must not reuse a canceled worker signal.
   */
  abstract settle(request: GraphCoordinationSettlement, signal: AbortSignal): Promise<void>
  /**
   * Request cooperative cancellation without accepting a terminal result.
   * @param request fenced live claim and public-safe reason.
   * @param signal caller cancellation.
   */
  abstract cancel(request: GraphCoordinationCancellation, signal: AbortSignal): Promise<void>
  /**
   * Compare exact Graph references with provider-owned durable evidence.
   * @param request stable work identity and optional claim, lease, fencing, and outcome expectations.
   * @param signal caller cancellation.
   * @returns confirmed, absent, conflicting, or unknown provider evidence.
   */
  abstract reconcile(request: GraphCoordinationReconcileRequest, signal: AbortSignal): Promise<GraphCoordinationReconcileResult>
}

interface MemoryWorkState {
  claim?: GraphCoordinationClaim
  owner?: string
  events: GraphCoordinationEvent[]
  progress: Map<number, string>
  cancelReason?: string
  terminal?: { outcome: GraphCoordinationSettlement['outcome']; evidence: string; settlementId: GraphSettlementId }
}

/** Deterministic in-memory provider used by protocol conformance and local compositions. */
export class MemoryGraphCoordination extends GraphCoordination {
  private readonly activations = new Map<GraphActivationId, MemoryWorkState>()
  private readonly leaseMs: number

  /** Construct an isolated provider with a bounded lease duration. */
  constructor(ctx: Context, leaseMs = 30_000) {
    super(ctx)
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1) throw new Error('memory graph coordination leaseMs must be positive')
    this.leaseMs = leaseMs
  }

  /** Validate graph role references before local execution begins. */
  prepare(graph: GraphRevision, roles: readonly GraphRole[], _cwd: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const enabled = new Set(roles.filter(role => role.enabled).map(role => role.id))
    for (const node of graph.nodes) if (!enabled.has(node.roleId)) throw new Error(`unavailable graph role ${node.roleId}`)
    return Promise.resolve()
  }

  /** Acquire or recover an expiring fenced lease for one physical activation. */
  claim(request: GraphCoordinationRequest, signal: AbortSignal): Promise<GraphCoordinationClaim> {
    signal.throwIfAborted()
    const state = this.state(request.activationId)
    if (state.terminal !== undefined) {
      const prior = state.claim
      return Promise.resolve({
        claimId: prior?.claimId ?? `terminal:${request.activationId}`,
        todoId: prior?.todoId ?? `todo:${request.activationId}`,
        leaseId: prior?.leaseId ?? `terminal:${request.activationId}`,
        expiresAt: prior?.expiresAt ?? 0,
        fencingToken: prior?.fencingToken ?? 0,
        observation: JSON.stringify({ schema: 'dsh-memory-coordination-v3', activationId: request.activationId, terminal: true }),
        terminal: { outcome: state.terminal.outcome, evidence: state.terminal.evidence },
      })
    }
    const now = Date.now()
    if (state.claim !== undefined && state.claim.expiresAt > now && state.owner !== request.callerId) {
      throw new Error(`graph activation ${request.activationId} has an unexpired owner`)
    }
    const fencingToken = state.claim === undefined ? 1 : state.claim.fencingToken + (state.claim.expiresAt <= now ? 1 : 0)
    const claim = state.claim !== undefined && state.claim.expiresAt > now
      ? { ...state.claim, expiresAt: now + this.leaseMs }
      : {
        claimId: `claim:${request.activationId}:${String(fencingToken)}`,
        todoId: `todo:${request.activationId}`,
        leaseId: `lease:${request.activationId}:${String(fencingToken)}`,
        expiresAt: now + this.leaseMs,
        fencingToken,
        observation: JSON.stringify({ schema: 'dsh-memory-coordination-v3', workId: request.workId, activationId: request.activationId, ownerEpoch: request.ownerEpoch }),
      }
    state.claim = claim
    state.owner = request.callerId
    this.append(state, 'claimed', now)
    return Promise.resolve(claim)
  }

  /** Renew exactly the current unfenced lease. */
  heartbeat(request: GraphCoordinationHeartbeat, signal: AbortSignal): Promise<GraphCoordinationHeartbeatResult> {
    signal.throwIfAborted()
    const state = this.live(request)
    const expiresAt = Date.now() + this.leaseMs
    state.claim = { ...(state.claim as GraphCoordinationClaim), expiresAt }
    const event = this.append(state, 'heartbeat', Date.now(), request.progressSequence)
    return Promise.resolve({
      leaseId: state.claim.leaseId,
      expiresAt,
      fencingToken: request.fencingToken,
      progressCursor: event.cursor,
      cancelRequested: state.cancelReason !== undefined,
    })
  }

  /** Read the current snapshot and ordered suffix for a logical work id. */
  observe(request: GraphCoordinationObserveRequest, signal: AbortSignal): Promise<GraphCoordinationObservation> {
    signal.throwIfAborted()
    return Promise.resolve(this.observation(request))
  }

  /** Return the same cursor-based suffix as observe for deterministic local polling. */
  watch(request: GraphCoordinationObserveRequest, signal: AbortSignal): Promise<GraphCoordinationObservation> {
    signal.throwIfAborted()
    return Promise.resolve(this.observation(request))
  }

  /** Append ordered progress, treating an identical repeated sequence as idempotent. */
  publishProgress(request: GraphCoordinationProgress, signal: AbortSignal): Promise<{ readonly cursor: string }> {
    signal.throwIfAborted()
    const state = this.live(request)
    const prior = state.progress.get(request.progressSequence)
    if (prior !== undefined && prior !== request.evidence) throw new Error(`conflicting progress sequence ${String(request.progressSequence)}`)
    if (prior !== undefined) {
      const existing = state.events.find(event => event.kind === 'progress' && event.sequence === request.progressSequence) as GraphCoordinationEvent
      return Promise.resolve({ cursor: existing.cursor })
    }
    if (!request.evidence.trim() || request.evidence.length > 2_000) throw new Error('coordination progress must be 1..2,000 characters')
    state.progress.set(request.progressSequence, request.evidence)
    return Promise.resolve({ cursor: this.append(state, 'progress', Date.now(), request.progressSequence, request.evidence).cursor })
  }

  /** Accept the first fenced terminal result and make matching retries idempotent. */
  settle(request: GraphCoordinationSettlement, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const state = this.state(request.activationId)
    if (state.terminal !== undefined) {
      if (state.terminal.settlementId === request.settlementId && state.terminal.outcome === request.outcome
        && state.terminal.evidence === request.evidence) return Promise.resolve()
      throw new Error(`graph activation ${request.activationId} has a conflicting terminal result`)
    }
    this.live(request)
    state.terminal = { outcome: request.outcome, evidence: request.evidence, settlementId: request.settlementId }
    this.append(state, 'terminal', Date.now(), undefined, request.evidence)
    return Promise.resolve()
  }

  /** Record a cooperative cancellation request for the current lease. */
  cancel(request: GraphCoordinationCancellation, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const state = this.live(request)
    if (!request.reason.trim()) throw new Error('coordination cancellation reason must be non-empty')
    if (state.cancelReason !== undefined && state.cancelReason !== request.reason) throw new Error('coordination claim already has a different cancellation reason')
    if (state.cancelReason === undefined) {
      state.cancelReason = request.reason
      this.append(state, 'cancel-requested', Date.now(), request.progressSequence, request.reason)
    }
    return Promise.resolve()
  }

  /** Compare caller expectations with the exact in-memory ledger. */
  reconcile(request: GraphCoordinationReconcileRequest, signal: AbortSignal): Promise<GraphCoordinationReconcileResult> {
    signal.throwIfAborted()
    const observation = this.observation(request)
    const state = this.activations.get(request.activationId)
    if (state === undefined) return Promise.resolve({ status: 'absent', observation, evidence: 'coordination activation is absent' })
    if (state.terminal !== undefined) {
      const status = request.expectedOutcome === undefined || request.expectedOutcome === state.terminal.outcome ? 'confirmed-terminal' : 'conflict'
      return Promise.resolve({ status, observation, evidence: status === 'conflict' ? 'terminal outcomes differ' : 'terminal outcome confirmed' })
    }
    if (state.claim === undefined) return Promise.resolve({ status: 'absent', observation, evidence: 'claim is absent' })
    if ((request.claimId !== undefined && request.claimId !== state.claim.claimId)
      || (request.leaseId !== undefined && request.leaseId !== state.claim.leaseId)
      || (request.fencingToken !== undefined && request.fencingToken !== state.claim.fencingToken)) {
      return Promise.resolve({ status: 'conflict', observation, evidence: 'claim or fencing identity differs' })
    }
    const live = state.claim.expiresAt > Date.now()
    return Promise.resolve({
      status: live ? 'confirmed-running' : 'unknown',
      observation,
      evidence: live ? 'live lease confirmed' : 'lease expired without terminal evidence',
    })
  }

  private state(activationId: GraphActivationId): MemoryWorkState {
    const existing = this.activations.get(activationId)
    if (existing !== undefined) return existing
    const created = { events: [], progress: new Map<number, string>() }
    this.activations.set(activationId, created)
    return created
  }

  private live(request: Pick<GraphCoordinationHeartbeat, 'activationId' | 'claimId' | 'leaseId' | 'fencingToken' | 'callerId'>): MemoryWorkState {
    const state = this.activations.get(request.activationId)
    const claim = state?.claim
    if (state === undefined || claim === undefined || state.terminal !== undefined) throw new Error(`graph activation ${request.activationId} has no live claim`)
    if (claim.claimId !== request.claimId || claim.leaseId !== request.leaseId || claim.fencingToken !== request.fencingToken
      || state.owner !== request.callerId || claim.expiresAt <= Date.now()) throw new Error(`graph activation ${request.activationId} lease is expired or fenced`)
    return state
  }

  private append(state: MemoryWorkState, kind: GraphCoordinationEvent['kind'], at: number, sequence?: number, evidence?: string): GraphCoordinationEvent {
    const cursor = String(state.events.length + 1)
    const event = { id: `event:${cursor}`, cursor, kind, at, ...sequence === undefined ? {} : { sequence }, ...evidence === undefined ? {} : { evidence } }
    state.events.push(event)
    return event
  }

  private observation(request: GraphCoordinationObserveRequest): GraphCoordinationObservation {
    const state = this.activations.get(request.activationId)
    if (state === undefined) return { status: 'absent', cursor: '0', events: [], compacted: false }
    const after = request.afterCursor === undefined ? 0 : Number.parseInt(request.afterCursor, 10)
    const events = Number.isSafeInteger(after) && after >= 0 ? state.events.slice(after) : state.events
    const status = state.terminal !== undefined ? 'terminal' : state.cancelReason !== undefined ? 'cancel-requested' : state.claim !== undefined ? 'claimed' : 'open'
    return {
      status,
      cursor: String(state.events.length),
      events,
      compacted: false,
      ...state.claim === undefined ? {} : { claim: state.claim },
      ...state.terminal === undefined ? {} : { terminal: { outcome: state.terminal.outcome, evidence: state.terminal.evidence } },
    }
  }
}

export default GraphCoordination
