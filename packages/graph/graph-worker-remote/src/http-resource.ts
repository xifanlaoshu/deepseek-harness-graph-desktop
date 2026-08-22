/** Authenticated HTTP Provider for cross-Host Graph model-resource authority. @module */

import {
  GraphControlOperationId,
  GraphWorkId,
} from '@deepseek-ai/dsh-graph'
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
import { z } from 'zod'
import {
  type GraphWorkerRemoteAudienceId,
  type GraphWorkerRemotePrincipalId,
} from './wire.ts'
import { AuthenticatedGraphHttpTransport, type GraphHttpFetch } from './http-transport.ts'

/** Authenticated remote resource route and transport policy. */
export interface HttpGraphResourceOptions {
  readonly providerName: string
  readonly endpoint: string
  readonly principal: GraphWorkerRemotePrincipalId
  readonly audience: GraphWorkerRemoteAudienceId
  readonly resolveSecret: () => Promise<string | undefined>
  readonly requestTimeoutMs: number
  readonly maxResponseBytes: number
  readonly allowInsecureLoopback: boolean
  /** Injectable transport used by deterministic tests. */
  readonly fetcher?: GraphHttpFetch
}

const text = z.string().min(1).max(4_000)
const safeNonNegative = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const safePositive = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
const routeSchema = z.object({ provider: text.optional(), model: text }).strict()
const snapshotSchema = routeSchema.extend({
  providerId: text,
  observedAt: safeNonNegative,
  expiresAt: safePositive,
  status: z.enum(['available', 'degraded', 'unavailable', 'unknown']),
  activeRequests: safeNonNegative.optional(),
  queueDepth: safeNonNegative.optional(),
  concurrencyLimit: safeNonNegative.optional(),
  activeWeight: z.number().nonnegative().optional(),
  weightLimit: z.number().positive().optional(),
  contextWindow: safeNonNegative.optional(),
  maxOutputTokens: safeNonNegative.optional(),
  memoryClass: text.optional(),
  availableDeviceBytes: safeNonNegative.optional(),
  recentOomAt: safeNonNegative.optional(),
  rateLimitedUntil: safeNonNegative.optional(),
}).strict()
const reservationSchema = routeSchema.extend({
  id: text,
  providerId: text,
  workId: text,
  operationId: text,
  ownerEpoch: safePositive,
  weight: z.number().positive(),
  fencingToken: safePositive,
  acquiredAt: safeNonNegative,
  expiresAt: safePositive,
  snapshot: snapshotSchema,
}).strict()
const decisionSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('granted'), reservation: reservationSchema }).strict(),
  z.object({
    status: z.literal('wait'),
    reason: z.enum(['provider-degraded', 'queue', 'concurrency', 'weight', 'memory', 'oom-backoff', 'rate-limit', 'unknown']),
    retryAt: safePositive,
    snapshot: snapshotSchema,
  }).strict(),
  z.object({
    status: z.literal('rejected'),
    reason: z.enum(['route-unavailable', 'request-impossible']),
    snapshot: snapshotSchema,
  }).strict(),
])
const acknowledgmentSchema = z.object({ protocolVersion: z.literal(1), accepted: z.literal(true) }).strict()
const reconcileResultSchema = z.object({
  status: z.enum(['released', 'already-released', 'absent', 'conflict']),
  evidence: text,
}).strict()

/** Authenticated Graph Resource Provider backed by one remote Worker service. */
export class HttpGraphResourceProvider implements GraphResourceProvider {
  readonly protocolVersion = 1 as const
  readonly name: string
  private readonly transport: AuthenticatedGraphHttpTransport

  /**
   * Create a cross-Host resource Provider with explicit identities and bounds.
   * @param options - remote endpoint, credentials, registered name, and transport policy.
   */
  constructor(options: HttpGraphResourceOptions) {
    if (!options.providerName.trim()) throw new Error('HTTP graph resource providerName must be non-empty')
    this.name = options.providerName
    this.transport = new AuthenticatedGraphHttpTransport(options)
  }

  /** Observe one exact remote model route. */
  async observe(route: GraphResourceRoute, signal: AbortSignal): Promise<GraphResourceSnapshot> {
    return snapshotSchema.parse(await this.transport.post('/v1/resources/observe', { protocolVersion: 1, route }, signal)) as GraphResourceSnapshot
  }

  /** Reserve remote capacity beneath the caller's durable hard ceilings. */
  async reserve(request: GraphResourceReservationRequest, signal: AbortSignal): Promise<GraphResourceDecision> {
    const parsed = decisionSchema.parse(await this.transport.post('/v1/resources/reserve', { protocolVersion: 1, request }, signal))
    if (parsed.status !== 'granted') return parsed as GraphResourceDecision
    return {
      status: 'granted',
      reservation: {
        ...parsed.reservation,
        id: GraphResourceReservationId(parsed.reservation.id),
        workId: GraphWorkId(parsed.reservation.workId),
        operationId: GraphControlOperationId(parsed.reservation.operationId),
      } as unknown as GraphResourceReservation,
    }
  }

  /** Report one exact remote reservation outcome idempotently. */
  async report(outcome: GraphResourceOutcome, signal: AbortSignal): Promise<void> {
    acknowledgmentSchema.parse(await this.transport.post('/v1/resources/report', { protocolVersion: 1, outcome }, signal))
  }

  /** Reconcile one exact remote reservation after Graph scheduler recovery. */
  async reconcile(
    request: GraphResourceReconcileRequest,
    signal: AbortSignal,
  ): Promise<GraphResourceReconcileResult> {
    return reconcileResultSchema.parse(await this.transport.post('/v1/resources/reconcile', { protocolVersion: 1, request }, signal))
  }
}
