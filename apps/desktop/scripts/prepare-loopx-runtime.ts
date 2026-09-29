/** Prepare and describe the privately bundled LoopX Python wheel. */

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import extractZip from 'extract-zip'
import { inventoryDesktopRuntime, type DesktopRuntimeFile } from '../src/runtime-tree.ts'

const RESOURCE_ROOT = fileURLToPath(new URL('../resources/loopx/', import.meta.url))
const LOCK_PATH = join(RESOURCE_ROOT, 'loopx-release.lock.json')
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const extractRequire = createRequire(createRequire(import.meta.url).resolve('extract-zip'))
const yauzl = extractRequire('yauzl') as Yauzl

interface ZipEntry {
  fileName: string
  externalFileAttributes: number
  versionMadeBy: number
}

interface YauzlFile {
  on(event: 'entry', listener: (entry: ZipEntry) => void): this
  on(event: 'error', listener: (error: Error) => void): this
  on(event: 'end', listener: () => void): this
  readEntry(): void
  close(): void
}

interface Yauzl {
  open(path: string, options: { lazyEntries: true; validateEntrySizes: true; strictFileNames: true },
    callback: (error: Error | null, file?: YauzlFile) => void): void
}

/** Fixed metadata for one verified LoopX wheel and its retained license files. */
export interface LoopXReleaseLock {
  schemaVersion: 1
  name: 'loopx'
  version: string
  source: string
  sourceCommit: string
  wheel: { fileName: string; url: string; size: number; sha256: string }
  python: string
  node: string
  license: string
  licenseFiles: string[]
}

/** Executable details returned to the Desktop runtime composer. */
export interface LoopXRuntimeDescriptor {
  root: string
  pythonExecutable: string
  packagesDirectory: string
  launcherPath: string
  manifestPath: string
  version: string
  sourceCommit: string
  license: string
  licenseFiles: string[]
}

/** Relocatable runtime description written beside the private wheel files. */
export interface LoopXRuntimeManifest {
  schemaVersion: 1
  release: string
  sourceCommit: string
  license: string
  launcher: 'launcher.py'
  packagesDirectory: 'python-packages'
  licenseFiles: string[]
  files: DesktopRuntimeFile[]
}

/** Inputs for downloading and preparing LoopX without changing a host Python installation. */
export interface PrepareLoopXRuntimeOptions {
  pythonExecutable: string
  output: string
  cache: string
  fetcher?: typeof fetch
}

/** Read the committed LoopX lock and reject unsupported or malformed metadata.
 * @returns The validated release URL, digest, version, and license metadata.
 */
export function readLoopXReleaseLock(): LoopXReleaseLock {
  const value: unknown = JSON.parse(readFileSync(LOCK_PATH, 'utf8'))
  if (value === null || typeof value !== 'object') throw new Error('LoopX release lock must be an object')
  const lock = value as Partial<LoopXReleaseLock>
  if (lock.schemaVersion !== 1 || lock.name !== 'loopx' || typeof lock.version !== 'string' ||
    typeof lock.source !== 'string' || typeof lock.sourceCommit !== 'string' || !/^[a-f0-9]{40}$/.test(lock.sourceCommit) ||
    typeof lock.wheel !== 'object' || lock.wheel === null || typeof lock.wheel.fileName !== 'string' ||
    typeof lock.wheel.url !== 'string' || !Number.isSafeInteger(lock.wheel.size) || lock.wheel.size <= 0 ||
    typeof lock.wheel.sha256 !== 'string' || !SHA256_PATTERN.test(lock.wheel.sha256) ||
    typeof lock.python !== 'string' || typeof lock.node !== 'string' || typeof lock.license !== 'string' ||
    !Array.isArray(lock.licenseFiles) || lock.licenseFiles.some(file => typeof file !== 'string' || basename(file) !== file) ||
    lock.licenseFiles.length !== 3 || !['LICENSE', 'NOTICE', 'LICENSE-MIT'].every(file => lock.licenseFiles?.includes(file))) {
    throw new Error('LoopX release lock has invalid fields')
  }
  if (basename(lock.wheel.fileName) !== lock.wheel.fileName || !lock.wheel.fileName.endsWith('.whl')) {
    throw new Error('LoopX release lock has an unsafe wheel filename')
  }
  const url = new URL(lock.wheel.url)
  const source = new URL(lock.source)
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username !== '' || url.password !== '' ||
    url.port !== '' || url.search !== '' || url.hash !== '' ||
    url.pathname !== `/loopx-project/loopx/releases/download/v${lock.version}/${lock.wheel.fileName}`) {
    throw new Error('LoopX release lock must point to its versioned GitHub release asset')
  }
  if (source.protocol !== 'https:' || source.hostname !== 'github.com' || source.username !== '' || source.password !== '' ||
    source.port !== '' || source.search !== '' || source.hash !== '' || source.pathname !== '/loopx-project/loopx/releases/tag/v' + lock.version) {
    throw new Error('LoopX release lock must point to the matching upstream release tag')
  }
  return lock as LoopXReleaseLock
}

