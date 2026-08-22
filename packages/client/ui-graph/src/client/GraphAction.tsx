import { useEffect, useId, useMemo, useRef, useState } from 'react'
import cytoscape from 'cytoscape'
import type { Core, ElementDefinition, EventObjectNode } from 'cytoscape'
import {
  IconChevronRightOutline14,
  IconCloseOutline16,
  IconEditOutline16,
  IconFullscreenOutline16,
  IconPauseOutline16,
  IconSettingsOutline16,
  IconStopFill16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  GraphModeConfig,
  GraphModelSelection,
  GraphCheckpoint,
  GraphNode,
  GraphNodeExecutionBudget,
  GraphNodeId,
  GraphNodeRun,
  GraphOperationTransition,
  GraphProjection,
  GraphRevision,
  GraphRole,
  GraphRun,
  GraphSettlementRecord,
} from '@deepseek-ai/dsh-graph/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type { GraphActionInjected } from './index.ts'
import { NS, type GraphKey } from './locales.ts'
import css from './GraphAction.module.css'

/** Full props for the session-header Graph Mode action. */
export type GraphActionProps = PropsRuntime<'conversation.session.header.actions'>
  & InjectFace<GraphActionInjected>
  & PropsLocale<typeof NS>

interface NodePoint {
  readonly id: string
  readonly x: number
  readonly y: number
}

interface ModelChoice {
  readonly key: string
  readonly provider: string
  readonly model: string
  readonly label: string
  readonly reasoningEfforts?: readonly string[]
  readonly defaultReasoningEffort?: string
}

/** Typography applied to task labels on the primary DAG canvas. */
export const graphCanvasNodeTypography = {
  'font-size': 12,
  'font-weight': 500,
} as const

/** Geometry applied to dependency edges on the primary DAG canvas. */
export const graphCanvasEdgeGeometry = {
  width: 1.5,
  'curve-style': 'unbundled-bezier',
  'control-point-distance': 42,
  'control-point-weight': 0.5,
  'line-cap': 'round',
} as const

/** Compute stable topological levels for the browser DAG canvas. */
export function graphNodePoints(revision: GraphRevision): readonly NodePoint[] {
  const incoming = new Map(revision.nodes.map(node => [node.id, 0]))
  const outgoing = new Map(revision.nodes.map(node => [node.id, [] as GraphNodeId[]]))
  for (const edge of revision.edges) {
    incoming.set(edge.to, (incoming.get(edge.to) as number) + 1)
    ;(outgoing.get(edge.from) as GraphNodeId[]).push(edge.to)
  }
  const level = new Map<GraphNodeId, number>()
  const queue = revision.nodes.filter(node => incoming.get(node.id) === 0).map(node => node.id)
  for (const id of queue) level.set(id, 0)
  for (let index = 0; index < queue.length; index += 1) {
    const id = queue[index] as GraphNodeId
    for (const next of outgoing.get(id) as GraphNodeId[]) {
      level.set(next, Math.max(level.get(next) ?? 0, (level.get(id) as number) + 1))
      const remaining = (incoming.get(next) as number) - 1
      incoming.set(next, remaining)
      if (remaining === 0) queue.push(next)
    }
  }
  const byLevel = new Map<number, GraphNodeId[]>()
  for (const node of revision.nodes) {
    const nodeLevel = level.get(node.id) as number
    const row = byLevel.get(nodeLevel) ?? []
    row.push(node.id)
    byLevel.set(nodeLevel, row)
  }
  return revision.nodes.map((node) => {
    const nodeLevel = level.get(node.id) as number
    const row = byLevel.get(nodeLevel) as GraphNodeId[]
    return { id: node.id, x: 95 + nodeLevel * 230, y: 65 + row.indexOf(node.id) * 120 }
  })
}

function currentGraph(projection: GraphProjection): readonly GraphRevision[] | undefined {
  return projection.currentGraphId === undefined
    ? undefined
    : projection.graphs[projection.currentGraphId]
}

function newestRun(projection: GraphProjection, revision: GraphRevision): GraphRun | undefined {
  return Object.values(projection.runs)
    .filter(run => run.graphId === revision.graphId && run.revision === revision.revision)
    .sort((left, right) => right.createdAt - left.createdAt)[0]
}

function modelCap(config: GraphModeConfig, role: GraphRole): number {
  if (role.model.model === undefined) return role.maxParallel
  return config.limits.models.find(limit => (
    limit.provider === role.model.provider && limit.model === role.model.model
  ))?.maxParallel ?? role.maxParallel
}

function replaceRole(
  config: GraphModeConfig,
  roleId: string,
  update: (role: GraphRole) => GraphRole,
): GraphModeConfig {
  return { ...config, roles: config.roles.map(role => role.id === roleId ? update(role) : role) }
}

function moveWorkerRole(config: GraphModeConfig, index: number, direction: -1 | 1): GraphModeConfig {
  const roles = [...config.roles]
  const target = index + direction
  if (target < 0 || target >= roles.length || roles[target]?.controller) return config
  const current = roles[index]
  const adjacent = roles[target]
  if (current === undefined || adjacent === undefined || current.controller) return config
  roles[index] = adjacent
  roles[target] = current
  return { ...config, roles }
}

function duplicateWorkerRole(config: GraphModeConfig, role: GraphRole): GraphModeConfig {
  if (role.controller) return config
  const prefix = `${role.id.slice(0, 112)}-copy`
  let id = prefix
  let suffix = 2
  while (config.roles.some(item => item.id === id)) id = `${prefix}-${String(suffix++)}`
  const index = config.roles.findIndex(item => item.id === role.id)
  const roles = [...config.roles]
  roles.splice(index + 1, 0, { ...role, id: id as GraphRole['id'] })
  return { ...config, roles }
}

function replaceModelCap(config: GraphModeConfig, role: GraphRole, maxParallel: number): GraphModeConfig {
  const model = role.model.model
  if (model === undefined || model.length === 0) return config
  const retained = config.limits.models.filter(limit => (
    limit.provider !== role.model.provider || limit.model !== model
  ))
  return {
    ...config,
    limits: {
      ...config.limits,
      models: [...retained, {
        ...(role.model.provider === undefined ? {} : { provider: role.model.provider }),
        model,
        maxParallel,
      }],
    },
  }
}

function modelChoices(directory: ModelDirectoryState): readonly ModelChoice[] {
  let index = 0
  return directory.groups.flatMap(group => group.models.map(model => ({
    key: `model-${String(index++)}`,
    provider: group.id,
    model: model.id,
    label: `${group.name} / ${model.name}`,
    ...model.reasoning === undefined ? {} : {
      reasoningEfforts: model.reasoning.efforts.map(effort => effort.id),
      ...model.reasoning.defaultEffort === undefined ? {} : { defaultReasoningEffort: model.reasoning.defaultEffort },
    },
  })))
}

/** One explicit role effort that the selected model directory entry cannot serve. */
export interface GraphRoleModelIssue {
  readonly key: Extract<GraphKey, 'model.reasoningUnsupported'>
  readonly role: string
  readonly model: string
  readonly effort: string
}

