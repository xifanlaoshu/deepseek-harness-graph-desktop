/** Authenticated cross-Host Graph scheduler ownership route. @module */

import { GraphRunGenerationId, GraphRunId } from '@deepseek-ai/dsh-graph'
import {
  GraphSchedulerLeaseId,
  GraphSchedulerOwnerId,
  type GraphSchedulerAcquireRequest,
  type GraphSchedulerDecision,
  type GraphSchedulerLease,
  type GraphSchedulerLeaseRequest,
  type GraphSchedulerProvider,
} from '@deepseek-ai/dsh-graph-scheduler'
import { z } from 'zod'
import { AuthenticatedGraphHttpTransport, type AuthenticatedGraphHttpOptions } from './http-transport.ts'

/** Authenticated Scheduler route configuration. */
export interface HttpGraphSchedulerOptions extends AuthenticatedGraphHttpOptions {
  readonly providerName: string
}

const text = z.string().min(1).max(4_000)
const safeNonNegative = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const safePositive = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
const leaseSchema = z.object({
  id: text,
  providerId: text,
  sessionId: text,
  runId: text,
  generationId: text,
  ownerId: text,
  ownerEpoch: safePositive,
  fencingToken: safePositive,
  acquiredAt: safeNonNegative,
  expiresAt: safePositive,
}).strict()
const decisionSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('granted'), lease: leaseSchema }).strict(),
  z.object({ status: z.literal('busy'), retryAt: safePositive, evidence: text }).strict(),
])
const acceptedSchema = z.object({ protocolVersion: z.literal(1), accepted: z.literal(true) }).strict()

function lease(value: z.infer<typeof leaseSchema>): GraphSchedulerLease {
  return {
    ...value,
    id: GraphSchedulerLeaseId(value.id),
    runId: GraphRunId(value.runId),
    generationId: GraphRunGenerationId(value.generationId),
    ownerId: GraphSchedulerOwnerId(value.ownerId),
  }
}

/** Persistent Scheduler Provider that delegates ownership to an authenticated service. */
export class HttpGraphSchedulerProvider implements GraphSchedulerProvider {
  readonly protocolVersion = 1 as const
  readonly name: string
  private readonly transport: AuthenticatedGraphHttpTransport

  /**
   * Create one authenticated cross-Host ownership route.
   * @param options - public route identity, service authentication, and transport bounds.
   */
  constructor(options: HttpGraphSchedulerOptions) {
    if (!options.providerName.trim()) throw new Error('HTTP graph scheduler providerName must be non-empty')
    this.name = options.providerName
    this.transport = new AuthenticatedGraphHttpTransport(options)
  }

  /** Acquire or recover one exact run lease through the remote authority. */
  async acquire(request: GraphSchedulerAcquireRequest, signal: AbortSignal): Promise<GraphSchedulerDecision> {
    const parsed = decisionSchema.parse(await this.transport.post('/v1/scheduler/acquire', {
      protocolVersion: 1,
      request,
    }, signal))
    return parsed.status === 'busy' ? parsed : { status: 'granted', lease: lease(parsed.lease) }
  }

  /** Renew one exact fenced lease through the remote authority. */
  async heartbeat(request: GraphSchedulerLeaseRequest, signal: AbortSignal): Promise<GraphSchedulerLease> {
    return lease(leaseSchema.parse(await this.transport.post('/v1/scheduler/heartbeat', {
      protocolVersion: 1,
      request,
    }, signal)))
  }

  /** Release one exact fenced lease through the remote authority. */
  async release(request: GraphSchedulerLeaseRequest, signal: AbortSignal): Promise<void> {
    acceptedSchema.parse(await this.transport.post('/v1/scheduler/release', {
      protocolVersion: 1,
      request,
    }, signal))
  }
}
