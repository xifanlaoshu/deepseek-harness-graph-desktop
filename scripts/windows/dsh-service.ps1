[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [ValidateSet('install', 'start', 'stop', 'restart', 'status', 'uninstall')]
  [string] $Action,

  [string] $RepositoryRoot,

  [string] $DshHome,

  [ValidatePattern('^[A-Za-z0-9._-]{1,80}$')]
  [string] $TaskName = 'DeepSeekHarnessWeb',

  [ValidateRange(1, 65535)]
  [int] $Port = 3080,

  [ValidateRange(512, 65536)]
  [int] $MaxOldSpaceSizeMB = 8192,

  [string] $StateRoot,

  [switch] $Force
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

function Quote-TaskArgument {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Value
  )

  if ($Value.Contains('"')) {
    throw "Task arguments cannot contain a double quote: $Value"
  }
  return '"{0}"' -f $Value
}

function Get-DshTask {
  return Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
}

function Read-RuntimeState {
  if (-not (Test-Path -LiteralPath $script:RuntimeStatePath -PathType Leaf)) {
    return $null
  }
  try {
    return Get-Content -LiteralPath $script:RuntimeStatePath -Raw | ConvertFrom-Json
  } catch {
    throw "DSH service runtime state is invalid: $script:RuntimeStatePath"
  }
}

function Test-DshHealth {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/" -TimeoutSec 3
    return $response.StatusCode -eq 200
  } catch {
    return $false
  }
}

function Wait-DshHealth {
  param(
    [ValidateRange(1, 300)]
    [int] $TimeoutSeconds = 60
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-DshHealth) {
      return
    }
    Start-Sleep -Milliseconds 500
  }
  $state = Read-RuntimeState
  $stderrPath = if ($null -eq $state -or $null -eq $state.PSObject.Properties['stderrPath']) {
    $null
  } else {
    $state.stderrPath
  }
  if ($null -ne $stderrPath -and (Test-Path -LiteralPath $stderrPath -PathType Leaf)) {
    Write-Host "Last DSH stderr lines from $stderrPath"
    Get-Content -LiteralPath $stderrPath -Tail 80
  }
  throw "DSH did not return HTTP 200 on port $Port within $TimeoutSeconds seconds."
}

function Test-ProcessIdentity {
  param(
    [Parameter(Mandatory = $true)]
    [int] $ProcessId,

    [Parameter(Mandatory = $true)]
    [string] $ExpectedExecutable,

    [Parameter(Mandatory = $true)]
    [datetime] $ExpectedStartTime
  )

  $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
  if ($null -eq $process) {
    return $false
  }
  try {
    $actualExecutable = [System.IO.Path]::GetFullPath($process.Path)
    $actualStartTime = $process.StartTime.ToUniversalTime()
  } catch {
    return $false
  }
  $sameExecutable = $actualExecutable.Equals(
    [System.IO.Path]::GetFullPath($ExpectedExecutable),
    [System.StringComparison]::OrdinalIgnoreCase
  )
  $sameStart = [Math]::Abs(($actualStartTime - $ExpectedStartTime.ToUniversalTime()).TotalSeconds) -lt 2
  return $sameExecutable -and $sameStart
}

function Stop-VerifiedProcessTree {
  param(
    [Parameter(Mandatory = $true)]
    [int] $RootProcessId,

    [Parameter(Mandatory = $true)]
    [string] $ExpectedExecutable,

    [Parameter(Mandatory = $true)]
    [datetime] $ExpectedStartTime
  )

  if (-not (Test-ProcessIdentity -ProcessId $RootProcessId -ExpectedExecutable $ExpectedExecutable -ExpectedStartTime $ExpectedStartTime)) {
    return
  }
  $all = @(Get-CimInstance Win32_Process)
  function Get-DescendantProcessIds {
    param(
      [int] $ParentProcessId,
      [object[]] $Processes
    )
    $children = @($Processes | Where-Object { $_.ParentProcessId -eq $ParentProcessId })
    foreach ($child in $children) {
      Get-DescendantProcessIds -ParentProcessId $child.ProcessId -Processes $Processes
    }
    foreach ($child in $children) {
      $child.ProcessId
    }
  }
  $targets = @((Get-DescendantProcessIds -ParentProcessId $RootProcessId -Processes $all) + $RootProcessId)
  foreach ($target in $targets) {
    if ($null -ne (Get-Process -Id $target -ErrorAction SilentlyContinue)) {
      Stop-Process -Id $target -Force
    }
  }
}

