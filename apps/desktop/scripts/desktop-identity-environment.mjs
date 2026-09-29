import { join } from 'node:path'
import { OFFICIAL_DESKTOP_APP_ID } from './desktop-release-environment.mjs'

/** Resolve the Desktop product identifiers and optional Electron data-directory name. */

export const DEFAULT_DESKTOP_PRODUCT_NAME = 'DeepSeek Harness'
export const DEFAULT_DESKTOP_PROTOCOL_SCHEME = 'dsh'

const PRODUCT_NAME_ENV = 'DSH_DESKTOP_PRODUCT_NAME'
const PROTOCOL_SCHEME_ENV = 'DSH_DESKTOP_PROTOCOL_SCHEME'
const USER_DATA_DIR_NAME_ENV = 'DSH_DESKTOP_USER_DATA_DIR_NAME'

/**
 * Resolve release identity settings embedded in the packaged application manifest.
 * @param {NodeJS.ProcessEnv} env - Platform-owned release settings.
 * @returns {{ productName: string, protocolScheme: string, userDataDirectoryName?: string }} Validated Desktop identity.
 */
export function resolveDesktopIdentityEnvironment(env, appId = OFFICIAL_DESKTOP_APP_ID) {
  const rawProductName = env[PRODUCT_NAME_ENV]?.trim()
  const productName = rawProductName === undefined ? DEFAULT_DESKTOP_PRODUCT_NAME : rawProductName
  if (productName === '' || productName.length > 128 || /[\u0000-\u001f\u007f]/u.test(productName)) {
    throw new Error(`desktop identity: ${PRODUCT_NAME_ENV} must be 1 to 128 printable characters`)
  }

  const rawProtocolScheme = env[PROTOCOL_SCHEME_ENV]?.trim()
  const protocolScheme = rawProtocolScheme === undefined ? DEFAULT_DESKTOP_PROTOCOL_SCHEME : rawProtocolScheme
  if (!/^[a-z][a-z0-9+.-]*$/u.test(protocolScheme) || protocolScheme === 'dsh-app') {
    throw new Error(`desktop identity: ${PROTOCOL_SCHEME_ENV} must be a URI scheme and cannot be dsh-app`)
  }

  const rawUserDataDirectoryName = env[USER_DATA_DIR_NAME_ENV]?.trim()
  if (rawUserDataDirectoryName === undefined) {
    if (appId !== OFFICIAL_DESKTOP_APP_ID) {
      throw new Error(`desktop identity: ${USER_DATA_DIR_NAME_ENV} must be set for non-official application IDs`)
    }
    return { productName, protocolScheme }
  }
  if (rawUserDataDirectoryName === '' || rawUserDataDirectoryName.length > 80 || rawUserDataDirectoryName === '.' || rawUserDataDirectoryName === '..'
    || /[<>:"/\\|?*\u0000-\u001f\u007f]/u.test(rawUserDataDirectoryName)
    || /[. ]$/u.test(rawUserDataDirectoryName)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu.test(rawUserDataDirectoryName)) {
    throw new Error(`desktop identity: ${USER_DATA_DIR_NAME_ENV} must be a safe directory name`)
  }
  if (appId !== OFFICIAL_DESKTOP_APP_ID) {
    if (rawProductName === undefined || productName === DEFAULT_DESKTOP_PRODUCT_NAME) {
      throw new Error(`desktop identity: ${PRODUCT_NAME_ENV} must identify non-official applications`)
    }
    if (rawProtocolScheme === undefined || protocolScheme === DEFAULT_DESKTOP_PROTOCOL_SCHEME) {
      throw new Error(`desktop identity: ${PROTOCOL_SCHEME_ENV} must differ from the official scheme for non-official application IDs`)
    }
  }
  return { productName, protocolScheme, userDataDirectoryName: rawUserDataDirectoryName }
}

/**
 * Read embedded release identity fields, using upstream defaults for development manifests.
 * @param {unknown} metadata - Parsed application package manifest.
 * @returns {{ appId: string, productName: string, protocolScheme: string, userDataDirectoryName?: string }} Runtime Desktop identity.
 */
export function resolvePackagedDesktopIdentity(metadata) {
  const identity = metadata !== null && typeof metadata === 'object'
    ? /** @type {{ dshDesktopIdentity?: unknown }} */ (metadata).dshDesktopIdentity
    : undefined
  const rawAppId = metadata !== null && typeof metadata === 'object'
    ? /** @type {{ dshDesktopAppId?: unknown }} */ (metadata).dshDesktopAppId
    : undefined
  const appId = rawAppId === undefined ? OFFICIAL_DESKTOP_APP_ID : rawAppId
  if (typeof appId !== 'string' || !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/u.test(appId)) {
    throw new Error('desktop identity: packaged application ID is invalid')
  }
  if (identity === undefined) {
    if (appId !== OFFICIAL_DESKTOP_APP_ID) throw new Error('desktop identity: fork packages require explicit identity metadata')
    return { appId, ...resolveDesktopIdentityEnvironment({}) }
  }
  if (identity === null || typeof identity !== 'object') throw new Error('desktop identity: packaged identity metadata is invalid')
  const value = /** @type {{ productName?: unknown, protocolScheme?: unknown, userDataDirectoryName?: unknown }} */ (identity)
  if (typeof value.productName !== 'string' || typeof value.protocolScheme !== 'string'
    || (value.userDataDirectoryName !== undefined && typeof value.userDataDirectoryName !== 'string')) {
    throw new Error('desktop identity: packaged identity is incomplete')
  }
  const env = {
    [PRODUCT_NAME_ENV]: value.productName,
    [PROTOCOL_SCHEME_ENV]: value.protocolScheme,
    ...(value.userDataDirectoryName === undefined ? {} : { [USER_DATA_DIR_NAME_ENV]: value.userDataDirectoryName }),
  }
  return { appId, ...resolveDesktopIdentityEnvironment(env, appId) }
}

/**
 * Select an isolated DSH home for a fork only when the user has not configured one.
 * @param {string} appId - Packaged application identifier.
 * @param {string | undefined} configuredHome - User-provided DSH_HOME value.
 * @param {string} appDataDirectory - Electron per-user application-data directory.
 * @returns {string | undefined} Fork home path, or undefined when the existing home must remain unchanged.
 */
export function resolveForkHarnessHome(appId, configuredHome, appDataDirectory) {
  if (configuredHome?.trim() || appId === OFFICIAL_DESKTOP_APP_ID) return undefined
  return join(appDataDirectory, appId)
}
