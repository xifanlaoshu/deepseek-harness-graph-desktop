/** Package-owned durable graph-stream invariants. @module @deepseek-ai/dsh-graph/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import { applyGraphEvent, emptyGraphProjection } from './index.ts'
import type { GraphProjection } from './types.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-graph'

/** Cordis companion plugin name. */
export const name = 'graph-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

const applyChecked = (state: GraphProjection, event: SessionEvent, fail: InvariantFailure): GraphProjection => {
  try {
    return applyGraphEvent(state, event)
  } catch (error) {
    /* v8 ignore next -- applyGraphEvent throws GraphValidationError instances. */
    const detail = error instanceof Error ? error.message : String(error)
    return fail(`session event ${String(event.seq)} violates the durable graph stream: ${detail}`)
  }
}

/** Install an independent graph fold over loaded and newly appended sessions. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  const states = new WeakMap<Session, GraphProjection>()
  const staged = new WeakMap<SessionEvent, { session: Session; state: GraphProjection }>()
  const seed = (session: Session): GraphProjection => {
    let state = emptyGraphProjection()
    for (const event of session.snapshotEvents()) state = applyChecked(state, event, fail)
    states.set(session, state)
    return state
  }
  const stateFor = (session: Session): GraphProjection => states.get(session) ?? seed(session)
  for (const session of ctx.sessions.list()) seed(session)
  ctx.on('session/created', (session) => { seed(session) }, { global: true })
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    staged.set(event, { session, state: applyChecked(stateFor(session), event, fail) })
  }, { global: true })
  ctx.on('session/event', (session, event) => {
    const candidate = staged.get(event)
    /* v8 ignore next 2 -- internal/dispatch stages the exact session/event callback arguments. */
    if (candidate === undefined || candidate.session !== session) {
      return fail('session/event reached publication without matching graph-fold validation')
    }
    staged.delete(event)
    states.set(session, candidate.state)
  }, { global: true })
}, { inject: ['sessions'] })

/**
 * Register the graph-stream invariant companion.
 * @param ctx Cordis context carrying the invariant registry.
 * @returns the installed registration's disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
