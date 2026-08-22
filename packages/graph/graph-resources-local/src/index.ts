/** Local Graph resource Provider with leased capacity and runtime backoff. @module @deepseek-ai/dsh-graph-resources-local */

import { createHash } from 'node:crypto'
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

export const name = 'graph-resources-local'
export const inject = ['graphResources']

/** Hard deployment facts for one exact model route. */
export interface RouteConfig {
  /** Optional model Provider id; omission addresses the default Provider. */
  readonly provider?: string
  /** Exact model id. */
  readonly model: string
  /** Maximum simultaneous reservations for this route. */
  readonly concurrencyLimit: number
  /** Optional total weight across simultaneous reservations. */
  readonly weightLimit?: number
  /** Optional model context capacity exposed to planning. */
  readonly contextWindow?: number
  /** Optional maximum model output exposed to planning. */
  readonly maxOutputTokens?: number
  /** Optional deployment-defined memory class without device identity. */
  readonly memoryClass?: string
}

/** Local resource-provider deployment configuration. */
export interface Config {
  /** Registered Graph resource Provider name. */
  readonly providerName: string
  /** Exact routes eligible for local reservation. */
  readonly routes: RouteConfig[]
  /** Lifetime of one published observation. */
  readonly observationTtlMs: number
  /** Maximum reservation lease duration. */
  readonly leaseMs: number
  /** Delay before a capacity waiter may ask again. */
  readonly retryMs: number
  /** Route backoff after a worker reports OOM. */
  readonly oomBackoffMs: number
}

const RouteConfig: z<RouteConfig> = z.object({
  provider: z.string(), model: z.string().required(), concurrencyLimit: z.natural().min(1).required(),
  weightLimit: z.number().min(0), contextWindow: z.natural().min(1), maxOutputTokens: z.natural().min(1), memoryClass: z.string(),
})

/** Plugin configuration schema. */
export const Config: z<Config> = z.object({
  providerName: z.string().default('local-resources'),
  routes: z.array(RouteConfig).required(),
  observationTtlMs: z.natural().min(100).max(300_000).default(5_000),
  leaseMs: z.natural().min(1_000).max(86_400_000).default(60_000),
  retryMs: z.natural().min(10).max(300_000).default(250),
  oomBackoffMs: z.natural().min(100).max(86_400_000).default(30_000),
})

interface RouteState {
  readonly config: RouteConfig
  recentOomAt?: number
  rateLimitedUntil?: number
}

const routeKey = (route: GraphResourceRoute): string => JSON.stringify([route.provider ?? null, route.model])

/** In-process reservation authority for configured model routes. */
export class LocalGraphResourceProvider implements GraphResourceProvider {
  readonly protocolVersion = 1 as const
  private readonly routes = new Map<string, RouteState>()
  private readonly reservations = new Map<string, GraphResourceReservation>()
  private readonly reservationRequests = new Map<string, GraphResourceReservationRequest>()
  private readonly fencingTokens = new Map<string, number>()
  private readonly reports = new Map<string, GraphResourceOutcome>()

  constructor(readonly name: string, private readonly config: Config) {
    if (!name.trim()) throw new Error('graph-resources-local providerName must be non-empty')
    for (const route of config.routes) {
      if (!route.model.trim() || (route.provider !== undefined && !route.provider.trim())
        || (route.memoryClass !== undefined && !route.memoryClass.trim())) {
        throw new Error('graph-resources-local routes require normalized provider, model, and memoryClass values')
      }
      if (route.weightLimit !== undefined && (!Number.isFinite(route.weightLimit) || route.weightLimit <= 0)) throw new Error(`graph resource route ${route.model} weightLimit must be positive`)
      const key = routeKey(route)
      if (this.routes.has(key)) throw new Error(`duplicate graph resource route ${key}`)
      this.routes.set(key, { config: route })
    }
  }

  observe(route: GraphResourceRoute, signal: AbortSignal): Promise<GraphResourceSnapshot> {
    return Promise.resolve().then(() => {
      signal.throwIfAborted()
      const now = Date.now()
      this.expire(now)
      return this.snapshot(route, now)
    })
  }

