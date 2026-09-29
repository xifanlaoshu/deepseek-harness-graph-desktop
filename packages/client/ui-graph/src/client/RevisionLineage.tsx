import { useEffect, useMemo, useRef, useState } from 'react'
import cytoscape from 'cytoscape'
import type { Core, EventObjectNode } from 'cytoscape'
import type {
  GraphId,
  GraphProjection,
  GraphRevision,
  GraphRevisionKind,
  GraphRevisionLineage,
  GraphRun,
} from '@deepseek-ai/dsh-graph/client'
import type { GraphActionProps } from './GraphAction.tsx'
import { cytoscapeColor } from './cytoscapeColor.ts'
import { graphFontFamily } from './graphTypography.ts'
import css from './GraphAction.module.css'

function cytoscapeLabelExpression(): string {
  return ['data(', 'label', ')'].join('')
}

/** Runtime totals derived from durable runs and child-attempt health. */
export interface RevisionRuntimeMetrics {
  readonly startedAt?: number
  readonly completedAt?: number
  readonly durationMs?: number
  readonly runCount: number
  readonly subagentCount: number
  readonly taskInteractions: number
  readonly agentTurns?: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly reasoningTokens: number
  readonly toolCalls: number
  readonly retries: number
  readonly humanInteractions: number
}

/** Browser-facing revision record that combines immutable design and runtime evidence. */
export interface RevisionLineageItem {
  readonly id: string
  readonly graph: GraphRevision
  readonly lineage?: GraphRevisionLineage
  readonly runs: readonly GraphRun[]
  readonly latestRun?: GraphRun
  readonly metrics: RevisionRuntimeMetrics
}

const terminalRunPhases = new Set(['succeeded', 'failed', 'canceled', 'exhausted'])

/**
 * Project every immutable graph revision into one user-visible lineage item.
 * @param projection durable graph session state.
 * @returns revisions ordered by logical-task creation and revision number.
 */
export function graphRevisionLineageItems(projection: GraphProjection): readonly RevisionLineageItem[] {
  const submissions = Object.values(projection.submissions)
  const controls = Object.values(projection.controls)
  return Object.values(projection.graphs).flatMap(revisions => revisions.map((graph) => {
    const runs = Object.values(projection.runs)
      .filter(run => run.graphId === graph.graphId && run.revision === graph.revision)
      .sort((left, right) => left.createdAt - right.createdAt)
    const nodeRuns = runs.flatMap(run => Object.values(run.nodes))
    const attempts = nodeRuns.flatMap(node => node.attempts)
    const sessions = new Set(attempts.flatMap(attempt => [
      attempt.childSessionId,
      ...(attempt.continuationSessionIds ?? []),
    ]).filter((id): id is string => id !== undefined))
    const completedRuns = runs.filter(run => terminalRunPhases.has(run.phase))
    const startedAt = attempts.length > 0
      ? Math.min(...attempts.map(attempt => attempt.startedAt))
      : runs.some(run => run.phase !== 'queued') ? Math.min(...runs.map(run => run.createdAt)) : undefined
    const completedAt = completedRuns.length === 0 || completedRuns.length !== runs.length
      ? undefined
      : Math.max(...completedRuns.map(run => run.terminal?.acceptedAt ?? run.updatedAt))
    const lineage = submissions
      .filter(item => item.graph.graphId === graph.graphId && item.graph.revision === graph.revision)
      .sort((left, right) => right.requestedAt - left.requestedAt)[0]?.lineage
    return {
      id: `${graph.graphId}:r${String(graph.revision)}`,
      graph,
      ...lineage === undefined ? {} : { lineage },
      runs,
      ...runs.at(-1) === undefined ? {} : { latestRun: runs.at(-1) as GraphRun },
      metrics: {
        ...startedAt === undefined ? {} : { startedAt },
        ...completedAt === undefined ? {} : { completedAt, durationMs: completedAt - (startedAt ?? completedAt) },
        runCount: runs.length,
        subagentCount: sessions.size,
        taskInteractions: attempts.length,
        inputTokens: attempts.reduce((total, attempt) => total + (attempt.health?.inputTokens ?? 0), 0),
        outputTokens: attempts.reduce((total, attempt) => total + (attempt.health?.outputTokens ?? 0), 0),
        reasoningTokens: attempts.reduce((total, attempt) => total + (attempt.health?.providerReasoningTokens ?? 0), 0),
        toolCalls: attempts.reduce((total, attempt) => total + (attempt.health?.toolCalls ?? 0), 0),
        retries: nodeRuns.reduce((total, node) => total + Math.max(0, node.attempts.length - 1), 0),
        humanInteractions: controls.filter(control => control.graphId === graph.graphId
          && control.expectedRevision === graph.revision
          && ['modify-task', 'rollback', 'approve-checkpoint', 'reject-checkpoint', 'supply-output'].includes(control.action)).length
          + Object.values(projection.checkpoints).filter(checkpoint => checkpoint.graphId === graph.graphId
            && checkpoint.revision === graph.revision && checkpoint.kind === 'awaiting_user').length,
      },
    }
  })).sort((left, right) => (
    left.graph.graphId === right.graph.graphId
      ? left.graph.revision - right.graph.revision
      : left.graph.createdAt - right.graph.createdAt
  ))
}

