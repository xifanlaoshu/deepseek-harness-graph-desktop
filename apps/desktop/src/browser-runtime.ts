/** Optional private Chrome runtime carried beside the Desktop dependency payload. */

import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { inventoryDesktopRuntime, runtimePath, type DesktopRuntimeFile } from './runtime-tree.ts'

const DESCRIPTOR = 'browser-runtime.json'
const EXECUTABLE = 'chrome/chrome.exe'

interface BrowserRuntimeDescriptor {
  readonly schemaVersion: 1
  readonly executablePath: typeof EXECUTABLE
  readonly files: readonly DesktopRuntimeFile[]
}

function assertRegularSourceTree(root: string): string[] {
  const files: string[] = []
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      const metadata = lstatSync(path)
      if (metadata.isSymbolicLink()) throw new Error(`desktop browser runtime: symbolic links are not supported: ${path}`)
      if (metadata.isDirectory()) visit(path)
      else if (metadata.isFile()) files.push(path)
      else throw new Error(`desktop browser runtime: unsupported filesystem entry: ${path}`)
    }
  }
  visit(root)
  return files
}

function containsPath(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function isRuntimeFile(value: unknown): value is DesktopRuntimeFile {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const file = value as Record<string, unknown>
  return typeof file.path === 'string'
    && typeof file.bytes === 'number' && Number.isSafeInteger(file.bytes) && file.bytes >= 0
    && typeof file.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(file.sha256)
    && typeof file.executable === 'boolean'
}

function parseDescriptor(value: unknown): BrowserRuntimeDescriptor {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('desktop browser runtime: invalid descriptor')
  }
  const descriptor = value as Record<string, unknown>
  const files = descriptor.files
  if (descriptor.schemaVersion !== 1 || descriptor.executablePath !== EXECUTABLE || !Array.isArray(files)
    || files.length === 0 || !files.every(isRuntimeFile)) {
    throw new Error('desktop browser runtime: invalid descriptor')
  }
  if (new Set(files.map(file => file.path)).size !== files.length
    || JSON.stringify([...files].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
      !== JSON.stringify(files)
    || !files.some(file => file.path === 'chrome.exe')) {
    throw new Error('desktop browser runtime: invalid file inventory')
  }
  for (const file of files) runtimePath('chrome', file.path)
  return { schemaVersion: 1, executablePath: EXECUTABLE, files }
}

/**
 * Copy a privately supplied Chrome distribution into the prepared Desktop runtime.
 * @param source - Absolute directory containing chrome.exe and its support files, or undefined when omitted.
 * @param runtimeRoot - Prepared Electron resources/runtime directory.
 */
export function prepareDesktopBrowserRuntime(source: string | undefined, runtimeRoot: string): void {
  if (source === undefined || source.trim() === '') return
  if (!isAbsolute(source)) throw new Error('desktop browser runtime: DSH_DESKTOP_CHROME_PAYLOAD_DIR must be absolute')
  const sourceRoot = resolve(source)
  const runtimePathRoot = resolve(runtimeRoot)
  let sourceMetadata
  let runtimeMetadata
  try {
    sourceMetadata = lstatSync(sourceRoot)
    runtimeMetadata = lstatSync(runtimePathRoot)
  } catch {
    throw new Error('desktop browser runtime: configured source and runtime directories must exist')
  }
  if (!sourceMetadata.isDirectory() || sourceMetadata.isSymbolicLink()) {
    throw new Error('desktop browser runtime: configured payload must be a directory')
  }
  if (!runtimeMetadata.isDirectory() || runtimeMetadata.isSymbolicLink()) {
    throw new Error('desktop browser runtime: runtime root must be a regular directory')
  }
  const canonicalSource = realpathSync(sourceRoot)
  const canonicalRuntime = realpathSync(runtimePathRoot)
  if (containsPath(canonicalSource, canonicalRuntime) || containsPath(canonicalRuntime, canonicalSource)) {
    throw new Error('desktop browser runtime: payload source and runtime directory must not overlap')
  }
  const files = assertRegularSourceTree(sourceRoot)
  if (!files.some(file => relative(sourceRoot, file) === 'chrome.exe')) {
    throw new Error(`desktop browser runtime: configured payload is missing chrome.exe: ${sourceRoot}`)
  }
  const executable = join(sourceRoot, 'chrome.exe')
  const executableMetadata = lstatSync(executable)
  if (!executableMetadata.isFile() || executableMetadata.isSymbolicLink()) {
    throw new Error(`desktop browser runtime: configured payload is missing a regular chrome.exe: ${sourceRoot}`)
  }
  const destination = join(runtimePathRoot, 'chrome')
  const descriptorPath = join(runtimePathRoot, DESCRIPTOR)
  for (const path of [destination, descriptorPath]) {
    try {
      const metadata = lstatSync(path)
      if (metadata.isSymbolicLink()) throw new Error(`desktop browser runtime: refusing linked destination: ${path}`)
      throw new Error('desktop browser runtime: Chrome payload destination is already populated')
    } catch (error) {
      if (!isMissing(error)) throw error
    }
  }

  const stagingRoot = mkdtempSync(join(runtimePathRoot, '.chrome-staging-'))
  const stagingChrome = join(stagingRoot, 'chrome')
  mkdirSync(stagingChrome)
  try {
    for (const file of files) {
      const target = join(stagingChrome, relative(sourceRoot, file))
      mkdirSync(join(target, '..'), { recursive: true })
      copyFileSync(file, target)
    }
    const inventory = inventoryDesktopRuntime(stagingChrome)
    const descriptor: BrowserRuntimeDescriptor = { schemaVersion: 1, executablePath: EXECUTABLE, files: inventory }
    writeFileSync(join(stagingRoot, DESCRIPTOR), `${JSON.stringify(descriptor, undefined, 2)}\n`)
    renameSync(stagingChrome, destination)
    renameSync(join(stagingRoot, DESCRIPTOR), descriptorPath)
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true })
  }
}