/** Inspect every ZIP entry with yauzl before extraction can create any filesystem paths.
 * @param wheelPath - Verified or untrusted wheel file to inspect without extracting.
 * @returns Resolves only when every archive path and entry type is safe to extract.
 */
export async function validateLoopXWheel(wheelPath: string): Promise<void> {
  const names = new Set<string>()
  const entries: Array<{ name: string; normalized: string; directory: boolean }> = []
  await new Promise<void>((resolvePromise, rejectPromise) => {
    yauzl.open(wheelPath, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (openError, zipFile) => {
      if (openError !== null) { rejectPromise(openError); return }
      if (zipFile === undefined) { rejectPromise(new Error('LoopX wheel ZIP reader returned no file')); return }
      let settled = false
      const fail = (error: Error): void => {
        if (settled) return
        settled = true
        zipFile.close()
        rejectPromise(error)
      }
      zipFile.on('error', fail)
      zipFile.on('end', () => { if (!settled) { settled = true; resolvePromise() } })
      zipFile.on('entry', (entry) => {
        try {
          const { name, normalized, directory } = validateEntry(entry)
          const key = normalized.toLowerCase()
          if (names.has(key)) throw new Error(`LoopX wheel repeats or collides on a Windows path: ${name}`)
          names.add(key)
          entries.push({ name, normalized, directory })
          zipFile.readEntry()
        } catch (error) { fail(error instanceof Error ? error : new Error(String(error))) }
      })
      zipFile.readEntry()
    })
  })
  const filePaths = new Set(entries.filter(entry => !entry.directory).map(entry => entry.normalized.toLowerCase()))
  for (const entry of entries) {
    const parts = entry.normalized.toLowerCase().split('/')
    for (let index = 1; index < parts.length; index += 1) {
      if (filePaths.has(parts.slice(0, index).join('/'))) throw new Error(`LoopX wheel places a path beneath a file: ${entry.name}`)
    }
  }
}

/** Extract a wheel after a complete path/type scan; the caller owns the empty output directory.
 * @param wheelPath - Wheel whose entries must pass the complete yauzl preflight.
 * @param packagesDirectory - Absolute, empty private directory that receives unchanged wheel paths.
 * @returns Resolves after all wheel files, including `.data` and license files, are extracted.
 */
export async function unpackLoopXWheel(wheelPath: string, packagesDirectory: string): Promise<void> {
  await validateLoopXWheel(wheelPath)
  const extractedNames = new Set<string>()
  await extractZip(wheelPath, { dir: packagesDirectory, onEntry: (entry) => {
    const { name, normalized, directory } = validateEntry(entry)
    const key = normalized.toLowerCase()
    if (extractedNames.has(key)) throw new Error(`LoopX wheel repeats or collides on a Windows path: ${name}`)
    extractedNames.add(key)
    if (!directory && entry.fileName.endsWith('/')) throw new Error(`LoopX wheel has a conflicting entry type: ${name}`)
  } })
}