/** Return the first model-aware role diagnostic once the directory is ready. */
export function graphRoleModelIssue(
  config: Pick<GraphModeConfig, 'roles'>,
  directory: ModelDirectoryState,
): GraphRoleModelIssue | undefined {
  if (directory.status !== 'ready') return undefined
  const choices = modelChoices(directory)
  for (const role of config.roles) {
    const effort = role.model.reasoningEffort
    if (role.model.provider === undefined || role.model.model === undefined || effort === undefined) continue
    const choice = choices.find(candidate => (
      candidate.provider === role.model.provider && candidate.model === role.model.model
    ))
    if (choice === undefined || choice.reasoningEfforts?.includes(effort) === true) continue
    return {
      key: 'model.reasoningUnsupported',
      role: role.label,
      model: `${role.model.provider}/${role.model.model}`,
      effort,
    }
  }
  return undefined
}

function replaceModelSelection(
  selection: GraphModelSelection,
  choice: ModelChoice | undefined,
): GraphModelSelection {
  const { provider: _provider, model: _model, reasoningEffort: _reasoningEffort, ...retainedWithoutReasoning } = selection
  return choice === undefined
    ? { ...retainedWithoutReasoning, ..._reasoningEffort === undefined ? {} : { reasoningEffort: _reasoningEffort } }
    : {
      ...retainedWithoutReasoning,
      provider: choice.provider,
      model: choice.model,
      ...choice.defaultReasoningEffort === undefined ? {} : { reasoningEffort: choice.defaultReasoningEffort },
    }
}

function replaceReasoningEffort(selection: GraphModelSelection, value: string): GraphModelSelection {
  if (value !== '') return { ...selection, reasoningEffort: value }
  const { reasoningEffort: _effort, ...rest } = selection
  return rest
}

const executionPolicyFields = [
  'maxOutputTokens',
  'maxReasoningOnlyTokens',
  'firstDurableActionMs',
  'maxNoDurableProgressMs',
  'checkpointIntervalMs',
  'maxWallTimeMs',
  'maxRuntimeContinuations',
] as const

function effectiveNodeBudget(node: GraphNode, config: GraphModeConfig): GraphNodeExecutionBudget {
  const stored = (node as { readonly executionBudget?: GraphNodeExecutionBudget }).executionBudget
  return stored ?? {
    maxOutputTokens: config.executionPolicy.maxOutputTokens,
    maxReasoningOnlyTokens: config.executionPolicy.maxReasoningOnlyTokens,
    firstDurableActionMs: config.executionPolicy.firstDurableActionMs,
    maxNoDurableProgressMs: config.executionPolicy.maxNoDurableProgressMs,
    checkpointIntervalMs: config.executionPolicy.checkpointIntervalMs,
    maxWallTimeMs: config.executionPolicy.maxWallTimeMs,
    maxContinuations: config.executionPolicy.maxRuntimeContinuations,
  }
}

/** Shared role editor for session snapshots and global Graph defaults. */
export function GraphRoleEditor({ config, models, setConfig, t }: {
  readonly config: GraphModeConfig
  readonly models: ModelDirectoryState
  readonly setConfig: (config: GraphModeConfig) => void
  readonly t: GraphActionProps['t']
}) {
  const choices = modelChoices(models)
  const updateLimit = (key: 'globalMaxParallel' | 'controllerReserve', value: number): void => {
    setConfig({ ...config, limits: { ...config.limits, [key]: value } })
  }
  const updateExecutionPolicy = (key: typeof executionPolicyFields[number], value: number): void => {
    setConfig({ ...config, executionPolicy: { ...config.executionPolicy, [key]: value } })
  }
  const updateRole = (role: GraphRole, update: (role: GraphRole) => GraphRole): void => {
    setConfig(replaceRole(config, role.id, update))
  }
  const addRole = (): void => {
    let index = config.roles.length + 1
    while (config.roles.some(role => role.id === `specialist-${String(index)}`)) index += 1
    setConfig({
      ...config,
      roles: [...config.roles, {
        id: `specialist-${String(index)}` as GraphRole['id'],
        label: `Specialist ${String(index)}`,
        description: 'Owns a user-defined specialist task.',
        controller: false,
        enabled: true,
        model: {},
        prompt: 'Complete only the assigned specialist task and publish concise evidence.',
        maxParallel: 1,
      }],
    })
  }
  return (
    <div className={css.settings}>
      <div className={css.limitRow}>
        <label>
          {t('globalLimit')}
          <input
            type="number"
            min={1}
            value={config.limits.globalMaxParallel}
            onChange={(event) => { updateLimit('globalMaxParallel', Number(event.target.value)) }}
          />
        </label>
        <label>
          {t('controllerReserve')}
          <input
            type="number"
            min={1}
            value={config.limits.controllerReserve}
            onChange={(event) => { updateLimit('controllerReserve', Number(event.target.value)) }}
          />
        </label>
      </div>
      <fieldset className={css.role}>
        <legend>{t('policy.title')}</legend>
        <p className={css.policyHelp}>{t('policy.help')}</p>
        <div className={css.roleGrid}>
          {executionPolicyFields.map(key => <label key={key}>
            {t(`policy.${key}`)}
            <input
              type="number"
              min={1}
              value={config.executionPolicy[key]}
              onChange={(event) => { updateExecutionPolicy(key, Number(event.target.value)) }}
            />
          </label>)}
        </div>
      </fieldset>
      {models.status === 'loading' ? <p role="status">{t('model.loading')}</p> : null}
      {models.error === null ? null : <p role="status">{t('model.error', { message: models.error })}</p>}
      {config.roles.map((role, index) => (
        <fieldset key={index} className={css.role}>
          <legend>{role.label}{role.controller ? ' · controller' : ''}</legend>
          <div className={css.roleGrid}>
            <label>
              {t('roleId')}
              <input
                value={role.id}
                disabled={role.controller}
                onChange={(event) => {
                  updateRole(role, current => ({ ...current, id: event.target.value as GraphRole['id'] }))
                }}
              />
            </label>
            <label>
              {t('roleLabel')}
              <input
                value={role.label}
                onChange={(event) => { updateRole(role, current => ({ ...current, label: event.target.value })) }}
              />
            </label>
            <label>
              {t('roleDescription')}
              <input
                value={role.description}
                onChange={(event) => {
                  updateRole(role, current => ({ ...current, description: event.target.value }))
                }}
              />
            </label>
            <label className={css.checkLabel}>
              {t('roleEnabled')}
              <input
                type="checkbox"
                checked={role.enabled}
                disabled={role.controller}
                onChange={(event) => {
                  updateRole(role, current => ({ ...current, enabled: event.target.checked }))
                }}
              />
            </label>
            <label>
              {t('model')}
              <select
                value={choices.find(choice => (
                  choice.provider === role.model.provider && choice.model === role.model.model
                ))?.key ?? (role.model.model === undefined ? '' : 'unavailable')}
                onChange={(event) => {
                  const choice = choices.find(item => item.key === event.target.value)
                  if (event.target.value !== '' && choice === undefined) return
                  updateRole(role, current => ({
                    ...current,
                    model: replaceModelSelection(current.model, choice),
                  }))
                }}
              >
                <option value="">{t('model.inherit')}</option>
                {role.model.model !== undefined && !choices.some(choice => (
                  choice.provider === role.model.provider && choice.model === role.model.model
                ))
                  ? <option value="unavailable" disabled>{t('model.unavailable', { model: role.model.model })}</option>
                  : null}
                {choices.map(choice => <option key={choice.key} value={choice.key}>{choice.label}</option>)}
              </select>
            </label>
            <label>
              {t('reasoning')}
              {(() => {
                const choice = choices.find(candidate => (
                  candidate.provider === role.model.provider && candidate.model === role.model.model
                ))
                const unsupported = role.model.reasoningEffort !== undefined
                  && choice !== undefined
                  && choice.reasoningEfforts?.includes(role.model.reasoningEffort) !== true
                return <input
                  value={role.model.reasoningEffort ?? ''}
                  aria-invalid={unsupported || undefined}
                  disabled={role.model.model !== undefined
                    && choice?.reasoningEfforts === undefined
                    && role.model.reasoningEffort === undefined}
                  list={`graph-reasoning-${role.id}`}
                  onChange={(event) => {
                    updateRole(role, current => ({
                      ...current,
                      model: replaceReasoningEffort(current.model, event.target.value),
                    }))
                  }}
                />
              })()}
              <datalist id={`graph-reasoning-${role.id}`}>
                {choices.find(choice => choice.provider === role.model.provider && choice.model === role.model.model)
                  ?.reasoningEfforts?.map(effort => <option key={effort} value={effort} />)}
              </datalist>
            </label>
            {role.controller ? null : <>
              <label>
                {t('roleParallel')}
                <input
                  type="number"
                  min={1}
                  value={role.maxParallel}
                  onChange={(event) => {
                    updateRole(role, current => ({ ...current, maxParallel: Number(event.target.value) }))
                  }}
                />
              </label>
              <label>
                {t('modelParallel')}
                <input
                  type="number"
                  min={1}
                  value={modelCap(config, role)}
                  onChange={(event) => { setConfig(replaceModelCap(config, role, Number(event.target.value))) }}
                />
              </label>
              <label>
                {t('workerProvider')}
                <input
                  value={role.workerProvider ?? ''}
                  placeholder="local"
                  onChange={(event) => {
                    const workerProvider = event.target.value
                    updateRole(role, (current) => {
                      if (workerProvider !== '') return { ...current, workerProvider }
                      const { workerProvider: _provider, ...rest } = current
                      return rest
                    })
                  }}
                />
              </label>
            </>}
          </div>
          <label>
            {t('prompt')}
            <textarea
              rows={4}
              value={role.prompt}
              onChange={(event) => {
                updateRole(role, current => ({ ...current, prompt: event.target.value }))
              }}
            />
          </label>
          {role.controller ? null : <div className={css.roleActions}>
            <button
              type="button"
              disabled={index === 0 || config.roles[index - 1]?.controller}
              onClick={() => { setConfig(moveWorkerRole(config, index, -1)) }}
            >{t('roleMoveUp')}</button>
            <button
              type="button"
              disabled={index === config.roles.length - 1}
              onClick={() => { setConfig(moveWorkerRole(config, index, 1)) }}
            >{t('roleMoveDown')}</button>
            <button type="button" onClick={() => { setConfig(duplicateWorkerRole(config, role)) }}>
              {t('roleDuplicate')}
            </button>
            <button
              type="button"
              disabled={config.roles.filter(item => !item.controller).length <= 1}
              onClick={() => { setConfig({ ...config, roles: config.roles.filter(item => item.id !== role.id) }) }}
            >{t('roleDelete')}</button>
          </div>}
        </fieldset>
      ))}
      <button type="button" onClick={addRole}>{t('roleAdd')}</button>
    </div>
  )
}