function Stop-DshService {
  $now = (Get-Date).ToUniversalTime().ToString('o')
  Set-Content -LiteralPath $script:StopPath -Value $now -Encoding utf8
  $state = Read-RuntimeState
  if ($null -ne $state -and $null -ne $state.childPid -and $null -ne $state.childStartedAt) {
    $expectedNodePath = if ($null -eq $state.PSObject.Properties['nodePath']) {
      $script:ResolvedNodePath
    } else {
      [string]$state.nodePath
    }
    Stop-VerifiedProcessTree `
      -RootProcessId ([int]$state.childPid) `
      -ExpectedExecutable $expectedNodePath `
      -ExpectedStartTime ([datetime]$state.childStartedAt)
  }
  $deadline = (Get-Date).AddSeconds(15)
  while ((Get-Date) -lt $deadline) {
    $current = Read-RuntimeState
    if ($null -eq $current -or $current.status -eq 'stopped') {
      break
    }
    Start-Sleep -Milliseconds 250
  }
  $task = Get-DshTask
  if ($null -ne $task -and $task.State -eq 'Running') {
    Stop-ScheduledTask -TaskName $TaskName
  }
}

function Start-DshService {
  $task = Get-DshTask
  if ($null -eq $task) {
    throw "Scheduled task $TaskName is not installed."
  }
  if (Test-DshHealth) {
    return
  }
  Remove-Item -LiteralPath $script:StopPath -Force -ErrorAction SilentlyContinue
  Start-ScheduledTask -TaskName $TaskName
  Wait-DshHealth
}

if ([string]::IsNullOrWhiteSpace($RepositoryRoot)) {
  $RepositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
}
if ([string]::IsNullOrWhiteSpace($DshHome)) {
  $DshHome = if ([string]::IsNullOrWhiteSpace($env:DSH_HOME)) {
    Join-Path $HOME '.dsh'
  } else {
    $env:DSH_HOME
  }
}
if ([string]::IsNullOrWhiteSpace($StateRoot)) {
  $StateRoot = Join-Path $env:LOCALAPPDATA 'DeepSeekHarness\Service'
}

$script:ResolvedRepositoryRoot = Resolve-AbsolutePath -Path $RepositoryRoot -Name 'RepositoryRoot'
$script:ResolvedDshHome = Resolve-AbsolutePath -Path $DshHome -Name 'DshHome'
$script:ResolvedStateRoot = Resolve-AbsolutePath -Path $StateRoot -Name 'StateRoot'
$entrypoint = Join-Path $script:ResolvedRepositoryRoot 'apps\cli\src\bin.ts'
$hostScript = Join-Path $script:ResolvedRepositoryRoot 'scripts\windows\dsh-service-host.ps1'
if (-not (Test-Path -LiteralPath $entrypoint -PathType Leaf)) {
  throw "DSH source entrypoint is absent: $entrypoint"
}
if (-not (Test-Path -LiteralPath $hostScript -PathType Leaf)) {
  throw "DSH service host script is absent: $hostScript"
}
$script:ResolvedNodePath = Resolve-AbsolutePath -Path (Get-Command node.exe -ErrorAction Stop).Source -Name 'NodePath'
$resolvedPwshPath = Resolve-AbsolutePath -Path (Get-Command pwsh.exe -ErrorAction Stop).Source -Name 'PwshPath'
New-Item -ItemType Directory -Path $script:ResolvedStateRoot -Force | Out-Null
$script:RuntimeStatePath = Join-Path $script:ResolvedStateRoot "$TaskName.runtime.json"
$script:StopPath = Join-Path $script:ResolvedStateRoot "$TaskName.stop"

switch ($Action) {
  'install' {
    $existing = Get-DshTask
    if ($null -ne $existing -and -not $Force) {
      throw "Scheduled task $TaskName already exists; use -Force to replace it."
    }
    if ($null -ne $existing) {
      Stop-DshService
    }
    if (Test-DshHealth) {
      throw "Port $Port already serves HTTP before $TaskName starts; stop the existing process first."
    }
    $user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    $arguments = @(
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      (Quote-TaskArgument $hostScript),
      '-RepositoryRoot',
      (Quote-TaskArgument $script:ResolvedRepositoryRoot),
      '-DshHome',
      (Quote-TaskArgument $script:ResolvedDshHome),
      '-NodePath',
      (Quote-TaskArgument $script:ResolvedNodePath),
      '-StateRoot',
      (Quote-TaskArgument $script:ResolvedStateRoot),
      '-TaskName',
      (Quote-TaskArgument $TaskName),
      '-Port',
      [string]$Port,
      '-MaxOldSpaceSizeMB',
      [string]$MaxOldSpaceSizeMB
    ) -join ' '
    $taskAction = New-ScheduledTaskAction -Execute $resolvedPwshPath -Argument $arguments
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet `
      -AllowStartIfOnBatteries `
      -DontStopIfGoingOnBatteries `
      -StartWhenAvailable `
      -ExecutionTimeLimit ([TimeSpan]::Zero) `
      -MultipleInstances IgnoreNew `
      -RestartCount 999 `
      -RestartInterval (New-TimeSpan -Minutes 1)
    $task = New-ScheduledTask `
      -Action $taskAction `
      -Trigger $trigger `
      -Principal $principal `
      -Settings $settings `
      -Description 'Runs DeepSeek Harness Web in the interactive user session with automatic restart.'
    Register-ScheduledTask -TaskName $TaskName -InputObject $task -Force | Out-Null
    Start-DshService
    & $PSCommandPath status -RepositoryRoot $script:ResolvedRepositoryRoot -DshHome $script:ResolvedDshHome -TaskName $TaskName -Port $Port -StateRoot $script:ResolvedStateRoot
  }
  'start' {
    Start-DshService
    & $PSCommandPath status -RepositoryRoot $script:ResolvedRepositoryRoot -DshHome $script:ResolvedDshHome -TaskName $TaskName -Port $Port -StateRoot $script:ResolvedStateRoot
  }
  'stop' {
    Stop-DshService
    & $PSCommandPath status -RepositoryRoot $script:ResolvedRepositoryRoot -DshHome $script:ResolvedDshHome -TaskName $TaskName -Port $Port -StateRoot $script:ResolvedStateRoot
  }
  'restart' {
    Stop-DshService
    Start-DshService
    & $PSCommandPath status -RepositoryRoot $script:ResolvedRepositoryRoot -DshHome $script:ResolvedDshHome -TaskName $TaskName -Port $Port -StateRoot $script:ResolvedStateRoot
  }
  'status' {
    $task = Get-DshTask
    $taskInfo = if ($null -eq $task) { $null } else { Get-ScheduledTaskInfo -TaskName $TaskName }
    $state = Read-RuntimeState
    [pscustomobject]@{
      taskName = $TaskName
      installed = $null -ne $task
      taskState = if ($null -eq $task) { 'Absent' } else { [string]$task.State }
      lastTaskResult = if ($null -eq $taskInfo) { $null } else { $taskInfo.LastTaskResult }
      runtimeStatus = if ($null -eq $state) { 'unknown' } else { $state.status }
      supervisorPid = if ($null -eq $state) { $null } else { $state.supervisorPid }
      childPid = if ($null -eq $state) { $null } else { $state.childPid }
      repositoryRoot = $script:ResolvedRepositoryRoot
      dshHome = $script:ResolvedDshHome
      stateRoot = $script:ResolvedStateRoot
      webUrl = "http://127.0.0.1:$Port/"
      httpHealthy = Test-DshHealth
      maxOldSpaceSizeMB = if ($null -eq $state -or $null -eq $state.PSObject.Properties['maxOldSpaceSizeMB']) {
        $MaxOldSpaceSizeMB
      } else {
        $state.maxOldSpaceSizeMB
      }
    } | Format-List
  }
  'uninstall' {
    Stop-DshService
    if ($null -ne (Get-DshTask)) {
      Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    }
    & $PSCommandPath status -RepositoryRoot $script:ResolvedRepositoryRoot -DshHome $script:ResolvedDshHome -TaskName $TaskName -Port $Port -StateRoot $script:ResolvedStateRoot
  }
}
