/** Global Graph role-template editor for the Plugins settings section. */

import { useEffect, useState } from 'react'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { GraphModeConfig } from '@deepseek-ai/dsh-graph/client'
import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import { defaultControllerResilience, GraphRoleEditor, graphRoleModelIssue } from './GraphAction.tsx'
import { NS, type GraphKey } from './locales.ts'
import css from './GraphTemplateSettingsTab.module.css'

const NODE_TIMER_MAX_MS = 2_147_483_647

/** User-owned defaults copied into a session on first Graph activation. */
export type GraphTemplateSettings = Pick<GraphModeConfig, 'roles' | 'limits' | 'executionPolicy'> & {
  readonly controllerResilience?: NonNullable<GraphModeConfig['controllerResilience']>
}

/** Accepted result of one revision-fenced template write. */
export type GraphTemplateSaveResult =
  | { readonly ok: true; readonly revision: number }
  | { readonly ok: false; readonly error: string }

/** Registration-side services used by the global template tab. */
export interface GraphTemplateSettingsTabInjected {
  readonly hooks: {
    readonly settings: ObservableSnapshot<ConfigFormSnapshot<GraphTemplateSettings>>
    readonly models: ObservableSnapshot<ModelDirectoryState>
  }
  /** Refresh the session-independent model directory. */
  readonly loadModels: () => void
  /** Atomically replace the three template fields under the observed revision. */
  readonly saveTemplate: (
    template: GraphTemplateSettings,
    expectedRevision: number,
  ) => Promise<GraphTemplateSaveResult>
  /** Clear the three user-layer fields so the built-in template is inherited. */
  readonly resetTemplate: (expectedRevision: number) => Promise<GraphTemplateSaveResult>
}

/** Props assembled by the Plugins settings slot renderer. */
export type GraphTemplateSettingsTabProps = PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<typeof NS>
  & InjectFace<GraphTemplateSettingsTabInjected>

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

function normalized(value: string): boolean {
  return value.length > 0 && value.trim() === value
}

