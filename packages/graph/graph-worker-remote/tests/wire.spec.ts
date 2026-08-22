import { describe, expect, it } from 'vitest'
import {
  GraphWorkerRemoteAudienceId,
  GraphWorkerRemotePrincipalId,
  GraphWorkerReplayGuard,
  signGraphWorkerRequest,
  type GraphWorkerAuthHeaders,
} from '../src/wire.ts'

const principal = GraphWorkerRemotePrincipalId('host-east-1')
const audience = GraphWorkerRemoteAudienceId('worker-west-2')
const secret = '0123456789abcdef0123456789abcdef'
const timestamp = 1_800_000_000_000
const nonce = 'abcdefghijklmnopqrstuvwxyzABCDEF'

function signed(body = '{"workId":"work-1"}', path = '/graph-worker/v1/start'): GraphWorkerAuthHeaders {
  return signGraphWorkerRequest({ method: 'POST', path, body, principal, audience, secret, timestamp, nonce })
}

function guard(options: Partial<ConstructorParameters<typeof GraphWorkerReplayGuard>[0]> = {}): GraphWorkerReplayGuard {
  return new GraphWorkerReplayGuard({
    maxClockSkewMs: 30_000,
    maxBodyBytes: 1_024,
    maxEntries: 10,
    ...options,
  })
}

describe('remote Graph Worker wire authentication', () => {
  it('binds the principal, method, path, timestamp, nonce, and body then consumes the nonce once', () => {
    const body = '{"workId":"work-1"}'
    const headers = signed(body)
    const verifier = guard()
    const request = {
      method: 'POST', path: '/graph-worker/v1/start', body, headers,
      expectedAudience: audience,
      resolveSecret: (candidate: typeof principal) => candidate === principal ? secret : undefined,
      now: timestamp + 1_000,
    }

    expect(verifier.verify(request)).toEqual({
      principal,
      audience,
      timestamp,
      nonce,
      bodySha256: '4763e324c7bd1c2a1b3a730368702067e55fac8776efa236735214a1eb5ac593',
    })
    expect(() => verifier.verify(request)).toThrow('nonce was already used')
  })

  it.each([
    ['method', { method: 'PUT' }],
    ['path', { path: '/graph-worker/v1/cancel' }],
    ['body', { body: '{"workId":"work-2"}' }],
  ])('rejects a signed request after its %s changes', (_label, replacement) => {
    const body = '{"workId":"work-1"}'
    expect(() => guard().verify({
      method: 'POST', path: '/graph-worker/v1/start', body, headers: signed(body),
      expectedAudience: audience,
      resolveSecret: () => secret,
      now: timestamp,
      ...replacement,
    })).toThrow('authentication failed')
  })

  it('does not reveal whether the principal or secret was wrong', () => {
    const headers = { ...signed(), 'x-dsh-worker-principal': 'unknown-host' }
    expect(() => guard().verify({
      method: 'POST', path: '/graph-worker/v1/start', body: '{"workId":"work-1"}', headers,
      expectedAudience: audience,
      resolveSecret: () => undefined,
      now: timestamp,
    })).toThrow('request authentication failed')
    expect(() => guard().verify({
      method: 'POST', path: '/graph-worker/v1/start', body: '{"workId":"work-1"}', headers: signed(),
      expectedAudience: audience,
      resolveSecret: () => 'fedcba9876543210fedcba9876543210',
      now: timestamp,
    })).toThrow('request authentication failed')
    expect(() => guard().verify({
      method: 'POST', path: '/graph-worker/v1/start', body: '{"workId":"work-1"}', headers: signed(),
      expectedAudience: audience,
      resolveSecret: () => 'too-short',
      now: timestamp,
    })).toThrow('request authentication failed')
  })

  it('rejects stale and future requests outside the same absolute clock window', () => {
    const headers = signed()
    for (const now of [timestamp - 30_001, timestamp + 30_001]) {
      expect(() => guard().verify({
        method: 'POST', path: '/graph-worker/v1/start', body: '{"workId":"work-1"}', headers,
        expectedAudience: audience,
        resolveSecret: () => secret,
        now,
      })).toThrow('outside the accepted clock window')
    }
  })

  it('fails closed at replay-cache capacity and admits a new nonce only after expiry', () => {
    const verifier = guard({ maxClockSkewMs: 10, maxEntries: 1 })
    const first = signed()
    verifier.verify({
      method: 'POST', path: '/graph-worker/v1/start', body: '{"workId":"work-1"}', headers: first,
      expectedAudience: audience,
      resolveSecret: () => secret,
      now: timestamp,
    })
    const second = signGraphWorkerRequest({
      method: 'POST', path: '/graph-worker/v1/start', body: '{}', principal, audience, secret,
      timestamp: timestamp + 1,
      nonce: '0123456789abcdefghijklmnopqrstuv',
    })
    expect(() => verifier.verify({
      method: 'POST', path: '/graph-worker/v1/start', body: '{}', headers: second,
      expectedAudience: audience,
      resolveSecret: () => secret,
      now: timestamp + 1,
    })).toThrow('replay cache is saturated')
    expect(verifier.verify({
      method: 'POST', path: '/graph-worker/v1/start', body: '{}', headers: second,
      expectedAudience: audience,
      resolveSecret: () => secret,
      now: timestamp + 11,
    })).toMatchObject({ principal, audience, nonce: '0123456789abcdefghijklmnopqrstuv' })
  })

  it('enforces request and credential bounds before accepting authentication', () => {
    expect(() => guard({ maxBodyBytes: 1 }).verify({
      method: 'POST', path: '/graph-worker/v1/start', body: '{}', headers: signed('{}'),
      expectedAudience: audience,
      resolveSecret: () => secret,
      now: timestamp,
    })).toThrow('body exceeds the configured byte limit')
    expect(() => signGraphWorkerRequest({
      method: 'POST', path: '/graph-worker/v1/start', body: '{}', principal, audience,
      secret: 'too-short', timestamp, nonce,
    })).toThrow('secret must be 32..4096 UTF-8 bytes')
  })

  it('rejects malformed identities, request targets, nonces, and policy bounds', () => {
    expect(() => GraphWorkerRemotePrincipalId('not allowed')).toThrow('principal')
    expect(() => GraphWorkerRemoteAudienceId('not allowed')).toThrow('audience')
    expect(() => signGraphWorkerRequest({ method: 'post', path: '/x', body: '', principal, audience, secret, timestamp, nonce })).toThrow('method')
    expect(() => signGraphWorkerRequest({ method: 'POST', path: 'relative', body: '', principal, audience, secret, timestamp, nonce })).toThrow('path')
    expect(() => signGraphWorkerRequest({ method: 'POST', path: '/x', body: '', principal, audience, secret, timestamp, nonce: 'short' })).toThrow('nonce')
    expect(() => new GraphWorkerReplayGuard({ maxClockSkewMs: 0, maxBodyBytes: 1, maxEntries: 1 })).toThrow('maxClockSkewMs')
    expect(() => new GraphWorkerReplayGuard({ maxClockSkewMs: 1, maxBodyBytes: 0, maxEntries: 1 })).toThrow('maxBodyBytes')
    expect(() => new GraphWorkerReplayGuard({ maxClockSkewMs: 1, maxBodyBytes: 1, maxEntries: 0 })).toThrow('maxEntries')
  })
})
