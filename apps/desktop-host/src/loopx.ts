/** Resolve and mount the verified, application-owned LoopX runtime. */

import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { readPrimaryRuntime, workspaceDependencyPaths } from '@deepseek-ai/dsh-tool-workspace-dependencies'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

interface RuntimeFile {
  path: string
  bytes: number
  sha256: string
  executable: boolean
}

interface LoopxManifest {
  schemaVersion: 1
  release: string
  sourceCommit: string
  license: string
  launcher: 'launcher.py'
  packagesDirectory: 'python-packages'
  licenseFiles: string[]
  files: RuntimeFile[]
}

/** Generated overlay location and cleanup for one desktop profile invocation. */
export interface DesktopLoopxOverlay {
  /** Absolute path appended to the profile patch stack. */
  patchFile: string
  /** Remove the private generated patch directory after profile composition. */
  dispose(): Promise<void>
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function safeRelative(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\\') || value.includes('\0') || value.includes(':')) return false
  if (isAbsolute(value) || value.split('/').some(part => part === '' || part === '.' || part === '..')) return false
  return value.split('/').every(part => !/[. ]$/u.test(part)
    && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))
}

function parseManifest(value: unknown): LoopxManifest {
  if (!record(value) || value.schemaVersion !== 1 || typeof value.release !== 'string' || value.release.length === 0
    || typeof value.sourceCommit !== 'string' || !/^[a-f0-9]{40}$/u.test(value.sourceCommit)
    || typeof value.license !== 'string' || value.license.length === 0
    || value.launcher !== 'launcher.py' || value.packagesDirectory !== 'python-packages'
    || !Array.isArray(value.licenseFiles) || !value.licenseFiles.every(safeRelative)
    || !Array.isArray(value.files)) throw new Error('desktop LoopX runtime: invalid manifest')
  const files: RuntimeFile[] = []
  const seen = new Set<string>()
  for (const item of value.files) {
    if (!record(item) || !safeRelative(item.path) || !Number.isSafeInteger(item.bytes) || (item.bytes as number) < 0
      || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(item.sha256)
      || typeof item.executable !== 'boolean') throw new Error('desktop LoopX runtime: invalid file record')
    const path = item.path
    const key = path.toLowerCase()
    if (seen.has(key)) throw new Error('desktop LoopX runtime: duplicate or case-colliding file path')
    seen.add(key)
    files.push({ path, bytes: item.bytes as number, sha256: item.sha256, executable: item.executable })
  }
  if (!seen.has('launcher.py') || !files.some(file => file.path.startsWith('python-packages/'))
    || !value.licenseFiles.every(path => seen.has(path.toLowerCase()))) {
    throw new Error('desktop LoopX runtime: incomplete file inventory')
  }
  return {
    schemaVersion: 1, release: value.release, sourceCommit: value.sourceCommit, license: value.license,
    launcher: 'launcher.py', packagesDirectory: 'python-packages', licenseFiles: value.licenseFiles, files,
  }
}

async function inventory(root: string): Promise<RuntimeFile[]> {
  const files: RuntimeFile[] = []
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      const metadata = await lstat(path)
      if (metadata.isSymbolicLink() || (!metadata.isFile() && !metadata.isDirectory())) {
        throw new Error(`desktop LoopX runtime: link or special file is not allowed: ${path}`)
      }
      if (metadata.isDirectory()) { await visit(path); continue }
      if (relative(root, path).split(sep).join('/') === 'runtime.json') continue
      const bytes = await readFile(path)
      files.push({
        path: relative(root, path).split(sep).join('/'), bytes: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        executable: process.platform !== 'win32' && (metadata.mode & 0o111) !== 0,
      })
    }
  }
  await visit(root)
  return files.sort((left, right) => left.path.localeCompare(right.path))
}

