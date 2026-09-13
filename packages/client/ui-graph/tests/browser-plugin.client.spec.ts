import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import {
  createSnapshotStore,
} from '@deepseek-ai/dsh-client-store'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import { GraphAction } from '../src/client/GraphAction.tsx'
import { GraphChildAction, type GraphChildActionInjected } from '../src/client/GraphChildAction.tsx'
import {
  GraphTemplateSettingsTab,
  type GraphTemplateSettings,
  type GraphTemplateSettingsTabInjected,
} from '../src/client/GraphTemplateSettingsTab.tsx'
import type { GraphActionInjected } from '../src/client/index.ts'
import { apply, inject } from '../src/client/index.ts'
import { apply as applyHost } from '../src/index.ts'
import * as GraphUiInvariant from '../src/invariant.ts'

const config = {
  version: 2,
  active: true,
  roles: [],
  limits: { globalMaxParallel: 1, controllerReserve: 1, models: [] },
  executionPolicy: {
    maxNodesPerRevision: 64,
    maxAttemptsPerNode: 3,
    maxGraphRevisions: 32,
    maxRepairRevisions: 8,
    maxDynamicExpansions: 16,
    maxSubgraphDepth: 4,
    maxRuntimeContinuations: 16,
    maxOutputTokens: 16_384,
    maxReasoningOnlyTokens: 4_096,
    firstDurableActionMs: 120_000,
    maxNoDurableProgressMs: 300_000,
    checkpointIntervalMs: 180_000,
    maxWallTimeMs: 3_600_000,
    maxOutputBytes: 262_144,
    noProgressLimit: 3,
  },
}