function NodeDetails({ node, run, graphRun, revision, operations, settlements, checkpoints, openSession, t }: {
  readonly node: GraphNode | undefined
  readonly run: GraphNodeRun | undefined
  readonly graphRun: GraphRun | undefined
  readonly revision: GraphRevision | undefined
  readonly operations: readonly GraphOperationTransition[]
  readonly settlements: readonly GraphSettlementRecord[]
  readonly checkpoints: readonly GraphCheckpoint[]
  readonly openSession: (id: string) => void
  readonly t: GraphActionProps['t']
}) {
  if (node === undefined) {
    return <aside className={css.details}><h3>{t('node.details')}</h3><p>{t('node.noSelection')}</p></aside>
  }
  return (
    <aside className={css.details}>
      <p>{node.objective}</p>
      <p className={css.phase}>{run?.phase ?? 'pending'} · {node.roleId}</p>
      {run?.resourceWait === undefined ? null : <p>
        <strong>Resource wait:</strong> {run.resourceWait.reason} · {run.resourceWait.providerId}/{run.resourceWait.model}
      </p>}
      {node.workspace === undefined ? null : <p>
        <strong>{t('node.workspace')}:</strong> {node.workspace.mode} · R[{node.workspace.readRoots.join(', ')}]
        {' · '}W[{node.workspace.writeRoots.join(', ')}]
      </p>}
      <h4>{t('node.budget')}</h4>
      <pre>{JSON.stringify(node.executionBudget, null, 2)}</pre>
      <h4>{t('node.schema')}</h4>
      <p>{node.outputSchema.id} · v{node.outputSchema.version} · ≤ {node.outputSchema.maxBytes.toLocaleString()} bytes</p>
      <pre>{JSON.stringify(node.outputSchema.schema, null, 2)}</pre>
      {node.expansion === undefined && node.subgraph === undefined
        && !(revision?.edges.some(edge => edge.to === node.id && edge.kind === 'conditional') ?? false)
        ? null
        : <>
          <h4>{t('node.controlFlow')}</h4>
          {node.expansion === undefined ? null : <pre>{JSON.stringify({ expansion: node.expansion }, null, 2)}</pre>}
          {node.subgraph === undefined ? null : <pre>{JSON.stringify({ subgraph: node.subgraph }, null, 2)}</pre>}
          {(revision?.edges.filter(edge => edge.to === node.id && edge.kind === 'conditional') ?? []).map((edge) => {
            const group = revision?.branchGroups.find(item => item.id === edge.branchGroupId)
            return <p key={`${edge.from}:${edge.to}`}>
              {edge.from} → {edge.to} · {edge.branchGroupId}/{group?.mode ?? 'unknown'} · {JSON.stringify(edge.condition)}
            </p>
          })}
        </>}
      {run?.branchEvaluation === undefined ? null : <>
        <h4>{t('branch.evidence')}</h4>
        <p>{run.branchEvaluation.decision} · {run.branchEvaluation.groups.map(group => `${group.id}:${String(group.matched)}/${String(group.considered)}`).join(', ')}</p>
      </>}
      <h4>{t('acceptance')}</h4>
      <ul>{node.acceptanceCriteria.map(item => <li key={item}>{item}</li>)}</ul>
      {run === undefined || (run.reusedFrom === undefined && run.suppliedByControlId === undefined && run.invalidatedBy === undefined)
        ? null
        : <>
          <h4>{t('node.provenance')}</h4>
          {run.reusedFrom === undefined
            ? null
            : <p>reused from {run.reusedFrom.runId}/{run.reusedFrom.generationId}/{run.reusedFrom.nodeId}</p>}
          {run.suppliedByControlId === undefined ? null : <p>supplied by {run.suppliedByControlId}</p>}
          {run.invalidatedBy === undefined ? null : <p>invalidated by {run.invalidatedBy.join(', ')}</p>}
        </>}
      {run?.output === undefined ? null : <>
        <h4>{t('output')}</h4><p>{run.output.summary}</p>
        {run.output.coordinationSummary === undefined ? null : <><h4>{t('coordination')}</h4><p>{run.output.coordinationSummary}</p></>}
        {run.output.data === undefined ? null : <><h4>{t('data')}</h4><pre>{JSON.stringify(run.output.data, null, 2)}</pre></>}
      </>}
      {run?.output?.artifacts.length
        ? <><h4>{t('artifacts')}</h4><ul>{run.output.artifacts.map(item => <li key={item}>{item}</li>)}</ul></>
        : null}
      {run === undefined || run.attempts.length === 0
        ? null
        : <><h4>{t('attempts')}</h4>{run.attempts.map((attempt) => {
          const childSessionId = attempt.childSessionId
          return (
            <div key={attempt.id} className={css.attempt}>
              <span>#{attempt.number} · {attempt.error?.message ?? (attempt.finishedAt === undefined ? 'running' : 'completed')}</span>
              <time>{new Date(attempt.startedAt).toLocaleString()} → {attempt.finishedAt === undefined ? '…' : new Date(attempt.finishedAt).toLocaleString()}</time>
              {attempt.error === undefined ? null : <code>{attempt.error.code}</code>}
              {attempt.loopxClaimId === undefined ? null : <code>{attempt.loopxClaimId}</code>}
              {attempt.health === undefined ? null : <>
                <span>{t('attempt.health', {
                  status: attempt.health.status,
                  reasoning: attempt.health.estimatedReasoningTokens,
                  durable: attempt.health.durableActions,
                  checkpoints: attempt.health.checkpointCount,
                })}</span>
                {attempt.health.stalledReason === undefined
                  ? null
                  : <code>{t('attempt.stalled', { reason: attempt.health.stalledReason })}</code>}
                <span>{t('attempt.usage', {
                  input: attempt.health.inputTokens,
                  output: attempt.health.outputTokens,
                  providerReasoning: attempt.health.providerReasoningTokens,
                  context: attempt.health.contextWindow ?? '—',
                  maxOutput: attempt.health.maxOutputTokens ?? attempt.executionBudget?.maxOutputTokens ?? '—',
                })}</span>
                <span>{t('attempt.progressTimes', {
                  activity: attempt.health.lastModelActivityAt === undefined ? '—' : new Date(attempt.health.lastModelActivityAt).toLocaleString(),
                  durable: attempt.health.lastDurableProgressAt === undefined ? '—' : new Date(attempt.health.lastDurableProgressAt).toLocaleString(),
                  files: attempt.health.changedFileCount,
                })}</span>
              </>}
              {attempt.modelProfile === undefined ? null : <details>
                <summary>{t('attempt.modelProfile')}</summary>
                <pre>{JSON.stringify(attempt.modelProfile, null, 2)}</pre>
              </details>}
              {attempt.executionBudget === undefined ? null : <details>
                <summary>{t('attempt.effectiveBudget')}</summary>
                <pre>{JSON.stringify(attempt.executionBudget, null, 2)}</pre>
              </details>}
              {attempt.checkpoints?.map(checkpoint => <details key={`${String(checkpoint.activation)}:${String(checkpoint.sequence)}`}>
                <summary>{t('attempt.checkpoint', { activation: checkpoint.activation, sequence: checkpoint.sequence })}</summary>
                <pre>{JSON.stringify(checkpoint, null, 2)}</pre>
              </details>)}
              {childSessionId === undefined
                ? null
                : (
                  <button type="button" onClick={() => { openSession(childSessionId) }}>
                    {t('attempt.open')}
                  </button>
                )}
              {attempt.continuationSessionIds?.map((id, index) => (
                <button key={id} type="button" onClick={() => { openSession(id) }}>
                  {t('attempt.openContinuation', { number: index + 1 })}
                </button>
              ))}
            </div>
          )
        })}</>}
      {checkpoints.length === 0 ? null : <>
        <h4>{t('node.checkpoints')}</h4>
        {checkpoints.map(item => <div key={item.id} className={css.attempt}>
          <span>{item.kind} · iteration {item.iteration} · {item.status}</span>
          <span>{item.reason}</span>
          {item.issues?.map(issue => <code key={issue.id}>{issue.severity}: {issue.id} — {issue.summary}</code>)}
        </div>)}
      </>}
      {operations.length === 0 ? null : <>
        <h4>{t('node.operations')}</h4>
        {operations.map(item => <div key={item.eventId} className={css.attempt}>
          <span>{item.stage} · epoch {item.ownerEpoch}</span>
          <time>{new Date(item.at).toLocaleString()}</time>
          {item.detail === undefined ? null : <span>{item.detail}</span>}
          {item.externalReferences.map(reference => <code key={`${reference.kind}:${reference.provider}:${reference.id}`}>
            {reference.kind}:{reference.provider}/{reference.id}
          </code>)}
        </div>)}
      </>}
      {settlements.length === 0 ? null : <>
        <h4>{t('node.settlements')}</h4>
        {settlements.map(item => <div key={`${item.id}:${item.attempt}`} className={css.attempt}>
          <span>{item.kind} · attempt {item.attempt} · {item.outcome}</span>
          <time>{new Date(item.completedAt ?? item.requestedAt).toLocaleString()}</time>
          {item.evidence === undefined ? null : <span>{item.evidence}</span>}
          {item.error === undefined ? null : <code>{item.error.code}: {item.error.message}</code>}
        </div>)}
      </>}
      {graphRun?.terminal === undefined ? null : <p><strong>{t('run.terminal', { rule: graphRun.terminal.rule })}</strong></p>}
    </aside>
  )
}

