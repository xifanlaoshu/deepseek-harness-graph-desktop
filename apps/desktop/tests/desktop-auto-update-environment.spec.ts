import { describe, expect, it } from 'vitest'
import {
  desktopBuildRecordFilename,
  desktopUpdateMetadataFilename,
  resolveDesktopAutoUpdateConfig,
  resolveDesktopAutoUpdateEnvironment,
  resolveDesktopAutoUpdateTarget,
  resolveDesktopUploadConfig,
  resolveDesktopUpdateMode,
} from '../scripts/desktop-auto-update-environment.mjs'

const RELEASE_ID = '0123456789abcdef0123456789abcdef'
const OFFICIAL_APP_ID = 'com.deepseek.harness'

function production(appId = OFFICIAL_APP_ID, origin?: string) {
  return {
    DSH_DESKTOP_AUTO_UPDATE_ENV: 'production',
    DSH_DESKTOP_APP_ID: appId,
    ...(origin === undefined ? {} : { DSH_DESKTOP_UPDATE_ORIGIN: origin }),
  }
}

describe('desktop auto-update environment', () => {
  it('defaults to feed mode and restricts disabled mode to isolated fork builds', () => {
    expect(resolveDesktopUpdateMode({})).toBe('feed')
    const disabled = { DSH_DESKTOP_APP_ID: 'com.example.fork', DSH_DESKTOP_UPDATE_MODE: 'disabled' }
    expect(resolveDesktopUpdateMode(disabled)).toBe('disabled')
    expect(() => resolveDesktopUpdateMode({ DSH_DESKTOP_UPDATE_MODE: 'disabled', DSH_DESKTOP_APP_ID: OFFICIAL_APP_ID }))
      .toThrow(/only available for custom/u)
    expect(() => resolveDesktopAutoUpdateConfig(disabled, 'win32', 'x64')).toThrow(/feed configuration is unavailable/u)
    expect(() => resolveDesktopUploadConfig(disabled, 'win32', 'x64')).toThrow(/uploads are unavailable/u)
  })

  it.each([
    ['DSH_DESKTOP_AUTO_UPDATE_ENV', 'test'],
    ['DSH_DESKTOP_UPDATE_ORIGIN', 'https://updates.example.com'],
    ['DOWNLOAD_TEST_ORIGIN', 'https://updates.example.com'],
    ['DOWNLOAD_TEST_RELEASE_ID', RELEASE_ID],
    ['DOWNLOAD_TEST_COS_BUCKET', 'bucket'],
    ['DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN', 'https://policy.example.com'],
    ['DSH_DESKTOP_MANDATORY_UPDATE_CONFIG', '{}'],
    ['DSH_DESKTOP_MANDATORY_UPDATE_RETRY_MS', '5000'],
  ])('rejects disabled mode with configured %s', (name, value) => {
    expect(() => resolveDesktopUpdateMode({ DSH_DESKTOP_APP_ID: 'com.example.fork', DSH_DESKTOP_UPDATE_MODE: 'disabled', [name]: value }))
      .toThrow(new RegExp(name, 'u'))
  })

  it('rejects an unknown update mode', () => {
    expect(() => resolveDesktopUpdateMode({ DSH_DESKTOP_UPDATE_MODE: 'offline' })).toThrow(/must be "feed" or "disabled"/u)
  })

  it.each([undefined, 'test'])('requires a release ID for deployment %s', (deployment) => {
    const environment = { DSH_DESKTOP_AUTO_UPDATE_ENV: deployment, DOWNLOAD_TEST_ORIGIN: 'https://updates.example.com',
      DOWNLOAD_TEST_COS_BUCKET: 'test-bucket' }
    expect(() => resolveDesktopAutoUpdateConfig(environment, 'win32', 'x64')).toThrow(/DOWNLOAD_TEST_RELEASE_ID/u)
    expect(() => resolveDesktopUploadConfig(environment, 'win32', 'x64')).toThrow(/DOWNLOAD_TEST_RELEASE_ID/u)
  })

  it.each(['', ' ', 'release-1', 'a'.repeat(31), 'a'.repeat(33), 'A'.repeat(32), 'g'.repeat(32),
    '../feeds', '01234567-89ab-cdef-0123-456789abcdef', `${RELEASE_ID}/bin`])('rejects invalid test release ID %j', (id) => {
    const environment = { DOWNLOAD_TEST_ORIGIN: 'https://updates.example.com', DOWNLOAD_TEST_RELEASE_ID: id }
    expect(() => resolveDesktopAutoUpdateConfig(environment, 'darwin', 'arm64')).toThrow(/DOWNLOAD_TEST_RELEASE_ID/u)
  })

  it.each([['darwin', 'arm64', 'mac-arm64'], ['darwin', 'x64', 'mac-x64'], ['win32', 'x64', 'win-x64']] as const)
  ('uses one test release directory for %s %s feeds and binaries', (platform, arch, target) => {
    expect(resolveDesktopAutoUpdateConfig({ DOWNLOAD_TEST_ORIGIN: 'https://updates.example.com',
      DOWNLOAD_TEST_RELEASE_ID: RELEASE_ID }, platform, arch)).toMatchObject({
      publicUrl: `https://updates.example.com/dsh-desk/${RELEASE_ID}/feeds/${target}/`,
      keyPrefix: `dsh-desk/${RELEASE_ID}/feeds/${target}`,
      binaryKeyPrefix: `dsh-desk/${RELEASE_ID}/bin/${target}`,
    })
  })

  it('defaults packages and uploads to the test deployment', () => {
    expect(resolveDesktopAutoUpdateEnvironment({})).toBe('test')
    expect(resolveDesktopAutoUpdateConfig({
      DOWNLOAD_TEST_ORIGIN: 'https://desktop-updates.example.com/',
      DOWNLOAD_TEST_RELEASE_ID: RELEASE_ID,
    }, 'darwin', 'arm64')).toEqual({
      environment: 'test',
      target: 'mac-arm64',
      origin: 'https://desktop-updates.example.com',
      publicUrl: `https://desktop-updates.example.com/dsh-desk/${RELEASE_ID}/feeds/mac-arm64/`,
      keyPrefix: `dsh-desk/${RELEASE_ID}/feeds/mac-arm64`,
      binaryKeyPrefix: `dsh-desk/${RELEASE_ID}/bin/mac-arm64`,
    })
    expect(resolveDesktopUploadConfig({
      DOWNLOAD_TEST_ORIGIN: 'https://desktop-updates.example.com/',
      DOWNLOAD_TEST_RELEASE_ID: RELEASE_ID,
      DOWNLOAD_TEST_COS_BUCKET: 'test-download-bucket',
    }, 'darwin', 'arm64')).toMatchObject({
      bucket: 'test-download-bucket',
      secretIdEnvName: 'DOWNLOAD_TEST_COS_SECRET_ID',
      secretKeyEnvName: 'DOWNLOAD_TEST_COS_SECRET_KEY',
    })
  })

  it.each([undefined, RELEASE_ID, 'unused-test-value'])('keeps production paths independent of test release ID %s', (id) => {
    expect(resolveDesktopAutoUpdateConfig({
      ...production(),
      DOWNLOAD_TEST_RELEASE_ID: id,
    }, 'win32', 'x64')).toMatchObject({
      environment: 'production',
      target: 'win-x64',
      publicUrl: 'https://download.deepseek.com/dsh-desk/feeds/win-x64/',
      binaryKeyPrefix: 'dsh-desk/bin/win-x64',
    })
    expect(resolveDesktopUploadConfig({
      ...production(),
      DOWNLOAD_PROD_COS_BUCKET: 'production-download-bucket',
    }, 'win32', 'x64')).toMatchObject({
      bucket: 'production-download-bucket',
      secretIdEnvName: 'DOWNLOAD_PROD_COS_SECRET_ID',
      secretKeyEnvName: 'DOWNLOAD_PROD_COS_SECRET_KEY',
    })
  })

  it('requires the selected deployment origin for packages and bucket only for uploads', () => {
    expect(() => resolveDesktopAutoUpdateConfig({}, 'darwin', 'arm64'))
      .toThrow(/DOWNLOAD_TEST_ORIGIN/u)
    expect(resolveDesktopAutoUpdateConfig({
      DOWNLOAD_TEST_ORIGIN: 'https://desktop-updates.example.com',
      DOWNLOAD_TEST_RELEASE_ID: RELEASE_ID,
    }, 'darwin', 'arm64').publicUrl).toContain('/mac-arm64/')
    expect(() => resolveDesktopUploadConfig({
      DOWNLOAD_TEST_ORIGIN: 'https://desktop-updates.example.com',
      DOWNLOAD_TEST_RELEASE_ID: RELEASE_ID,
    }, 'darwin', 'arm64')).toThrow(/DOWNLOAD_TEST_COS_BUCKET/u)
    expect(() => resolveDesktopUploadConfig({
      ...production(),
    }, 'win32', 'x64')).toThrow(/DOWNLOAD_PROD_COS_BUCKET/u)
  })

  it('requires a separate production origin for non-official application identities', () => {
    expect(() => resolveDesktopAutoUpdateConfig(production('com.example.fork'), 'win32', 'x64'))
      .toThrow(/DSH_DESKTOP_UPDATE_ORIGIN.*separate HTTPS origin/u)
    expect(resolveDesktopAutoUpdateConfig(production('com.example.fork', 'https://updates.example.com/'), 'win32', 'x64'))
      .toMatchObject({ origin: 'https://updates.example.com', publicUrl: 'https://updates.example.com/dsh-desk/feeds/win-x64/' })
    expect(() => resolveDesktopAutoUpdateConfig(production('com.example.fork', 'https://download.deepseek.com/'), 'win32', 'x64'))
      .toThrow(/must not use the official update origin/u)
  })

  it('requires application identity before using the production update service', () => {
    expect(() => resolveDesktopAutoUpdateConfig({ DSH_DESKTOP_AUTO_UPDATE_ENV: 'production' }, 'win32', 'x64'))
      .toThrow(/DSH_DESKTOP_APP_ID/u)
  })

  it.each(['http://updates.example.com', 'https://updates.example.com/path', 'https://user:pass@updates.example.com',
    'https://updates.example.com/?feed=nightly', 'https://updates.example.com/#nightly'])
  ('rejects invalid production override %s', (origin) => {
    expect(() => resolveDesktopAutoUpdateConfig(production('com.example.fork', origin), 'win32', 'x64'))
      .toThrow(/DSH_DESKTOP_UPDATE_ORIGIN.*HTTPS origin/u)
  })

  it('retains the official production origin unless an explicit override is configured', () => {
    expect(resolveDesktopAutoUpdateConfig(production(), 'win32', 'x64').origin).toBe('https://download.deepseek.com')
    expect(resolveDesktopAutoUpdateConfig(production(OFFICIAL_APP_ID, 'https://updates.example.com'), 'win32', 'x64').origin)
      .toBe('https://updates.example.com')
  })

  it('rejects the production override in the test deployment', () => {
    expect(() => resolveDesktopAutoUpdateConfig({ DOWNLOAD_TEST_ORIGIN: 'https://test.example.com',
      DOWNLOAD_TEST_RELEASE_ID: RELEASE_ID, DSH_DESKTOP_UPDATE_ORIGIN: 'https://production.example.com' }, 'win32', 'x64'))
      .toThrow(/applies only to production/u)
  })

  it('rejects a test download URL that is not an HTTPS origin', () => {
    expect(() => resolveDesktopAutoUpdateConfig({
      DOWNLOAD_TEST_ORIGIN: 'https://desktop-updates.example.com/releases',
    }, 'darwin', 'arm64')).toThrow(/HTTPS origin without a path/u)
    expect(() => resolveDesktopAutoUpdateConfig({
      DOWNLOAD_TEST_ORIGIN: 'http://desktop-updates.example.com',
    }, 'darwin', 'arm64')).toThrow(/HTTPS origin/u)
  })

  it('rejects unknown deployments and targets', () => {
    expect(() => resolveDesktopAutoUpdateEnvironment({
      DSH_DESKTOP_AUTO_UPDATE_ENV: 'staging',
    })).toThrow(/test.*production/u)
    expect(() => resolveDesktopAutoUpdateTarget('linux', 'x64')).toThrow(/unsupported target/u)
    expect(() => desktopBuildRecordFilename('linux-x64' as 'mac-arm64')).toThrow(/unsupported target/u)
  })

  it('uses Nightly metadata for stable and prerelease Desktop versions', () => {
    expect(desktopUpdateMetadataFilename('1.2.3', 'darwin')).toBe('nightly-mac.yml')
    expect(desktopUpdateMetadataFilename('1.2.3-alpha.4', 'darwin')).toBe('nightly-mac.yml')
    expect(desktopUpdateMetadataFilename('1.2.3-beta.2', 'win32')).toBe('nightly.yml')
    expect(() => desktopUpdateMetadataFilename('not-semver', 'darwin')).toThrow(/invalid Desktop version/u)
    expect(() => desktopUpdateMetadataFilename('1.2.3', 'linux')).toThrow(/unsupported metadata platform/u)
  })
})