describe('ui-graph browser apply', () => {
  it('keeps the host half as a no-op', () => {
    applyHost()
  })

  it('reserves package invariant ownership', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await ctx.plugin(GraphUiInvariant).await()
    expect(() => {
      ctx.invariants.register('@deepseek-ai/dsh-client-ui-graph', () => {})
    }).toThrow(/already registered/)
  })

  it('registers the header action and serializes config through /graph', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    ctx.slots.register({
      name: 'root',
      children: {
        'conversation.session.header.actions': { kind: 'list', scope: 'session' },
        'settings.plugins.tab': { kind: 'list', scope: 'root' },
      },
    } as never, () => null)
    const open = vi.fn()
    const parentGraph = createSnapshotStore(undefined)
    const sessionList = createSnapshotStore({
      ids: ['parent', 'child'],
      byId: { child: { parentId: 'parent' } },
      current: 'child',
      phase: 'ready',
      subagentsByParent: {},
      jobsBySession: {},
    })
    const binding = vi.fn(() => ({ session: { projections: { faceOf: () => parentGraph } } }))
    ctx.provide('sessions', { open, list: sessionList, binding })
    const execute = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: { commandId: 'c', result: { kind: 'success' } } })
      .mockResolvedValueOnce({ ok: true, value: { commandId: 'c', result: { kind: 'error', text: 'invalid graph config' } } })
      .mockResolvedValueOnce({ ok: false, error: { code: 'DENIED', message: 'not allowed' } })
      .mockResolvedValueOnce({ ok: true, value: undefined })
      .mockResolvedValueOnce({ ok: true, value: { commandId: 'c', result: { kind: 'success' } } })
      .mockResolvedValueOnce({ ok: true, value: { commandId: 'c', result: { kind: 'success' } } })
    const off = vi.fn()
    const on = vi.fn(() => off)
    const modelCatalog = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        value: { default: { provider: 'test', model: 'model' }, groups: [], failures: [], routableProviders: [] },
      })
      .mockResolvedValueOnce({ ok: false, error: { code: 'OFFLINE', message: 'offline' } })
    ctx.provide('remote', { commands: { execute }, session: { modelCatalog }, $on: on })
    ctx.provide('remote.commands', { execute })
    ctx.provide('remote.session', { modelCatalog })
    const templateStore = createSnapshotStore<SettingsScopeSnapshot<GraphTemplateSettings>>({
      status: 'ready',
      value: { roles: [], limits: config.limits, executionPolicy: config.executionPolicy },
      base: undefined,
      user: undefined,
      revision: 7,
      writable: true,
      mode: 'host',
    })
    const mutateTemplate = vi.fn(async (_operations: unknown, expectedRevision: number) => {
      if (expectedRevision === 7) {
        templateStore.update((state) => { state.revision = 8 })
        return
      }
      templateStore.update((state) => { state.revision = 9 })
    })
    const graphTemplateScope = Object.assign(templateStore, { mutate: mutateTemplate })
    const bind = vi.fn(() => graphTemplateScope)
    ctx.provide('settingsScope', { bind })
    const loadModels = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('catalog offline'))
    const modelStore = createSnapshotStore<ModelDirectoryState>({
      current: null,
      routable: null,
      groups: [],
      failures: [],
      status: 'idle',
      error: null,
    })
    ctx.provide('modelDirectories', { directoryFor: () => ({ store: modelStore, load: loadModels }) })
    ctx.provide('locale', new LocaleRuntime(ctx))
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const templateEntry = ctx.slots.entries('settings.plugins.tab').find(item => item.options.id === 'graph-templates')!
    expect(templateEntry.component).toBe(GraphTemplateSettingsTab)
    const templateInjected = (templateEntry.inject as unknown as () => GraphTemplateSettingsTabInjected)()
    expect(templateInjected.hooks.settings).toBe(graphTemplateScope)
    templateInjected.loadModels()
    templateInjected.loadModels()
    await vi.waitFor(() => { expect(modelCatalog).toHaveBeenCalledTimes(2) })
    await expect(templateInjected.saveTemplate(templateStore.getSnapshot().value!, 7))
      .resolves.toEqual({ ok: true, revision: 8 })
    await expect(templateInjected.resetTemplate(8)).resolves.toEqual({ ok: true, revision: 9 })
    expect(mutateTemplate).toHaveBeenNthCalledWith(1, expect.any(Array), 7)
    expect(mutateTemplate).toHaveBeenNthCalledWith(2, expect.any(Array), 8)
    const entry = ctx.slots.entries('conversation.session.header.actions').find(item => item.options.id === 'graph-mode')!
    expect(entry.component).toBe(GraphAction)
    const injected = (entry.inject as unknown as (id: SessionId) => GraphActionInjected)('s1' as SessionId)
    expect(injected.hooks.models).toBe(modelStore)
    injected.loadModels()
    injected.loadModels()
    await Promise.resolve()
    expect(loadModels).toHaveBeenCalledTimes(2)
    await expect(injected.saveConfig(config as never)).resolves.toBeNull()
    await expect(injected.saveConfig(config as never)).resolves.toBe('invalid graph config')
    await expect(injected.saveConfig(config as never)).resolves.toBe('not allowed (DENIED)')
    await expect(injected.saveConfig(config as never)).resolves.toBe('unknown command: /graph')
    expect(execute).toHaveBeenCalledWith('s1', expect.stringMatching(/^\/graph config /), [])
    await expect(injected.control({ operationId: 'ui-op', action: 'cancel-run' })).resolves.toBeNull()
    expect(execute).toHaveBeenCalledWith('s1', expect.stringMatching(/^\/graph control /), [])
    injected.openSession('child-1')
    expect(open).toHaveBeenCalledWith('child-1')
    const childEntry = ctx.slots.entries('conversation.session.header.actions')
      .find(item => item.options.id === 'graph-child')!
    expect(childEntry.component).toBe(GraphChildAction)
    const childInjected = (childEntry.inject as unknown as (id: SessionId) => GraphChildActionInjected)(
      'child' as SessionId,
    )
    expect(childInjected.hooks.parentGraph).toBe(parentGraph)
    await expect(childInjected.controlParent({ action: 'cancel-node' })).resolves.toBeNull()
    expect(execute).toHaveBeenCalledWith('parent', expect.stringMatching(/^\/graph control /), [])
    childInjected.openParent()
    expect(open).toHaveBeenCalledWith('parent')
    await fiber.dispose()
    expect(ctx.slots.entries('settings.plugins.tab').find(item => item.options.id === 'graph-templates')).toBeUndefined()
    expect(ctx.slots.entries('conversation.session.header.actions').find(item => item.options.id === 'graph-mode')).toBeUndefined()
    expect(ctx.slots.entries('conversation.session.header.actions').find(item => item.options.id === 'graph-child')).toBeUndefined()
  })
})
