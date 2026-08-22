/** Activate Graph Mode and stabilize completion delivery for the snapshot. */

import type { Context } from '@deepseek-ai/cordis'
import { defaultGraphModeConfig } from '@deepseek-ai/dsh-graph'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-loop'
import type {} from '@deepseek-ai/dsh-graph-mode'

/** Fixture plugin name. */
export const name = 'graph-snapshot-fixture'
/** Services required before the fixture activates the pre-created agent. */
export const inject = ['agents', 'graphMode']

/**
 * Activate Graph Mode on the example's pre-created agent and fence step three
 * behind insertion of the durable graph-completion follow-up.
 * @param ctx assembled headless-agent context.
 */
export function apply(ctx: Context): void {
  for (const agent of ctx.agents.list()) {
    ctx.graphMode.setConfig(agent, { ...defaultGraphModeConfig(), active: true })
  }

  const delivered = Promise.withResolvers<undefined>()
  let hasDelivered = false
  ctx.effect(() => {
    const disposeInbox = ctx.root.on('agent/inbox/inserted', ({ agent, message }) => {
      if (agent.session.header.parentSession !== undefined
        || message.source.kind !== 'plugin'
        || message.source.plugin !== 'graph-mode') return
      hasDelivered = true
      delivered.resolve(undefined)
    })
    const disposeStep = ctx.root.on('agent/pre-step', async ({ agent, turn, step }, next) => {
      if (agent.session.header.parentSession === undefined && turn === 1 && step === 3 && !hasDelivered) {
        await delivered.promise
      }
      return next()
    })
    return () => {
      disposeStep()
      disposeInbox()
    }
  }, 'graph-snapshot-fixture.listeners')
}
