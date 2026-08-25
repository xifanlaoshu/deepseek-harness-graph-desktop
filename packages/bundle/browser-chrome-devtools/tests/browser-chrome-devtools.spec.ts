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
      browserMode: 'managed',
      browserUrl: 'http://127.0.0.1:9222',
      chromeChannel: 'stable',
      headless: false,
      isolatedProfile: true,
      startMaximized: true,
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
      '--channel=stable',
      '--headless=false',
      '--isolated=true',
      '--chrome-arg=--start-maximized',
      '--experimental-vision=true',
      '--experimental-page-id-routing=true',
      '--performance-crux=false',
      '--usage-statistics=false',
      '--redact-network-headers=true',
      '--allow-unrestricted-paths=true',
      '--screenshot-format=webp',
      '--screenshot-quality=80',
      '--screenshot-max-width=1600',
      '--screenshot-max-height=1200',
    ])
    expect(config.workspacePathArguments).toEqual([
      'baseFilePath',
      'currentFilePath',
      'filePath',
      'outputDirPath',
      'path',
      'requestFilePath',
      'responseFilePath',
    ])
    expect(resolveServerEntry()).toBe(config.args[0])
  })

  it('supports an operator-owned external Chrome endpoint', () => {
    const config = resolveMcpConfig(new Config({ browserMode: 'external', browserUrl: 'http://127.0.0.1:9333/' } as never))
    expect(config.args.slice(1, 2)).toEqual(['--browser-url=http://127.0.0.1:9333'])
    expect(config.args).not.toContain('--isolated=true')
    expect(config.args).not.toContain('--channel=stable')
  })

  it('rejects a non-HTTP endpoint only in external mode', () => {
    expect(() => resolveMcpConfig(new Config({ browserMode: 'external', browserUrl: 'ws://127.0.0.1:9222' } as never)))
      .toThrow('browserUrl must use http or https')
    expect(() => resolveMcpConfig(new Config({ browserMode: 'external', browserUrl: 'not a URL' } as never)))
      .toThrow('browserUrl must be an absolute HTTP URL')
    expect(() => resolveMcpConfig(new Config({ browserUrl: 'not a URL' } as never))).not.toThrow()
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
    expect(browserPrompt('qa')).toContain('unique isolatedContext')
    expect(browserPrompt('qa')).toContain('take_screenshot')
    expect(browserPrompt('qa')).toContain('filePath relative to the current session workspace')
    expect(browserPrompt('qa')).toContain('Report a test as passing only')
    await ctx.fiber.dispose()
  })
})
