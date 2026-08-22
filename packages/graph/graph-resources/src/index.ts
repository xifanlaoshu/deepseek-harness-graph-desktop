/** Service Definition for expiring Graph model-resource observations and reservations. @module @deepseek-ai/dsh-graph-resources */

import { Context, Service } from '@deepseek-ai/cordis'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { GraphControlOperationId, GraphWorkId } from '@deepseek-ai/dsh-graph'

declare module '@deepseek-ai/cordis' {
  interface Context {
    graphResources: GraphResourceRuntime
  }
}

/** Stable identity of one exact model-resource reservation. */
export type GraphResourceReservationId = Branded<'GraphResourceReservationId'>
/**
 * Brand one validated reservation identity.
 * @param value validated reservation identity text.
 * @returns branded reservation identity.
 */
export const GraphResourceReservationId = (value: string): GraphResourceReservationId => value as GraphResourceReservationId

/** Exact configured route whose live capacity may reduce Graph admission. */
export interface GraphResourceRoute {
  readonly provider?: string
  readonly model: string
}

/** Expiring advisory facts published by one resource Provider. */
export interface GraphResourceSnapshot extends GraphResourceRoute {
  readonly providerId: string
  readonly observedAt: number
  readonly expiresAt: number
  readonly status: 'available' | 'degraded' | 'unavailable' | 'unknown'
  readonly activeRequests?: number
  readonly queueDepth?: number
  readonly concurrencyLimit?: number
  readonly activeWeight?: number
  readonly weightLimit?: number
  readonly contextWindow?: number
  readonly maxOutputTokens?: number
  readonly memoryClass?: string
  readonly availableDeviceBytes?: number
  readonly recentOomAt?: number
  readonly rateLimitedUntil?: number
}

/** Hard configured ceilings and logical identity for one reservation request. */
export interface GraphResourceReservationRequest extends GraphResourceRoute {
  readonly protocolVersion: 1
  readonly workId: GraphWorkId
  readonly operationId: GraphControlOperationId
  readonly ownerEpoch: number
  readonly weight: number
  readonly hardMaxParallel: number
  readonly hardMaxWeight?: number
  readonly requestedAt: number
  readonly deadline: number
}

/** Capacity retained by a Provider until release or expiry. */
export interface GraphResourceReservation extends GraphResourceRoute {
  readonly id: GraphResourceReservationId
  readonly providerId: string
  readonly workId: GraphWorkId
  readonly operationId: GraphControlOperationId
  readonly ownerEpoch: number
  readonly weight: number
  readonly fencingToken: number
  readonly acquiredAt: number
  readonly expiresAt: number
  readonly snapshot: GraphResourceSnapshot
}

/** Provider decision for one exact reservation request. */
export type GraphResourceDecision =
  | { readonly status: 'granted'; readonly reservation: GraphResourceReservation }
  | { readonly status: 'wait'; readonly reason: 'provider-degraded' | 'queue' | 'concurrency' | 'weight' | 'memory' | 'oom-backoff' | 'rate-limit' | 'unknown'; readonly retryAt: number; readonly snapshot: GraphResourceSnapshot }
  | { readonly status: 'rejected'; readonly reason: 'route-unavailable' | 'request-impossible'; readonly snapshot: GraphResourceSnapshot }

/** Runtime resource outcome used to reduce later eligibility. */
export interface GraphResourceOutcome {
  readonly reservationId: GraphResourceReservationId
  readonly providerId: string
  readonly workId: GraphWorkId
  readonly ownerEpoch: number
  readonly fencingToken: number
  readonly outcome: 'released' | 'completed' | 'capacity' | 'oom' | 'rate-limited' | 'worker-lost'
  readonly at: number
  readonly retryAfterMs?: number
  readonly evidence?: string
}

/** Exact prior reservation inspected and released during scheduler recovery. */
export interface GraphResourceReconcileRequest {
  readonly protocolVersion: 1
  readonly reservationId: GraphResourceReservationId
  readonly providerId: string
  readonly workId: GraphWorkId
  readonly ownerEpoch: number
  readonly fencingToken: number
  readonly at: number
  readonly evidence: string
}

