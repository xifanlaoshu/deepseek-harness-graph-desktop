/** Fenced ownership authority for durable Graph schedulers. @module @deepseek-ai/dsh-graph-scheduler */

import { Context, Service } from '@deepseek-ai/cordis'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { GraphRunGenerationId, GraphRunId } from '@deepseek-ai/dsh-graph'

/** Opaque identity of one scheduler Host process. */
export type GraphSchedulerOwnerId = Branded<'GraphSchedulerOwnerId'>
/**
 * Brand one scheduler Host process identity.
 * @param value serialized identity.
 * @returns branded scheduler owner id.
 */
export const GraphSchedulerOwnerId = (value: string): GraphSchedulerOwnerId => value as GraphSchedulerOwnerId
/** Opaque identity of one fenced run lease. */
export type GraphSchedulerLeaseId = Branded<'GraphSchedulerLeaseId'>
/**
 * Brand one fenced scheduler lease identity.
 * @param value serialized identity.
 * @returns branded scheduler lease id.
 */
export const GraphSchedulerLeaseId = (value: string): GraphSchedulerLeaseId => value as GraphSchedulerLeaseId

/** Non-retryable loss of one exact scheduler lease identity. */
export class GraphSchedulerAuthorityError extends Error {
  /** Stable diagnostic code for retry classification. */
  readonly code = 'GRAPH_SCHEDULER_AUTHORITY_LOST'

  /**
   * Create a failure that requires fenced recovery instead of another heartbeat.
   * @param message exact lease identity or expiry failure.
   */
  constructor(message: string) {
    super(message)
    this.name = 'GraphSchedulerAuthorityError'
  }
}

/** Exact durable run ownership requested by one Host. */
export interface GraphSchedulerAcquireRequest {
  readonly protocolVersion: 1
  readonly sessionId: string
  readonly runId: GraphRunId
  readonly generationId: GraphRunGenerationId
  readonly ownerId: GraphSchedulerOwnerId
  readonly minimumOwnerEpoch: number
  readonly requestedAt: number
}

/** Fenced authority to advance one Graph run. */
export interface GraphSchedulerLease {
  readonly id: GraphSchedulerLeaseId
  readonly providerId: string
  readonly sessionId: string
  readonly runId: GraphRunId
  readonly generationId: GraphRunGenerationId
  readonly ownerId: GraphSchedulerOwnerId
  readonly ownerEpoch: number
  readonly fencingToken: number
  readonly acquiredAt: number
  readonly expiresAt: number
}

/** Atomic ownership admission result. */
export type GraphSchedulerDecision =
  | { readonly status: 'granted'; readonly lease: GraphSchedulerLease }
  | { readonly status: 'busy'; readonly retryAt: number; readonly evidence: string }

/** Exact lease identity required by heartbeat and release. */
export interface GraphSchedulerLeaseRequest {
  readonly protocolVersion: 1
  readonly providerId: string
  readonly leaseId: GraphSchedulerLeaseId
  readonly runId: GraphRunId
  readonly generationId: GraphRunGenerationId
  readonly ownerId: GraphSchedulerOwnerId
  readonly ownerEpoch: number
  readonly fencingToken: number
  readonly at: number
}

/** Durable scheduler ownership Provider. */
export interface GraphSchedulerProvider {
  readonly protocolVersion: 1
  readonly name: string
  acquire(request: GraphSchedulerAcquireRequest, signal: AbortSignal): Promise<GraphSchedulerDecision>
  heartbeat(request: GraphSchedulerLeaseRequest, signal: AbortSignal): Promise<GraphSchedulerLease>
  release(request: GraphSchedulerLeaseRequest, signal: AbortSignal): Promise<void>
}

interface MemorySchedulerRun {
  readonly sessionId: string
  lastFencingToken: number
  lease?: GraphSchedulerLease
}

/** In-process Scheduler Provider with the same ownership and fencing semantics as durable Providers. */
export class MemoryGraphSchedulerProvider implements GraphSchedulerProvider {
  readonly protocolVersion = 1 as const
  private readonly runs = new Map<string, MemorySchedulerRun>()

  /**
   * Construct one process-local ownership authority.
   * @param name registered Provider identity.
   * @param leaseMs lifetime assigned to acquired and renewed leases.
   * @param retryMs minimum retry delay when a live owner blocks admission.
   */
  constructor(readonly name: string, private readonly leaseMs: number, private readonly retryMs: number) {
    if (!name.trim()) throw new Error('memory graph scheduler Provider requires a non-empty name')
    positiveInteger(leaseMs, 'memory graph scheduler leaseMs')
    positiveInteger(retryMs, 'memory graph scheduler retryMs')
  }

