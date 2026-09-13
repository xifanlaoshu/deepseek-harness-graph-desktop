/** Browser graph surface registration. */
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import {
  createSnapshotStore,
  type ClientContext,
  type ISessions,
  type ObservableSnapshot,
  type SessionId,
} from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type {} from '@deepseek-ai/dsh-graph/client'
import type { GraphModeConfig } from '@deepseek-ai/dsh-graph/client'
import type { GraphProjection } from '@deepseek-ai/dsh-graph/client'
import { GraphAction } from './GraphAction.tsx'
import { GraphChildAction, type GraphChildActionInjected } from './GraphChildAction.tsx'
import {
  GraphTemplateSettingsTab,
  type GraphTemplateSaveResult,
  type GraphTemplateSettings,
  type GraphTemplateSettingsTabInjected,
} from './GraphTemplateSettingsTab.tsx'
import { en, NS, zh, type GraphKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Graph-mode panel copy. */
    graph: GraphKey
  }
}

/** Host operations used by the pure graph component. */
export interface GraphActionInjected {
  readonly hooks: {
    /** Settings-backed model directory bound by the renderer as useModels. */
    readonly models: ObservableSnapshot<ModelDirectoryState>
  }
  /** Refresh the settings-backed model directory. */
  readonly loadModels: () => void
  readonly saveConfig: (config: GraphModeConfig) => Promise<string | null>
  /** Submit an idempotent human control operation to the current Graph run. */
  readonly control: (request: Readonly<Record<string, unknown>>) => Promise<string | null>
  readonly openSession: (id: string) => void
}

/** Required client services. */
export const inject = [
  'slots', 'sessions', 'connection', 'remote', 'remote.commands', 'locale', 'modelDirectories', 'settingsScope',
]

/** Register the session-header Graph Mode action. */
export function apply(ctx: ClientContext): void {
  const sessions = ctx.get('sessions') as unknown as ISessions
  const { api } = ctx.get('connection') as ConnectionHandle
  const graphTemplates = ctx.settingsScope.bind<GraphTemplateSettings>({ namespace: 'graph-mode' })
  const templateModels = createSnapshotStore<ModelDirectoryState>({
    current: null,
    routable: null,
    groups: [],
    failures: [],
    status: 'idle',
    error: null,
  })
  const absentParentGraph = createSnapshotStore<GraphProjection | undefined>(undefined)
  let modelGeneration = 0
  const loadTemplateModels = (): void => {
    const generation = ++modelGeneration
    templateModels.update((state) => { state.status = 'loading'; state.error = null })
    void api.llm.models({}).then((response) => {
      if (generation !== modelGeneration) return
      const { result } = response
      if (!result.ok) {
        const message = `${result.error.code}: ${result.error.message}`
        templateModels.update((state) => {
          state.status = 'error'
          state.error = message
        })
        return
      }
      const { groups, failures } = result.value
      templateModels.update((state) => {
        state.groups = groups
        state.failures = failures
        state.status = 'ready'
        state.error = null
      })
    }, (reason: unknown) => {
      if (generation !== modelGeneration) return
      templateModels.update((state) => {
        state.status = 'error'
        state.error = reason instanceof Error ? reason.message : String(reason)
      })
    })
  }
  const saveTemplate = async (
    template: GraphTemplateSettings,
    expectedRevision: number,
  ): Promise<GraphTemplateSaveResult> => {
    try {
      const response = await api.settings.update({
        ns: 'graph-mode',
        patch: template,
        expectedRevision,
      })
      if (!response.result.ok) {
        return { ok: false, error: `${response.result.error.message} (${response.result.error.code})` }
      }
      return { ok: true, revision: response.result.value.revision }
    } catch (reason) {
      return { ok: false, error: reason instanceof Error ? reason.message : String(reason) }
    }
  }
  const resetTemplate = async (expectedRevision: number): Promise<GraphTemplateSaveResult> => {
    try {
      const response = await api.settings.mutate({
        ns: 'graph-mode',
        ops: [
          { op: 'unset', path: ['roles'] },
          { op: 'unset', path: ['limits'] },
          { op: 'unset', path: ['executionPolicy'] },
          { op: 'unset', path: ['controllerResilience'] },
        ],
        expectedRevision,
      })
      if (!response.result.ok) {
        return { ok: false, error: `${response.result.error.message} (${response.result.error.code})` }
      }
      return { ok: true, revision: response.result.value.revision }
    } catch (reason) {
      return { ok: false, error: reason instanceof Error ? reason.message : String(reason) }
    }
  }
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-graph: dictionaries')
  ctx.effect(() => {
    const refresh = (): void => { loadTemplateModels() }
    const disposers = [
      ctx.remote.$on('llm/adapters-updated', refresh),
      ctx.remote.$on('settings/document-updated', refresh),
    ]
    return () => { for (const dispose of disposers) dispose() }
  }, 'ui-graph: global model directory invalidations')
  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'graph-templates',
    order: 5,
    label: () => ctx.locale.bind(NS)('global.tab'),
    locale: NS,
    inject: (): GraphTemplateSettingsTabInjected => ({
      hooks: { settings: graphTemplates, models: templateModels },
      loadModels: loadTemplateModels,
      saveTemplate,
      resetTemplate,
    }),
  }, GraphTemplateSettingsTab))
  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: 'graph-mode',
    order: 30,
    locale: NS,
    inject: (sessionId: SessionId): GraphActionInjected => {
      const directory = ctx.modelDirectories.directoryFor(sessionId)
      return {
        hooks: { models: directory.store },
        loadModels: () => { directory.load().catch(() => { /* surfaced through the directory snapshot */ }) },
        saveConfig: async (config) => {
          const result = await ctx.remote.commands.execute(sessionId, `/graph config ${JSON.stringify(config)}`, [])
          if (!result.ok) return `${result.error.message} (${result.error.code})`
          if (result.value === undefined) return 'unknown command: /graph'
          if (result.value.result.kind === 'error') return result.value.result.text
          return null
        },
        control: async (request) => {
          const result = await ctx.remote.commands.execute(sessionId, `/graph control ${JSON.stringify(request)}`, [])
          if (!result.ok) return `${result.error.message} (${result.error.code})`
          if (result.value === undefined) return 'unknown command: /graph'
          if (result.value.result.kind === 'error') return result.value.result.text
          return null
        },
        openSession: (id) => { sessions.open(id as SessionId) },
      }
    },
  }, GraphAction))
  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: 'graph-child',
    order: 31,
    locale: NS,
    inject: (sessionId: SessionId): GraphChildActionInjected => {
      const parentId = sessions.list.getSnapshot().byId[sessionId]?.parentId
      const parent = parentId === undefined ? undefined : sessions.binding(parentId)
      const parentGraph = parent?.session.projections.faceOf('graph') as ObservableSnapshot<GraphProjection | undefined>
        | undefined
      return {
        childSessionId: sessionId,
        hooks: { parentGraph: parentGraph ?? absentParentGraph },
        controlParent: async (request) => {
          if (parentId === undefined) return 'Graph parent session is unavailable.'
          const result = await ctx.remote.commands.execute(parentId, `/graph control ${JSON.stringify(request)}`, [])
          if (!result.ok) return `${result.error.message} (${result.error.code})`
          if (result.value === undefined) return 'unknown command: /graph'
          if (result.value.result.kind === 'error') return result.value.result.text
          return null
        },
        openParent: () => { if (parentId !== undefined) sessions.open(parentId) },
      }
    },
  }, GraphChildAction))
}
