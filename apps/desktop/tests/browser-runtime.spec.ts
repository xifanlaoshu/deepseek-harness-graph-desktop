import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { desktopBrowserEnvironment, prepareDesktopBrowserRuntime, resolveDesktopBrowserExecutable } from '../src/browser-runtime.ts'

const roots: string[] = []

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-browser-runtime-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('optional Desktop browser runtime', () => {
  it('leaves the runtime unchanged when no private browser directory is configured', () => {
    const root = temporaryRoot()
    const runtime = join(root, 'runtime')
    mkdirSync(runtime)
    prepareDesktopBrowserRuntime(undefined, runtime)
    expect(readdirSync(runtime)).toEqual([])
    expect(resolveDesktopBrowserExecutable(runtime)).toBeUndefined()
    expect(desktopBrowserEnvironment({ PATH: 'original' }, runtime)).toEqual({ PATH: 'original' })
  })

  it('copies a private distribution and publishes a hashed fixed executable path', () => {
    const root = temporaryRoot()
    const source = join(root, 'source')
    const runtime = join(root, 'runtime')
    mkdirSync(source)
    mkdirSync(runtime)
    writeFileSync(join(source, 'chrome.exe'), 'chrome-payload')
    writeFileSync(join(source, 'resources.pak'), 'resources')

    prepareDesktopBrowserRuntime(source, runtime)

    const executable = join(runtime, 'chrome', 'chrome.exe')
    const manifest = JSON.parse(readFileSync(join(runtime, 'browser-runtime.json'), 'utf8')) as Record<string, unknown>
    expect(manifest).toMatchObject({ schemaVersion: 1, executablePath: 'chrome/chrome.exe' })
    expect(manifest.files).toHaveLength(2)
    expect(JSON.stringify(manifest.files)).toContain('resources.pak')
    expect(readFileSync(join(runtime, 'chrome', 'resources.pak'), 'utf8')).toBe('resources')
    expect(resolveDesktopBrowserExecutable(runtime)).toBe(executable)
    expect(desktopBrowserEnvironment({ PATH: 'original' }, runtime)).toEqual({
      PATH: 'original', DSH_DESKTOP_PRIVATE_CHROME_EXECUTABLE_PATH: executable,
    })
  })

  it('fails preparation when a configured payload is missing its executable', () => {
    const root = temporaryRoot()
    const source = join(root, 'source')
    const runtime = join(root, 'runtime')
    mkdirSync(source)
    mkdirSync(runtime)
    expect(() =>{  prepareDesktopBrowserRuntime(source, runtime) }).toThrow(/missing .*chrome\.exe/u)
  })

  it('fails Host resolution when the prepared executable is absent or altered', () => {
    const root = temporaryRoot()
    const source = join(root, 'source')
    const runtime = join(root, 'runtime')
    mkdirSync(source)
    mkdirSync(runtime)
    writeFileSync(join(source, 'chrome.exe'), 'original')
    prepareDesktopBrowserRuntime(source, runtime)
    rmSync(join(runtime, 'chrome', 'chrome.exe'))
    expect(() => resolveDesktopBrowserExecutable(runtime)).toThrow(/packaged executable is missing/u)
    writeFileSync(join(runtime, 'chrome', 'chrome.exe'), 'changed')
    expect(() => resolveDesktopBrowserExecutable(runtime)).toThrow(/failed their SHA-256 inventory check/u)
  })

  it.each(['missing', 'modified', 'extra'] as const)('checks the complete private Chrome inventory against %s support files', (change) => {
    const root = temporaryRoot()
    const source = join(root, 'source')
    const runtime = join(root, 'runtime')
    mkdirSync(source)
    mkdirSync(runtime)
    writeFileSync(join(source, 'chrome.exe'), 'chrome')
    writeFileSync(join(source, 'chrome.dll'), 'support')
    prepareDesktopBrowserRuntime(source, runtime)

    if (change === 'missing') rmSync(join(runtime, 'chrome', 'chrome.dll'))
    if (change === 'modified') writeFileSync(join(runtime, 'chrome', 'chrome.dll'), 'changed')
    if (change === 'extra') writeFileSync(join(runtime, 'chrome', 'extra.dll'), 'unexpected')

    expect(() => resolveDesktopBrowserExecutable(runtime)).toThrow(/failed their SHA-256 inventory check/u)
  })

  it('removes an inherited private executable path when no verified payload exists', () => {
    const runtime = temporaryRoot()
    expect(desktopBrowserEnvironment({ DSH_DESKTOP_PRIVATE_CHROME_EXECUTABLE_PATH: 'untrusted' }, runtime))
      .not.toHaveProperty('DSH_DESKTOP_PRIVATE_CHROME_EXECUTABLE_PATH')
  })

  it('rejects relative source paths before copying', () => {
    expect(() =>{  prepareDesktopBrowserRuntime('relative/chrome', 'runtime') }).toThrow(/must be absolute/u)
  })

  it('rejects overlapping source and runtime directories without deleting source files', () => {
    const root = temporaryRoot()
    const runtime = join(root, 'runtime')
    mkdirSync(runtime)
    writeFileSync(join(runtime, 'chrome.exe'), 'source')
    expect(() =>{  prepareDesktopBrowserRuntime(runtime, runtime) }).toThrow(/must not overlap/u)
    expect(readFileSync(join(runtime, 'chrome.exe'), 'utf8')).toBe('source')
  })
})
