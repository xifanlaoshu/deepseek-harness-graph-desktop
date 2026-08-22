import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GraphRunGenerationId, GraphRunId } from '@deepseek-ai/dsh-graph'
import GraphSchedulerRuntime, { GraphSchedulerOwnerId, type GraphSchedulerLease } from '@deepseek-ai/dsh-graph-scheduler'
import * as SqlitePlugin from '../src/index.ts'
import { SqliteGraphSchedulerProvider, type Config } from '../src/index.ts'
import { runGraphSchedulerProviderContract } from '../../graph-scheduler/tests/contract.ts'

const roots: string[] = []
afterEach(() => { vi.useRealTimers(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const databasePath = (): string => { const root = mkdtempSync(join(tmpdir(), 'dsh-graph-scheduler-')); roots.push(root); return join(root, 'scheduler.sqlite') }
const config = (path: string, leaseMs = 1_000): Config => ({ providerName: 'sqlite-scheduler', path, leaseMs, retryMs: 100, busyTimeoutMs: 5_000, journalMode: 'wal' })
const acquire = (owner: string, generation = 'generation', minimumOwnerEpoch = 1) => ({ protocolVersion: 1 as const, sessionId: 'session', runId: GraphRunId('run'), generationId: GraphRunGenerationId(generation), ownerId: GraphSchedulerOwnerId(owner), minimumOwnerEpoch, requestedAt: Date.now() })
const exact = (lease: GraphSchedulerLease) => ({
  protocolVersion: 1 as const,
  providerId: lease.providerId,
  leaseId: lease.id,
  runId: lease.runId,
  generationId: lease.generationId,
  ownerId: lease.ownerId,
  ownerEpoch: lease.ownerEpoch,
  fencingToken: lease.fencingToken,
  at: Date.now(),
})

runGraphSchedulerProviderContract('sqlite', () => {
  const path = databasePath()
  const provider = new SqliteGraphSchedulerProvider('sqlite-scheduler', path, config(path, 60_000))
  return { provider, dispose: () => { provider.close() } }
})
const signal = (): AbortSignal => new AbortController().signal

describe('SqliteGraphSchedulerProvider', () => {
  it('serializes owners, renews idempotently, and fences takeover after expiry', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1_000_000)
    const path = databasePath()
    const first = new SqliteGraphSchedulerProvider('sqlite-scheduler', path, config(path))
    const second = new SqliteGraphSchedulerProvider('sqlite-scheduler', path, config(path))
    const granted = await first.acquire(acquire('one'), signal())
    if (granted.status !== 'granted') throw new Error('expected ownership')
    expect(await second.acquire(acquire('two', 'generation-2'), signal())).toMatchObject({ status: 'busy', retryAt: 1_001_000 })
    expect(await first.acquire(acquire('one'), signal())).toEqual(granted)
    vi.setSystemTime(1_000_500)
    expect(await first.heartbeat(exact(granted.lease), signal())).toMatchObject({ expiresAt: 1_001_500 })
    vi.setSystemTime(1_001_501)
    const replacement = await second.acquire(acquire('two', 'generation-2', 2), signal())
    if (replacement.status !== 'granted') throw new Error('expected takeover')
    expect(replacement.lease.fencingToken).toBeGreaterThan(granted.lease.fencingToken)
    await expect(first.heartbeat({ ...exact(granted.lease), at: Date.now() }, signal())).rejects.toThrow(/fenced/)
    await expect(first.release({ ...exact(granted.lease), at: Date.now() }, signal())).rejects.toThrow(/fenced/)
    await second.release(exact(replacement.lease), signal())
    await expect(second.release(exact(replacement.lease), signal())).resolves.toBeUndefined()
    first.close(); second.close()
  })

  it('persists fencing across restart and rejects conflicting session identity', async () => {
    vi.useFakeTimers(); vi.setSystemTime(2_000_000)
    const path = databasePath()
    const first = new SqliteGraphSchedulerProvider('sqlite-scheduler', path, config(path))
    const granted = await first.acquire(acquire('one'), signal())
    if (granted.status !== 'granted') throw new Error('expected ownership')
    first.close(); vi.setSystemTime(2_001_001)
    const restarted = new SqliteGraphSchedulerProvider('sqlite-scheduler', path, config(path))
    const replacement = await restarted.acquire(acquire('two', 'generation-2'), signal())
    if (replacement.status !== 'granted') throw new Error('expected ownership')
    expect(replacement.lease.fencingToken).toBe(2)
    await restarted.release(exact(replacement.lease), signal())
    await expect(restarted.acquire({ ...acquire('three', 'generation-3'), sessionId: 'other' }, signal())).rejects.toThrow(/another session/)
    restarted.close()
  })

  it('protects database identity, configuration, malformed values, and lifecycle', async () => {
    const path = databasePath()
    expect(() => new SqliteGraphSchedulerProvider('', path, config(path))).toThrow(/providerName/)
    expect(() => new SqliteGraphSchedulerProvider('sqlite-scheduler', 'relative.sqlite', config(path))).toThrow(/absolute/)
    const provider = new SqliteGraphSchedulerProvider('sqlite-scheduler', path, config(path))
    const granted = await provider.acquire(acquire('one'), signal())
    expect(granted.status).toBe('granted')
    expect(() => new SqliteGraphSchedulerProvider('sqlite-scheduler', path, config(path, 2_000))).toThrow(/configuration differs/)
    provider.close(); provider.close()
    await expect(provider.acquire(acquire('one'), signal())).rejects.toThrow(/closed/)

    const foreignPath = databasePath(); const foreign = new DatabaseSync(foreignPath); foreign.exec('CREATE TABLE user_data(value TEXT)'); foreign.close()
    expect(() => new SqliteGraphSchedulerProvider('sqlite-scheduler', foreignPath, config(foreignPath))).toThrow(/refuses database identity/)

    const lifecyclePath = databasePath(); const ctx = new Context(); await ctx.plugin(GraphSchedulerRuntime)
    const scope = ctx.plugin(SqlitePlugin, config(lifecyclePath)); await scope
    expect((await ctx.graphScheduler.acquire('sqlite-scheduler', acquire('owner'), signal())).status).toBe('granted')
    await scope.dispose()
    await expect(ctx.graphScheduler.acquire('sqlite-scheduler', acquire('owner'), signal())).rejects.toThrow(/unknown/)
    await ctx.fiber.dispose()
  })

  it('rejects expired or absent exact leases and malformed durable fields', async () => {
    vi.useFakeTimers(); vi.setSystemTime(3_000_000)
    const path = databasePath()
    const provider = new SqliteGraphSchedulerProvider('sqlite-scheduler', path, config(path))
    const granted = await provider.acquire(acquire('one'), signal())
    if (granted.status !== 'granted') throw new Error('expected ownership')
    vi.setSystemTime(3_001_001)
    await expect(provider.heartbeat(exact(granted.lease), signal())).rejects.toThrow(/expired/)
    await provider.release(exact(granted.lease), signal())
    await expect(provider.heartbeat(exact(granted.lease), signal())).rejects.toThrow(/absent/)
    provider.close()

    const hashPath = databasePath()
    const malformedHash = new SqliteGraphSchedulerProvider('sqlite-scheduler', hashPath, config(hashPath))
    const hashDb = new DatabaseSync(hashPath)
    hashDb.exec("UPDATE graph_scheduler_meta SET value = X'01' WHERE key = 'config_hash'")
    hashDb.close()
    await expect(malformedHash.acquire(acquire('hash'), signal())).rejects.toThrow(/SQLite text/)
    malformedHash.close()

    const missingHashPath = databasePath()
    const missingHash = new SqliteGraphSchedulerProvider('sqlite-scheduler', missingHashPath, config(missingHashPath))
    const missingHashDb = new DatabaseSync(missingHashPath)
    missingHashDb.exec("DELETE FROM graph_scheduler_meta WHERE key = 'config_hash'")
    missingHashDb.close()
    await expect(missingHash.acquire(acquire('missing-hash'), signal())).rejects.toThrow(/configuration changed/)
    missingHash.close()

    const numberPath = databasePath()
    const malformedNumber = new SqliteGraphSchedulerProvider('sqlite-scheduler', numberPath, config(numberPath))
    const initial = await malformedNumber.acquire(acquire('number'), signal())
    if (initial.status !== 'granted') throw new Error('expected ownership')
    const numberDb = new DatabaseSync(numberPath)
    numberDb.exec("UPDATE graph_scheduler_leases SET expires_at = 'bad'")
    numberDb.close()
    await expect(malformedNumber.acquire(acquire('other'), signal())).rejects.toThrow(/finite SQLite number/)
    malformedNumber.close()
  })
})
