import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'

describe('browser-chrome-devtools bundle patch', () => {
  it('declares one parseable wrapper row through the bundle manifest', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      dsh?: { bundle?: { patch?: string } }
    }
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(manifest.dependencies).toMatchObject({
      '@deepseek-ai/dsh-mcp-client': 'workspace:^',
      'chrome-devtools-mcp': '1.7.0',
    })
    const parsed = yaml.load(
      readFileSync(resolve(root, manifest.dsh!.bundle!.patch!), 'utf8'),
      { schema: entryListSchema },
    ) as { insert?: { id?: string; name?: string; config?: Record<string, unknown> }[] }[]
    expect(parsed).toHaveLength(1)
    expect(parsed[0]?.insert).toHaveLength(1)
    expect(parsed[0]?.insert?.[0]).toMatchObject({
      id: 'browser-chrome-devtools',
      name: '@deepseek-ai/dsh-browser-chrome-devtools',
      config: {
        serverName: 'chrome',
        browserMode: {
          __jsExpr: "process.env.DSH_CHROME_DEBUG_URL?.trim() ? 'external' : 'managed'",
        },
        chromeChannel: 'stable',
        headless: false,
        isolatedProfile: true,
        startMaximized: true,
        experimentalVision: true,
        pageIdRouting: true,
        usageStatistics: false,
        redactNetworkHeaders: true,
        screenshotFormat: 'webp',
      },
    })
  })
})