/** Return the first deterministic client-side template diagnostic. */
export function graphTemplateIssue(template: GraphTemplateSettings): GraphKey | undefined {
  if (!Number.isSafeInteger(template.limits.globalMaxParallel)
    || template.limits.globalMaxParallel < 1) return 'global.invalidParallel'
  if (!Number.isSafeInteger(template.limits.controllerReserve)
    || template.limits.controllerReserve < 1
    || template.limits.controllerReserve >= template.limits.globalMaxParallel) {
    return 'global.invalidReserve'
  }
  if (template.limits.maxActiveSubagents !== undefined
    && (!Number.isSafeInteger(template.limits.maxActiveSubagents)
      || template.limits.maxActiveSubagents < 1)) return 'global.invalidActiveSubagents'
  const ids = new Set<string>()
  let controllers = 0
  let workers = 0
  for (const role of template.roles) {
    if (!SAFE_ID.test(role.id) || ids.has(role.id)) return 'global.invalidRoleId'
    ids.add(role.id)
    if ([role.label, role.description, role.prompt].some(value => value.trim() !== value || value.length === 0)) {
      return 'global.invalidRoleText'
    }
    if (!Number.isSafeInteger(role.maxParallel) || role.maxParallel < 1) return 'global.invalidRoleParallel'
    if (role.workerProvider !== undefined && !normalized(role.workerProvider)) return 'global.invalidRoleRoute'
    const modelValues = [role.model.provider, role.model.model, role.model.reasoningEffort]
      .filter((value): value is string => value !== undefined)
    if (modelValues.some(value => !normalized(value))) return 'global.invalidRoleRoute'
    if (role.controller && role.enabled) controllers += 1
    if (!role.controller && role.enabled) workers += 1
  }
  if (controllers !== 1) return 'global.invalidController'
  if (workers < 1) return 'global.invalidWorker'
  const modelKeys = new Set<string>()
  for (const limit of template.limits.models) {
    if (!normalized(limit.model)
      || (limit.provider !== undefined && !normalized(limit.provider))
      || !Number.isSafeInteger(limit.maxParallel)
      || limit.maxParallel < 1
      || (limit.maxWeight !== undefined && (!Number.isFinite(limit.maxWeight) || limit.maxWeight <= 0))) {
      return 'global.invalidModelLimit'
    }
    const key = JSON.stringify([limit.provider ?? null, limit.model])
    if (modelKeys.has(key)) return 'global.invalidModelLimit'
    modelKeys.add(key)
  }
  for (const [name, limit] of Object.entries(template.executionPolicy)) {
    if (!Number.isSafeInteger(limit) || limit < 1) return 'global.invalidPolicy'
    if (['firstDurableActionMs', 'maxNoDurableProgressMs', 'checkpointIntervalMs', 'maxWallTimeMs'].includes(name)
      && limit > NODE_TIMER_MAX_MS) return 'global.invalidPolicy'
  }
  if (template.executionPolicy.maxRepairRevisions > template.executionPolicy.maxGraphRevisions) {
    return 'global.invalidPolicy'
  }
  const resilience = template.controllerResilience ?? defaultControllerResilience()
  if (!Number.isSafeInteger(resilience.maxFallbackAttemptsPerTurn)
    || resilience.maxFallbackAttemptsPerTurn < 1
    || resilience.retryableFailureCodes.length === 0
    || new Set(resilience.retryableFailureCodes).size !== resilience.retryableFailureCodes.length
    || resilience.retryableFailureCodes.some(code => !normalized(code))) {
    return 'global.invalidResilience'
  }
  const fallbackKeys = new Set<string>()
  for (const fallback of resilience.fallbackModels) {
    const key = JSON.stringify([fallback.provider, fallback.model])
    if (!normalized(fallback.provider) || !normalized(fallback.model)
      || (fallback.reasoningEffort !== undefined && !normalized(fallback.reasoningEffort))
      || (!fallback.controller && !fallback.compaction) || fallbackKeys.has(key)) {
      return 'global.invalidResilience'
    }
    fallbackKeys.add(key)
  }
  const compaction = resilience.compaction
  if (!Number.isFinite(compaction.thresholdRatio) || compaction.thresholdRatio <= 0
    || compaction.thresholdRatio > 1 || !Number.isFinite(compaction.retainRatio)
    || compaction.retainRatio <= 0 || compaction.retainRatio >= compaction.thresholdRatio
    || !Number.isSafeInteger(compaction.maxTokens) || compaction.maxTokens < 1
    || (compaction.reasoningEffort !== undefined && !normalized(compaction.reasoningEffort))) {
    return 'global.invalidResilience'
  }
  return undefined
}

