/** The Desktop Host mounts LoopX only from its digest-verified private runtime. */

import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { boot, loadOverlayPatches, composeEntries } from '@deepseek-ai/dsh-app-boot'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDesktopLoopxOverlay } from '../src/loopx.ts'

const roots: string[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(): { primary: string; loopx: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-loopx-host-'))
  roots.push(root)
  vi.stubEnv('DSH_HOME', join(root, 'home'))
  const primary = join(root, 'resources', 'runtime', 'primary-runtime')
  const loopx = join(root, 'resources', 'runtime', 'loopx')
  mkdirSync(join(primary, 'dependencies', 'python', 'Lib'), { recursive: true })
  mkdirSync(join(primary, 'dependencies', 'node', 'bin'), { recursive: true })
  writeFileSync(join(primary, 'runtime.json'), JSON.stringify({
    desktopVersion: '0.2.0-rc.2', platform: process.platform, arch: process.arch,
    python: '3.12.4', node: '22.19.0', pythonPackages: {},
  }))
  writeFileSync(join(primary, 'dependencies', 'python', 'python.exe'), 'python')
  writeFileSync(join(primary, 'dependencies', 'node', 'bin', 'node.exe'), 'node')
  mkdirSync(join(loopx, 'python-packages'), { recursive: true })
  writeFileSync(join(loopx, 'launcher.py'), 'launch')
  writeFileSync(join(loopx, 'python-packages', 'loopx.py'), 'wheel')
  const files = ['launcher.py', 'python-packages/loopx.py'].map((path) => {
    const bytes = readFileSync(join(loopx, ...path.split('/')))
    return { path, bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex'), executable: false }
  })
  writeFileSync(join(loopx, 'runtime.json'), JSON.stringify({
    schemaVersion: 1, release: '1.2.3', sourceCommit: 'a'.repeat(40), license: 'MIT',
    launcher: 'launcher.py', packagesDirectory: 'python-packages', licenseFiles: ['python-packages/loopx.py'], files,
  }))
  return { primary, loopx }
}

describe('Desktop managed LoopX overlay', () => {
  it('verifies both runtime manifests and composes managed injection before Graph activation', async () => {
    const { primary } = fixture()
    const overlay = await createDesktopLoopxOverlay(primary)
    try {
      const patches = loadOverlayPatches('test', overlay.patchFile)
      const rows = composeEntries([
        [{ insert: [
          { id: 'graph-coordination-loopx', name: 'LoopX', disabled: true, config: { mode: 'external' } },
          { id: 'graph-mode', name: 'Graph mode' },
        ] }],
        patches,
      ])
      const provider = rows.find(row => row.id === 'graph-coordination-loopx')
      const graph = rows.find(row => row.id === 'graph-mode')
      expect(provider).toMatchObject({ disabled: false, config: { mode: 'managed' } })
      expect(provider?.config).toMatchObject({
        pythonExecutable: join(primary, 'dependencies', 'python', 'python.exe'),
        nodeExecutable: join(primary, 'dependencies', 'node', 'bin', 'node.exe'),
        launcherPath: join(dirname(primary), 'loopx', 'launcher.py'),
      })
      expect(graph?.inject).toContain('graphCoordination')
      expect(readFileSync(overlay.patchFile, 'utf8')).not.toContain('DEEPSEEK_API_KEY')
    } finally { await overlay.dispose() }
  })

  it('mounts the consumer only after the provider is ready in the real Loader', async () => {
    const { primary } = fixture()
    const overlay = await createDesktopLoopxOverlay(primary)
    const profile = join(primary, 'profile')
    mkdirSync(profile, { recursive: true })
    writeFileSync(join(profile, 'cordis.yml'), '[]\n')
    writeFileSync(join(profile, 'loopx-provider.mjs'), [
      'export const name = "test-loopx-provider"',
      'export function apply(ctx) { ctx.provide("graphCoordination", { ready: true }) }',
      '',
    ].join('\n'))
    writeFileSync(join(profile, 'graph-mode.mjs'), [
      'export const name = "test-graph-mode"',
      'export const inject = ["graphCoordination"]',
      'export function apply(ctx) { ctx.provide("consumerObservedReady", ctx.graphCoordination.ready) }',
      '',
    ].join('\n'))
    const base = [{ insert: [
      { id: 'graph-coordination-loopx', name: './loopx-provider.mjs', disabled: true, config: { mode: 'external' } },
      { id: 'graph-mode', name: './graph-mode.mjs' },
    ] }]
    try {
      const overlayPatches = loadOverlayPatches('test', overlay.patchFile)
      const ctx = await boot('test', join(profile, 'cordis.yml'), [...base, ...overlayPatches])
      try {
        const entries = [...ctx.loader.entries()].map(entry => ({
          id: entry.options.id, disabled: entry.disabled, state: entry.fiber?.state,
        }))
        expect(ctx.get('consumerObservedReady'), JSON.stringify(entries)).toBe(true)
      }
      finally { await ctx.fiber.dispose() }
    } finally {
      await overlay.dispose()
    }
  })

  it('rejects altered or missing manifest payload files before writing an overlay', async () => {
    const { primary, loopx } = fixture()
    writeFileSync(join(loopx, 'python-packages', 'loopx.py'), 'altered')
    await expect(createDesktopLoopxOverlay(primary)).rejects.toThrow(/inventory or digest mismatch/u)
    writeFileSync(join(loopx, 'python-packages', 'loopx.py'), 'wheel')
    rmSync(join(loopx, 'launcher.py'))
    await expect(createDesktopLoopxOverlay(primary)).rejects.toThrow()
  })

  it('rejects unsafe relative paths and malformed manifests', async () => {
    const { primary, loopx } = fixture()
    const manifestPath = join(loopx, 'runtime.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { launcher: string }
    manifest.launcher = '../launcher.py'
    writeFileSync(manifestPath, JSON.stringify(manifest))
    await expect(createDesktopLoopxOverlay(primary)).rejects.toThrow(/invalid manifest/u)
  })
})