  reserve(request: GraphResourceReservationRequest, signal: AbortSignal): Promise<GraphResourceDecision> {
    return Promise.resolve().then(() => {
      signal.throwIfAborted()
      const now = Date.now()
      this.expire(now)
      const state = this.routes.get(routeKey(request))
      const snapshot = this.snapshot(request, now)
      if (state === undefined) return { status: 'rejected' as const, reason: 'route-unavailable' as const, snapshot }
      const existing = [...this.reservations.values()].find(item => (
        item.operationId === request.operationId && item.ownerEpoch === request.ownerEpoch
      ))
      if (existing !== undefined) {
        this.assertReservationRequest(this.reservationRequests.get(existing.id), request)
        return { status: 'granted' as const, reservation: existing }
      }
      if (state.rateLimitedUntil !== undefined && state.rateLimitedUntil > now) {
        return { status: 'wait' as const, reason: 'rate-limit' as const, retryAt: state.rateLimitedUntil, snapshot }
      }
      if (state.recentOomAt !== undefined && state.recentOomAt + this.config.oomBackoffMs > now) {
        return {
          status: 'wait' as const,
          reason: 'oom-backoff' as const,
          retryAt: state.recentOomAt + this.config.oomBackoffMs,
          snapshot,
        }
      }
      const active = this.active(request)
      const concurrencyLimit = Math.min(request.hardMaxParallel, state.config.concurrencyLimit)
      if (active.length >= concurrencyLimit) {
        return { status: 'wait' as const, reason: 'concurrency' as const, retryAt: now + this.config.retryMs, snapshot }
      }
      const weightLimit = request.hardMaxWeight === undefined ? state.config.weightLimit
        : state.config.weightLimit === undefined ? request.hardMaxWeight : Math.min(request.hardMaxWeight, state.config.weightLimit)
      if (weightLimit !== undefined && request.weight > weightLimit) {
        return { status: 'rejected' as const, reason: 'request-impossible' as const, snapshot }
      }
      if (weightLimit !== undefined && active.reduce((total, item) => total + item.weight, 0) + request.weight > weightLimit) {
        return { status: 'wait' as const, reason: 'weight' as const, retryAt: now + this.config.retryMs, snapshot }
      }
      const id = GraphResourceReservationId(`reservation:${createHash('sha256').update(JSON.stringify([
        request.operationId,
        request.ownerEpoch,
      ])).digest('hex')}`)
      const fencingToken = (this.fencingTokens.get(id) ?? 0) + 1
      const reservation: GraphResourceReservation = {
        id, providerId: this.name, workId: request.workId, operationId: request.operationId, ownerEpoch: request.ownerEpoch,
        weight: request.weight, fencingToken, acquiredAt: now,
        expiresAt: Math.min(request.deadline, now + this.config.leaseMs), snapshot,
        ...request.provider === undefined ? {} : { provider: request.provider }, model: request.model,
      }
      this.fencingTokens.set(id, fencingToken)
      this.reservations.set(id, reservation)
      this.reservationRequests.set(id, request)
      return { status: 'granted' as const, reservation }
    })
  }

  report(outcome: GraphResourceOutcome, signal: AbortSignal): Promise<void> {
    return Promise.resolve().then(() => {
      signal.throwIfAborted()
      const reportKey = this.reportKey(outcome.reservationId, outcome.fencingToken)
      const previous = this.reports.get(reportKey)
      if (previous !== undefined) {
        if (previous.providerId === outcome.providerId && previous.workId === outcome.workId
          && previous.ownerEpoch === outcome.ownerEpoch && previous.fencingToken === outcome.fencingToken
          && previous.outcome === outcome.outcome) return
        throw new Error(`conflicting Graph resource outcome for ${outcome.reservationId}`)
      }
      const reservation = this.reservations.get(outcome.reservationId)
      if (reservation === undefined || reservation.providerId !== outcome.providerId || reservation.workId !== outcome.workId
        || reservation.ownerEpoch !== outcome.ownerEpoch || reservation.fencingToken !== outcome.fencingToken) {
        throw new Error(`Graph resource outcome is absent or fenced for ${outcome.reservationId}`)
      }
      this.reports.set(reportKey, outcome)
      this.reservations.delete(outcome.reservationId)
      this.reservationRequests.delete(outcome.reservationId)
      const state = this.routes.get(routeKey(reservation)) as RouteState
      if (outcome.outcome === 'oom') state.recentOomAt = outcome.at
      if (outcome.outcome === 'rate-limited') state.rateLimitedUntil = outcome.at + (outcome.retryAfterMs ?? this.config.retryMs)
    })
  }

