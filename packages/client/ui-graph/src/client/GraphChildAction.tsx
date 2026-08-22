/** Graph-node identity and cancellation controls shown inside an attempt child session. */

import { useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  GraphAttempt,
  GraphNode,
  GraphNodeRun,
  GraphProjection,
  GraphRun,
} from '@deepseek-ai/dsh-graph/client'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import { NS } from './locales.ts'
import css from './GraphAction.module.css'

/** Host operations and the parent projection required by a child-session action. */
export interface GraphChildActionInjected {
  readonly childSessionId: string
  readonly hooks: { readonly parentGraph: ObservableSnapshot<GraphProjection | undefined> }
  /** Submit a precisely addressed operation through the parent session. */
  readonly controlParent: (request: Readonly<Record<string, unknown>>) => Promise<string | null>
  /** Navigate back to the authoritative parent Graph surface. */
  readonly openParent: () => void
}

/** Props assembled for the session-header action. */
export type GraphChildActionProps = PropsRuntime<'conversation.session.header.actions'>
  & InjectFace<GraphChildActionInjected>
  & PropsLocale<typeof NS>

interface AttemptLocation {
  readonly run: GraphRun
  readonly node: GraphNode
  readonly nodeRun: GraphNodeRun
  readonly attempt: GraphAttempt
}

/** Find the newest attempt whose primary or continuation session matches the selected child. */
export function graphAttemptLocation(
  projection: GraphProjection | undefined,
  childSessionId: string,
): AttemptLocation | undefined {
  if (projection === undefined) return undefined
  const matches: AttemptLocation[] = []
  for (const run of Object.values(projection.runs)) {
    const revision = projection.graphs[run.graphId]?.find(item => item.revision === run.revision)
    if (revision === undefined) continue
    for (const nodeRun of Object.values(run.nodes)) {
      const node = revision.nodes.find(item => item.id === nodeRun.nodeId)
      if (node === undefined) continue
      for (const attempt of nodeRun.attempts) {
        if (attempt.childSessionId === childSessionId || attempt.continuationSessionIds?.includes(childSessionId)) {
          matches.push({ run, node, nodeRun, attempt })
        }
      }
    }
  }
  return matches.sort((left, right) => right.attempt.startedAt - left.attempt.startedAt)[0]
}

/** Render parent navigation and scheduler-owned cancellation for one Graph attempt child. */
export function GraphChildAction({
  childSessionId,
  useParentGraph,
  controlParent,
  openParent,
  t,
}: GraphChildActionProps) {
  const projection = useParentGraph(value => value)
  const location = graphAttemptLocation(projection, childSessionId)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  if (location === undefined) return null
  const roleId = location.run.overrides[location.node.id]?.roleId ?? location.node.roleId
  const role = location.run.configSnapshot.roles.find(item => item.id === roleId)
  const model = location.run.overrides[location.node.id]?.model ?? role?.model
  const cancel = (): void => {
    setBusy(true)
    setError(undefined)
    const operationId = `ui-child-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`
    void controlParent({
      operationId,
      action: 'cancel-node',
      graphId: location.run.graphId,
      runId: location.run.id,
      nodeId: location.node.id,
      expectedRevision: location.run.revision,
      expectedGeneration: location.run.generation,
      expectedAttemptId: location.attempt.id,
      reason: `User requested cancel-node from child session ${childSessionId}.`,
    }).then((failure) => {
      setBusy(false)
      if (failure !== null) setError(failure)
    }, (reason: unknown) => {
      setBusy(false)
      setError(reason instanceof Error ? reason.message : String(reason))
    })
  }
  return (
    <div className={css.root}>
      <button type="button" className={css.trigger} aria-expanded={open} onClick={() => { setOpen(value => !value) }}>
        {t('child.trigger')}
      </button>
      {open ? <div className={css.childMenu} role="dialog" aria-label={t('child.title')}>
        <strong>{location.node.title}</strong>
        <span>{t('child.route', {
          role: role?.label ?? roleId,
          model: model?.model ?? t('model.inherit'),
          reasoning: model?.reasoningEffort ?? '—',
        })}</span>
        <span>{t('child.phase', { phase: location.nodeRun.phase, number: location.attempt.number })}</span>
        <div>
          <button type="button" onClick={openParent}>{t('child.openParent')}</button>
          {location.nodeRun.phase === 'running'
            ? <button type="button" disabled={busy} onClick={cancel}>{t('control.cancelNode')}</button>
            : null}
        </div>
        {error === undefined ? null : <span role="status">{error}</span>}
      </div> : null}
    </div>
  )
}