/** Download, verify, safely unpack, and version-smoke the fixed LoopX wheel.
 * @param options - Bundled Python path, fresh payload output path, private cache path, and optional fetch implementation.
 * @returns The launcher paths and license metadata consumed by Desktop packaging.
 * @throws If download bytes, archive entries, license files, or the isolated CLI smoke do not match the lock.
 */
export async function prepareLoopxRuntime(options: PrepareLoopXRuntimeOptions): Promise<LoopXRuntimeDescriptor> {
  const lock = readLoopXReleaseLock()
  const pythonExecutable = resolve(options.pythonExecutable)
  const destination = resolve(options.output)
  const cacheDirectory = resolve(options.cache)
  if (!isRegularFile(pythonExecutable)) throw new Error(`LoopX requires the bundled Python executable: ${pythonExecutable}`)
  mkdirSync(cacheDirectory, { recursive: true })
  const wheelPath = join(cacheDirectory, lock.wheel.fileName)
  let archive: Buffer
  try {
    archive = readFileSync(wheelPath)
    verifyWheel(archive, lock)
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
    const fetcher = options.fetcher ?? fetch
    const response = await fetcher(lock.wheel.url, { redirect: 'follow' })
    if (!response.ok) throw new Error(`LoopX wheel download failed with HTTP ${response.status}`)
    const finalUrl = new URL(response.url)
    if (finalUrl.protocol !== 'https:' || !['github.com', 'release-assets.githubusercontent.com'].includes(finalUrl.hostname)) {
      throw new Error('LoopX wheel download redirected outside GitHub release assets')
    }
    archive = await readBoundedResponse(response, lock.wheel.size)
    verifyWheel(archive, lock)
    writeFileSync(wheelPath, archive, { flag: 'wx' })
  }
  await validateLoopXWheel(wheelPath)
  if (pathExists(destination)) throw new Error(`LoopX destination already exists: ${destination}`)
  const parent = dirname(destination)
  mkdirSync(parent, { recursive: true })
  const staging = mkdtempSync(join(parent, '.loopx-runtime-'))
  try {
    const packagesDirectory = join(staging, 'python-packages')
    mkdirSync(packagesDirectory)
    await unpackLoopXWheel(wheelPath, packagesDirectory)
    const launcherPath = join(staging, 'launcher.py')
    writeFileSync(launcherPath, readFileSync(join(RESOURCE_ROOT, 'launcher.py')))
    const licenseFiles = locateLicenseFiles(packagesDirectory, lock.version, lock.licenseFiles)
    const stagedDescriptor: LoopXRuntimeDescriptor = {
      root: staging,
      pythonExecutable,
      packagesDirectory,
      launcherPath,
      manifestPath: join(staging, 'runtime.json'),
      version: lock.version,
      sourceCommit: lock.sourceCommit,
      license: lock.license,
      licenseFiles: licenseFiles.map(path => `python-packages/${relative(packagesDirectory, path).split(sep).join('/')}`),
    }
    smokeLoopXRuntime(stagedDescriptor)
    writeLoopXRuntimeManifest(staging, lock, stagedDescriptor.licenseFiles)
    renameSync(staging, destination)
    return { ...stagedDescriptor, root: destination,
      packagesDirectory: join(destination, 'python-packages'), launcherPath: join(destination, 'launcher.py'),
      manifestPath: join(destination, 'runtime.json') }
  } catch (error) {
    rmSync(staging, { recursive: true, force: true })
    throw error
  }
}

/** Invoke LoopX in isolated mode and require its CLI to report the locked release.
 * @param descriptor - Prepared payload and bundled Python executable.
 * @throws If the interpreter fails or the CLI reports another version.
 */
export function smokeLoopXRuntime(descriptor: LoopXRuntimeDescriptor): void {
  const result = execFileSync(descriptor.pythonExecutable,
    ['-I', '-S', '-B', descriptor.launcherPath, '--version'],
    { encoding: 'utf8', env: { SystemRoot: process.env.SystemRoot ?? '', WINDIR: process.env.WINDIR ?? '' }, timeout: 30_000 })
  if (!new RegExp(`\\b${escapeRegExp(descriptor.version)}\\b`).test(result)) {
    throw new Error(`LoopX launcher did not report locked version ${descriptor.version}: ${result.trim()}`)
  }
}