function graphNodePresentation(
  node: GraphNode,
  run: GraphRun | undefined,
  mode: 'design' | 'execution',
  palette: GraphPalette,
): { label: string; color: string } {
  const phase = run?.nodes[node.id]?.phase ?? 'pending'
  const color = mode === 'design' ? palette.business : phase === 'succeeded' ? palette.success
    : phase === 'running' ? palette.business
      : ['failed', 'blocked', 'exhausted'].includes(phase) ? palette.error
        : phase === 'awaiting_user' ? palette.warning : palette.pending
  return { label: `${node.title}\n${node.roleId} · ${mode === 'design' ? node.kind : phase}`, color }
}

interface GraphPalette {
  readonly background: string
  readonly border: string
  readonly business: string
  readonly conditional: string
  readonly error: string
  readonly label: string
  readonly labelInverted: string
  readonly pending: string
  readonly selected: string
  readonly success: string
  readonly warning: string
}

function graphPalette(element: HTMLElement): GraphPalette {
  const styles = getComputedStyle(element)
  const token = (name: string): string => styles.getPropertyValue(name).trim()
  return {
    background: token('--dsw-alias-bg-layer-1'),
    border: token('--dsw-alias-border-l4'),
    business: token('--dsw-alias-state-business-primary'),
    conditional: token('--dsw-alias-state-warn-primary'),
    error: token('--dsw-alias-state-error-primary'),
    label: token('--dsw-alias-label-secondary'),
    labelInverted: token('--dsw-alias-label-primary-foreground'),
    pending: token('--dsw-alias-label-tertiary'),
    selected: token('--dsw-alias-button-info-fill'),
    success: token('--dsw-alias-state-success-primary'),
    warning: token('--dsw-alias-state-warn-primary'),
  }
}