  async reconcile(request: GraphResourceReconcileRequest, signal: AbortSignal): Promise<GraphResourceReconcileResult> {
    signal.throwIfAborted()
    const prior = this.reports.get(this.reportKey(request.reservationId, request.fencingToken))
    if (prior !== undefined) {
      const matches = prior.providerId === request.providerId && prior.workId === request.workId
        && prior.ownerEpoch === request.ownerEpoch && prior.fencingToken === request.fencingToken
      return matches
        ? { status: 'already-released', evidence: `reservation ${request.reservationId} already has terminal outcome ${prior.outcome}` }
        : { status: 'conflict', evidence: `reservation ${request.reservationId} has a differently fenced terminal outcome` }
    }
    const reservation = this.reservations.get(request.reservationId)
    if (reservation === undefined) return { status: 'absent', evidence: `reservation ${request.reservationId} is absent` }
    if (reservation.providerId !== request.providerId || reservation.workId !== request.workId
      || reservation.ownerEpoch !== request.ownerEpoch || reservation.fencingToken !== request.fencingToken) {
      return { status: 'conflict', evidence: `reservation ${request.reservationId} belongs to different fenced work` }
    }
    await this.report({
      reservationId: request.reservationId,
      providerId: request.providerId,
      workId: request.workId,
      ownerEpoch: request.ownerEpoch,
      fencingToken: request.fencingToken,
      outcome: 'worker-lost',
      at: request.at,
      evidence: request.evidence,
    }, signal)
    return { status: 'released', evidence: `reservation ${request.reservationId} released as worker-lost` }
  }

  private active(route: GraphResourceRoute): GraphResourceReservation[] {
    return [...this.reservations.values()].filter(item => routeKey(item) === routeKey(route))
  }

  private assertReservationRequest(
    existing: GraphResourceReservationRequest | undefined,
    request: GraphResourceReservationRequest,
  ): void {
    if (existing === undefined || existing.provider !== request.provider || existing.model !== request.model
      || existing.workId !== request.workId || existing.weight !== request.weight
      || existing.hardMaxParallel !== request.hardMaxParallel || existing.hardMaxWeight !== request.hardMaxWeight) {
      throw new Error(`conflicting Graph resource reservation for ${String(request.operationId)}`)
    }
  }

  private reportKey(id: GraphResourceReservationId, fencingToken: number): string {
    return `${String(id)}\u0000${String(fencingToken)}`
  }

  private snapshot(route: GraphResourceRoute, now: number): GraphResourceSnapshot {
    const state = this.routes.get(routeKey(route))
    if (state === undefined) return { ...route, providerId: this.name, observedAt: now, expiresAt: now + this.config.observationTtlMs, status: 'unavailable' }
    const active = this.active(route)
    const degraded = (state.recentOomAt !== undefined && state.recentOomAt + this.config.oomBackoffMs > now)
      || (state.rateLimitedUntil !== undefined && state.rateLimitedUntil > now)
    return {
      ...route, providerId: this.name, observedAt: now, expiresAt: now + this.config.observationTtlMs,
      status: degraded ? 'degraded' : 'available', activeRequests: active.length,
      concurrencyLimit: state.config.concurrencyLimit, activeWeight: active.reduce((total, item) => total + item.weight, 0),
      ...state.config.weightLimit === undefined ? {} : { weightLimit: state.config.weightLimit },
      ...state.config.contextWindow === undefined ? {} : { contextWindow: state.config.contextWindow },
      ...state.config.maxOutputTokens === undefined ? {} : { maxOutputTokens: state.config.maxOutputTokens },
      ...state.config.memoryClass === undefined ? {} : { memoryClass: state.config.memoryClass },
      ...state.recentOomAt === undefined ? {} : { recentOomAt: state.recentOomAt },
      ...state.rateLimitedUntil === undefined ? {} : { rateLimitedUntil: state.rateLimitedUntil },
    }
  }

  private expire(now: number): void {
    for (const [id, reservation] of this.reservations) {
      if (reservation.expiresAt > now) continue
      this.reservations.delete(id)
      this.reservationRequests.delete(id)
    }
  }
}

/** Register the local resource Provider. */
export function apply(ctx: Context, config: Config): void {
  ctx.effect(() => ctx.graphResources.register(new LocalGraphResourceProvider(config.providerName, config)), 'graph-resources-local: provider registration')
}

export default apply