const dateTime = (value: number | undefined, unavailable: string): string => (
  value === undefined ? unavailable : new Date(value).toLocaleString()
)

const duration = (value: number | undefined, unavailable: string, t: GraphActionProps['t']): string => {
  if (value === undefined) return unavailable
  const seconds = Math.max(0, Math.round(value / 1_000))
  const minutes = Math.floor(seconds / 60)
  return minutes === 0
    ? t('node.elapsedSeconds', { seconds })
    : t('node.elapsed', { minutes, seconds: seconds % 60 })
}

const compactNumber = (value: number): string => new Intl.NumberFormat(undefined, {
  notation: 'compact',
  maximumFractionDigits: 1,
}).format(value)

const compactDate = (value: number | undefined, unavailable: string): string => value === undefined
  ? unavailable
  : new Date(value).toLocaleString(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })

const compactTitle = (value: string): string => value.length <= 34 ? value : `${value.slice(0, 33)}…`

function kindOf(item: RevisionLineageItem): GraphRevisionKind | 'unknown' {
  return item.lineage?.kind ?? 'unknown'
}

function kindLabel(t: GraphActionProps['t'], kind: GraphRevisionKind | 'unknown'): string {
  switch (kind) {
    case 'new_task': return t('revision.kind.new_task')
    case 'analysis_refactor': return t('revision.kind.analysis_refactor')
    case 'execution_correction': return t('revision.kind.execution_correction')
    case 'unknown': return t('revision.kind.unknown')
  }
}

function runPhaseLabel(t: GraphActionProps['t'], phase: string): string {
  switch (phase) {
    case 'queued': return t('node.phase.queued')
    case 'running': return t('node.phase.running')
    case 'succeeded': return t('node.phase.succeeded')
    case 'failed': return t('node.phase.failed')
    case 'awaiting_user': return t('node.phase.awaiting_user')
    case 'blocked': return t('node.phase.blocked')
    case 'canceled': return t('node.phase.canceled')
    case 'exhausted': return t('node.phase.exhausted')
    default: return phase
  }
}

function metric(label: string, value: string | number) {
  return <div><span>{label}</span><strong>{value}</strong></div>
}