function GraphCanvas({ revision, run, selected, select, mode, t }: {
  readonly revision: GraphRevision
  readonly run: GraphRun | undefined
  readonly selected: string | undefined
  readonly select: (id: string) => void
  readonly mode: 'design' | 'execution'
  readonly t: GraphActionProps['t']
}) {
  const container = useRef<HTMLDivElement>(null)
  const overview = useRef<HTMLDivElement>(null)
  const graph = useRef<Core | null>(null)
  const minimap = useRef<Core | null>(null)
  const revisionRef = useRef(revision)
  const runRef = useRef(run)
  const selectedRef = useRef(selected)
  const selectRef = useRef(select)
  revisionRef.current = revision
  runRef.current = run
  selectedRef.current = selected
  selectRef.current = select
  useEffect(() => {
    if (container.current === null) return
    const currentRevision = revisionRef.current
    const headless = typeof navigator !== 'undefined' && navigator.userAgent.includes('jsdom')
    const palette = graphPalette(container.current)
    const instance: Core = cytoscape({
      ...headless ? { headless: true, styleEnabled: false } : { container: container.current },
      elements: [
        ...currentRevision.nodes.map(node => ({
          data: { id: node.id, ...graphNodePresentation(node, runRef.current, mode, palette) },
        })),
        ...currentRevision.edges.map((edge, index) => ({
          data: {
            id: `edge-${String(index)}`,
            source: edge.from,
            target: edge.to,
            label: edge.kind === 'conditional' ? edge.branchGroupId ?? 'condition' : '',
          },
          classes: edge.kind,
        })),
      ],
      layout: {
        name: 'breadthfirst',
        directed: true,
        circle: false,
        spacingFactor: 1.35,
        roots: currentRevision.nodes
          .filter(node => !currentRevision.edges.some(edge => edge.to === node.id))
          .map(node => node.id),
        transform: (_node, position) => ({ x: position.y, y: position.x }),
      },
      style: [
        { selector: 'node', style: { 'background-color': 'data(color)', 'border-color': palette.background, 'border-width': 2, color: palette.labelInverted, label: 'data(label)', ...graphCanvasNodeTypography, 'text-wrap': 'wrap', 'text-max-width': '150px', width: 176, height: 58, shape: 'round-rectangle', 'text-valign': 'center', 'text-halign': 'center' } },
        { selector: 'node:selected', style: { 'border-color': palette.selected, 'border-width': 4, 'overlay-opacity': 0 } },
        { selector: 'edge', style: { ...graphCanvasEdgeGeometry, 'line-color': palette.border, 'target-arrow-color': palette.border, 'target-arrow-shape': 'triangle', label: 'data(label)', color: palette.label, 'font-size': 10, 'text-background-color': palette.background, 'text-background-opacity': 0.9, 'text-background-padding': '3px' } },
        { selector: 'edge.conditional', style: { 'line-style': 'dashed', 'line-color': palette.conditional, 'target-arrow-color': palette.conditional } },
      ],
      minZoom: 0.35,
      maxZoom: 2.5,
      autoungrabify: true,
      boxSelectionEnabled: false,
    })
    instance.on('tap', 'node', (event: EventObjectNode) => { selectRef.current(event.target.id()) })
    if (selectedRef.current !== undefined) instance.getElementById(selectedRef.current).select()
    if (!headless) instance.fit(undefined, 28)
    graph.current = instance
    const overviewInstance: Core | undefined = headless || overview.current === null ? undefined : cytoscape({
      container: overview.current,
      elements: instance.elements().jsons() as ElementDefinition[],
      layout: {
        name: 'preset',
        positions: Object.fromEntries(graphNodePoints(currentRevision).map(point => [point.id, { x: point.x, y: point.y }])),
        fit: true,
        padding: 8,
      },
      style: [
        { selector: 'node', style: { 'background-color': 'data(color)', width: 16, height: 10, shape: 'round-rectangle', label: '' } },
        { selector: 'edge', style: { width: 1, 'line-color': palette.border, 'target-arrow-color': palette.border, 'target-arrow-shape': 'triangle', 'curve-style': 'straight' } },
      ],
      userPanningEnabled: false,
      userZoomingEnabled: false,
      autoungrabify: true,
      boxSelectionEnabled: false,
    })
    minimap.current = overviewInstance ?? null
    return () => {
      graph.current = null
      minimap.current = null
      overviewInstance?.destroy()
      instance.destroy()
    }
    // Revisions are immutable; the instance identity preserves the viewport across run projections.
  }, [mode, revision.graphId, revision.revision])
  useEffect(() => {
    const applyPresentation = (instance: Core): void => {
      instance.batch(() => {
        for (const node of revisionRef.current.nodes) {
          const element = instance.getElementById(node.id)
          if (element.nonempty()) element.data(graphNodePresentation(node, run, mode, graphPalette(container.current as HTMLDivElement)))
        }
      })
    }
    if (graph.current !== null) applyPresentation(graph.current)
    if (minimap.current !== null) applyPresentation(minimap.current)
  }, [mode, run])
  useEffect(() => {
    const instance = graph.current
    if (instance === null) return
    instance.elements().unselect()
    if (selected !== undefined) instance.getElementById(selected).select()
  }, [selected])
  const focusNode = (offset: -1 | 1): void => {
    const current = selected === undefined ? -1 : revision.nodes.findIndex(node => node.id === selected)
    const next = revision.nodes[(current + offset + revision.nodes.length) % revision.nodes.length]
    if (next === undefined) return
    select(next.id)
    const element = graph.current?.getElementById(next.id)
    if (element !== undefined && element.nonempty()) {
      graph.current?.elements().unselect()
      element.select()
      graph.current?.animate({ center: { eles: element }, duration: 120 })
    }
  }
  return <div className={css.canvasFrame}>
    <div className={css.canvasTools}>
      <button type="button" className={css.fitButton} onClick={() => { graph.current?.fit(undefined, 28) }}>
        <IconFullscreenOutline16 size={14} />
        <span>{t('canvas.fit')}</span>
      </button>
      <button type="button" aria-label={t('canvas.zoomOut')} onClick={() => { if (graph.current !== null) graph.current.zoom(graph.current.zoom() / 1.2) }}>−</button>
      <button type="button" aria-label={t('canvas.zoomIn')} onClick={() => { if (graph.current !== null) graph.current.zoom(graph.current.zoom() * 1.2) }}>+</button>
    </div>
    <div
      ref={container}
      className={css.canvas}
      role="application"
      tabIndex={0}
      aria-label="Directed acyclic task graph"
      onKeyDown={(event) => {
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') { event.preventDefault(); focusNode(1) }
        if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') { event.preventDefault(); focusNode(-1) }
      }}
    />
    <div ref={overview} className={css.minimap} aria-hidden="true" />
  </div>
}

function effectiveRoute(node: GraphNode, run: GraphRun | undefined, fallback: GraphModeConfig): string {
  const snapshot = run?.configSnapshot ?? fallback
  const overrides = run?.overrides
  const override = overrides?.[node.id]
  const roleId = override?.roleId ?? node.roleId
  const role = snapshot.roles.find(candidate => candidate.id === roleId)
  const model = { ...role?.model, ...override?.model }
  const route = [model.provider, model.model].filter(Boolean).join('/') || 'inherited model'
  const worker = override?.workerProvider ?? role?.workerProvider ?? 'local'
  return `${role?.label ?? roleId} · ${worker} · ${route}${model.reasoningEffort === undefined ? '' : ` · ${model.reasoningEffort}`}`
}

