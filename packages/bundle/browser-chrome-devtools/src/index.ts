/**
 * Chrome DevTools browser automation bundle. The wrapper resolves the pinned
 * official Chrome DevTools MCP executable from its own dependency tree,
 * mounts it through the generic dsh MCP client, and contributes browser-test
 * guidance to the model prompt.
 *
 * @module @deepseek-ai/dsh-browser-chrome-devtools
 */

import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import type { StdioConfig } from '@deepseek-ai/dsh-mcp-client'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'

/** Stable Cordis plugin name. */
export const name = 'browser-chrome-devtools'

/** Services required by the wrapper and its MCP child. */
export const inject = ['systemPrompt', 'tools']

const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/
const SCREENSHOT_FORMATS = ['jpeg', 'png', 'webp'] as const
const BROWSER_MODES = ['managed', 'external'] as const
const CHROME_CHANNELS = ['stable', 'beta', 'dev', 'canary'] as const
const WORKSPACE_PATH_ARGUMENTS = [
  'baseFilePath',
  'currentFilePath',
  'filePath',
  'outputDirPath',
  'path',
  'requestFilePath',
  'responseFilePath',
] as const

/** Browser automation and screenshot defaults passed to Chrome DevTools MCP. */
export interface Config {
  /** Namespace used in model-facing names such as `mcp__chrome__take_snapshot`. */
  serverName: string
  /** Whether the MCP child owns Chrome or attaches to an operator-owned process. */
  browserMode: typeof BROWSER_MODES[number]
  /** HTTP endpoint used only in `external` mode. */
  browserUrl: string
  /** Installed Chrome release channel selected in `managed` mode. */
  chromeChannel: typeof CHROME_CHANNELS[number]
  /** Launch managed Chrome without a visible window. */
  headless: boolean
  /** Give each MCP child a temporary profile removed when Chrome closes. */
  isolatedProfile: boolean
  /** Ask headed managed Chrome to maximize its initial window. */
  startMaximized: boolean
  /** Maximum duration of one MCP tool call in milliseconds. */
  toolCallTimeoutMs: number
  /** Fail bundle activation when MCP startup or tool discovery fails. */
  failOnStartupError: boolean
  /** Expose screenshot-coordinate actions such as `click_at`. */
  experimentalVision: boolean
  /** Add `pageId` to page-scoped tools so concurrent agents can target separate tabs. */
  pageIdRouting: boolean
  /** Permit performance traces to query Google's CrUX field-data service. */
  performanceCrux: boolean
  /** Permit the upstream server to send its own anonymous usage statistics. */
  usageStatistics: boolean
  /** Redact sensitive network headers from tool results. */
  redactNetworkHeaders: boolean
  /** Default screenshot encoding returned to the model. */
  screenshotFormat: typeof SCREENSHOT_FORMATS[number]
  /** JPEG or WebP quality from 0 through 100. */
  screenshotQuality: number
  /** Maximum screenshot width before proportional downscaling. */
  screenshotMaxWidth: number
  /** Maximum screenshot height before proportional downscaling. */
  screenshotMaxHeight: number
}

/** Runtime validation and deployment defaults for {@link Config}. */
export const Config: z<Config> = z.object({
  serverName: z.string().pattern(SERVER_NAME_PATTERN).default('chrome'),
  browserMode: z.union(BROWSER_MODES).default('managed'),
  browserUrl: z.string().default('http://127.0.0.1:9222'),
  chromeChannel: z.union(CHROME_CHANNELS).default('stable'),
  headless: z.boolean().default(false),
  isolatedProfile: z.boolean().default(true),
  startMaximized: z.boolean().default(true),
  toolCallTimeoutMs: z.number().step(1).min(1).default(120_000),
  failOnStartupError: z.boolean().default(true),
  experimentalVision: z.boolean().default(true),
  pageIdRouting: z.boolean().default(true),
  performanceCrux: z.boolean().default(false),
  usageStatistics: z.boolean().default(false),
  redactNetworkHeaders: z.boolean().default(true),
  screenshotFormat: z.union(SCREENSHOT_FORMATS).default('webp'),
  screenshotQuality: z.number().step(1).min(0).max(100).default(80),
  screenshotMaxWidth: z.number().step(1).min(1).default(1600),
  screenshotMaxHeight: z.number().step(1).min(1).default(1200),
})

/**
 * Resolve the installed upstream MCP executable without relying on PATH or a shell.
 * @returns the absolute path to the pinned Chrome DevTools MCP entry point.
 */
