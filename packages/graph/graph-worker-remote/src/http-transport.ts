/** Shared bounded authenticated HTTP transport for Graph Worker service capabilities. @module */

import { isIP } from 'node:net'
import { signGraphWorkerRequest, type GraphWorkerRemoteAudienceId, type GraphWorkerRemotePrincipalId } from './wire.ts'

/** Fetch-compatible function used by authenticated Graph HTTP Clients. */
export type GraphHttpFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

/** Shared identity, credential, and response policy for one Graph HTTP service. */
export interface AuthenticatedGraphHttpOptions {
  readonly endpoint: string
  readonly principal: GraphWorkerRemotePrincipalId
  readonly audience: GraphWorkerRemoteAudienceId
  readonly resolveSecret: () => Promise<string | undefined>
  readonly requestTimeoutMs: number
  readonly maxResponseBytes: number
  readonly allowInsecureLoopback: boolean
  readonly fetcher?: GraphHttpFetch
}

/** HTTP failure classification used by idempotent operation retry policy. */
export class GraphHttpError extends Error {
  /**
   * Create one transport or status failure.
   * @param message - public-safe operation diagnostic.
   * @param retryable - whether an idempotent caller may retry the exact request.
   * @param options - optional causal error.
   */
  constructor(message: string, readonly retryable: boolean, options?: ErrorOptions) {
    super(message, options)
  }
}

function validate(options: AuthenticatedGraphHttpOptions): URL {
  if (!Number.isSafeInteger(options.requestTimeoutMs) || options.requestTimeoutMs < 1) {
    throw new Error('authenticated Graph HTTP requestTimeoutMs must be positive')
  }
  if (!Number.isSafeInteger(options.maxResponseBytes) || options.maxResponseBytes < 1) {
    throw new Error('authenticated Graph HTTP maxResponseBytes must be positive')
  }
  const endpoint = new URL(options.endpoint)
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('authenticated Graph HTTP endpoint must not contain credentials, query, or fragment')
  }
  const loopback = endpoint.hostname === 'localhost' || endpoint.hostname === '::1' || endpoint.hostname === '[::1]'
    || isIP(endpoint.hostname) === 4 && endpoint.hostname.startsWith('127.')
  if (endpoint.protocol !== 'https:' && !(options.allowInsecureLoopback && endpoint.protocol === 'http:' && loopback)) {
    throw new Error('authenticated Graph HTTP endpoint requires HTTPS; insecure HTTP is allowed only for explicit loopback development')
  }
  endpoint.pathname = endpoint.pathname.replace(/\/$/u, '')
  return endpoint
}

async function boundedText(response: Response, maxBytes: number): Promise<string> {
  const declared = response.headers.get('content-length')
  if (declared !== null && Number(declared) > maxBytes) throw new Error('authenticated Graph HTTP response exceeds the configured byte limit')
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      total += next.value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        throw new Error('authenticated Graph HTTP response exceeds the configured byte limit')
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

/** Bounded signer and JSON POST transport shared by remote Graph capabilities. */
export class AuthenticatedGraphHttpTransport {
  private readonly endpoint: URL
  private readonly fetcher: GraphHttpFetch

  /**
   * Validate and retain one service route without resolving its rotating secret.
   * @param options - endpoint, deployment identities, credential resolver, and bounds.
   */
  constructor(private readonly options: AuthenticatedGraphHttpOptions) {
    this.endpoint = validate(options)
    this.fetcher = options.fetcher ?? globalThis.fetch
  }

  /**
   * Sign and send one exact JSON operation.
   * @param path - service-relative absolute operation path below the endpoint.
   * @param payload - JSON-serializable operation body.
   * @param signal - caller cancellation.
   * @returns parsed JSON response.
   */
  async post(path: string, payload: object, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted()
    if (!path.startsWith('/') || path.includes('?') || path.includes('#')) throw new Error('authenticated Graph HTTP operation path is invalid')
    const secret = await this.options.resolveSecret()
    if (secret === undefined) throw new Error('authenticated Graph HTTP credential is not configured')
    const target = new URL(`${this.endpoint.pathname}${path}`, this.endpoint)
    const body = JSON.stringify(payload)
    const authentication = signGraphWorkerRequest({
      method: 'POST',
      path: target.pathname,
      body,
      principal: this.options.principal,
      audience: this.options.audience,
      secret,
    })
    let response: Response
    try {
      response = await this.fetcher(target, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authentication },
        body,
        redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(this.options.requestTimeoutMs)]),
      })
    } catch (error) {
      signal.throwIfAborted()
      throw new GraphHttpError(`authenticated Graph HTTP ${path} transport failed`, true, { cause: error })
    }
    const text = await boundedText(response, this.options.maxResponseBytes)
    if (!response.ok) {
      const retryable = response.status === 408 || response.status === 429 || response.status >= 500
      throw new GraphHttpError(`authenticated Graph HTTP ${path} failed with HTTP ${String(response.status)}${text ? `: ${text}` : ''}`, retryable)
    }
    try {
      return JSON.parse(text)
    } catch (error) {
      throw new GraphHttpError(`authenticated Graph HTTP ${path} returned invalid JSON`, false, { cause: error })
    }
  }
}
