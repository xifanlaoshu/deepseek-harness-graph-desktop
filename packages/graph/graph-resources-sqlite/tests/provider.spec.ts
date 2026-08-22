import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GraphControlOperationId, GraphWorkId } from '@deepseek-ai/dsh-graph'
import GraphResourceRuntime from '@deepseek-ai/dsh-graph-resources'
import * as SqlitePlugin from '../src/index.ts'
import { SqliteGraphResourceProvider, type Config } from '../src/index.ts'
import { runGraphResourceProviderContract } from '../../graph-resources/tests/contract.ts'

const roots: string[] = []

afterEach(() => {
  vi.useRealTimers()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const databasePath = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-graph-resources-sqlite-'))
  roots.push(root)
  return join(root, 'resources.sqlite')
}

const config = (path: string, routes: Config['routes'] = [
  {
    provider: 'local', model: 'qwen', concurrencyLimit: 4, weightLimit: 8,
    contextWindow: 128_000, maxOutputTokens: 32_000, memoryClass: '24gb',
  },
]): Config => ({
  providerName: 'sqlite-resources',
  path,
  routes,
  observationTtlMs: 5_000,
  leaseMs: 1_000,
  retryMs: 250,
  oomBackoffMs: 30_000,
  busyTimeoutMs: 5_000,
  telemetryMaxBytes: 65_536,
  journalMode: 'wal',
})

const request = (operation: string, overrides: Partial<ReturnType<typeof requestBase>> = {}) => ({
  ...requestBase(operation),
  ...overrides,
})

const requestBase = (operation: string) => ({
  protocolVersion: 1 as const,
  provider: 'local',
  model: 'qwen',
  workId: GraphWorkId(`work-${operation}`),
  operationId: GraphControlOperationId(operation),
  ownerEpoch: 1,
  weight: 1,
  hardMaxParallel: 2,
  hardMaxWeight: 4,
  requestedAt: Date.now(),
  deadline: Date.now() + 60_000,
})

const unlistedRequest = (operation: string) => {
  const base = requestBase(operation)
  return {
    protocolVersion: base.protocolVersion,
    model: 'other',
    workId: base.workId,
    operationId: base.operationId,
    ownerEpoch: base.ownerEpoch,
    weight: base.weight,
    hardMaxParallel: 1,
    requestedAt: base.requestedAt,
    deadline: base.deadline,
  }
}

const signal = (): AbortSignal => new AbortController().signal

describe('SqliteGraphResourceProvider', () => {
  it('atomically shares the strictest active session ceiling across Provider instances and restarts', async () => {
    const path = databasePath()
    const first = new SqliteGraphResourceProvider('sqlite-resources', path, config(path))
    const second = new SqliteGraphResourceProvider('sqlite-resources', path, config(path))
    const one = await first.reserve(request('one'), signal())
    const two = await second.reserve(request('two', { hardMaxParallel: 4 }), signal())
    expect(one.status).toBe('granted')
    expect(two.status).toBe('granted')
    expect(await first.reserve(request('three', { hardMaxParallel: 4 }), signal()))
      .toMatchObject({ status: 'wait', reason: 'concurrency' })

    first.close()
    const restarted = new SqliteGraphResourceProvider('sqlite-resources', path, config(path))
    expect(await restarted.observe({ provider: 'local', model: 'qwen' }, signal()))
      .toMatchObject({ activeRequests: 2, activeWeight: 2, concurrencyLimit: 2, contextWindow: 128_000 })
    expect(await restarted.reserve(request('one'), signal())).toMatchObject({
      status: 'granted',
      reservation: { workId: GraphWorkId('work-one') },
    })
    restarted.close()
    second.close()
  })

  it('persists OOM backoff and idempotent terminal outcomes across restarts', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const path = databasePath()
    const first = new SqliteGraphResourceProvider('sqlite-resources', path, config(path))
    const decision = await first.reserve(request('oom'), signal())
    if (decision.status !== 'granted') throw new Error('expected a reservation')
    const outcome = {
      reservationId: decision.reservation.id,
      providerId: first.name,
      workId: decision.reservation.workId,
      ownerEpoch: decision.reservation.ownerEpoch,
      fencingToken: decision.reservation.fencingToken,
      outcome: 'oom' as const,
      at: Date.now(),
      evidence: 'model server reported OOM',
    }
    await first.report(outcome, signal())
    first.close()

    const restarted = new SqliteGraphResourceProvider('sqlite-resources', path, config(path))
    expect(await restarted.observe({ provider: 'local', model: 'qwen' }, signal()))
      .toMatchObject({ status: 'degraded', recentOomAt: 1_000_000 })
    expect(await restarted.reserve(request('after-oom'), signal()))
      .toMatchObject({ status: 'wait', reason: 'oom-backoff', retryAt: 1_030_000 })
    await expect(restarted.report({ ...outcome, at: outcome.at + 1 }, signal())).resolves.toBeUndefined()
    await expect(restarted.report({ ...outcome, outcome: 'completed' }, signal())).rejects.toThrow(/conflicting/)
    restarted.close()
  })

  it('admits work from fresh queue and device-memory telemetry and fails closed when it is stale', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_500_000)
    const path = databasePath()
    const telemetryPath = join(path, '..', 'qwen-telemetry.json')
    const telemetry = (overrides: Record<string, unknown> = {}): void => {
      writeFileSync(telemetryPath, JSON.stringify({
        protocolVersion: 1,
        provider: 'local',
        model: 'qwen',
        observedAt: Date.now(),
        expiresAt: Date.now() + 5_000,
        status: 'available',
        activeRequests: 0,
        queueDepth: 0,
        concurrencyLimit: 3,
        availableDeviceBytes: 16_000_000_000,
        ...overrides,
      }))
    }
    const telemetryConfig = config(path, [{
      provider: 'local',
      model: 'qwen',
      concurrencyLimit: 4,
      telemetryPath,
      minimumAvailableDeviceBytesPerWeight: 8_000_000_000,
      maxQueueDepth: 2,
    }])
    const provider = new SqliteGraphResourceProvider('sqlite-resources', path, telemetryConfig)

    telemetry({ queueDepth: 2 })
    await expect(provider.reserve(request('telemetry-queue'), signal()))
      .resolves.toMatchObject({ status: 'wait', reason: 'queue', snapshot: { queueDepth: 2 } })
    telemetry({ availableDeviceBytes: 4_000_000_000 })
    await expect(provider.reserve(request('telemetry-memory'), signal()))
      .resolves.toMatchObject({ status: 'wait', reason: 'memory', snapshot: { availableDeviceBytes: 4_000_000_000 } })
    telemetry()
    await expect(provider.reserve(request('telemetry-granted'), signal()))
      .resolves.toMatchObject({ status: 'granted', reservation: { snapshot: { concurrencyLimit: 2 } } })
    telemetry({ observedAt: Date.now() - 10_000, expiresAt: Date.now() - 5_000 })
    await expect(provider.reserve(request('telemetry-stale'), signal()))
      .resolves.toMatchObject({ status: 'wait', reason: 'provider-degraded', snapshot: { status: 'unavailable' } })
    telemetry({ model: 'another-model' })
    await expect(provider.observe({ provider: 'local', model: 'qwen' }, signal()))
      .rejects.toThrow('targets another protocol or model route')
    provider.close()
  })

  it('fences an expired reservation when the same operation is reacquired', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(2_000_000)
    const path = databasePath()
    const provider = new SqliteGraphResourceProvider('sqlite-resources', path, config(path))
    const first = await provider.reserve(request('reacquire'), signal())
    if (first.status !== 'granted') throw new Error('expected a reservation')
    vi.setSystemTime(2_001_001)
    const second = await provider.reserve(request('reacquire'), signal())
    if (second.status !== 'granted') throw new Error('expected a replacement reservation')
    expect(second.reservation.id).toBe(first.reservation.id)
    expect(second.reservation.fencingToken).toBeGreaterThan(first.reservation.fencingToken)

    const recovery = {
      protocolVersion: 1 as const,
      reservationId: first.reservation.id,
      providerId: provider.name,
      workId: first.reservation.workId,
      ownerEpoch: first.reservation.ownerEpoch,
      fencingToken: first.reservation.fencingToken,
      at: Date.now(),
      evidence: 'recover the expired reservation',
    }
    await expect(provider.reconcile(recovery, signal())).resolves.toMatchObject({ status: 'conflict' })
    await expect(provider.report({
      reservationId: first.reservation.id,
      providerId: provider.name,
      workId: first.reservation.workId,
      ownerEpoch: first.reservation.ownerEpoch,
      fencingToken: first.reservation.fencingToken,
      outcome: 'worker-lost',
      at: Date.now(),
    }, signal())).rejects.toThrow(/absent or fenced/)
    provider.close()
  })

  it('rejects a conflicting live configuration and preserves a foreign database', async () => {
    const path = databasePath()
    const provider = new SqliteGraphResourceProvider('sqlite-resources', path, config(path))
    expect((await provider.reserve(request('active'), signal())).status).toBe('granted')
    expect(() => new SqliteGraphResourceProvider('sqlite-resources', path, config(path, [
      { provider: 'local', model: 'qwen', concurrencyLimit: 1 },
    ]))).toThrow(/configuration differs while durable reservations are active/)
    provider.close()

    const foreignPath = databasePath()
    const foreign = new DatabaseSync(foreignPath)
    foreign.exec('CREATE TABLE user_data(value TEXT); INSERT INTO user_data VALUES (\'safe\')')
    foreign.close()
    expect(() => new SqliteGraphResourceProvider('sqlite-resources', foreignPath, config(foreignPath)))
      .toThrow(/refuses database identity/)
    const unchanged = new DatabaseSync(foreignPath)
    expect(unchanged.prepare('SELECT value FROM user_data').get()).toEqual({ value: 'safe' })
    unchanged.close()
  })

  it('validates provider identity, paths, route facts, duplicates, and closed handles', async () => {
    const path = databasePath()
    expect(() => new SqliteGraphResourceProvider('', path, config(path))).toThrow(/providerName/)
    expect(() => new SqliteGraphResourceProvider('sqlite-resources', 'relative.sqlite', config(path))).toThrow(/absolute/)
    expect(() => new SqliteGraphResourceProvider('sqlite-resources', path, config(path, [{ model: '' }])))
      .toThrow(/normalized/)
    expect(() => new SqliteGraphResourceProvider('sqlite-resources', path, config(path, [{ provider: ' ', model: 'qwen' }])))
      .toThrow(/normalized/)
    expect(() => new SqliteGraphResourceProvider('sqlite-resources', path, config(path, [{ model: 'qwen', memoryClass: ' ' }])))
      .toThrow(/normalized/)
    expect(() => new SqliteGraphResourceProvider('sqlite-resources', path, config(path, [{ model: 'qwen', weightLimit: Number.POSITIVE_INFINITY }])))
      .toThrow(/weightLimit/)
    expect(() => new SqliteGraphResourceProvider('sqlite-resources', path, config(path, [{ model: 'qwen', weightLimit: 0 }])))
      .toThrow(/weightLimit/)
    expect(() => new SqliteGraphResourceProvider('sqlite-resources', path, config(path, [{ model: 'qwen', telemetryPath: ' ' }])))
      .toThrow(/telemetryPath/)
    expect(() => new SqliteGraphResourceProvider('sqlite-resources', path, config(path, [
      { model: 'qwen' }, { model: 'qwen' },
    ]))).toThrow(/duplicate/)

    const provider = new SqliteGraphResourceProvider('sqlite-resources', path, config(path, [
      { model: 'zeta' }, { model: 'alpha' },
    ]))
    provider.close()
    provider.close()
    await expect(provider.observe({ model: 'alpha' }, signal())).rejects.toThrow(/closed/)
  })

  it('accepts a drained configuration replacement and fences stale open Providers', async () => {
    const path = databasePath()
    const oldProvider = new SqliteGraphResourceProvider('sqlite-resources', path, config(path))
    const replacement = new SqliteGraphResourceProvider('sqlite-resources', path, config(path, [
      { provider: 'local', model: 'qwen', concurrencyLimit: 1 },
    ]))
    await expect(oldProvider.observe({ provider: 'local', model: 'qwen' }, signal()))
      .rejects.toThrow(/configuration changed/)
    replacement.close()
    oldProvider.close()

    const missingHashPath = databasePath()
    const missingHash = new SqliteGraphResourceProvider('sqlite-resources', missingHashPath, config(missingHashPath))
    const mutator = new DatabaseSync(missingHashPath)
    mutator.exec("DELETE FROM graph_resource_meta WHERE key = 'config_hash'")
    mutator.close()
    await expect(missingHash.observe({ provider: 'local', model: 'qwen' }, signal()))
      .rejects.toThrow(/configuration changed/)
    missingHash.close()
  })

  it('rejects an unsupported schema version and malformed durable numeric or text fields', async () => {
    const versionPath = databasePath()
    const initialized = new SqliteGraphResourceProvider('sqlite-resources', versionPath, config(versionPath))
    initialized.close()
    const versionMutator = new DatabaseSync(versionPath)
    versionMutator.exec('PRAGMA user_version = 2')
    versionMutator.close()
    expect(() => new SqliteGraphResourceProvider('sqlite-resources', versionPath, config(versionPath)))
      .toThrow(/refuses database identity/)

    const numberPath = databasePath()
    const malformedNumber = new SqliteGraphResourceProvider('sqlite-resources', numberPath, config(numberPath))
    const numberMutator = new DatabaseSync(numberPath)
    numberMutator.prepare(`INSERT INTO graph_resource_reservations(
      reservation_id, provider_key, model, work_id, operation_id, owner_epoch, weight,
      hard_max_parallel, hard_max_weight, acquired_at, expires_at
    ) VALUES('bad', 'local', 'qwen', 'work', 'operation', 1, 1, 'bad', NULL, 1, ?)`)
      .run(Date.now() + 60_000)
    numberMutator.close()
    await expect(malformedNumber.observe({ provider: 'local', model: 'qwen' }, signal()))
      .rejects.toThrow(/finite SQLite number/)
    malformedNumber.close()

    const textPath = databasePath()
    const malformedText = new SqliteGraphResourceProvider('sqlite-resources', textPath, config(textPath))
    const textMutator = new DatabaseSync(textPath)
    textMutator.exec("UPDATE graph_resource_meta SET value = X'01' WHERE key = 'config_hash'")
    textMutator.close()
    await expect(malformedText.observe({ provider: 'local', model: 'qwen' }, signal()))
      .rejects.toThrow(/SQLite text/)
    malformedText.close()
  })

  it('supports unlisted default-provider routes and terminal release without optional limits', async () => {
    const path = databasePath()
    const provider = new SqliteGraphResourceProvider('sqlite-resources', path, config(path, []))
    const decision = await provider.reserve(unlistedRequest('unlisted'), signal())
    if (decision.status !== 'granted') throw new Error('expected a reservation')
    expect(decision.reservation).not.toHaveProperty('provider')
    expect(await provider.reserve(unlistedRequest('unlisted'), signal()))
      .toMatchObject({ status: 'granted', reservation: { model: 'other' } })
    expect(await provider.observe({ model: 'other' }, signal())).toMatchObject({
      status: 'available', activeRequests: 1, concurrencyLimit: 1,
    })
    await provider.report({
      reservationId: decision.reservation.id,
      providerId: provider.name,
      workId: decision.reservation.workId,
      ownerEpoch: decision.reservation.ownerEpoch,
      fencingToken: decision.reservation.fencingToken,
      outcome: 'completed',
      at: Date.now(),
    }, signal())
    const empty = await provider.observe({ model: 'never-reserved' }, signal())
    expect(empty).not.toHaveProperty('concurrencyLimit')
    expect(empty).not.toHaveProperty('weightLimit')
    provider.close()
  })

  it('distinguishes impossible weight, occupied weight, and persisted rate-limit backoff', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(3_000_000)
    const path = databasePath()
    const provider = new SqliteGraphResourceProvider('sqlite-resources', path, config(path))
    expect(await provider.reserve(request('impossible', { weight: 9, hardMaxWeight: 10 }), signal()))
      .toMatchObject({ status: 'rejected', reason: 'request-impossible' })
    const first = await provider.reserve(request('weighted-one', { weight: 2, hardMaxWeight: 3 }), signal())
    if (first.status !== 'granted') throw new Error('expected a reservation')
    expect(await provider.reserve(request('weighted-two', { weight: 2, hardMaxWeight: 3 }), signal()))
      .toMatchObject({ status: 'wait', reason: 'weight' })
    await provider.report({
      reservationId: first.reservation.id,
      providerId: provider.name,
      workId: first.reservation.workId,
      ownerEpoch: first.reservation.ownerEpoch,
      fencingToken: first.reservation.fencingToken,
      outcome: 'rate-limited',
      at: Date.now(),
      retryAfterMs: 2_000,
      evidence: 'server retry-after',
    }, signal())
    expect(await provider.reserve(request('during-rate-limit'), signal()))
      .toMatchObject({ status: 'wait', reason: 'rate-limit', retryAt: 3_002_000 })
    vi.setSystemTime(3_002_001)
    const after = await provider.reserve(request('after-rate-limit'), signal())
    if (after.status !== 'granted') throw new Error('expected a reservation')
    await provider.report({
      reservationId: after.reservation.id,
      providerId: provider.name,
      workId: after.reservation.workId,
      ownerEpoch: after.reservation.ownerEpoch,
      fencingToken: after.reservation.fencingToken,
      outcome: 'rate-limited',
      at: Date.now(),
    }, signal())
    provider.close()
  })

  it('rejects conflicting reservation replays at every frozen request field', async () => {
    const path = databasePath()
    const provider = new SqliteGraphResourceProvider('sqlite-resources', path, config(path))
    expect((await provider.reserve(request('same'), signal())).status).toBe('granted')
    const conflicts = [
      request('same', { provider: 'other' }),
      request('same', { model: 'other' }),
      request('same', { workId: GraphWorkId('other-work') }),
      request('same', { weight: 2 }),
      request('same', { hardMaxParallel: 3 }),
      request('same', { hardMaxWeight: 3 }),
    ]
    for (const conflict of conflicts) {
      await expect(provider.reserve(conflict, signal())).rejects.toThrow(/conflicting Graph resource reservation/)
    }
    provider.close()
  })

  it('validates reports and reconciles active, terminal, conflicting, and absent identities', async () => {
    const path = databasePath()
    const provider = new SqliteGraphResourceProvider('sqlite-resources', path, config(path))
    const decision = await provider.reserve(request('reconcile'), signal())
    if (decision.status !== 'granted') throw new Error('expected a reservation')
    const terminal = {
      reservationId: decision.reservation.id,
      providerId: provider.name,
      workId: decision.reservation.workId,
      ownerEpoch: decision.reservation.ownerEpoch,
      fencingToken: decision.reservation.fencingToken,
      outcome: 'completed' as const,
      at: Date.now(),
    }
    await expect(provider.report({ ...terminal, providerId: 'other' }, signal())).rejects.toThrow(/targets other/)
    await expect(provider.report({ ...terminal, evidence: 'x'.repeat(4_001) }, signal())).rejects.toThrow(/4000/)
    await expect(provider.report({ ...terminal, workId: GraphWorkId('wrong') }, signal())).rejects.toThrow(/absent or fenced/)
    await expect(provider.report({ ...terminal, ownerEpoch: 2 }, signal())).rejects.toThrow(/absent or fenced/)

    const recovery = {
      protocolVersion: 1 as const,
      reservationId: decision.reservation.id,
      providerId: provider.name,
      workId: decision.reservation.workId,
      ownerEpoch: decision.reservation.ownerEpoch,
      fencingToken: decision.reservation.fencingToken,
      at: Date.now(),
      evidence: 'scheduler recovery',
    }
    await expect(provider.reconcile({ ...recovery, providerId: 'other' }, signal())).resolves.toMatchObject({ status: 'conflict' })
    await expect(provider.reconcile({ ...recovery, workId: GraphWorkId('wrong') }, signal())).resolves.toMatchObject({ status: 'conflict' })
    await expect(provider.reconcile({ ...recovery, ownerEpoch: 2 }, signal())).resolves.toMatchObject({ status: 'conflict' })
    await expect(provider.reconcile(recovery, signal())).resolves.toMatchObject({ status: 'released' })
    await expect(provider.reconcile(recovery, signal())).resolves.toMatchObject({ status: 'already-released' })
    await expect(provider.reconcile({ ...recovery, workId: GraphWorkId('wrong') }, signal())).resolves.toMatchObject({ status: 'conflict' })
    await expect(provider.reconcile({
      ...recovery,
      reservationId: `${recovery.reservationId}-missing` as typeof recovery.reservationId,
    }, signal())).resolves.toMatchObject({ status: 'absent' })
    await expect(provider.report({
      ...terminal,
      reservationId: `${terminal.reservationId}-missing` as typeof terminal.reservationId,
    }, signal())).rejects.toThrow(/absent or fenced/)
    provider.close()
  })

  it('registers and unregisters through the Cordis lifecycle', async () => {
    const path = databasePath()
    const ctx = new Context()
    await ctx.plugin(GraphResourceRuntime)
    const scope = ctx.plugin(SqlitePlugin, config(path))
    await scope
    expect(await ctx.graphResources.observe('sqlite-resources', { provider: 'local', model: 'qwen' }, signal()))
      .toMatchObject({ status: 'available' })
    await scope.dispose()
    await expect(ctx.graphResources.observe('sqlite-resources', { provider: 'local', model: 'qwen' }, signal()))
      .rejects.toThrow(/unknown graph resource provider/)
    await ctx.fiber.dispose()
  })
})

runGraphResourceProviderContract('sqlite', () => {
  const path = databasePath()
  const provider = new SqliteGraphResourceProvider('sqlite-resources', path, config(path, [
    { provider: 'local', model: 'qwen', concurrencyLimit: 1, weightLimit: 2 },
  ]))
  return {
    provider,
    route: { provider: 'local', model: 'qwen' },
    dispose: () => { provider.close() },
  }
})