function elapsed(state: GraphNodeRun | undefined): string {
  const first = state?.attempts[0]?.startedAt
  if (first === undefined) return '—'
  const last = state?.attempts.at(-1)
  const end = last?.finishedAt ?? Date.now()
  const seconds = Math.max(0, Math.round((end - first) / 1_000))
  return seconds < 60 ? `${String(seconds)}s` : `${String(Math.floor(seconds / 60))}m ${String(seconds % 60)}s`
}

function ExecutionRecords({ revision, run, config, selected, select, t }: {
  readonly revision: GraphRevision
  readonly run: GraphRun | undefined
  readonly config: GraphModeConfig
  readonly selected: string | undefined
  readonly select: (id: string) => void
  readonly t: GraphActionProps['t']
}) {
  return (
    <aside className={css.records} aria-label={t('record.node')}>
      <div className={css.recordsHeader}>
        <div>
          <h2>{t('node.list')}</h2>
          <p>{t(selected === undefined ? 'node.noSelection' : 'node.listHelp')}</p>
        </div>
        <span>{revision.nodes.length}</span>
      </div>
      {revision.nodes.map((node) => {
        const state = run?.nodes[node.id]
        return (
          <button
            key={node.id}
            type="button"
            aria-label={node.title}
            aria-pressed={selected === node.id}
            className={css.record}
            onClick={() => { select(node.id) }}
          >
            <span className={css.recordTitle}><strong>{node.title}</strong><small>{node.kind} · {state?.phase ?? 'pending'}</small></span>
            <span className={css.recordMeta}>{effectiveRoute(node, run, config)}</span>
            <span className={css.recordResult}>{state?.output?.summary ?? state?.attempts.at(-1)?.error?.message ?? t('record.noResult')}</span>
            <span className={css.recordFooter}><time>{elapsed(state)}</time><IconChevronRightOutline14 size={14} /></span>
          </button>
        )
      })}
    </aside>
  )
}

