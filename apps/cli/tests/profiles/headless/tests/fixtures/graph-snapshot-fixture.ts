/** Activate Graph Mode and stabilize completion delivery for the snapshot. */

import type { Context } from '@deepseek-ai/cordis'
import { defaultGraphModeConfig } from '@deepseek-ai/dsh-graph'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-loop'
import type {} from '@deepseek-ai/dsh-graph-mode'

/** Fixture plugin name. */
export const name = 'graph-snapshot-fixture'
/** Services required before the fixture activates root agents. */
export const inject = ['agents', 'graphMode', 'sessions']

/**
 * Activate Graph Mode on each root agent and keep the snapshot driver waiting
 * through the background-run idle gap.
 * @param ctx assembled headless-agent context.
 */
export function apply(ctx: Context): void {
  const terminal = Promise.withResolvers<undefined>()
  let hasHumanInput = false
  const wrapped = new WeakSet<Agent>()
  const activate = (agent: Agent): void => {
    if (agent.session.header.parentSession !== undefined) return
    ctx.graphMode.setConfig(agent, { ...defaultGraphModeConfig(), active: true })
    if (wrapped.has(agent)) return
    wrapped.add(agent)
    const whenIdle = agent.whenIdle.bind(agent)
    agent.whenIdle = async (): Promise<void> => {
      await whenIdle()
      if (!hasHumanInput) return
      await terminal.promise
      await whenIdle()
      await ctx.sessions.flush(agent.session)
    }
  }
  for (const agent of ctx.agents.list()) activate(agent)
  ctx.on('agent/created', ({ agent }) => activate(agent))

  ctx.effect(() => {
    const disposeInbox = ctx.root.on('agent/inbox/inserted', ({ agent, message }) => {
      if (agent.session.header.parentSession === undefined && message.source.kind === 'user') hasHumanInput = true
    })
    const disposeSession = ctx.on('session/event', (session, event) => {
      if (session.header.parentSession !== undefined || event.type !== 'graph/run-update') return
      if (!['queued', 'running'].includes(event.data.phase)) terminal.resolve(undefined)
    })
    return () => {
      disposeInbox()
      disposeSession()
    }
  }, 'graph-snapshot-fixture.listeners')
}
