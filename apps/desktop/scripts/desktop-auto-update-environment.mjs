/** Resolve the Desktop auto-update channel and its Tencent COS destination. */

import { valid } from 'semver'
import { OFFICIAL_DESKTOP_APP_ID, resolveDesktopAppId } from './desktop-release-environment.mjs'

/** Environment variable that selects the Desktop update deployment. */
export const DESKTOP_AUTO_UPDATE_ENV = 'DSH_DESKTOP_AUTO_UPDATE_ENV'
export const DESKTOP_UPDATE_MODE_ENV = 'DSH_DESKTOP_UPDATE_MODE'

const PRODUCTION_UPDATE_ORIGIN_ENV = 'DSH_DESKTOP_UPDATE_ORIGIN'
const OFFICIAL_UPDATE_ORIGIN = 'https://download.deepseek.com'

const UPDATE_ENVIRONMENTS = {
  test: {
    originEnvName: 'DOWNLOAD_TEST_ORIGIN',
    fixedOrigin: undefined,
    bucketEnvName: 'DOWNLOAD_TEST_COS_BUCKET',
    secretIdEnvName: 'DOWNLOAD_TEST_COS_SECRET_ID',
    secretKeyEnvName: 'DOWNLOAD_TEST_COS_SECRET_KEY',
  },
  production: {
    originEnvName: undefined,
    fixedOrigin: OFFICIAL_UPDATE_ORIGIN,
    bucketEnvName: 'DOWNLOAD_PROD_COS_BUCKET',
    secretIdEnvName: 'DOWNLOAD_PROD_COS_SECRET_ID',
    secretKeyEnvName: 'DOWNLOAD_PROD_COS_SECRET_KEY',
  },
}

const UPDATE_TARGETS = new Set(['mac-arm64', 'mac-x64', 'win-x64'])
const DISABLED_UPDATE_CONFLICTS = [
  DESKTOP_AUTO_UPDATE_ENV,
  'DSH_DESKTOP_UPDATE_ORIGIN',
  'DOWNLOAD_TEST_ORIGIN', 'DOWNLOAD_TEST_RELEASE_ID', 'DOWNLOAD_TEST_COS_BUCKET',
  'DOWNLOAD_TEST_COS_SECRET_ID', 'DOWNLOAD_TEST_COS_SECRET_KEY',
  'DOWNLOAD_PROD_COS_BUCKET', 'DOWNLOAD_PROD_COS_SECRET_ID', 'DOWNLOAD_PROD_COS_SECRET_KEY',
  'DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN', 'DSH_DESKTOP_MANDATORY_UPDATE_PROD_ORIGIN',
  'DSH_DESKTOP_MANDATORY_UPDATE_CONFIG',
]

/**
 * Resolve whether this application publishes updates through a feed.
 * @param {NodeJS.ProcessEnv} env - Packaging environment.
 * @returns {'feed' | 'disabled'} Validated update mode.
 */
export function resolveDesktopUpdateMode(env) {
  const value = env[DESKTOP_UPDATE_MODE_ENV]?.trim() || 'feed'
  if (value !== 'feed' && value !== 'disabled') {
    throw new Error(`desktop auto-update: ${DESKTOP_UPDATE_MODE_ENV} must be "feed" or "disabled"`)
  }
  if (value === 'disabled') {
    const appId = resolveDesktopAppId(env)
    if (appId === OFFICIAL_DESKTOP_APP_ID) {
      throw new Error(`desktop auto-update: disabled mode is only available for custom application IDs`)
    }
    const configured = [...new Set([
      ...DISABLED_UPDATE_CONFLICTS,
      ...Object.keys(env).filter(name => /^(?:DOWNLOAD_(?:TEST|PROD)_|DSH_DESKTOP_MANDATORY_UPDATE_)/u.test(name)),
    ])].filter(name => env[name]?.trim())
    if (configured.length > 0) {
      throw new Error(`desktop auto-update: disabled mode cannot include feed, upload, or mandatory-policy settings (${configured.join(', ')})`)
    }
  }
  return value
}

