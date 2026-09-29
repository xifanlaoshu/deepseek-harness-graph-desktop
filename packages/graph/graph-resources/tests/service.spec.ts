import { Context } from '@deepseek-ai/cordis'
import { GraphControlOperationId, GraphWorkId } from '@deepseek-ai/dsh-graph'
import { describe, expect, it, vi } from 'vitest'
import GraphResourceRuntime, {
  GraphResourceReservationId,
  type GraphResourceProvider,
  type GraphResourceReservationRequest,
  type GraphResourceSnapshot,
} from '../src/index.ts'

const now = 10_000
const request = (overrides: Partial<GraphResourceReservationRequest> = {}): GraphResourceReservationRequest => ({
  protocolVersion: 1,
  workId: GraphWorkId('work-1'),
  operationId: GraphControlOperationId('operation-1'),
  ownerEpoch: 1,
  provider: 'local',
  model: 'qwen',
  weight: 2,
  hardMaxParallel: 2,
  hardMaxWeight: 4,
  requestedAt: now,
  deadline: now + 60_000,
  ...overrides,
})

const snapshot = (overrides: Partial<GraphResourceSnapshot> = {}): GraphResourceSnapshot => ({
  providerId: 'gpu',
  provider: 'local',
  model: 'qwen',
  observedAt: now,
  expiresAt: now + 10_000,
  status: 'available',
  activeRequests: 0,
  queueDepth: 0,
  concurrencyLimit: 2,
  weightLimit: 4,
  availableDeviceBytes: 16_000_000_000,
  ...overrides,
})

type TestProvider = GraphResourceProvider & {
  readonly reserveMock: ReturnType<typeof vi.fn<GraphResourceProvider['reserve']>>
}

const provider = (): TestProvider => {
  const reserveMock = vi.fn<GraphResourceProvider['reserve']>(async item => ({
    status: 'granted' as const,
    reservation: {
      id: GraphResourceReservationId('reservation-1'),
      providerId: 'gpu',
      workId: item.workId,
      operationId: item.operationId,
      ownerEpoch: item.ownerEpoch,
      ...item.provider === undefined ? {} : { provider: item.provider },
      model: item.model,
      weight: item.weight,
      fencingToken: 1,
      acquiredAt: now,
      expiresAt: now + 5_000,
      snapshot: snapshot(),
    },
  }))
  return {
    name: 'gpu',
    protocolVersion: 1,
    observe: vi.fn<GraphResourceProvider['observe']>(async () => snapshot()),
    reserve: reserveMock,
    reserveMock,
    report: vi.fn<GraphResourceProvider['report']>(async () => {}),
    reconcile: vi.fn<GraphResourceProvider['reconcile']>(async item => ({ status: 'released', evidence: `released ${item.reservationId}` })),
  }
}

describe('graph resource service', () => {
  it('validates observations and fenced reservations from one named provider', async () => {
    const ctx = new Context()
    await ctx.plugin(GraphResourceRuntime).await()
    const gpu = provider()
    ctx.graphResources.register(gpu)

    await expect(ctx.graphResources.observe('gpu', { provider: 'local', model: 'qwen' }, new AbortController().signal))
      .resolves.toMatchObject({ status: 'available', concurrencyLimit: 2 })
    await expect(ctx.graphResources.reserve('gpu', request(), new AbortController().signal))
      .resolves.toMatchObject({ status: 'granted', reservation: { fencingToken: 1 } })
    await expect(ctx.graphResources.reconcile({
      protocolVersion: 1,
      reservationId: GraphResourceReservationId('reservation-1'),
      providerId: 'gpu',
      workId: GraphWorkId('work-1'),
      ownerEpoch: 1,
      fencingToken: 1,
      at: now,
      evidence: 'scheduler recovery found an abandoned reservation',
    }, new AbortController().signal)).resolves.toMatchObject({ status: 'released' })
  })

  it('preserves typed waits while rejecting invalid retry and snapshot evidence', async () => {
    const ctx = new Context()
    await ctx.plugin(GraphResourceRuntime).await()
    const waiting: GraphResourceProvider = {
      ...provider(),
      reserve: vi.fn(async () => ({ status: 'wait' as const, reason: 'oom-backoff' as const, retryAt: now + 2_000, snapshot: snapshot({ recentOomAt: now }) })),
    }
    ctx.graphResources.register(waiting)
    await expect(ctx.graphResources.reserve('gpu', request(), new AbortController().signal))
      .resolves.toMatchObject({ status: 'wait', reason: 'oom-backoff' })

    const invalid: GraphResourceProvider = {
      ...provider(),
      name: 'invalid',
      observe: vi.fn(async () => snapshot({ providerId: 'someone-else' })),
    }
    ctx.graphResources.register(invalid)
    await expect(ctx.graphResources.observe('invalid', { provider: 'local', model: 'qwen' }, new AbortController().signal))
      .rejects.toThrow('returned snapshot for someone-else')
  })

  it('rejects requests that could bypass configured hard ceilings', async () => {
    const ctx = new Context()
    await ctx.plugin(GraphResourceRuntime).await()
    const gpu = provider()
    ctx.graphResources.register(gpu)

    await expect(ctx.graphResources.reserve('gpu', request({ hardMaxParallel: 0 }), new AbortController().signal))
      .rejects.toThrow('hardMaxParallel')
    await expect(ctx.graphResources.reserve('gpu', request({ hardMaxWeight: -1 }), new AbortController().signal))
      .rejects.toThrow('hardMaxWeight')
    expect(gpu.reserveMock).not.toHaveBeenCalled()
  })

})
