/**
 * Authentication vocabulary shared by remote Graph Worker clients and servers.
 * The signature binds one exact HTTP request target and body to a deployment
 * principal while {@link GraphWorkerReplayGuard} rejects stale or repeated use.
 * @module @deepseek-ai/dsh-graph-worker-remote
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Authenticated deployment identity of one remote Graph Worker caller. */
export type GraphWorkerRemotePrincipalId = Branded<'GraphWorkerRemotePrincipalId'>

/**
 * Brand and validate a remote Worker deployment identity.
 * @param value - normalized ASCII identity configured on both peers.
 * @returns the branded identity.
 */
export function GraphWorkerRemotePrincipalId(value: string): GraphWorkerRemotePrincipalId {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) {
    throw new TypeError('remote Graph Worker principal must be 1..128 ASCII identifier characters')
  }
  return value as GraphWorkerRemotePrincipalId
}

/** Authenticated deployment identity of one remote Graph Worker service. */
export type GraphWorkerRemoteAudienceId = Branded<'GraphWorkerRemoteAudienceId'>

/**
 * Brand and validate a remote Worker service audience.
 * @param value - normalized ASCII service identity configured on both peers.
 * @returns the branded audience identity.
 */
export function GraphWorkerRemoteAudienceId(value: string): GraphWorkerRemoteAudienceId {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) {
    throw new TypeError('remote Graph Worker audience must be 1..128 ASCII identifier characters')
  }
  return value as GraphWorkerRemoteAudienceId
}

/** Stable remote service identity of one accepted Graph Worker job. */
export type GraphWorkerRemoteJobId = Branded<'GraphWorkerRemoteJobId'>

/**
 * Brand a server-validated remote Worker job identity.
 * @param value - bounded opaque job identity returned by the Worker service.
 * @returns the branded job identity.
 */
export function GraphWorkerRemoteJobId(value: string): GraphWorkerRemoteJobId {
  if (!value || value.length > 512 || /[\r\n]/u.test(value)) throw new TypeError('remote Graph Worker job id must be bounded non-empty text')
  return value as GraphWorkerRemoteJobId
}

/** Headers carrying one authenticated remote Worker request. */
export interface GraphWorkerAuthHeaders {
  readonly 'x-dsh-worker-principal': string
  readonly 'x-dsh-worker-audience': string
  readonly 'x-dsh-worker-timestamp': string
  readonly 'x-dsh-worker-nonce': string
  readonly 'x-dsh-worker-signature': string
}

/** Input used to sign one exact remote Worker request. */
export interface GraphWorkerSignRequest {
  readonly method: string
  readonly path: string
  readonly body: string | Uint8Array
  readonly principal: GraphWorkerRemotePrincipalId
  readonly audience: GraphWorkerRemoteAudienceId
  readonly secret: string
  /** Milliseconds since the Unix epoch; defaults to the current time. */
  readonly timestamp?: number
  /** Base64url nonce; generated cryptographically when omitted. */
  readonly nonce?: string
}

/** Input used to authenticate one exact remote Worker request. */
export interface GraphWorkerVerifyRequest {
  readonly method: string
  readonly path: string
  readonly body: string | Uint8Array
  readonly headers: GraphWorkerAuthHeaders
  readonly expectedAudience: GraphWorkerRemoteAudienceId
  /** Resolve the current secret for the asserted deployment principal. */
  readonly resolveSecret: (principal: GraphWorkerRemotePrincipalId) => string | undefined
  /** Current milliseconds since the Unix epoch; defaults to the current time. */
  readonly now?: number
}

/** Successful request authentication evidence safe to retain in operation logs. */
export interface GraphWorkerAuthenticatedRequest {
  readonly principal: GraphWorkerRemotePrincipalId
  readonly audience: GraphWorkerRemoteAudienceId
  readonly timestamp: number
  readonly nonce: string
  readonly bodySha256: string
}

