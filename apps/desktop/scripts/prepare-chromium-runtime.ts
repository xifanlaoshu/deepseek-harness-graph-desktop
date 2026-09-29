/** Materialize a pinned, unbranded Chromium snapshot for the Windows fork installer. */

import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import extractZip from 'extract-zip'
import { prepareDesktopBrowserRuntime } from '../src/browser-runtime.ts'
import { OFFICIAL_DESKTOP_APP_ID } from './desktop-release-environment.mjs'

const LOCK_PATH = fileURLToPath(new URL('../resources/chromium/snapshot.lock.json', import.meta.url))
const SHA256 = /^[a-f0-9]{64}$/u

interface LockedFile {
  readonly url: string
  readonly size: number
  readonly sha256: string
}

/** Chromium snapshot and source-license bytes selected for this fork's Windows payload. */
export interface ChromiumSnapshotLock {
  readonly schemaVersion: 1
  readonly platform: 'Win_x64'
  readonly revision: number
  readonly sourceCommit: string
  readonly archive: LockedFile
  readonly license: LockedFile
}

/** Select the browser payload source without changing official Desktop builds.
 * @param platform - Target operating system.
 * @param appId - Release application ID, when configured.
 * @param directory - Optional legacy browser payload directory.
 * @returns The browser preparation mode for this target.
 */
export function resolveChromiumPayloadMode(
  platform: NodeJS.Platform, appId: string | undefined, directory: string | undefined,
): 'snapshot' | 'directory' | 'none' {
  const configuredDirectory = directory?.trim()
  if (platform !== 'win32') {
    if (configuredDirectory) throw new Error('desktop browser runtime: Chrome payloads are supported only for Windows targets')
    return 'none'
  }
  if (appId?.trim() === '') throw new Error('desktop browser runtime: application ID must not be blank')
  const fork = appId !== undefined && appId !== OFFICIAL_DESKTOP_APP_ID
  if (fork && configuredDirectory) throw new Error('desktop browser runtime: fork Windows builds use the pinned Chromium snapshot')
  if (fork) return 'snapshot'
  return configuredDirectory ? 'directory' : 'none'
}

function lockedFile(value: unknown): value is LockedFile {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && 'url' in value && typeof value.url === 'string'
    && 'size' in value && typeof value.size === 'number' && Number.isSafeInteger(value.size) && value.size > 0
    && 'sha256' in value && typeof value.sha256 === 'string' && SHA256.test(value.sha256)
}

/** Read the fixed Chromium archive and matching Chromium source-license metadata.
 * @returns The validated release record used by package preparation.
 */
export function readChromiumSnapshotLock(): ChromiumSnapshotLock {
  const value: unknown = JSON.parse(readFileSync(LOCK_PATH, 'utf8'))
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('desktop Chromium lock is invalid')
  const lock = value as Partial<ChromiumSnapshotLock>
  if (lock.schemaVersion !== 1 || lock.platform !== 'Win_x64' || typeof lock.revision !== 'number'
    || !Number.isSafeInteger(lock.revision) || lock.revision <= 0
    || typeof lock.sourceCommit !== 'string' || !/^[a-f0-9]{40}$/u.test(lock.sourceCommit)
    || !lockedFile(lock.archive) || !lockedFile(lock.license)
    || lock.archive.url !== `https://commondatastorage.googleapis.com/chromium-browser-snapshots/Win_x64/${lock.revision}/chrome-win.zip`
    || lock.license.url !== `https://raw.githubusercontent.com/chromium/chromium/${lock.sourceCommit}/LICENSE`) {
    throw new Error('desktop Chromium lock is invalid')
  }
  return lock as ChromiumSnapshotLock
}

async function digestFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

async function verifyFile(path: string, file: LockedFile): Promise<void> {
  if (statSync(path).size !== file.size || await digestFile(path) !== file.sha256) {
    throw new Error(`desktop Chromium cached bytes do not match the pinned SHA-256: ${path}`)
  }
}

async function fetchLockedFile(file: LockedFile, path: string): Promise<void> {
  if (existsSync(path)) { await verifyFile(path, file); return }
  const response = await fetch(file.url, { redirect: 'follow' })
  if (!response.ok || response.body === null) throw new Error(`desktop Chromium download failed: HTTP ${response.status}`)
  if (response.url !== file.url) throw new Error('desktop Chromium download redirected away from the pinned URL')
  const expectedSize = response.headers.get('content-length')
  if (expectedSize !== null && response.headers.get('content-encoding') === null && Number(expectedSize) !== file.size) {
    throw new Error('desktop Chromium download length differs from the lock')
  }
  const temporary = `${path}.partial-${randomUUID()}`
  try {
    const reader = response.body.getReader()
    async function* chunks(): AsyncGenerator<Uint8Array> {
      try {
        while (true) {
          const result = await reader.read()
          if (result.done) return
          yield result.value
        }
      } finally {
        reader.releaseLock()
      }
    }
    await pipeline(Readable.from(chunks()), createWriteStream(temporary, { flags: 'wx' }))
    await verifyFile(temporary, file)
    renameSync(temporary, path)
  } finally {
    rmSync(temporary, { force: true })
  }
}

/** Download and verify the fixed Chromium snapshot, then install it into the immutable Desktop runtime.
 * @param runtimeRoot - Prepared Electron resources/runtime directory.
 * @param cacheRoot - Build-only download cache; it is never included in the installer.
 * @returns The snapshot revision included in the runtime.
 */
export async function prepareChromiumRuntime(runtimeRoot: string, cacheRoot: string): Promise<number> {
  const lock = readChromiumSnapshotLock()
  const cache = resolve(cacheRoot)
  mkdirSync(cache, { recursive: true })
  const archive = join(cache, `chrome-win-${lock.revision}.zip`)
  const license = join(cache, `chromium-${lock.sourceCommit}-LICENSE`)
  await fetchLockedFile(lock.archive, archive)
  await fetchLockedFile(lock.license, license)

  const staging = mkdtempSync(join(cache, '.chromium-unpack-'))
  try {
    await extractZip(archive, { dir: staging })
    const source = join(staging, 'chrome-win')
    if (!existsSync(join(source, 'chrome.exe'))) throw new Error('desktop Chromium archive has no chrome-win/chrome.exe')
    // The snapshot includes a test executable that is not needed to run Chromium.
    rmSync(join(source, 'interactive_ui_tests.exe'), { force: true })
    writeFileSync(join(source, 'LICENSE.chromium'), readFileSync(license), { flag: 'wx' })
    prepareDesktopBrowserRuntime(source, runtimeRoot)
    return lock.revision
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}
