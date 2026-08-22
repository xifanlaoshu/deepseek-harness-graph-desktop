import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as BrowserChromeDevtools from '../src/index.ts'

describe('browser-chrome-devtools real upstream server', () => {
  it('discovers the pinned Chrome browser tools over stdio without a shell', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(BrowserChromeDevtools, new BrowserChromeDevtools.Config({
      browserUrl: 'http://127.0.0.1:1',
      failOnStartupError: true,
    } as never))

    const deadline = Date.now() + 15_000
    while (!ctx.tools.schemas().some(schema => schema.name === 'mcp__chrome__take_screenshot')) {
      if (Date.now() >= deadline) throw new Error('Chrome DevTools MCP tools did not register within 15 seconds')
      await new Promise(resolve => setTimeout(resolve, 25))
    }

    const names = ctx.tools.schemas().map(schema => schema.name)
    expect(names).toContain('mcp__chrome__take_snapshot')
    expect(names).toContain('mcp__chrome__take_screenshot')
    expect(names).toContain('mcp__chrome__click_at')
    expect(names).toContain('mcp__chrome__list_console_messages')
    expect(names).toContain('mcp__chrome__list_network_requests')
    await ctx.fiber.dispose()
  }, 30_000)
})
