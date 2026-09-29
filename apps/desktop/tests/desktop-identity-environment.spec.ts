import { describe, expect, it } from 'vitest'
import { resolveDesktopIdentityEnvironment, resolveForkHarnessHome, resolvePackagedDesktopIdentity } from '../scripts/desktop-identity-environment.mjs'
import { createElectronBuilderConfig } from '../scripts/electron-builder-config.mjs'
import { resolveDesktopPaths } from '../src/paths.ts'

describe('Desktop release identity', () => {
  it('keeps official defaults and accepts a fork identity with separate protocol and data directory', () => {
    expect(resolveDesktopIdentityEnvironment({})).toEqual({ productName: 'DeepSeek Harness', protocolScheme: 'dsh' })
    const identity = resolveDesktopIdentityEnvironment({
      DSH_DESKTOP_PRODUCT_NAME: 'DSH Graph Desktop',
      DSH_DESKTOP_PROTOCOL_SCHEME: 'dshgraph',
      DSH_DESKTOP_USER_DATA_DIR_NAME: 'DSH-Graph-Desktop',
    })
    expect(identity).toEqual({ productName: 'DSH Graph Desktop', protocolScheme: 'dshgraph', userDataDirectoryName: 'DSH-Graph-Desktop' })
    expect(resolvePackagedDesktopIdentity({ dshDesktopIdentity: identity })).toEqual({ appId: 'com.deepseek.harness', ...identity })
  })

  it('requires forks to separate Electron data, protocol, and product identity from the official app', () => {
    const forkAppId = 'io.example.dshfork'
    for (const env of [
      {},
      { DSH_DESKTOP_USER_DATA_DIR_NAME: 'DSH-Fork' },
      { DSH_DESKTOP_PROTOCOL_SCHEME: 'dshfork', DSH_DESKTOP_USER_DATA_DIR_NAME: 'DSH-Fork' },
      { DSH_DESKTOP_PRODUCT_NAME: 'DSH Fork', DSH_DESKTOP_USER_DATA_DIR_NAME: 'DSH-Fork' },
    ]) {
      expect(() => resolveDesktopIdentityEnvironment(env, forkAppId))
        .toThrow(/DSH_DESKTOP_(?:USER_DATA_DIR_NAME|PRODUCT_NAME|PROTOCOL_SCHEME)/u)
    }
    expect(resolveDesktopIdentityEnvironment({
      DSH_DESKTOP_PRODUCT_NAME: 'DSH Fork', DSH_DESKTOP_PROTOCOL_SCHEME: 'dshfork', DSH_DESKTOP_USER_DATA_DIR_NAME: 'DSH-Fork',
    }, forkAppId)).toEqual({ productName: 'DSH Fork', protocolScheme: 'dshfork', userDataDirectoryName: 'DSH-Fork' })
  })

  it('embeds fork identity in the actual electron-builder configuration', () => {
    const config = createElectronBuilderConfig({
      DSH_DESKTOP_APP_ID: 'com.example.dshfork',
      DSH_DESKTOP_TARGET_PLATFORM: 'win32',
      DSH_DESKTOP_TARGET_ARCH: 'x64',
      DSH_DESKTOP_UNSIGNED: '1',
      DSH_DESKTOP_PRODUCT_NAME: 'DSH Graph Desktop',
      DSH_DESKTOP_PROTOCOL_SCHEME: 'dshgraph',
      DSH_DESKTOP_USER_DATA_DIR_NAME: 'DSH-Graph-Desktop',
      DSH_DESKTOP_AUTO_UPDATE_ENV: 'test',
      DOWNLOAD_TEST_ORIGIN: 'https://updates.example.com',
      DOWNLOAD_TEST_RELEASE_ID: '0123456789abcdef0123456789abcdef',
      DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN: 'https://policy.example.com',
      DSH_DESKTOP_MANDATORY_UPDATE_CONFIG: JSON.stringify({ allowedAuthOrigins: ['https://login.example.com'] }),
    }, 'win32', 'x64')
    expect(config.appId).toBe('com.example.dshfork')
    expect(config.productName).toBe('DSH Graph Desktop')
    expect(config.protocols).toEqual([{ name: 'DSH Graph Desktop', schemes: ['dshgraph'] }])
    expect(config.extraMetadata.dshDesktopIdentity).toEqual({
      productName: 'DSH Graph Desktop', protocolScheme: 'dshgraph', userDataDirectoryName: 'DSH-Graph-Desktop',
    })
    expect(config.mac.extendInfo).toMatchObject({
      CFBundleLocalizations: ['en', 'zh_CN'],
    })
    expect(typeof config.mac.extendInfo.NSMicrophoneUsageDescription).toBe('string')
  })

  it('builds an offline fork without update policy or a publish URL', () => {
    const config = createElectronBuilderConfig({
      DSH_DESKTOP_APP_ID: 'com.example.dshfork',
      DSH_DESKTOP_TARGET_PLATFORM: 'win32',
      DSH_DESKTOP_TARGET_ARCH: 'x64',
      DSH_DESKTOP_UNSIGNED: '1',
      DSH_DESKTOP_UPDATE_MODE: 'disabled',
      DSH_DESKTOP_PRODUCT_NAME: 'DSH Fork',
      DSH_DESKTOP_PROTOCOL_SCHEME: 'dshfork',
      DSH_DESKTOP_USER_DATA_DIR_NAME: 'DSH-Fork',
    }, 'win32', 'x64')
    expect(config.extraMetadata).toMatchObject({ dshDesktopUpdatesEnabled: false })
    expect(config.extraMetadata).not.toHaveProperty('dshMandatoryUpdatePolicy')
    expect(config.publish).toBeNull()
  })

  it.each(['', '1dsh', 'dsh-app', 'dsh/graph'])('rejects invalid protocol scheme %j', (value) => {
    expect(() => resolveDesktopIdentityEnvironment({ DSH_DESKTOP_PROTOCOL_SCHEME: value })).toThrow(/DSH_DESKTOP_PROTOCOL_SCHEME/u)
  })

  it.each(['', '.', '..', 'C:\\Users\\Data', 'CON', 'folder.', 'bad/name'])('rejects unsafe user-data directory name %j', (value) => {
    expect(() => resolveDesktopIdentityEnvironment({ DSH_DESKTOP_USER_DATA_DIR_NAME: value })).toThrow(/DSH_DESKTOP_USER_DATA_DIR_NAME/u)
  })

  it('rejects malformed embedded identity instead of silently accepting partial values', () => {
    expect(() => resolvePackagedDesktopIdentity({ dshDesktopIdentity: { productName: 'Fork' } })).toThrow(/packaged identity is incomplete/u)
    expect(() => resolvePackagedDesktopIdentity({ dshDesktopIdentity: 'fork' })).toThrow(/packaged identity metadata is invalid/u)
    expect(() => resolvePackagedDesktopIdentity({ dshDesktopAppId: 'io.example.fork' })).toThrow(/fork packages require explicit identity metadata/u)
  })

  it('gives distinct fork app IDs distinct DSH homes without replacing an explicit user home', () => {
    const one = resolveForkHarnessHome('io.example.dsh.one', undefined, 'C:\\Users\\test\\AppData\\Roaming')
    const two = resolveForkHarnessHome('io.example.dsh.two', undefined, 'C:\\Users\\test\\AppData\\Roaming')
    expect(one).toBeTruthy()
    expect(two).toBeTruthy()
    expect(one).not.toBe(two)
    expect(resolveDesktopPaths(one).profile).not.toBe(resolveDesktopPaths(two).profile)
    expect(resolveForkHarnessHome('io.example.dsh.one', 'E:\\HarnessData', 'C:\\Users\\test\\AppData\\Roaming')).toBeUndefined()
    expect(resolveForkHarnessHome('com.deepseek.harness', undefined, 'C:\\Users\\test\\AppData\\Roaming')).toBeUndefined()
  })
})