/** Render global defaults without mutating any existing session snapshot. */
export function GraphTemplateSettingsTab(props: GraphTemplateSettingsTabProps) {
  const settings = props.useSettings(value => value)
  const models = props.useModels(value => value)
  const [draft, setDraft] = useState<GraphTemplateSettings>()
  const [baseRevision, setBaseRevision] = useState<number>()
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string>()
  const [confirmReset, setConfirmReset] = useState(false)

  useEffect(() => {
    props.loadModels()
  }, [props.loadModels])

  useEffect(() => {
    if (settings.status !== 'ready' || settings.value === undefined) return
    if (draft === undefined || (!dirty && baseRevision !== settings.revision)) {
      setDraft({
        ...settings.value,
        controllerResilience: settings.value.controllerResilience ?? defaultControllerResilience(),
      })
      setBaseRevision(settings.revision)
      setError(undefined)
    } else if (!saving && baseRevision !== settings.revision) {
      setError(props.t('global.conflict'))
    }
  }, [baseRevision, dirty, draft, props.t, saving, settings])

  if (settings.status === 'unavailable') {
    return <p className={css.status} role="status">{props.t('global.unavailable')}</p>
  }
  if (settings.status === 'loading' || draft === undefined) {
    return <p className={css.status} role="status">{props.t('global.loading')}</p>
  }

  const config: GraphModeConfig = { version: 2, active: false, ...draft }
  const issue = graphTemplateIssue(draft)
  const roleModelIssue = graphRoleModelIssue(config, models)
  const conflict = baseRevision !== settings.revision
  const update = (next: GraphModeConfig): void => {
    setDraft({
      roles: next.roles,
      limits: next.limits,
      executionPolicy: next.executionPolicy,
      controllerResilience: next.controllerResilience as NonNullable<GraphModeConfig['controllerResilience']>,
    })
    setDirty(true)
    setSaved(false)
    setError(conflict ? props.t('global.conflict') : undefined)
  }
  const reload = (): void => {
    if (settings.value === undefined) return
    setDraft({
      ...settings.value,
      controllerResilience: settings.value.controllerResilience ?? defaultControllerResilience(),
    })
    setBaseRevision(settings.revision)
    setDirty(false)
    setSaved(false)
    setError(undefined)
    setConfirmReset(false)
  }
  const reset = (): void => {
    if (!confirmReset) {
      setConfirmReset(true)
      return
    }
    if (conflict || baseRevision === undefined || !settings.writable || saving) return
    setSaving(true)
    setError(undefined)
    void props.resetTemplate(baseRevision).then((result) => {
      setSaving(false)
      setConfirmReset(false)
      if (!result.ok) {
        setError(result.error)
        return
      }
      setBaseRevision(result.revision)
      setDirty(false)
      setSaved(true)
    }, (reason: unknown) => {
      setSaving(false)
      setError(reason instanceof Error ? reason.message : String(reason))
    })
  }
  const save = (): void => {
    if (!dirty || issue !== undefined || roleModelIssue !== undefined
      || conflict || baseRevision === undefined || !settings.writable) return
    setSaving(true)
    setError(undefined)
    void props.saveTemplate(draft, baseRevision).then((result) => {
      setSaving(false)
      if (!result.ok) {
        setError(result.error)
        return
      }
      setBaseRevision(result.revision)
      setDirty(false)
      setSaved(true)
    }, (reason: unknown) => {
      setSaving(false)
      setError(reason instanceof Error ? reason.message : String(reason))
    })
  }

  return (
    <section className={css.page} aria-label={props.t('global.title')}>
      <header className={css.header}>
        <div>
          <h2>{props.t('global.title')}</h2>
          <p>{props.t('global.intro')}</p>
        </div>
        <div className={css.actions}>
          <button
            type="button"
            disabled={conflict || baseRevision === undefined || !settings.writable || saving}
            onClick={reset}
          >
            {props.t(confirmReset ? 'global.confirmReset' : 'global.reset')}
          </button>
          {confirmReset ? <button type="button" onClick={() => { setConfirmReset(false) }}>
            {props.t('global.cancelReset')}
          </button> : null}
          <button type="button" disabled={!dirty && !conflict} onClick={reload}>{props.t('global.reload')}</button>
          <button
            type="button"
            className={css.save}
            disabled={!dirty || issue !== undefined || roleModelIssue !== undefined
              || conflict || saving || !settings.writable}
            onClick={save}
          >
            {props.t(saving ? 'saving' : 'save')}
          </button>
        </div>
      </header>
      {!settings.writable ? <p className={css.error} role="status">{props.t('global.readOnly')}</p> : null}
      {issue === undefined ? null : <p className={css.error} role="status">{props.t(issue)}</p>}
      {roleModelIssue === undefined ? null : <p className={css.error} role="status">
        {props.t(roleModelIssue.key, {
          role: roleModelIssue.role,
          model: roleModelIssue.model,
          effort: roleModelIssue.effort,
        })}
      </p>}
      {error === undefined ? null : <p className={css.error} role="status">{error}</p>}
      {saved ? <p className={css.saved} role="status">{props.t('saved')}</p> : null}
      <GraphRoleEditor config={config} models={models} setConfig={update} t={props.t} />
    </section>
  )
}
