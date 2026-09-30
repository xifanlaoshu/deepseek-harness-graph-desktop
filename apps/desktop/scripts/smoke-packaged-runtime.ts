/** Validate the assembled application, including native Office conversion outside ASAR. */
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { resolveDesktopBuildTarget, resolveDesktopTargetBuildPaths } from './desktop-build-paths.mjs'
import { resolveDesktopAppId } from './desktop-release-environment.mjs'
import { resolveDesktopIdentityEnvironment } from './desktop-identity-environment.mjs'
import { readDesktopRuntime, verifyDesktopRuntime } from '../src/runtime-tree.ts'
import { verifyWindowsCode } from './windows-runtime-signature.mjs'
import { smokePreparedRuntime } from './smoke-prepared-runtime.ts'
import { resolveDesktopPackageTarget } from './package-target.ts'

/**
 * Resolve application files emitted for one configured product identity.
 * @param artifacts - Platform artifact directory.
 * @param target - Prepared desktop target.
 * @param productName - Product name embedded in the release identity.
 * @returns Application root, resources directory, and executable path.
 */
export function resolvePackagedRuntimePaths(artifacts: string, target: string, productName: string) {
  const windows = target === 'win-x64'
  const application = windows ? join(artifacts, 'win-unpacked')
    : join(artifacts, target === 'mac-arm64' ? 'mac-arm64' : 'mac', `${productName}.app`, 'Contents')
  return {
    application,
    resources: join(application, windows ? 'resources' : 'Resources'),
    executable: windows ? join(application, `${productName}.exe`) : join(application, 'MacOS', productName),
  }
}

async function main(): Promise<void> {
  const paths = resolveDesktopTargetBuildPaths()
  const { values } = parseArgs({ options: { unsigned: { type: 'boolean', default: false } }, allowPositionals: false })
  const target = resolveDesktopBuildTarget()
  const windows = target === 'win-x64'
  if (values.unsigned && !windows) throw new Error('desktop smoke: unsigned artifacts require Windows')
  const artifacts = values.unsigned ? paths.unsignedArtifacts : paths.artifacts
  const appId = resolveDesktopAppId(process.env)
  const identity = resolveDesktopIdentityEnvironment(process.env, appId)
  const packagedPaths = resolvePackagedRuntimePaths(artifacts, target, identity.productName)
  const descriptor = await verifyDesktopRuntime(paths.dsh, readDesktopRuntime(paths.dsh).release.version,
    resolveDesktopPackageTarget(target))
  if (windows && !values.unsigned) await verifyWindowsCode(packagedPaths.application)
  await smokePreparedRuntime(join(packagedPaths.resources, 'app.asar', 'dsh'), packagedPaths.executable,
    join(packagedPaths.resources, 'runtime'), descriptor)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
