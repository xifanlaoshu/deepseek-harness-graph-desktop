/**
 * Keyless real-composition snapshot for the optional Chrome DevTools bundle.
 * The pinned upstream server starts over stdio and publishes its real catalog;
 * no Chrome or model endpoint is needed until a browser tool executes.
 */

import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as BrowserChromeDevtools from '@deepseek-ai/dsh-browser-chrome-devtools'

it('publishes the browser-test prompt and real pinned tool catalog', async () => {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(BrowserChromeDevtools, new BrowserChromeDevtools.Config({
    browserUrl: 'http://127.0.0.1:1',
  } as never))

  const deadline = Date.now() + 15_000
  while (!ctx.tools.schemas().some(schema => schema.name === 'mcp__chrome__take_screenshot')) {
    if (Date.now() >= deadline) throw new Error('Chrome DevTools MCP tools did not register within 15 seconds')
    await new Promise(resolve => setTimeout(resolve, 25))
  }

  const assembly = await ctx.systemPrompt.assemble()
  const browserSection = assembly.sections.find(section => section.name === 'tool:browser-chrome-devtools')
  const tools = ctx.tools.schemas()
  expect({
    prompt: browserSection,
    toolNames: tools.map(schema => schema.name).filter(name => name.startsWith('mcp__chrome__')).sort(),
    screenshot: tools.find(schema => schema.name === 'mcp__chrome__take_screenshot'),
  }).toMatchSnapshot()

  await ctx.fiber.dispose()
}, 30_000)