/**
 * Resolve a prepared private Chrome executable; an absent descriptor means no payload was configured.
 * @param runtimeRoot - Electron resources/runtime directory.
 * @returns The verified executable path, or undefined when no browser payload was prepared.
 */
export function resolveDesktopBrowserExecutable(runtimeRoot: string): string | undefined {
  const descriptorPath = join(runtimeRoot, DESCRIPTOR)
  let value: unknown
  try {
    value = JSON.parse(readFileSync(descriptorPath, 'utf8'))
  } catch (error) {
    if (isMissing(error)) return undefined
    throw new Error(`desktop browser runtime: cannot read ${descriptorPath}`)
  }
  const descriptor = parseDescriptor(value)
  const executable = runtimePath(runtimeRoot, descriptor.executablePath)
  let metadata
  try {
    metadata = lstatSync(executable)
  } catch {
    throw new Error(`desktop browser runtime: packaged executable is missing: ${executable}`)
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error('desktop browser runtime: packaged chrome.exe must be a regular file')
  }
  const actualFiles = inventoryDesktopRuntime(join(runtimeRoot, 'chrome'))
  if (JSON.stringify(actualFiles) !== JSON.stringify(descriptor.files)) {
    throw new Error('desktop browser runtime: packaged Chrome files failed their SHA-256 inventory check')
  }
  return executable
}

/**
 * Add the private Chrome path to a Host environment only when its runtime descriptor exists.
 * @param environment - Host environment before private browser configuration.
 * @param runtimeRoot - Electron resources/runtime directory.
 * @returns A new environment with the verified private Chrome path when available.
 */
export function desktopBrowserEnvironment(environment: NodeJS.ProcessEnv, runtimeRoot: string): NodeJS.ProcessEnv {
  const cleanEnvironment = { ...environment }
  delete cleanEnvironment.DSH_DESKTOP_PRIVATE_CHROME_EXECUTABLE_PATH
  const executable = resolveDesktopBrowserExecutable(runtimeRoot)
  return executable === undefined ? cleanEnvironment : {
    ...cleanEnvironment,
    DSH_DESKTOP_PRIVATE_CHROME_EXECUTABLE_PATH: executable,
  }
}