function writeLoopXRuntimeManifest(root: string, lock: LoopXReleaseLock, licenseFiles: string[]): LoopXRuntimeManifest {
  const manifest: LoopXRuntimeManifest = {
    schemaVersion: 1,
    release: lock.version,
    sourceCommit: lock.sourceCommit,
    license: lock.license,
    launcher: 'launcher.py',
    packagesDirectory: 'python-packages',
    licenseFiles,
    files: inventoryDesktopRuntime(root),
  }
  writeFileSync(join(root, 'runtime.json'), `${JSON.stringify(manifest, undefined, 2)}\n`, { flag: 'wx' })
  return manifest
}

function verifyWheel(archive: Buffer, lock: LoopXReleaseLock): void {
  if (archive.length !== lock.wheel.size) throw new Error(`LoopX wheel size mismatch: expected ${lock.wheel.size}, received ${archive.length}`)
  const digest = createHash('sha256').update(archive).digest('hex')
  if (digest !== lock.wheel.sha256) throw new Error(`LoopX wheel SHA-256 mismatch: ${digest}`)
}

async function readBoundedResponse(response: Response, maximumBytes: number): Promise<Buffer> {
  if (response.body === null) throw new Error('LoopX wheel response has no body')
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maximumBytes) {
        await reader.cancel()
        throw new Error(`LoopX wheel response exceeds the locked size of ${maximumBytes} bytes`)
      }
      chunks.push(Buffer.from(value))
    }
  } finally { reader.releaseLock() }
  return Buffer.concat(chunks, total)
}

function validateEntry(entry: ZipEntry): { name: string; normalized: string; directory: boolean } {
  const name = entry.fileName
  const directory = name.endsWith('/')
  if (name.length === 0 || name.includes('\\') || name.includes('\0') || name.startsWith('/') ||
    /^[a-zA-Z]:/.test(name) || name.includes(':')) {
    throw new Error(`LoopX wheel contains an unsafe archive path: ${JSON.stringify(name)}`)
  }
  const parts = (directory ? name.slice(0, -1) : name).split('/')
  if (parts.some(part => part.length === 0 || part === '.' || part === '..' || /[. ]$/.test(part) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error(`LoopX wheel contains an unsafe archive path: ${JSON.stringify(name)}`)
  }
  const normalized = parts.join('/')
  if (isAbsolute(normalized) || win32.isAbsolute(normalized) || normalized === '..' || normalized.startsWith(`..${sep}`)) {
    throw new Error(`LoopX wheel contains an unsafe archive path: ${JSON.stringify(name)}`)
  }
  const mode = (entry.externalFileAttributes >>> 16) & 0xffff
  const type = mode & 0o170000
  if (type !== 0 && type !== 0o100000 && type !== 0o040000) {
    throw new Error(`LoopX wheel contains a link or special file: ${name}`)
  }
  if (type === 0o040000 && !directory || type === 0o100000 && directory) {
    throw new Error(`LoopX wheel entry has a conflicting file type: ${name}`)
  }
  return { name, normalized, directory }
}

function locateLicenseFiles(packagesDirectory: string, version: string, names: string[]): string[] {
  const metadataRoot = join(packagesDirectory, `loopx-${version}.dist-info`, 'licenses')
  const result = names.map(name => join(metadataRoot, name))
  for (const path of result) {
    const relativePath = relative(resolve(packagesDirectory), resolve(path))
    if (relativePath.startsWith(`..${sep}`) || relativePath === '..' || !isRegularFile(path) || statSync(path).size === 0) {
      throw new Error(`LoopX wheel is missing its retained license file: ${path}`)
    }
  }
  return result
}

function pathExists(path: string): boolean {
  try { lstatSync(path); return true } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
    throw error
  }
}

function isRegularFile(path: string): boolean {
  try { return lstatSync(path).isFile() } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
    throw error
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