/** Replay-window policy for an authenticated remote Worker endpoint. */
export interface GraphWorkerReplayGuardOptions {
  /** Maximum absolute clock difference accepted for a request. */
  readonly maxClockSkewMs: number
  /** Maximum request-body bytes authenticated by this endpoint. */
  readonly maxBodyBytes: number
  /** Maximum unexpired principal/nonce entries retained in memory. */
  readonly maxEntries: number
}

const NONCE_PATTERN = /^[A-Za-z0-9_-]{22,128}$/u
const SIGNATURE_PATTERN = /^[a-f0-9]{64}$/u
const MIN_SECRET_BYTES = 32
const MAX_SECRET_BYTES = 4_096

function assertSafeTime(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be a non-negative safe integer`)
}

function normalizedMethod(value: string): string {
  if (!/^[A-Z]+$/u.test(value)) throw new TypeError('remote Graph Worker method must be normalized uppercase ASCII')
  return value
}

function normalizedPath(value: string): string {
  if (!value.startsWith('/') || value.length > 2_048 || value.includes('#') || /[\r\n]/u.test(value)) {
    throw new TypeError('remote Graph Worker path must be an absolute request target without a fragment')
  }
  return value
}

function bodyBytes(value: string | Uint8Array): Uint8Array {
  return typeof value === 'string' ? Buffer.from(value, 'utf8') : value
}

function assertSecret(value: string): void {
  const bytes = Buffer.byteLength(value, 'utf8')
  if (bytes < MIN_SECRET_BYTES || bytes > MAX_SECRET_BYTES) {
    throw new TypeError(`remote Graph Worker secret must be ${String(MIN_SECRET_BYTES)}..${String(MAX_SECRET_BYTES)} UTF-8 bytes`)
  }
}

function validSecret(value: string): boolean {
  const bytes = Buffer.byteLength(value, 'utf8')
  return bytes >= MIN_SECRET_BYTES && bytes <= MAX_SECRET_BYTES
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function signingPayload(
  method: string,
  path: string,
  principal: GraphWorkerRemotePrincipalId,
  audience: GraphWorkerRemoteAudienceId,
  timestamp: number,
  nonce: string,
  bodySha256: string,
): string {
  return ['DSH-GRAPH-WORKER-V1', method, path, principal, audience, String(timestamp), nonce, bodySha256].join('\n')
}

function signature(
  secret: string,
  method: string,
  path: string,
  principal: GraphWorkerRemotePrincipalId,
  audience: GraphWorkerRemoteAudienceId,
  timestamp: number,
  nonce: string,
  bodySha256: string,
): string {
  return createHmac('sha256', secret)
    .update(signingPayload(method, path, principal, audience, timestamp, nonce, bodySha256), 'utf8')
    .digest('hex')
}

/**
 * Sign one exact request without retaining its secret or body.
 * @param request - target, body, deployment identity, secret, and optional clock/nonce.
 * @returns headers accepted by {@link GraphWorkerReplayGuard.verify}.
 */
export function signGraphWorkerRequest(request: GraphWorkerSignRequest): GraphWorkerAuthHeaders {
  const method = normalizedMethod(request.method)
  const path = normalizedPath(request.path)
  GraphWorkerRemotePrincipalId(request.principal)
  GraphWorkerRemoteAudienceId(request.audience)
  assertSecret(request.secret)
  const timestamp = request.timestamp ?? Date.now()
  assertSafeTime(timestamp, 'remote Graph Worker timestamp')
  const nonce = request.nonce ?? randomBytes(24).toString('base64url')
  if (!NONCE_PATTERN.test(nonce)) throw new TypeError('remote Graph Worker nonce must be 22..128 base64url characters')
  const bodySha256 = digest(bodyBytes(request.body))
  return {
    'x-dsh-worker-principal': request.principal,
    'x-dsh-worker-audience': request.audience,
    'x-dsh-worker-timestamp': String(timestamp),
    'x-dsh-worker-nonce': nonce,
    'x-dsh-worker-signature': signature(request.secret, method, path, request.principal, request.audience, timestamp, nonce, bodySha256),
  }
}

/**
 * Stateful verifier for one server process. It rejects replay-cache saturation
 * instead of evicting an unexpired nonce and weakening replay protection.
 */
export class GraphWorkerReplayGuard {
  private readonly seen = new Map<string, number>()

  /**
   * Create a replay guard with explicit bounds.
   * @param options - clock, request-size, and retained-entry ceilings.
   */
  constructor(private readonly options: GraphWorkerReplayGuardOptions) {
    if (!Number.isSafeInteger(options.maxClockSkewMs) || options.maxClockSkewMs < 1) {
      throw new TypeError('remote Graph Worker maxClockSkewMs must be a positive safe integer')
    }
    if (!Number.isSafeInteger(options.maxBodyBytes) || options.maxBodyBytes < 1) {
      throw new TypeError('remote Graph Worker maxBodyBytes must be a positive safe integer')
    }
    if (!Number.isSafeInteger(options.maxEntries) || options.maxEntries < 1) {
      throw new TypeError('remote Graph Worker maxEntries must be a positive safe integer')
    }
  }

  /**
   * Authenticate and consume one request nonce.
   * @param request - exact request data, asserted headers, secret resolver, and optional clock.
   * @returns bounded public-safe authentication evidence.
   * @throws when any field, signature, clock, body bound, replay, or cache-capacity check fails.
   */
  verify(request: GraphWorkerVerifyRequest): GraphWorkerAuthenticatedRequest {
    const method = normalizedMethod(request.method)
    const path = normalizedPath(request.path)
    const body = bodyBytes(request.body)
    if (body.byteLength > this.options.maxBodyBytes) throw new Error('remote Graph Worker request body exceeds the configured byte limit')
    const principal = GraphWorkerRemotePrincipalId(request.headers['x-dsh-worker-principal'])
    const audience = GraphWorkerRemoteAudienceId(request.headers['x-dsh-worker-audience'])
    if (audience !== request.expectedAudience) throw new Error('remote Graph Worker request authentication failed')
    const timestamp = Number(request.headers['x-dsh-worker-timestamp'])
    assertSafeTime(timestamp, 'remote Graph Worker timestamp')
    const now = request.now ?? Date.now()
    assertSafeTime(now, 'remote Graph Worker verifier time')
    if (Math.abs(now - timestamp) > this.options.maxClockSkewMs) throw new Error('remote Graph Worker request timestamp is outside the accepted clock window')
    const nonce = request.headers['x-dsh-worker-nonce']
    if (!NONCE_PATTERN.test(nonce)) throw new TypeError('remote Graph Worker nonce must be 22..128 base64url characters')
    const supplied = request.headers['x-dsh-worker-signature']
    if (!SIGNATURE_PATTERN.test(supplied)) throw new Error('remote Graph Worker request authentication failed')
    const secret = request.resolveSecret(principal)
    if (secret === undefined || !validSecret(secret)) throw new Error('remote Graph Worker request authentication failed')
    const bodySha256 = digest(body)
    const expected = signature(secret, method, path, principal, audience, timestamp, nonce, bodySha256)
    if (!timingSafeEqual(Buffer.from(supplied, 'hex'), Buffer.from(expected, 'hex'))) {
      throw new Error('remote Graph Worker request authentication failed')
    }
    this.prune(now)
    const replayKey = `${principal}\u0000${nonce}`
    if (this.seen.has(replayKey)) throw new Error('remote Graph Worker request nonce was already used')
    if (this.seen.size >= this.options.maxEntries) throw new Error('remote Graph Worker replay cache is saturated')
    this.seen.set(replayKey, timestamp + this.options.maxClockSkewMs)
    return { principal, audience, timestamp, nonce, bodySha256 }
  }

  private prune(now: number): void {
    for (const [key, expiresAt] of this.seen) {
      if (expiresAt < now) this.seen.delete(key)
    }
  }
}