/** Provider-confirmed disposition of one prior reservation. */
export interface GraphResourceReconcileResult {
  readonly status: 'released' | 'already-released' | 'absent' | 'conflict'
  readonly evidence: string
}

/** Deployment Provider for one resource observation and reservation authority. */
export interface GraphResourceProvider {
  readonly name: string
  readonly protocolVersion: 1
  observe(route: GraphResourceRoute, signal: AbortSignal): Promise<GraphResourceSnapshot>
  reserve(request: GraphResourceReservationRequest, signal: AbortSignal): Promise<GraphResourceDecision>
  report(outcome: GraphResourceOutcome, signal: AbortSignal): Promise<void>
  reconcile(request: GraphResourceReconcileRequest, signal: AbortSignal): Promise<GraphResourceReconcileResult>
}

const positiveSafeInteger = (value: number, name: string): void => {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`)
}

const validateSnapshot = (provider: string, route: GraphResourceRoute, snapshot: GraphResourceSnapshot): void => {
  if (snapshot.providerId !== provider) throw new Error(`graph resource provider ${provider} returned snapshot for ${snapshot.providerId}`)
  if (snapshot.model !== route.model || (snapshot.provider ?? '') !== (route.provider ?? '')) {
    throw new Error(`graph resource provider ${provider} returned a different model route`)
  }
  if (!Number.isSafeInteger(snapshot.observedAt) || !Number.isSafeInteger(snapshot.expiresAt)
    || snapshot.expiresAt <= snapshot.observedAt) {
    throw new Error(`graph resource provider ${provider} returned an invalid observation lifetime`)
  }
  for (const [name, value] of Object.entries({
    activeRequests: snapshot.activeRequests,
    queueDepth: snapshot.queueDepth,
    concurrencyLimit: snapshot.concurrencyLimit,
    contextWindow: snapshot.contextWindow,
    maxOutputTokens: snapshot.maxOutputTokens,
    availableDeviceBytes: snapshot.availableDeviceBytes,
  })) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new Error(`graph resource snapshot ${name} must be a non-negative safe integer`)
  }
}

/** Named registry that validates every observation, reservation, and outcome. */
export class GraphResourceRuntime extends Service {
  private readonly providers = new Map<string, GraphResourceProvider>()

  constructor(ctx: Context) {
    super(ctx, 'graphResources')
  }

  /**
   * Register one unique resource Provider until disposal.
   * @param provider named observation and reservation authority.
   * @returns disposer that removes only this registration.
   */
  register(provider: GraphResourceProvider): () => void {
    if (!provider.name.trim()) throw new Error('graph resource provider name must be non-empty')
    if (this.providers.has(provider.name)) throw new Error(`graph resource provider ${provider.name} is already registered`)
    this.providers.set(provider.name, provider)
    return () => {
      if (this.providers.get(provider.name) === provider) this.providers.delete(provider.name)
    }
  }

  /**
   * Observe one exact route without reserving it.
   * @param name registered resource Provider name.
   * @param route exact provider and model route.
   * @param signal caller cancellation.
   * @returns validated expiring route observation.
   */
  async observe(name: string, route: GraphResourceRoute, signal: AbortSignal): Promise<GraphResourceSnapshot> {
    const provider = this.requireProvider(name)
    signal.throwIfAborted()
    const snapshot = await provider.observe(route, signal)
    validateSnapshot(name, route, snapshot)
    return snapshot
  }

  /**
   * Ask one Provider for capacity beneath the request's hard configured ceilings.
   * @param name registered resource Provider name.
   * @param request fenced work identity, route, weight, ceilings, and deadline.
   * @param signal caller cancellation.
   * @returns granted reservation, typed wait, or terminal rejection.
   */
  async reserve(name: string, request: GraphResourceReservationRequest, signal: AbortSignal): Promise<GraphResourceDecision> {
    const provider = this.requireProvider(name)
    signal.throwIfAborted()
    positiveSafeInteger(request.ownerEpoch, 'graph resource ownerEpoch')
    if (!Number.isFinite(request.weight) || request.weight <= 0) throw new Error('graph resource weight must be positive')
    positiveSafeInteger(request.hardMaxParallel, 'graph resource hardMaxParallel')
    if (request.hardMaxWeight !== undefined && (!Number.isFinite(request.hardMaxWeight) || request.hardMaxWeight <= 0)) throw new Error('graph resource hardMaxWeight must be positive')
    if (!Number.isSafeInteger(request.requestedAt) || !Number.isSafeInteger(request.deadline) || request.deadline <= request.requestedAt) {
      throw new Error('graph resource reservation lifetime is invalid')
    }
    const decision = await provider.reserve(request, signal)
    const snapshot = decision.status === 'granted' ? decision.reservation.snapshot : decision.snapshot
    validateSnapshot(name, request, snapshot)
    if (decision.status === 'granted') {
      const reservation = decision.reservation
      if (reservation.providerId !== name || reservation.workId !== request.workId || reservation.operationId !== request.operationId
        || reservation.ownerEpoch !== request.ownerEpoch || reservation.weight !== request.weight
        || reservation.model !== request.model || (reservation.provider ?? '') !== (request.provider ?? '')) {
        throw new Error(`graph resource provider ${name} returned a reservation for different work`)
      }
      positiveSafeInteger(reservation.fencingToken, 'graph resource fencingToken')
      if (reservation.expiresAt <= reservation.acquiredAt) throw new Error(`graph resource provider ${name} returned an expired reservation`)
    } else if (decision.status === 'wait' && (!Number.isSafeInteger(decision.retryAt) || decision.retryAt <= request.requestedAt)) {
      throw new Error(`graph resource provider ${name} returned an invalid retry time`)
    }
    return decision
  }

  /**
   * Report one fenced release or resource signal idempotently to its Provider.
   * @param outcome exact reservation identity and terminal resource classification.
   * @param signal caller cancellation independent from the worker signal.
   */
  async report(outcome: GraphResourceOutcome, signal: AbortSignal): Promise<void> {
    const provider = this.requireProvider(outcome.providerId)
    signal.throwIfAborted()
    positiveSafeInteger(outcome.ownerEpoch, 'graph resource ownerEpoch')
    positiveSafeInteger(outcome.fencingToken, 'graph resource fencingToken')
    if (!Number.isSafeInteger(outcome.at) || outcome.at < 0) throw new Error('graph resource outcome time must be a non-negative safe integer')
    if (outcome.retryAfterMs !== undefined && (!Number.isSafeInteger(outcome.retryAfterMs) || outcome.retryAfterMs < 1)) throw new Error('graph resource retryAfterMs must be positive')
    await provider.report(outcome, signal)
  }

  /**
   * Reconcile and release one exact prior reservation after scheduler recovery.
   * @param request fenced reservation identity and public-safe evidence.
   * @param signal caller cancellation independent from the abandoned Worker.
   * @returns provider-confirmed release, absence, or conflict.
   */
  async reconcile(request: GraphResourceReconcileRequest, signal: AbortSignal): Promise<GraphResourceReconcileResult> {
    const provider = this.requireProvider(request.providerId)
    signal.throwIfAborted()
    positiveSafeInteger(request.ownerEpoch, 'graph resource ownerEpoch')
    positiveSafeInteger(request.fencingToken, 'graph resource fencingToken')
    if (!Number.isSafeInteger(request.at) || request.at < 0) throw new Error('graph resource reconcile time must be a non-negative safe integer')
    if (!request.evidence.trim() || request.evidence.length > 4_000) throw new Error('graph resource reconcile evidence must be non-empty and bounded')
    const result = await provider.reconcile(request, signal)
    if (!result.evidence.trim() || result.evidence.length > 4_000) throw new Error(`graph resource provider ${request.providerId} returned invalid reconcile evidence`)
    return result
  }

  private requireProvider(name: string): GraphResourceProvider {
    const provider = this.providers.get(name)
    if (provider === undefined) throw new Error(`unknown graph resource provider ${name}`)
    return provider
  }
}

export default GraphResourceRuntime
