[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string] $RepositoryRoot,

  [Parameter(Mandatory = $true)]
  [string] $DshHome,

  [Parameter(Mandatory = $true)]
  [string] $NodePath,

  [Parameter(Mandatory = $true)]
  [string] $StateRoot,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[A-Za-z0-9._-]{1,80}$')]
  [string] $TaskName,

  [ValidateRange(1, 65535)]
  [int] $Port = 3080,

  [ValidateRange(512, 65536)]
  [int] $MaxOldSpaceSizeMB = 8192,

  [ValidateRange(1, 300)]
  [int] $RestartDelaySeconds = 5,

  [ValidateRange(2, 100)]
  [int] $RetainedLogFiles = 20
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Resolve-AbsolutePath {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Path,

    [Parameter(Mandatory = $true)]
    [string] $Name
  )

  if (-not [System.IO.Path]::IsPathFullyQualified($Path)) {
    throw "$Name must be an absolute path: $Path"
  }
  return [System.IO.Path]::GetFullPath($Path)
}

function Write-RuntimeState {
  param(
    [Parameter(Mandatory = $true)]
    [hashtable] $Value
  )

  $temporary = Join-Path $script:ResolvedStateRoot ".$TaskName.runtime.$PID.tmp"
  $Value | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $temporary -Encoding utf8
  Move-Item -LiteralPath $temporary -Destination $script:RuntimeStatePath -Force
}

function Write-SupervisorLog {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Message
  )

  $line = '{0:o} {1}' -f (Get-Date).ToUniversalTime(), $Message
  Add-Content -LiteralPath $script:SupervisorLogPath -Value $line -Encoding utf8
}

function Remove-ExpiredLogs {
  $statePrefix = $script:ResolvedStateRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
  $expired = Get-ChildItem -LiteralPath $script:ResolvedStateRoot -File -Filter 'dsh-*.log' |
    Sort-Object LastWriteTimeUtc -Descending |
    Select-Object -Skip $RetainedLogFiles
  foreach ($file in $expired) {
    $resolved = [System.IO.Path]::GetFullPath($file.FullName)
    if (-not $resolved.StartsWith($statePrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "Refusing to remove a log outside the service state root: $resolved"
    }
    Remove-Item -LiteralPath $resolved -Force
  }
}

$ResolvedRepositoryRoot = Resolve-AbsolutePath -Path $RepositoryRoot -Name 'RepositoryRoot'
$ResolvedDshHome = Resolve-AbsolutePath -Path $DshHome -Name 'DshHome'
$ResolvedNodePath = Resolve-AbsolutePath -Path $NodePath -Name 'NodePath'
$script:ResolvedStateRoot = Resolve-AbsolutePath -Path $StateRoot -Name 'StateRoot'
$entrypoint = Join-Path $ResolvedRepositoryRoot 'apps\cli\src\bin.ts'
if (-not (Test-Path -LiteralPath $entrypoint -PathType Leaf)) {
  throw "DSH source entrypoint is absent: $entrypoint"
}
if (-not (Test-Path -LiteralPath $ResolvedNodePath -PathType Leaf)) {
  throw "Node.js executable is absent: $ResolvedNodePath"
}

New-Item -ItemType Directory -Path $script:ResolvedStateRoot -Force | Out-Null
$script:RuntimeStatePath = Join-Path $script:ResolvedStateRoot "$TaskName.runtime.json"
$stopPath = Join-Path $script:ResolvedStateRoot "$TaskName.stop"
$script:SupervisorLogPath = Join-Path $script:ResolvedStateRoot "$TaskName.supervisor.log"
$mutexSeed = [Convert]::ToHexString(
  [System.Security.Cryptography.SHA256]::HashData(
    [System.Text.Encoding]::UTF8.GetBytes("$TaskName`n$ResolvedRepositoryRoot")
  )
).Substring(0, 24)
$mutex = [System.Threading.Mutex]::new($false, "Local\DeepSeekHarness-$mutexSeed")
$ownsMutex = $false

try {
  $ownsMutex = $mutex.WaitOne(0)
  if (-not $ownsMutex) {
    Write-SupervisorLog -Message 'A supervisor already owns this service identity; exiting duplicate launch.'
    exit 0
  }

  Remove-Item -LiteralPath $stopPath -Force -ErrorAction SilentlyContinue
  Write-SupervisorLog -Message "Supervisor started as PID $PID."
  while (-not (Test-Path -LiteralPath $stopPath)) {
    Remove-ExpiredLogs
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $nonce = [Guid]::NewGuid().ToString('N').Substring(0, 8)
    $stdoutPath = Join-Path $script:ResolvedStateRoot "dsh-$stamp-$nonce.stdout.log"
    $stderrPath = Join-Path $script:ResolvedStateRoot "dsh-$stamp-$nonce.stderr.log"
    $env:DSH_HOME = $ResolvedDshHome
    $process = Start-Process `
      -FilePath $ResolvedNodePath `
      -ArgumentList @("--max-old-space-size=$MaxOldSpaceSizeMB", '--import', 'tsx/esm', 'apps/cli/src/bin.ts', 'web', '--no-open', '--port', [string]$Port) `
      -WorkingDirectory $ResolvedRepositoryRoot `
      -WindowStyle Hidden `
      -RedirectStandardOutput $stdoutPath `
      -RedirectStandardError $stderrPath `
      -PassThru
    $startedAt = $process.StartTime.ToUniversalTime().ToString('o')
    Write-RuntimeState -Value @{
      status = 'running'
      taskName = $TaskName
      repositoryRoot = $ResolvedRepositoryRoot
      dshHome = $ResolvedDshHome
      nodePath = $ResolvedNodePath
      port = $Port
      maxOldSpaceSizeMB = $MaxOldSpaceSizeMB
      supervisorPid = $PID
      childPid = $process.Id
      childStartedAt = $startedAt
      stdoutPath = $stdoutPath
      stderrPath = $stderrPath
    }
    Write-SupervisorLog -Message "Started DSH PID $($process.Id) on port $Port with a $MaxOldSpaceSizeMB MB V8 old-space limit."
    $process.WaitForExit()
    $exitCode = $process.ExitCode
    Write-SupervisorLog -Message "DSH PID $($process.Id) exited with code $exitCode."
    Write-RuntimeState -Value @{
      status = 'restarting'
      taskName = $TaskName
      repositoryRoot = $ResolvedRepositoryRoot
      dshHome = $ResolvedDshHome
      nodePath = $ResolvedNodePath
      port = $Port
      maxOldSpaceSizeMB = $MaxOldSpaceSizeMB
      supervisorPid = $PID
      childPid = $null
      childStartedAt = $startedAt
      lastExitCode = $exitCode
      stdoutPath = $stdoutPath
      stderrPath = $stderrPath
    }
    if (Test-Path -LiteralPath $stopPath) {
      break
    }
    Start-Sleep -Seconds $RestartDelaySeconds
  }
} finally {
  if ($ownsMutex) {
    Write-RuntimeState -Value @{
      status = 'stopped'
      taskName = $TaskName
      repositoryRoot = $ResolvedRepositoryRoot
      dshHome = $ResolvedDshHome
      nodePath = $ResolvedNodePath
      port = $Port
      maxOldSpaceSizeMB = $MaxOldSpaceSizeMB
      supervisorPid = $PID
      childPid = $null
    }
    Write-SupervisorLog -Message "Supervisor PID $PID stopped."
    $mutex.ReleaseMutex()
  }
  $mutex.Dispose()
}