/** Session-header entry point for Graph Mode. */
export function GraphAction({ useProjection, useModels, loadModels, saveConfig, control, openSession, t }: GraphActionProps) {
  const projection = useProjection('graph')
  const models = useModels(state => state)
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<'design' | 'execution'>('design')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [nodeDialogOpen, setNodeDialogOpen] = useState(false)
  const [revisionNumber, setRevisionNumber] = useState<number>()
  const [selected, setSelected] = useState<string>()
  const [draft, setDraft] = useState<GraphModeConfig>()
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle')
  const [error, setError] = useState<string>()
  const [controlError, setControlError] = useState<string>()
  const [overrideRole, setOverrideRole] = useState('')
  const [overrideModel, setOverrideModel] = useState('')
  const [overrideReasoning, setOverrideReasoning] = useState('')
  const [overrideWorker, setOverrideWorker] = useState('')
  const [overrideMaxOutput, setOverrideMaxOutput] = useState('')
  const [overrideReasoningBudget, setOverrideReasoningBudget] = useState('')
  const [suppliedOutput, setSuppliedOutput] = useState('{"summary":"","artifacts":[]}')
  const [modificationReason, setModificationReason] = useState('')
  const panelTitleId = useId()
  const settingsTitleId = useId()
  const nodeTitleId = useId()
  const revisions = projection === undefined ? undefined : currentGraph(projection)
  const revision = revisions?.find(item => item.revision === revisionNumber) ?? revisions?.at(-1)
  const run = projection !== undefined && revision !== undefined ? newestRun(projection, revision) : undefined
  const latestRevision = revisions?.at(-1)
  const latestRun = projection !== undefined && latestRevision !== undefined ? newestRun(projection, latestRevision) : undefined
  const selectedNode = revision?.nodes.find(node => node.id === selected)
  const selectedRun = selected === undefined ? undefined : run?.nodes[selected]
  const workerRoles = (run?.configSnapshot ?? projection?.config)?.roles
    .filter(role => role.enabled && !role.controller) ?? []
  const overrideRoleValue = overrideRole
    || workerRoles.find(role => role.id === selectedNode?.roleId)?.id || workerRoles[0]?.id || ''
  const checkpoint = run === undefined
    ? undefined
    : Object.values(projection?.checkpoints ?? {}).find(item => item.runId === run.id && item.status === 'pending')
  const controls = run === undefined
    ? []
    : Object.values(projection?.controls ?? {})
      .filter(item => item.runId === run.id)
      .sort((left, right) => left.completedAt - right.completedAt)

  useEffect(() => {
    if (projection !== undefined && !open) setDraft(projection.config)
  }, [open, projection?.config])
  useEffect(() => {
    if (open) loadModels()
  }, [loadModels, open])
  useEffect(() => {
    setRevisionNumber(revisions?.at(-1)?.revision)
    setSelected(undefined)
    setNodeDialogOpen(false)
  }, [projection?.currentGraphId, revisions?.length])
  useEffect(() => {
    setOverrideRole('')
    setOverrideModel('')
    setOverrideReasoning('')
    setOverrideWorker('')
    const budget = selectedNode === undefined || config === undefined ? undefined : effectiveNodeBudget(selectedNode, config)
    setOverrideMaxOutput(budget === undefined ? '' : String(budget.maxOutputTokens))
    setOverrideReasoningBudget(budget === undefined ? '' : String(budget.maxReasoningOnlyTokens))
  }, [run?.generation, selected])
  useEffect(() => {
    if (!open) return
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (nodeDialogOpen) setNodeDialogOpen(false)
      else if (settingsOpen) setSettingsOpen(false)
      else setOpen(false)
    }
    document.addEventListener('keydown', closeOnEscape)
    return () => { document.removeEventListener('keydown', closeOnEscape) }
  }, [nodeDialogOpen, open, settingsOpen])
  const config = draft ?? projection?.config
  const roleModelIssue = config === undefined ? undefined : graphRoleModelIssue(config, models)
  const updateDraft = (next: GraphModeConfig): void => {
    setDraft(next)
    setSaveState('idle')
    setError(undefined)
  }
  const summary = useMemo(() => (
    revision === undefined ? '' : `${revision.nodes.length} nodes · r${revision.revision}`
  ), [revision])
  if (projection?.config.active !== true || config === undefined) return null

  const save = (): void => {
    if (roleModelIssue !== undefined) return
    setSaveState('saving')
    setError(undefined)
    void saveConfig(config).then((failure) => {
      if (failure === null) setSaveState('saved')
      else {
        setSaveState('idle')
        setError(failure)
      }
    }, (reason: unknown) => {
      setSaveState('idle')
      setError(reason instanceof Error ? reason.message : String(reason))
    })
  }
  const operate = (action: string, extra: Readonly<Record<string, unknown>> = {}, addressedRun = run): void => {
    if (addressedRun === undefined || typeof control !== 'function') return
    setControlError(undefined)
    const operationId = `ui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`
    const nodeId = typeof extra['nodeId'] === 'string' ? extra['nodeId'] : undefined
    const expectedAttemptId = nodeId === undefined ? undefined : addressedRun.nodes[nodeId]?.attempts.at(-1)?.id
    void control({
      operationId,
      action,
      graphId: addressedRun.graphId,
      runId: addressedRun.id,
      expectedRevision: addressedRun.revision,
      expectedGeneration: addressedRun.generation,
      ...expectedAttemptId === undefined ? {} : { expectedAttemptId },
      reason: `User requested ${action} from the Graph execution view.`,
      ...extra,
    })
      .then((failure) => { if (failure !== null) setControlError(failure) }, (reason: unknown) => {
        setControlError(reason instanceof Error ? reason.message : String(reason))
      })
  }
  const applyOverride = (): void => {
    if (selectedNode === undefined) return
    const choice = modelChoices(models).find(item => item.key === overrideModel)
    const model = replaceReasoningEffort(replaceModelSelection({}, choice), overrideReasoning.trim())
    const maxOutputTokens = Number(overrideMaxOutput)
    const maxReasoningOnlyTokens = Number(overrideReasoningBudget)
    if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1
      || !Number.isSafeInteger(maxReasoningOnlyTokens) || maxReasoningOnlyTokens < 1) {
      setControlError(t('control.overrideBudgetInvalid'))
      return
    }
    operate('override-node', {
      nodeId: selectedNode.id,
      override: {
        roleId: overrideRoleValue,
        ...Object.keys(model).length === 0 ? {} : { model },
        ...overrideWorker.trim() === '' ? {} : { workerProvider: overrideWorker.trim() },
        executionBudget: {
          ...effectiveNodeBudget(selectedNode, config),
          maxOutputTokens,
          maxReasoningOnlyTokens,
        },
      },
    })
  }
  const applySuppliedOutput = (): void => {
    if (selectedNode === undefined) return
    try {
      operate('supply-output', { nodeId: selectedNode.id, output: JSON.parse(suppliedOutput) as unknown })
    } catch {
      setControlError('Substitute node output must be valid JSON.')
    }
  }
  const requestModification = (): void => {
    if (selectedNode === undefined) return
    const reason = modificationReason.trim()
    if (reason === '') {
      setControlError(t('control.modifyRequired'))
      return
    }
    operate('modify-task', { nodeId: selectedNode.id, reason })
  }
  const inspectNode = (id: string): void => {
    setSelected(id)
    setNodeDialogOpen(true)
  }
  return (
    <div className={css.root}>
      <button type="button" className={css.trigger} aria-haspopup="dialog" aria-expanded={open} onClick={() => { setOpen(value => !value) }}>
        Graph{summary === '' ? '' : ` · ${summary}`}
      </button>
      {open
        ? (
          <>
            <div className={css.mask} aria-hidden="true" onClick={() => { setOpen(false) }} />
            <div className={css.panel} role="dialog" aria-modal="true" aria-labelledby={panelTitleId}>
              <header className={css.panelHeader}>
                <div className={css.panelIdentity}>
                  <strong id={panelTitleId}>{t('panel.title')}</strong>
                  <span>{summary}</span>
                </div>
                <nav className={css.tabs} role="tablist" aria-label={t('panel.aria')}>
                  <button type="button" role="tab" aria-selected={tab === 'design'} data-active={tab === 'design'} onClick={() => { setSettingsOpen(false); setTab('design') }}>
                    {t('tab.design')}
                  </button>
                  <button type="button" role="tab" aria-selected={tab === 'execution'} data-active={tab === 'execution'} onClick={() => { setSettingsOpen(false); setTab('execution') }}>
                    {t('tab.execution')}
                  </button>
                </nav>
                <div className={css.headerActions}>
                  <button type="button" className={css.iconButton} aria-label={t('settings.open')} onClick={() => { setSettingsOpen(true) }}><IconSettingsOutline16 size={16} /></button>
                  <button type="button" className={css.iconButton} aria-label={t('close')} onClick={() => { setOpen(false) }}><IconCloseOutline16 size={16} /></button>
                </div>
              </header>
              {settingsOpen
                ? (
                  <div className={css.settingsPane} role="dialog" aria-modal="true" aria-labelledby={settingsTitleId}>
                    <header className={css.modalHeader}>
                      <h2 id={settingsTitleId}>{t('settings.title')}</h2>
                      <button type="button" className={css.iconButton} aria-label={t('close')} autoFocus onClick={() => { setSettingsOpen(false) }}><IconCloseOutline16 size={16} /></button>
                    </header>
                    <GraphRoleEditor config={config} models={models} setConfig={updateDraft} t={t} />
                    <footer className={css.modalFooter}>
                      <button
                        type="button"
                        className={css.primaryButton}
                        disabled={saveState === 'saving' || roleModelIssue !== undefined}
                        onClick={save}
                      >
                        {t(saveState === 'saving' ? 'saving' : 'save')}
                      </button>
                      {saveState === 'saved' ? <span>{t('saved')}</span> : null}
                      {roleModelIssue === undefined ? null : <span role="status">{t(roleModelIssue.key, {
                        role: roleModelIssue.role,
                        model: roleModelIssue.model,
                        effort: roleModelIssue.effort,
                      })}</span>}
                      {error === undefined ? null : <span role="status">{error}</span>}
                    </footer>
                  </div>
                )
                : revisions === undefined || revision === undefined
                  ? <p className={css.empty}>{t('empty')}</p>
                  : (
                    <div className={css.graphView}>
                      <div className={css.graphMain}>
                        <label className={css.revision}>
                          {t('revisions')}
                          <select value={revision.revision} onChange={(event) => {
                            setRevisionNumber(Number(event.target.value))
                            setSelected(undefined)
                          }}>
                            {revisions.map(item => (
                              <option key={item.revision} value={item.revision}>r{item.revision}</option>
                            ))}
                          </select>
                          {latestRevision !== undefined && revision.revision < latestRevision.revision && latestRun !== undefined
                            ? <button type="button" onClick={() => { operate('rollback', { targetRevision: revision.revision }, latestRun) }}>{t('control.rollback')}</button>
                            : null}
                        </label>
                        {run === undefined
                          ? <p>{t('run.none')}</p>
                          : <div className={css.runBar}><p className={css.phase}>{run.phase}</p>
                            {!['succeeded', 'failed', 'canceled', 'exhausted', 'paused', 'awaiting_user'].includes(run.phase)
                              ? <button type="button" onClick={() => { operate('pause-run') }}><IconPauseOutline16 size={14} />{t('control.pauseRun')}</button>
                              : null}
                            {run.phase === 'awaiting_user'
                              ? <button type="button" onClick={() => { operate('reconcile-run') }}>{t('control.reconcile')}</button>
                              : null}
                            {!['succeeded', 'failed', 'canceled', 'exhausted'].includes(run.phase)
                              ? <button type="button" onClick={() => { operate('cancel-run') }}><IconStopFill16 size={14} />{t('control.cancelRun')}</button>
                              : null}
                          </div>}
                        {run?.error === undefined
                          ? null
                          : <p role="status">{t('run.error', { code: run.error.code, message: run.error.message })}</p>}
                        {controlError === undefined ? null : <p role="status">{controlError}</p>}
                        {checkpoint === undefined ? null : <div className={css.checkpoint}>
                          <strong>{checkpoint.kind}</strong><span>{checkpoint.reason}</span>
                          <button type="button" onClick={() => { operate('approve-checkpoint', { checkpointId: checkpoint.id }) }}>{t('control.approve')}</button>
                          <button type="button" onClick={() => { operate('reject-checkpoint', { checkpointId: checkpoint.id }) }}>{t('control.reject')}</button>
                        </div>}
                        {tab === 'design'
                          ? <section className={css.graphSection} data-view="design">
                            <GraphCanvas mode="design" revision={revision} run={run} selected={selected} select={setSelected} t={t} />
                          </section>
                          : <section className={css.graphSection} data-view="execution">
                            <div className={css.executionGraph}>
                              <GraphCanvas
                                mode="execution"
                                revision={revision}
                                run={run}
                                selected={selected}
                                select={inspectNode}
                                t={t}
                              />
                            </div>
                            <ExecutionRecords
                              revision={revision}
                              run={run}
                              config={config}
                              selected={selected}
                              select={inspectNode}
                              t={t}
                            />
                          </section>}
                        {nodeDialogOpen && selectedNode !== undefined ? <div className={css.subOverlay} role="presentation">
                          <div className={css.mask} aria-hidden="true" onClick={() => { setNodeDialogOpen(false) }} />
                          <div className={css.nodeDialog} role="dialog" aria-modal="true" aria-labelledby={nodeTitleId}>
                            <header className={css.modalHeader}>
                              <div>
                                <span className={css.modalEyebrow}>{t('node.details')}</span>
                                <h2 id={nodeTitleId}>{selectedNode.title}</h2>
                              </div>
                              <button
                                type="button"
                                className={css.iconButton}
                                aria-label={t('close')}
                                autoFocus
                                onClick={() => { setNodeDialogOpen(false) }}
                              >
                                <IconCloseOutline16 size={16} />
                              </button>
                            </header>
                            <div className={css.nodeDialogBody}>
                              <NodeDetails
                                node={selectedNode}
                                run={selectedRun}
                                graphRun={run}
                                revision={revision}
                                operations={selectedRun === undefined || run === undefined
                                  ? []
                                  : (projection.operations[selectedRun.workId] ?? []).filter(item => (
                                    item.runId === run.id && item.generationId === run.generationId
                                  ))}
                                settlements={selectedRun === undefined || run === undefined
                                  ? []
                                  : Object.values(projection.settlements).flat().filter(item => item.workId === selectedRun.workId
                                  && item.runId === run.id && item.generationId === run.generationId)}
                                checkpoints={run === undefined
                                  ? []
                                  : Object.values(projection.checkpoints).filter(item => (
                                    item.runId === run.id && item.nodeId === selectedNode.id
                                  ))}
                                openSession={openSession}
                                t={t}
                              />
                              {controls.length === 0 ? null : <section className={css.controlTimeline}>
                                <h3>{t('control.timeline')}</h3>
                                {controls.map(item => <div key={item.id}>
                                  <strong>{item.action}</strong>
                                  <span>{item.actor.kind}:{item.actor.id} · {item.source}</span>
                                  <span>
                                    g{item.expectedGeneration} → {item.resultingGeneration ?? item.expectedGeneration}
                                    {' · '}{item.result.outcome}
                                  </span>
                                  <time>{new Date(item.completedAt).toLocaleString()}</time>
                                </div>)}
                              </section>}
                              {run === undefined ? null : <div className={css.nodeControls}>
                                <div className={css.supplyControls}>
                                  <label>{t('control.modifyLabel')}<textarea value={modificationReason} onChange={(event) => { setModificationReason(event.target.value) }} /></label>
                                  <button type="button" onClick={requestModification}><IconEditOutline16 size={14} />{t('control.modify')}</button>
                                </div>
                                {selectedRun?.phase === 'running'
                                  ? <button type="button" onClick={() => { operate('cancel-node', { nodeId: selectedNode.id }) }}><IconStopFill16 size={14} />{t('control.cancelNode')}</button>
                                  : null}
                                {selectedRun !== undefined && ['failed', 'canceled', 'exhausted', 'blocked'].includes(selectedRun.phase)
                                  ? <button type="button" onClick={() => { operate('retry-node', { nodeId: selectedNode.id }) }}>{t('control.retry')}</button>
                                  : null}
                                {['succeeded', 'failed', 'canceled', 'exhausted'].includes(run.phase)
                                  ? <button type="button" onClick={() => { operate('resume-from-node', { nodeId: selectedNode.id }) }}>{t('control.resume')}</button>
                                  : null}
                                {selectedNode.skippable && !['succeeded', 'skipped'].includes(selectedRun?.phase ?? '')
                                  ? <button type="button" onClick={() => { operate('skip-node', { nodeId: selectedNode.id }) }}>{t('control.skip')}</button>
                                  : null}
                                {selectedRun !== undefined && ['failed', 'canceled', 'exhausted', 'blocked', 'awaiting_user'].includes(selectedRun.phase)
                                  ? <div className={css.supplyControls}>
                                    <label>{t('control.supplyOutputLabel')}<textarea value={suppliedOutput} onChange={(event) => { setSuppliedOutput(event.target.value) }} /></label>
                                    <button type="button" onClick={applySuppliedOutput}>{t('control.supplyOutput')}</button>
                                  </div>
                                  : null}
                                {selectedRun?.phase === 'running' || ['succeeded', 'failed', 'canceled', 'exhausted'].includes(run.phase)
                                  ? <div className={css.overrideControls}>
                                    <label>
                                      {t('control.overrideRole')}
                                      <select value={overrideRoleValue} onChange={(event) => { setOverrideRole(event.target.value) }}>
                                        {workerRoles.map(role => (
                                          <option key={role.id} value={role.id}>{role.label}</option>
                                        ))}
                                      </select>
                                    </label>
                                    <label>
                                      {t('control.overrideModel')}
                                      <select value={overrideModel} onChange={(event) => {
                                        const choice = modelChoices(models).find(item => item.key === event.target.value)
                                        setOverrideModel(event.target.value)
                                        setOverrideReasoning(choice?.defaultReasoningEffort ?? '')
                                      }}>
                                        <option value="">{t('model.inherit')}</option>
                                        {modelChoices(models).map(choice => (
                                          <option key={choice.key} value={choice.key}>{choice.label}</option>
                                        ))}
                                      </select>
                                    </label>
                                    <label>
                                      {t('control.overrideReasoning')}
                                      <input
                                        value={overrideReasoning}
                                        disabled={overrideModel !== '' && modelChoices(models).find(item => item.key === overrideModel)?.reasoningEfforts === undefined}
                                        list="graph-override-reasoning"
                                        onChange={(event) => { setOverrideReasoning(event.target.value) }}
                                      />
                                      <datalist id="graph-override-reasoning">
                                        {modelChoices(models).find(item => item.key === overrideModel)?.reasoningEfforts
                                          ?.map(effort => <option key={effort} value={effort} />)}
                                      </datalist>
                                    </label>
                                    <label>
                                      {t('control.overrideWorker')}
                                      <input value={overrideWorker} onChange={(event) => { setOverrideWorker(event.target.value) }} />
                                    </label>
                                    <label>
                                      {t('control.overrideMaxOutput')}
                                      <input type="number" min={1} value={overrideMaxOutput} onChange={(event) => { setOverrideMaxOutput(event.target.value) }} />
                                    </label>
                                    <label>
                                      {t('control.overrideReasoningBudget')}
                                      <input type="number" min={1} value={overrideReasoningBudget} onChange={(event) => { setOverrideReasoningBudget(event.target.value) }} />
                                    </label>
                                    <button type="button" onClick={applyOverride}>{t('control.override')}</button>
                                  </div>
                                  : null}
                              </div>}
                            </div>
                          </div>
                        </div> : null}
                      </div>
                    </div>
                  )}
            </div>
          </>
        )
        : null}
    </div>
  )
}
