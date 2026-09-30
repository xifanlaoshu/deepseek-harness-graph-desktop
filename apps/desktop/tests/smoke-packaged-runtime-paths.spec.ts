import { join } from 'node:path'
import { expect, it } from 'vitest'
import { resolvePackagedRuntimePaths } from '../scripts/smoke-packaged-runtime.ts'

it('resolves packaged executable and resource paths from the configured product name', () => {
  expect(resolvePackagedRuntimePaths('artifacts', 'win-x64', 'DSH Graph Desktop')).toEqual({
    application: join('artifacts', 'win-unpacked'),
    resources: join('artifacts', 'win-unpacked', 'resources'),
    executable: join('artifacts', 'win-unpacked', 'DSH Graph Desktop.exe'),
  })
  expect(resolvePackagedRuntimePaths('artifacts', 'mac-arm64', 'DSH Graph Desktop')).toEqual({
    application: join('artifacts', 'mac-arm64', 'DSH Graph Desktop.app', 'Contents'),
    resources: join('artifacts', 'mac-arm64', 'DSH Graph Desktop.app', 'Contents', 'Resources'),
    executable: join('artifacts', 'mac-arm64', 'DSH Graph Desktop.app', 'Contents', 'MacOS', 'DSH Graph Desktop'),
  })
})