/** Revision lineage canvas, filters, preview, and evidence drawer. */
export function RevisionLineage({ projection, selectedGraphId, selectedRevision, selectRevision, t }: {
  readonly projection: GraphProjection
  readonly selectedGraphId: GraphId | undefined
  readonly selectedRevision: number | undefined
  readonly selectRevision: (graphId: GraphId, revision: number, view?: 'design' | 'execution') => void
  readonly t: GraphActionProps['t']
}) {
  const all = useMemo(() => graphRevisionLineageItems(projection), [projection])
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<GraphRevisionKind | 'all' | 'unknown'>('all')
  const [phase, setPhase] = useState<'all' | 'running' | 'succeeded' | 'failed' | 'awaiting_user'>('all')
  const [expanded, setExpanded] = useState(false)
  const selectedId = selectedGraphId === undefined || selectedRevision === undefined
    ? all.at(-1)?.id
    : `${selectedGraphId}:r${String(selectedRevision)}`
  const [detailId, setDetailId] = useState<string | undefined>(selectedId)
  const [preview, setPreview] = useState<{ readonly item: RevisionLineageItem; readonly x: number; readonly y: number }>()
  const container = useRef<HTMLDivElement>(null)
  const graph = useRef<Core | null>(null)
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>()
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const filtered = all.filter((item) => {
    if (kind !== 'all' && kindOf(item) !== kind) return false
    if (phase !== 'all' && item.latestRun?.phase !== phase) return false
    if (normalizedQuery === '') return true
    return [item.graph.graphId, item.graph.objective, item.lineage?.title, item.lineage?.reason, item.lineage?.trigger.summary,
      item.lineage?.trigger.errorCode, ...item.graph.nodes.map(node => node.roleId),
      ...item.runs.flatMap(run => Object.values(run.nodes).flatMap(node => node.attempts.flatMap(attempt => [
        attempt.modelProfile?.provider, attempt.modelProfile?.model, attempt.error?.code,
      ]))),
    ]
      .some(value => value?.toLocaleLowerCase().includes(normalizedQuery))
  })
  const visible = expanded || filtered.length <= 40
    ? filtered
    : filtered.filter((item, index) => index === 0 || index >= filtered.length - 20 || item.id === selectedId)
  const visibleIds = new Set(visible.map(item => item.id))
  const laneIds = [...new Set(visible.map(item => item.lineage?.taskId ?? item.graph.graphId))]
  const structuralSignature = visible.map(item => `${item.id}:${item.lineage?.relationships.map(link => `${link.kind}:${link.graphId}:${String(link.revision ?? '')}`).join(',') ?? ''}`).join('|')
  const itemRef = useRef(new Map(visible.map(item => [item.id, item])))
  itemRef.current = new Map(visible.map(item => [item.id, item]))

  useEffect(() => {
    if (container.current === null) return
    const headless = typeof navigator !== 'undefined' && navigator.userAgent.includes('jsdom')
    const styles = getComputedStyle(container.current)
    const token = (name: string): string => cytoscapeColor(styles.getPropertyValue(name).trim())
    const elements = [
      ...visible.map((item) => {
        const taskId = item.lineage?.taskId ?? item.graph.graphId
        const taskItems = visible.filter(candidate => (candidate.lineage?.taskId ?? candidate.graph.graphId) === taskId)
        const totalTokens = item.metrics.inputTokens + item.metrics.outputTokens
        return {
          data: {
            id: item.id,
            label: [
              compactTitle(item.lineage?.title ?? item.graph.objective),
              `${t('node.revision', { revision: item.graph.revision })} · ${kindLabel(t, kindOf(item))} · ${item.latestRun === undefined ? t('revision.state.notRun') : runPhaseLabel(t, item.latestRun.phase)}`,
              `${compactDate(item.metrics.startedAt, '—')} · ${duration(item.metrics.durationMs, '—', t)}`,
              `${String(item.metrics.subagentCount)}A · ${String(item.metrics.taskInteractions)}I · ${compactNumber(totalTokens)}T`,
            ].join('\n'),
            status: item.latestRun?.phase ?? 'not-run',
          },
          position: { x: 150 + taskItems.indexOf(item) * 250, y: 90 + laneIds.indexOf(taskId) * 150 },
          classes: `${kindOf(item)} ${item.latestRun?.phase ?? 'not-run'}`,
        }
      }),
      ...visible.flatMap((item) => {
        const links = item.lineage?.relationships ?? (item.graph.parentRevision === undefined ? [] : [{
          kind: 'derived_from' as const,
          graphId: item.graph.graphId,
          revision: item.graph.parentRevision,
          reason: 'Historical parent revision.',
        }])
        return links.flatMap((link, index) => {
          if (link.revision === undefined) return []
          const source = `${link.graphId}:r${String(link.revision)}`
          if (!visibleIds.has(source)) return []
          return [{
            data: { id: `${source}->${item.id}:${String(index)}`, source, target: item.id, label: link.kind },
            classes: link.kind,
          }]
        })
      }),
    ]
    const instance = cytoscape({
      ...headless ? { headless: true, styleEnabled: false } : { container: container.current },
      elements,
      layout: { name: 'preset', fit: true, padding: 54 },
      style: [
        { selector: 'node', style: { width: 220, height: 92, shape: 'round-rectangle', label: cytoscapeLabelExpression(), 'text-wrap': 'wrap', 'text-max-width': '190px', 'font-family': graphFontFamily, 'font-size': 10.5, 'font-weight': 500, color: token('--dsw-alias-label-primary'), 'background-color': token('--dsw-alias-bg-layer-2'), 'border-width': 1.5, 'border-color': token('--dsw-alias-border-l4'), 'text-valign': 'center', 'text-halign': 'center' } },
        { selector: 'node.new_task', style: { 'border-color': token('--dsw-alias-state-business-primary') } },
        { selector: 'node.analysis_refactor', style: { 'border-color': token('--dsw-alias-state-warn-primary') } },
        { selector: 'node.execution_correction', style: { 'border-color': token('--dsw-alias-state-error-primary') } },
        { selector: 'node.succeeded', style: { 'background-color': token('--dsw-alias-state-success-secondary') } },
        { selector: 'node:selected', style: { 'border-width': 3, 'border-color': token('--dsw-alias-button-info-fill'), 'overlay-opacity': 0 } },
        { selector: 'edge', style: { width: 1.4, 'curve-style': 'unbundled-bezier', 'control-point-distance': 40, 'control-point-weight': 0.5, 'target-arrow-shape': 'triangle', 'line-color': token('--dsw-alias-border-l4'), 'target-arrow-color': token('--dsw-alias-border-l4'), label: cytoscapeLabelExpression(), 'font-family': graphFontFamily, 'font-size': 9, color: token('--dsw-alias-label-tertiary'), 'text-background-color': token('--dsw-alias-bg-layer-1'), 'text-background-opacity': 0.9 } },
        { selector: 'edge.corrects', style: { 'line-style': 'dashed', 'line-color': token('--dsw-alias-state-error-primary'), 'target-arrow-color': token('--dsw-alias-state-error-primary') } },
        { selector: 'edge.refactors', style: { 'line-style': 'dotted', 'line-color': token('--dsw-alias-state-warn-primary'), 'target-arrow-color': token('--dsw-alias-state-warn-primary') } },
        { selector: 'edge.depends_on', style: { 'line-style': 'dashed', 'line-color': token('--dsw-alias-state-business-primary'), 'target-arrow-color': token('--dsw-alias-state-business-primary') } },
      ],
      minZoom: 0.2,
      maxZoom: 1.35,
      autoungrabify: true,
      boxSelectionEnabled: false,
    })
    instance.on('tap', 'node', (event: EventObjectNode) => {
      const item = itemRef.current.get(event.target.id())
      if (item === undefined) return
      setDetailId(item.id)
      selectRevision(item.graph.graphId, item.graph.revision)
    })
    instance.on('mouseover', 'node', (event: EventObjectNode) => {
      const item = itemRef.current.get(event.target.id())
      if (item === undefined) return
      const position = event.target.renderedPosition()
      hoverTimer.current = setTimeout(() => { setPreview({ item, x: position.x + 20, y: position.y + 18 }) }, 360)
    })
    instance.on('mouseout', 'node', () => {
      if (hoverTimer.current !== undefined) clearTimeout(hoverTimer.current)
      setPreview(undefined)
    })
    if (selectedId !== undefined) instance.getElementById(selectedId).select()
    if (!headless) instance.fit(undefined, 54)
    graph.current = instance
    return () => {
      if (hoverTimer.current !== undefined) clearTimeout(hoverTimer.current)
      graph.current = null
      instance.destroy()
    }
  }, [structuralSignature])

  useEffect(() => {
    const instance = graph.current
    if (instance === null) return
    instance.elements().unselect()
    if (selectedId !== undefined) instance.getElementById(selectedId).select()
  }, [selectedId])

  const detail = all.find(item => item.id === detailId) ?? all.find(item => item.id === selectedId) ?? all.at(-1)
  const unavailable = t('revision.unavailable')
  const related = detail === undefined ? [] : [
    ...(detail.lineage?.relationships.flatMap((relationship) => {
      const target = relationship.revision === undefined ? undefined : all.find(item => (
        item.graph.graphId === relationship.graphId && item.graph.revision === relationship.revision
      ))
      return target === undefined ? [] : [{ label: t('revision.related', { kind: relationship.kind, revision: target.graph.revision }), item: target }]
    }) ?? []),
    ...all.flatMap(candidate => candidate.lineage?.relationships.some(relationship => (
      relationship.graphId === detail.graph.graphId && relationship.revision === detail.graph.revision
    )) === true ? [{ label: t('revision.correctedBy', { revision: candidate.graph.revision }), item: candidate }] : []),
  ]
  const detailRunIds = new Set(detail?.runs.map(run => run.id) ?? [])
  const detailSubmissions = detail === undefined ? [] : Object.values(projection.submissions).filter(item => (
    item.graph.graphId === detail.graph.graphId && item.graph.revision === detail.graph.revision
  ))
  const detailControls = detail === undefined ? [] : Object.values(projection.controls).filter(item => (
    item.graphId === detail.graph.graphId && item.expectedRevision === detail.graph.revision
  ))
  const detailSettlements = [...new Map(Object.values(projection.settlements).flat()
    .filter(item => detailRunIds.has(item.runId))
    .map(item => [`${item.id}:${String(item.attempt)}`, item])).values()]
  return <section className={css.revisionWorkspace} data-view="revisions">
    <header className={css.revisionToolbar}>
      <label>{t('revision.search')}<input value={query} onChange={(event) => { setQuery(event.target.value) }} /></label>
      <label>{t('revision.filterKind')}<select value={kind} onChange={(event) => { setKind(event.target.value as typeof kind) }}>
        <option value="all">{t('revision.kind.all')}</option>
        <option value="new_task">{t('revision.kind.new_task')}</option>
        <option value="analysis_refactor">{t('revision.kind.analysis_refactor')}</option>
        <option value="execution_correction">{t('revision.kind.execution_correction')}</option>
        <option value="unknown">{t('revision.kind.unknown')}</option>
      </select></label>
      <label>{t('revision.filterState')}<select value={phase} onChange={(event) => { setPhase(event.target.value as typeof phase) }}>
        <option value="all">{t('revision.state.all')}</option>
        <option value="running">{t('revision.state.running')}</option>
        <option value="succeeded">{t('revision.state.succeeded')}</option>
        <option value="failed">{t('revision.state.failed')}</option>
        <option value="awaiting_user">{t('revision.state.awaiting_user')}</option>
      </select></label>
      {filtered.length <= 40 ? null : <button type="button" onClick={() => { setExpanded(value => !value) }}>
        {t(expanded ? 'revision.collapse' : 'revision.showAll', { count: filtered.length })}
      </button>}
      <span>{t('revision.count', { count: filtered.length })}</span>
    </header>
    <div className={css.revisionBody}>
      <div className={css.revisionCanvasFrame}>
        <div className={css.canvasTools}>
          <button type="button" onClick={() => { graph.current?.fit(undefined, 54) }}>{t('canvas.fit')}</button>
          <button type="button" aria-label={t('canvas.zoomOut')} onClick={() => { if (graph.current !== null) graph.current.zoom(graph.current.zoom() / 1.2) }}>−</button>
          <button type="button" aria-label={t('canvas.zoomIn')} onClick={() => { if (graph.current !== null) graph.current.zoom(graph.current.zoom() * 1.2) }}>+</button>
        </div>
        <div ref={container} className={css.revisionCanvas} role="application" tabIndex={0} aria-label={t('revision.canvasAria')} />
        {preview === undefined ? null : <aside className={css.revisionPreview} style={{ left: preview.x, top: preview.y }}>
          <strong>{preview.item.lineage?.title ?? preview.item.graph.objective}</strong>
          <span>{kindLabel(t, kindOf(preview.item))}</span>
          <p>{preview.item.lineage?.trigger.summary ?? t('revision.historicalUnknown')}</p>
          <p>{dateTime(preview.item.metrics.startedAt, unavailable)} · {duration(preview.item.metrics.durationMs, unavailable, t)}</p>
          <p>{t('revision.subagents')}: {preview.item.metrics.subagentCount} · {t('revision.interactions')}: {preview.item.metrics.taskInteractions}
            {' · '}{t('revision.tokens')}: {preview.item.metrics.inputTokens + preview.item.metrics.outputTokens}</p>
          {preview.item.lineage === undefined ? null : <p>
            {t('revision.added', { count: preview.item.lineage.changes.addedNodeIds.length })}{' · '}
            {t('revision.changed', { count: preview.item.lineage.changes.changedNodeIds.length })}{' · '}
            {t('revision.removed', { count: preview.item.lineage.changes.removedNodeIds.length })}
          </p>}
          <small>{t('revision.previewHint')}</small>
        </aside>}
        <ol className={css.revisionAccessibleList} aria-label={t('revision.listAria')}>
          {visible.map(item => <li key={item.id}><button type="button" onClick={() => { setDetailId(item.id); selectRevision(item.graph.graphId, item.graph.revision) }}>
            {item.lineage?.title ?? item.graph.objective} {t('revision.eventRevision', { revision: item.graph.revision })}
          </button></li>)}
        </ol>
      </div>
      {detail === undefined ? <p className={css.empty}>{t('revision.empty')}</p> : <aside className={css.revisionDrawer}>
        <header>
          <span>{kindLabel(t, kindOf(detail))}</span>
          <h2>{detail.lineage?.title ?? detail.graph.objective}</h2>
          <code>{detail.graph.graphId} · {t('node.revision', { revision: detail.graph.revision })}</code>
        </header>
        <div className={css.revisionMetrics}>
          {metric(t('revision.startedAt'), dateTime(detail.metrics.startedAt, unavailable))}
          {metric(t('revision.completedAt'), dateTime(detail.metrics.completedAt, unavailable))}
          {metric(t('revision.duration'), duration(detail.metrics.durationMs, unavailable, t))}
          {metric(t('revision.subagents'), detail.metrics.subagentCount)}
          {metric(t('revision.interactions'), detail.metrics.taskInteractions)}
          {metric(t('revision.agentTurns'), detail.metrics.agentTurns ?? unavailable)}
          {metric(t('revision.tokens'), detail.metrics.inputTokens + detail.metrics.outputTokens)}
          {metric(t('revision.toolCalls'), detail.metrics.toolCalls)}
          {metric(t('revision.retries'), detail.metrics.retries)}
          {metric(t('revision.humanInteractions'), detail.metrics.humanInteractions)}
        </div>
        <section><h3>{t('revision.summary')}</h3><p>{detail.graph.objective}</p></section>
        <section><h3>{t('revision.creationReason')}</h3><p>{detail.lineage?.reason ?? t('revision.historicalUnknown')}</p>
          <p>{detail.lineage?.trigger.summary}</p>
          {detail.lineage?.trigger.evidence.map(item => <code key={item}>{item}</code>)}</section>
        <section><h3>{t('revision.graphDiff')}</h3>{detail.lineage === undefined ? <p>{unavailable}</p> : <ul>
          <li>{t('revision.added', { count: detail.lineage.changes.addedNodeIds.length })}</li>
          <li>{t('revision.changed', { count: detail.lineage.changes.changedNodeIds.length })}</li>
          <li>{t('revision.removed', { count: detail.lineage.changes.removedNodeIds.length })}</li>
          <li>{t('revision.preserved', { count: detail.lineage.changes.preservedNodeIds.length })}</li>
          <li>{t('revision.invalidated', { count: detail.lineage.changes.invalidatedNodeIds.length })}</li>
        </ul>}</section>
        <section><h3>{t('revision.runs')}</h3><p>{t('revision.runSummary', { count: detail.metrics.runCount, status: detail.latestRun?.phase ?? unavailable })}</p></section>
        <section><h3>{t('revision.resources')}</h3><p>{t('revision.tokenBreakdown', { input: detail.metrics.inputTokens, output: detail.metrics.outputTokens, reasoning: detail.metrics.reasoningTokens })}</p></section>
        <section><h3>{t('revision.relationships')}</h3>{related.length === 0 ? <p>{unavailable}</p> : related.map(item => <button key={`${item.label}:${item.item.id}`} type="button" onClick={() => {
          setDetailId(item.item.id)
          selectRevision(item.item.graph.graphId, item.item.graph.revision)
        }}>{item.label}</button>)}</section>
        <section><h3>{t('revision.rawEvents')}</h3>
          {detailSubmissions.map(item => <code key={item.id}>{t('node.event.submission', { id: item.id })}</code>)}
          {detail.runs.map(item => <code key={item.id}>{t('node.event.run', { id: item.id })}</code>)}
          {detailControls.map(item => <code key={item.id}>{t('node.event.control', { id: item.id })}</code>)}
          {detailSettlements.map(item => <code key={`${item.id}:${String(item.attempt)}`}>{t('node.event.settlement', { id: item.id })}</code>)}
          {detailSubmissions.length + detail.runs.length + detailControls.length + detailSettlements.length === 0
            ? <p>{unavailable}</p>
            : null}
        </section>
        <footer><button type="button" onClick={() => { selectRevision(detail.graph.graphId, detail.graph.revision, 'design') }}>{t('revision.openDesign')}</button>
          <button type="button" onClick={() => { selectRevision(detail.graph.graphId, detail.graph.revision, 'execution') }}>{t('revision.openExecution')}</button></footer>
      </aside>}
    </div>
  </section>
}