/**
 * Resolve the update deployment, defaulting local release work to test.
 * @param {NodeJS.ProcessEnv} env - Packaging or upload environment.
 * @returns {'test' | 'production'} Validated deployment name.
 */
export function resolveDesktopAutoUpdateEnvironment(env) {
  const value = env[DESKTOP_AUTO_UPDATE_ENV]?.trim() || 'test'
  if (value !== 'test' && value !== 'production') {
    throw new Error(`desktop auto-update: ${DESKTOP_AUTO_UPDATE_ENV} must be "test" or "production"`)
  }
  return value
}

/**
 * Resolve one supported platform and architecture to its update directory.
 * @param {NodeJS.Platform} platform - Target Node.js platform.
 * @param {string} arch - Target Node.js architecture.
 * @returns {'mac-arm64' | 'mac-x64' | 'win-x64'} Update target directory.
 */
export function resolveDesktopAutoUpdateTarget(platform, arch) {
  const os = platform === 'darwin' ? 'mac' : platform === 'win32' ? 'win' : platform
  const target = `${os}-${arch}`
  if (!UPDATE_TARGETS.has(target)) {
    throw new Error(`desktop auto-update: unsupported target ${target}`)
  }
  return target
}

/**
 * Return the local completion record filename for one packaged target.
 * @param {'mac-arm64' | 'mac-x64' | 'win-x64'} target - Supported release target.
 * @returns {string} Filename stored beside electron-builder artifacts.
 */
export function desktopBuildRecordFilename(target) {
  if (!UPDATE_TARGETS.has(target)) {
    throw new Error(`desktop auto-update: unsupported target ${target}`)
  }
  return `${target}-release.json`
}

/**
 * Return the electron-builder channel metadata filename for an application version.
 * @param {string} version - Desktop semantic version.
 * @param {NodeJS.Platform} platform - Target platform.
 * @returns {string} Channel metadata filename emitted for the target.
 */
export function desktopUpdateMetadataFilename(version, platform) {
  if (valid(version) === null) {
    throw new Error(`desktop auto-update: invalid Desktop version ${JSON.stringify(version)}`)
  }
  if (platform !== 'darwin' && platform !== 'win32') {
    throw new Error(`desktop auto-update: unsupported metadata platform ${platform}`)
  }
  return `nightly${platform === 'darwin' ? '-mac' : ''}.yml`
}

/**
 * Read one required release setting without accepting whitespace-only values.
 * @param {NodeJS.ProcessEnv} env - Packaging or upload environment.
 * @param {string} name - Environment variable to read.
 * @returns {string} Trimmed setting.
 */
function requiredEnvironmentValue(env, name) {
  const value = env[name]?.trim()
  if (value === undefined || value === '') {
    throw new Error(`desktop auto-update: ${name} must be set to a non-empty value`)
  }
  return value
}

/**
 * Normalize an HTTPS origin and reject paths or credentials.
 * @param {string} value - Candidate origin.
 * @param {string} name - Environment variable used in diagnostics.
 * @returns {string} Normalized HTTPS origin without a trailing slash.
 */
function httpsOrigin(value, name) {
  let parsed
  try {
    parsed = new URL(value)
  }
  catch {
    throw new Error(`desktop auto-update: ${name} must be an absolute HTTPS origin`)
  }
  if (parsed.protocol !== 'https:'
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.pathname !== '/'
    || parsed.search !== ''
    || parsed.hash !== '') {
    throw new Error(`desktop auto-update: ${name} must be an absolute HTTPS origin without a path, credentials, query, or fragment`)
  }
  return parsed.origin
}

/**
 * Resolve the public updater URL and object prefixes for one release target.
 * @param {NodeJS.ProcessEnv} env - Packaging or upload environment.
 * @param {NodeJS.Platform} platform - Target Node.js platform.
 * @param {string} arch - Target Node.js architecture.
 * @returns {{ environment: 'test' | 'production', target: 'mac-arm64' | 'mac-x64' | 'win-x64', origin: string, publicUrl: string, keyPrefix: string, binaryKeyPrefix: string }} Resolved updater configuration.
 * @throws {Error} When the deployment origin or release ID is invalid, or production identity lacks a separate update origin.
 */