  /** Acquire one run or return the live owner's expiry as a bounded retry. */
  acquire(request: GraphSchedulerAcquireRequest, signal: AbortSignal): Promise<GraphSchedulerDecision> {
    signal.throwIfAborted()
    const key = String(request.runId)
    const now = Date.now()
    let state = this.runs.get(key)
    if (state !== undefined && state.sessionId !== request.sessionId) {
      throw new Error(`graph run ${key} belongs to another session`)
    }
    if (state === undefined) {
      state = { sessionId: request.sessionId, lastFencingToken: 0 }
      this.runs.set(key, state)
    }
    const active = state.lease
    if (active !== undefined && active.expiresAt > now) {
      if (active.generationId === request.generationId && active.ownerId === request.ownerId
        && active.ownerEpoch >= request.minimumOwnerEpoch) return Promise.resolve({ status: 'granted', lease: active })
      return Promise.resolve({
        status: 'busy',
        retryAt: Math.max(active.expiresAt, request.requestedAt + this.retryMs),
        evidence: `run ${key} is owned by another live scheduler`,
      })
    }
    const token = Math.max(state.lastFencingToken + 1, request.minimumOwnerEpoch)
    const lease: GraphSchedulerLease = {
      id: GraphSchedulerLeaseId(`memory:${key}:${String(token)}`),
      providerId: this.name,
      sessionId: request.sessionId,
      runId: request.runId,
      generationId: request.generationId,
      ownerId: request.ownerId,
      ownerEpoch: token,
      fencingToken: token,
      acquiredAt: now,
      expiresAt: now + this.leaseMs,
    }
    state.lastFencingToken = token
    state.lease = lease
    return Promise.resolve({ status: 'granted', lease })
  }

  /** Renew only the exact live ownership identity without changing its fencing token. */
  heartbeat(request: GraphSchedulerLeaseRequest, signal: AbortSignal): Promise<GraphSchedulerLease> {
    signal.throwIfAborted()
    const state = this.runs.get(String(request.runId))
    const lease = state?.lease
    this.assertExact(lease, request)
    if ((lease as GraphSchedulerLease).expiresAt <= request.at) throw new GraphSchedulerAuthorityError('graph scheduler lease expired')
    const renewed = { ...(lease as GraphSchedulerLease), expiresAt: request.at + this.leaseMs }
    ;(state as MemorySchedulerRun).lease = renewed
    return Promise.resolve(renewed)
  }

  /** Release the exact live lease idempotently while rejecting a replacement identity. */
  release(request: GraphSchedulerLeaseRequest, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const state = this.runs.get(String(request.runId))
    if (state?.lease === undefined) return Promise.resolve()
    this.assertExact(state.lease, request)
    delete state.lease
    return Promise.resolve()
  }

