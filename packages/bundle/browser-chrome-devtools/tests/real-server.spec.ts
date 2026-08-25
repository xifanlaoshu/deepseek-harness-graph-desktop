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
      browserMode: 'external',
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
    const configured = new Set(BrowserChromeDevtools.resolveMcpConfig(new BrowserChromeDevtools.Config({} as never)).workspacePathArguments)
    const discovered = new Set<string>()
    for (const schema of ctx.tools.schemas()) {
      const parameters = schema.parameters as { properties?: Record<string, unknown> }
      for (const argument of Object.keys(parameters.properties ?? {})) {
        if (argument === 'path' || argument.endsWith('Path')) discovered.add(argument)
      }
    }
    expect([...discovered].filter(argument => !configured.has(argument)).sort()).toEqual([])
    await ctx.fiber.dispose()
  }, 30_000)
})
