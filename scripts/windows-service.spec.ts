import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const manager = join(root, 'scripts', 'windows', 'dsh-service.ps1')
const host = join(root, 'scripts', 'windows', 'dsh-service-host.ps1')

describe('Windows DSH background service scripts', () => {
  it('keep registration and supervision responsibilities in separate scripts', () => {
    expect(readFileSync(manager, 'utf8')).toContain('New-ScheduledTaskTrigger -AtLogOn')
    expect(readFileSync(manager, 'utf8')).toContain('-LogonType Interactive')
    expect(readFileSync(host, 'utf8')).toContain('$process.WaitForExit()')
    expect(readFileSync(host, 'utf8')).toContain('Start-Sleep -Seconds $RestartDelaySeconds')
    expect(readFileSync(manager, 'utf8')).toContain("'-MaxOldSpaceSizeMB'")
    expect(readFileSync(host, 'utf8')).toContain('"--max-old-space-size=$MaxOldSpaceSizeMB"')
  })

  describe.runIf(process.platform === 'win32')('status command', () => {
    const stateRoot = mkdtempSync(join(tmpdir(), 'dsh-windows-service-test-'))
    const taskName = `DshServiceTest-${process.pid}`

    afterAll(() => {
      rmSync(stateRoot, { recursive: true, force: true })
    })

    it('reports an absent isolated task without registering it', () => {
      const output = execFileSync('pwsh.exe', [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        manager,
        'status',
        '-RepositoryRoot',
        root,
        '-StateRoot',
        stateRoot,
        '-TaskName',
        taskName,
        '-Port',
        '65534',
      ], { encoding: 'utf8' })

      expect(output).toMatch(/installed\s+: False/)
      expect(output).toMatch(/httpHealthy\s+: False/)
      expect(output).toMatch(/maxOldSpaceSizeMB\s+: 8192/)
    })
  })
})