  private assertExact(lease: GraphSchedulerLease | undefined, request: GraphSchedulerLeaseRequest): void {
    if (lease === undefined || lease.id !== request.leaseId || lease.generationId !== request.generationId
      || lease.ownerId !== request.ownerId || lease.ownerEpoch !== request.ownerEpoch
      || lease.fencingToken !== request.fencingToken) throw new GraphSchedulerAuthorityError('graph scheduler lease is absent or fenced')
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context { graphScheduler: GraphSchedulerRuntime }
}

const positiveInteger = (value: number, subject: string): void => {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${subject} must be a positive safe integer`)
}

const validateIdentity = (request: GraphSchedulerAcquireRequest | GraphSchedulerLeaseRequest): void => {
  if (!String(request.runId).trim() || !String(request.generationId).trim() || !String(request.ownerId).trim()) {
    throw new Error('graph scheduler run, generation, and owner ids must be non-empty')
  }
  if ('sessionId' in request && !request.sessionId.trim()) throw new Error('graph scheduler sessionId must be non-empty')
}

/** `ctx.graphScheduler`: validates and routes fenced ownership operations. */
export class GraphSchedulerRuntime extends Service {
  private readonly providers = new Map<string, GraphSchedulerProvider>()
  constructor(ctx: Context) { super(ctx, 'graphScheduler') }

  /**
   * Register one named ownership Provider for its Cordis lifetime.
   * @param provider named Provider to expose.
   * @returns disposer that removes this exact registration.
   */
  register(provider: GraphSchedulerProvider): () => void {
    if (!provider.name.trim()) throw new Error('graph scheduler Provider requires a non-empty name')
    if (this.providers.has(provider.name)) throw new Error(`duplicate graph scheduler provider ${provider.name}`)
    this.providers.set(provider.name, provider)
    return () => { if (this.providers.get(provider.name) === provider) this.providers.delete(provider.name) }
  }

  /**
   * Atomically acquire or renew ownership of one run.
   * @param providerId registered Provider name.
   * @param request exact run and Host identity.
   * @param signal cancellation for this Provider operation.
   * @returns granted lease or bounded busy decision.
   */
  async acquire(providerId: string, request: GraphSchedulerAcquireRequest, signal: AbortSignal): Promise<GraphSchedulerDecision> {
    validateIdentity(request)
    positiveInteger(request.minimumOwnerEpoch, 'graph scheduler minimumOwnerEpoch')
    if (!Number.isSafeInteger(request.requestedAt) || request.requestedAt < 0) throw new Error('graph scheduler requestedAt must be a non-negative safe integer')
    const result = await this.requireProvider(providerId).acquire(request, signal)
    if (result.status === 'busy') {
      if (!Number.isSafeInteger(result.retryAt) || result.retryAt <= request.requestedAt || !result.evidence.trim()) throw new Error(`graph scheduler provider ${providerId} returned an invalid busy decision`)
      return result
    }
    this.validateLease(providerId, request, result.lease)
    return result
  }

  /**
   * Renew one exact lease; stale identities fail instead of silently reacquiring.
   * @param request exact current lease identity.
   * @param signal cancellation for this Provider operation.
   * @returns renewed lease with unchanged fencing identity.
   */
  async heartbeat(request: GraphSchedulerLeaseRequest, signal: AbortSignal): Promise<GraphSchedulerLease> {
    this.validateLeaseRequest(request)
    const lease = await this.requireProvider(request.providerId).heartbeat(request, signal)
    this.validateLease(request.providerId, request, lease)
    if (lease.id !== request.leaseId || lease.fencingToken !== request.fencingToken) {
      throw new GraphSchedulerAuthorityError('graph scheduler heartbeat changed the lease identity')
    }
    return lease
  }

  /**
   * Release one exact lease idempotently; a fenced identity is rejected.
   * @param request exact current lease identity.
   * @param signal cancellation for this Provider operation.
   */
  async release(request: GraphSchedulerLeaseRequest, signal: AbortSignal): Promise<void> {
    this.validateLeaseRequest(request)
    await this.requireProvider(request.providerId).release(request, signal)
  }

  private validateLeaseRequest(request: GraphSchedulerLeaseRequest): void {
    validateIdentity(request)
    if (!request.providerId.trim() || !String(request.leaseId).trim()) throw new Error('graph scheduler providerId and leaseId must be non-empty')
    positiveInteger(request.ownerEpoch, 'graph scheduler ownerEpoch')
    positiveInteger(request.fencingToken, 'graph scheduler fencingToken')
    if (!Number.isSafeInteger(request.at) || request.at < 0) throw new Error('graph scheduler lease time must be a non-negative safe integer')
  }

  private validateLease(
    providerId: string,
    request: GraphSchedulerAcquireRequest | GraphSchedulerLeaseRequest,
    lease: GraphSchedulerLease,
  ): void {
    if (lease.providerId !== providerId || lease.runId !== request.runId
      || lease.generationId !== request.generationId || lease.ownerId !== request.ownerId) {
      throw new Error(`graph scheduler provider ${providerId} returned a lease for another owner or run`)
    }
    positiveInteger(lease.ownerEpoch, 'graph scheduler lease ownerEpoch')
    positiveInteger(lease.fencingToken, 'graph scheduler lease fencingToken')
    if ('minimumOwnerEpoch' in request && lease.ownerEpoch < request.minimumOwnerEpoch) {
      throw new Error(`graph scheduler provider ${providerId} returned an ownerEpoch below the requested minimum`)
    }
    if (!String(lease.id).trim() || !lease.sessionId.trim() || !Number.isSafeInteger(lease.acquiredAt) || !Number.isSafeInteger(lease.expiresAt) || lease.expiresAt <= lease.acquiredAt) throw new Error(`graph scheduler provider ${providerId} returned an invalid lease`)
  }

  private requireProvider(name: string): GraphSchedulerProvider {
    const provider = this.providers.get(name)
    if (provider === undefined) throw new Error(`unknown graph scheduler provider ${name}`)
    return provider
  }
}

export default GraphSchedulerRuntime
