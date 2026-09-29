import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { prepareChromiumRuntime, readChromiumSnapshotLock, resolveChromiumPayloadMode } from '../scripts/prepare-chromium-runtime.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('pinned Windows Chromium payload', () => {
  it('requires the snapshot for Windows forks while preserving official and macOS modes', () => {
    expect(resolveChromiumPayloadMode('win32', 'com.example.graph', undefined)).toBe('snapshot')
    expect(resolveChromiumPayloadMode('win32', 'com.deepseek.harness', undefined)).toBe('none')
    expect(resolveChromiumPayloadMode('win32', 'com.deepseek.harness', 'C:/browser')).toBe('directory')
    expect(resolveChromiumPayloadMode('darwin', 'com.example.graph', undefined)).toBe('none')
    expect(() => resolveChromiumPayloadMode('win32', 'com.example.graph', 'C:/browser')).toThrow(/pinned Chromium/u)
    expect(() => resolveChromiumPayloadMode('darwin', 'com.example.graph', 'C:/browser')).toThrow(/Windows/u)
  })

  it('names a fixed unbranded snapshot and its matching source license', () => {
    const lock = readChromiumSnapshotLock()
    expect(lock.platform).toBe('Win_x64')
    expect(lock.archive.url).toBe(`https://commondatastorage.googleapis.com/chromium-browser-snapshots/Win_x64/${lock.revision}/chrome-win.zip`)
    expect(lock.license.url).toBe(`https://raw.githubusercontent.com/chromium/chromium/${lock.sourceCommit}/LICENSE`)
    expect(lock.archive.sha256).toMatch(/^[a-f0-9]{64}$/u)
    expect(lock.license.sha256).toMatch(/^[a-f0-9]{64}$/u)
  })

  it('rejects corrupt cached bytes before extraction or network fallback', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-chromium-lock-'))
    roots.push(root)
    const cache = join(root, 'cache')
    const runtime = join(root, 'runtime')
    mkdirSync(cache)
    mkdirSync(runtime)
    writeFileSync(join(cache, `chrome-win-${readChromiumSnapshotLock().revision}.zip`), 'corrupt')
    await expect(prepareChromiumRuntime(runtime, cache)).rejects.toThrow(/pinned SHA-256/u)
  })
})
