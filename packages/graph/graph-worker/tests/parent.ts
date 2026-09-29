import type { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { type SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'

/** Mount the standard Agent services and create a production Graph Worker parent. */
export async function createWorkerTestParent(ctx: Context, id: SessionId): Promise<Agent> {
  if (ctx.get('llm') === undefined) await ctx.plugin(LlmRuntime)
  if (ctx.get('sessionStore') === undefined) await ctx.plugin(SessionStore)
  if (ctx.get('sessionProjections') === undefined) await ctx.plugin(SessionProjectionRegistry)
  if (ctx.get('systemPrompt') === undefined) await ctx.plugin(SystemPrompt)
  if (ctx.get('tools') === undefined) await ctx.plugin(ToolRuntime)
  if (ctx.get('agents') === undefined) await ctx.plugin(AgentRegistry)
  if (ctx.get('agentLoop') === undefined) await ctx.plugin(AgentLoop, { agents: [] })
  return ctx.agentLoop.create(id, { provider: 'test', model: 'test' })
}