export function resolveServerEntry(): string {
  const require = createRequire(import.meta.url)
  return resolve(dirname(require.resolve('chrome-devtools-mcp')), 'bin/chrome-devtools-mcp.js')
}

/**
 * Translate wrapper settings to the generic MCP client's stdio configuration.
 * @param config - validated browser wrapper settings.
 * @returns an executable and arguments for the pinned Chrome DevTools MCP server.
 */
export function resolveMcpConfig(config: Config): StdioConfig {
  const browserArgs = config.browserMode === 'managed'
    ? [
      `--channel=${config.chromeChannel}`,
      `--headless=${String(config.headless)}`,
      `--isolated=${String(config.isolatedProfile)}`,
      ...config.startMaximized && !config.headless ? ['--chrome-arg=--start-maximized'] : [],
    ]
    : [`--browser-url=${resolveBrowserUrl(config.browserUrl)}`]
  return {
    transport: 'stdio',
    serverName: config.serverName,
    command: process.execPath,
    args: [
      resolveServerEntry(),
      ...browserArgs,
      `--experimental-vision=${String(config.experimentalVision)}`,
      `--experimental-page-id-routing=${String(config.pageIdRouting)}`,
      `--performance-crux=${String(config.performanceCrux)}`,
      `--usage-statistics=${String(config.usageStatistics)}`,
      `--redact-network-headers=${String(config.redactNetworkHeaders)}`,
      '--allow-unrestricted-paths=true',
      `--screenshot-format=${config.screenshotFormat}`,
      `--screenshot-quality=${String(config.screenshotQuality)}`,
      `--screenshot-max-width=${String(config.screenshotMaxWidth)}`,
      `--screenshot-max-height=${String(config.screenshotMaxHeight)}`,
    ],
    env: { CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: '1' },
    cwd: '',
    toolCallTimeoutMs: config.toolCallTimeoutMs,
    workspacePathArguments: [...WORKSPACE_PATH_ARGUMENTS],
    failOnStartupError: config.failOnStartupError,
  }
}

/** Validate and normalize the external Chrome endpoint. */
function resolveBrowserUrl(value: string): string {
  let browserUrl: URL
  try {
    browserUrl = new URL(value)
  } catch {
    throw new Error(`browser-chrome-devtools: browserUrl must be an absolute HTTP URL, got ${JSON.stringify(value)}`)
  }
  if (browserUrl.protocol !== 'http:' && browserUrl.protocol !== 'https:') {
    throw new Error(`browser-chrome-devtools: browserUrl must use http or https, got ${JSON.stringify(browserUrl.protocol)}`)
  }
  return browserUrl.href.replace(/\/$/u, '')
}

/**
 * Build concise model guidance for reliable DOM actions and visual verification.
 * @param serverName - MCP namespace used in model-facing tool names.
 * @returns instructions for evidence-backed browser automation.
 */
export function browserPrompt(serverName: string): string {
  const prefix = `mcp__${serverName}__`
  return `Browser automation is available through tools prefixed ${prefix}. `
    + 'For delegated or parallel web tests, create the first page with a unique isolatedContext and use only pageIds returned for that context. '
    + 'For reliable web tests, keep pageId explicit, use take_snapshot plus element UIDs for ordinary interaction, and use take_screenshot for visual assertions or click_at only when the snapshot cannot identify the target. '
    + 'When preserving browser evidence as a file, create its parent directory with an available filesystem tool, then pass a filePath relative to the current session workspace; absolute paths outside that workspace are rejected. '
    + 'After critical actions, inspect visible state and relevant console or network failures. Report a test as passing only when the observed evidence satisfies the requested behavior.'
}

/** Test hook for the owned MCP child mount. */
export const internals: {
  mountMcp(ctx: Context, config: StdioConfig): void
} = {
  mountMcp: (ctx, config) => { ctx.plugin(McpClient, config) },
}

/**
 * Mount the Chrome DevTools MCP child and its model guidance.
 * @param ctx - plugin context carrying the tool and system-prompt registries.
 * @param config - validated browser settings.
 */
export function apply(ctx: Context, config: Config): void {
  const mcpConfig = resolveMcpConfig(config)
  ctx.systemPrompt.section({
    name: 'tool:browser-chrome-devtools',
    order: 114,
    text: browserPrompt(config.serverName),
  })
  internals.mountMcp(ctx, mcpConfig)
}
