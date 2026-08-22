import { existsSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import type { StdioConfig } from '@deepseek-ai/dsh-mcp-client'
import {
  apply,
  browserPrompt,
  Config,
  inject,
  internals,
  name,
  resolveMcpConfig,
  resolveServerEntry,
} from '../src/index.ts'

const originalMountMcp = internals.mountMcp.bind(internals)

afterEach(() => {
  internals.mountMcp = originalMountMcp
})

describe('browser-chrome-devtools bundle plugin', () => {
  it('publishes the stable plugin identity and required registries', () => {
    expect(name).toBe('browser-chrome-devtools')
    expect(inject).toEqual(['systemPrompt', 'tools'])
  })

  it('resolves safe multimodal browser-test defaults', () => {
    expect(new Config({} as never)).toEqual({
      serverName: 'chrome',
      browserUrl: 'http://127.0.0.1:9222',
      toolCallTimeoutMs: 120_000,
      failOnStartupError: true,
      experimentalVision: true,
      pageIdRouting: true,
      performanceCrux: false,
      usageStatistics: false,
      redactNetworkHeaders: true,
      screenshotFormat: 'webp',
      screenshotQuality: 80,
      screenshotMaxWidth: 1600,
      screenshotMaxHeight: 1200,
    })
  })

  it('starts the pinned server through Node with explicit privacy and image settings', () => {
    const config = resolveMcpConfig(new Config({} as never))
    expect(existsSync(config.args[0]!)).toBe(true)
    expect(config).toMatchObject({
      transport: 'stdio',
      serverName: 'chrome',
      command: process.execPath,
      env: { CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: '1' },
      cwd: '',
      toolCallTimeoutMs: 120_000,
      failOnStartupError: true,
    })
    expect(config.args.slice(1)).toEqual([
      '--browser-url=http://127.0.0.1:9222',
      '--experimental-vision=true',
      '--experimental-page-id-routing=true',
      '--performance-crux=false',
      '--usage-statistics=false',
      '--redact-network-headers=true',
      '--screenshot-format=webp',
      '--screenshot-quality=80',
      '--screenshot-max-width=1600',
      '--screenshot-max-height=1200',
    ])
    expect(resolveServerEntry()).toBe(config.args[0])
  })

  it('rejects a non-HTTP debugging endpoint before mounting a child', () => {
    expect(() => resolveMcpConfig(new Config({ browserUrl: 'ws://127.0.0.1:9222' } as never)))
      .toThrow('browserUrl must use http or https')
    expect(() => resolveMcpConfig(new Config({ browserUrl: 'not a URL' } as never)))
      .toThrow('browserUrl must be an absolute HTTP URL')
  })

  it('mounts one MCP child and contributes evidence-oriented browser guidance', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    let mounted: StdioConfig | undefined
    internals.mountMcp = (_ctx, config) => { mounted = config }
    apply(ctx, new Config({ serverName: 'qa' } as never))

    expect(mounted?.serverName).toBe('qa')
    const assembly = await ctx.systemPrompt.assemble()
    expect(assembly.sections.find(section => section.name === 'tool:browser-chrome-devtools')).toEqual({
      name: 'tool:browser-chrome-devtools',
      text: browserPrompt('qa'),
    })
    expect(browserPrompt('qa')).toContain('mcp__qa__')
    expect(browserPrompt('qa')).toContain('take_screenshot')
    expect(browserPrompt('qa')).toContain('Report a test as passing only')
    await ctx.fiber.dispose()
  })
})