export function resolveDesktopAutoUpdateConfig(env, platform, arch) {
  if (resolveDesktopUpdateMode(env) === 'disabled') {
    throw new Error('desktop auto-update: feed configuration is unavailable when updates are disabled')
  }
  const environment = resolveDesktopAutoUpdateEnvironment(env)
  const target = resolveDesktopAutoUpdateTarget(platform, arch)
  const deployment = UPDATE_ENVIRONMENTS[environment]
  let origin = deployment.fixedOrigin
  if (environment === 'production') {
    const configuredOrigin = env[PRODUCTION_UPDATE_ORIGIN_ENV]?.trim() ?? ''
    const appId = resolveDesktopAppId(env)
    if (configuredOrigin !== '') {
      origin = httpsOrigin(configuredOrigin, PRODUCTION_UPDATE_ORIGIN_ENV)
      if (appId !== OFFICIAL_DESKTOP_APP_ID && origin === OFFICIAL_UPDATE_ORIGIN) {
        throw new Error(`desktop auto-update: ${PRODUCTION_UPDATE_ORIGIN_ENV} must not use the official update origin for ${appId}`)
      }
    }
    else if (appId !== OFFICIAL_DESKTOP_APP_ID) {
      throw new Error(`desktop auto-update: ${PRODUCTION_UPDATE_ORIGIN_ENV} must be set to a separate HTTPS origin for ${appId}`)
    }
  }
  else {
    if (env[PRODUCTION_UPDATE_ORIGIN_ENV]?.trim()) {
      throw new Error(`desktop auto-update: ${PRODUCTION_UPDATE_ORIGIN_ENV} applies only to production; use DOWNLOAD_TEST_ORIGIN for test`)
    }
    const { originEnvName } = deployment
    if (originEnvName === undefined) throw new Error('desktop auto-update: selected deployment has no origin')
    origin = httpsOrigin(requiredEnvironmentValue(env, originEnvName), originEnvName)
  }
  let releasePrefix = 'dsh-desk'
  if (environment === 'test') {
    const releaseId = requiredEnvironmentValue(env, 'DOWNLOAD_TEST_RELEASE_ID')
    if (!/^[a-f0-9]{32}$/u.test(releaseId)) {
      throw new Error('desktop auto-update: DOWNLOAD_TEST_RELEASE_ID must contain 32 lowercase hexadecimal characters')
    }
    releasePrefix += `/${releaseId}`
  }
  const keyPrefix = `${releasePrefix}/feeds/${target}`
  return {
    environment,
    target,
    origin,
    keyPrefix,
    binaryKeyPrefix: `${releasePrefix}/bin/${target}`,
    publicUrl: `${origin}/${keyPrefix}/`,
  }
}

/**
 * Resolve the public updater URL and private COS destination for one upload target.
 * @param {NodeJS.ProcessEnv} env - Upload environment.
 * @param {NodeJS.Platform} platform - Target Node.js platform.
 * @param {string} arch - Target Node.js architecture.
 * @returns {{ environment: 'test' | 'production', target: 'mac-arm64' | 'mac-x64' | 'win-x64', origin: string, publicUrl: string, keyPrefix: string, binaryKeyPrefix: string, bucket: string, secretIdEnvName: string, secretKeyEnvName: string }} Resolved upload configuration.
 * @throws {Error} When the selected deployment lacks a bucket or valid updater configuration.
 */
export function resolveDesktopUploadConfig(env, platform, arch) {
  if (resolveDesktopUpdateMode(env) === 'disabled') {
    throw new Error('desktop auto-update: uploads are unavailable when updates are disabled')
  }
  const update = resolveDesktopAutoUpdateConfig(env, platform, arch)
  const deployment = UPDATE_ENVIRONMENTS[update.environment]
  return {
    ...update,
    bucket: requiredEnvironmentValue(env, deployment.bucketEnvName),
    secretIdEnvName: deployment.secretIdEnvName,
    secretKeyEnvName: deployment.secretKeyEnvName,
  }
}