async function verifyRuntime(root: string): Promise<LoopxManifest> {
  const rootMetadata = await lstat(root).catch((error: unknown) => {
    throw new Error(`desktop LoopX runtime is unavailable at ${root}`, { cause: error })
  })
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) throw new Error('desktop LoopX runtime root must be a real directory')
  const value: unknown = JSON.parse(await readFile(join(root, 'runtime.json'), 'utf8'))
  const manifest = parseManifest(value)
  const actual = await inventory(root)
  // The manifest does not hash itself; every other payload file must match exactly.
  const expected = [...manifest.files].sort((left, right) => left.path.localeCompare(right.path))
  if (actual.length !== expected.length || actual.some((file, index) => {
    const entry = expected[index]
    return entry === undefined || file.path !== entry.path || file.bytes !== entry.bytes || file.sha256 !== entry.sha256
  })) throw new Error('desktop LoopX runtime: payload file inventory or digest mismatch')
  return manifest
}

function quote(value: string): string {
  return JSON.stringify(value)
}

/** Create a private managed-mode patch from bundled runtime manifests and files.
 * @param primaryRuntime - Absolute root of the bundled primary runtime.
 * @returns An overlay to append to runProfile and an owned cleanup operation.
 * @throws If required runtime metadata or any LoopX payload file is missing or altered.
 */
export async function createDesktopLoopxOverlay(primaryRuntime: string): Promise<DesktopLoopxOverlay> {
  if (!isAbsolute(primaryRuntime)) throw new Error('desktop LoopX requires an absolute primary runtime path')
  const runtimeRoot = resolve(dirname(resolve(primaryRuntime)), 'loopx')
  const manifest = await verifyRuntime(runtimeRoot)
  const primaryManifest = await readPrimaryRuntime(primaryRuntime)
  if (primaryManifest.platform !== process.platform || primaryManifest.arch !== process.arch) {
    throw new Error('desktop LoopX: primary runtime platform does not match this process')
  }
  const runtime = workspaceDependencyPaths(primaryRuntime, primaryManifest)
  if (runtime.node === undefined) throw new Error('desktop LoopX requires bundled Node.js')
  for (const executable of [runtime.python, runtime.node]) {
    const metadata = await lstat(executable).catch((error: unknown) => {
      throw new Error(`desktop LoopX requires bundled executable ${executable}`, { cause: error })
    })
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`desktop LoopX executable is not a regular file: ${executable}`)
  }
  const bindingsRoot = join(resolveDshHome(), 'loopx', 'bindings')
  const stateRoot = join(resolveDshHome(), 'loopx', 'runtime')
  const tempRoot = join(resolveDshHome(), 'loopx', 'temp')
  const launcherPath = join(runtimeRoot, manifest.launcher)
  await mkdir(resolveDshHome(), { recursive: true })
  const patchDirectory = await mkdtemp(join(resolveDshHome(), 'desktop-loopx-overlay-'))
  try {
    await mkdir(bindingsRoot, { recursive: true })
    await mkdir(stateRoot, { recursive: true })
    await mkdir(tempRoot, { recursive: true })
    const patchFile = join(patchDirectory, 'cordis.patch.yml')
    const patch = [
      '- id: graph-coordination-loopx',
      '  disabled: false',
      '  config:',
      '    mode: managed',
      `    pythonExecutable: ${quote(runtime.python)}`,
      `    launcherPath: ${quote(launcherPath)}`,
      `    nodeExecutable: ${quote(runtime.node)}`,
      `    bindingsRoot: ${quote(bindingsRoot)}`,
      `    runtimeRoot: ${quote(stateRoot)}`,
      `    tempRoot: ${quote(tempRoot)}`,
      '- id: graph-mode',
      '  inject:',
      '    - graphCoordination',
      '',
    ].join('\n')
    await writeFile(patchFile, patch, { flag: 'wx', mode: 0o600 })
    return { patchFile, dispose: () => rm(patchDirectory, { recursive: true, force: true }) }
  } catch (error) {
    await rm(patchDirectory, { recursive: true, force: true })
    throw error
  }
}
