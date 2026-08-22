[CmdletBinding()]
param(
  [ValidateRange(1, 65535)]
  [int]$Port = 9222,
  [string]$ProfileDirectory = (Join-Path $env:LOCALAPPDATA 'dsh\chrome-debug-profile'),
  [string]$StartUrl = 'about:blank'
)

$ErrorActionPreference = 'Stop'
$endpoint = "http://127.0.0.1:$Port/json/version"

try {
  $version = Invoke-RestMethod -Uri $endpoint -TimeoutSec 1
  Write-Host "Chrome debugging is already available at http://127.0.0.1:$Port ($($version.Browser))."
  exit 0
} catch {
  # An unavailable loopback endpoint is the expected launch path.
}

$command = Get-Command chrome.exe -ErrorAction SilentlyContinue
$candidates = @(
  $command.Source
  (Join-Path $env:PROGRAMFILES 'Google\Chrome\Application\chrome.exe')
  (Join-Path ${env:PROGRAMFILES(X86)} 'Google\Chrome\Application\chrome.exe')
  (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -Unique

$chrome = $candidates | Select-Object -First 1
if (-not $chrome) {
  throw 'Google Chrome was not found. Install Chrome or add chrome.exe to PATH.'
}

$profile = [IO.Path]::GetFullPath($ProfileDirectory)
New-Item -ItemType Directory -Path $profile -Force | Out-Null
try {
  $normalizedStartUrl = ([Uri]$StartUrl).AbsoluteUri
} catch {
  throw "StartUrl must be an absolute URL, got: $StartUrl"
}
$arguments = @(
  "--remote-debugging-port=$Port"
  '--remote-debugging-address=127.0.0.1'
  "--user-data-dir=`"$profile`""
  '--no-first-run'
  '--no-default-browser-check'
  $normalizedStartUrl
)

# This is the interactive browser the user and the agent inspect together, so
# it intentionally opens a visible window.
Start-Process -FilePath $chrome -ArgumentList $arguments | Out-Null

$deadline = [DateTime]::UtcNow.AddSeconds(10)
do {
  Start-Sleep -Milliseconds 200
  try {
    $version = Invoke-RestMethod -Uri $endpoint -TimeoutSec 1
    Write-Host "Chrome debugging is ready at http://127.0.0.1:$Port ($($version.Browser))."
    Write-Host "Profile: $profile"
    exit 0
  } catch {
    # Retry until Chrome publishes the DevTools endpoint or the deadline passes.
  }
} while ([DateTime]::UtcNow -lt $deadline)

throw "Chrome started but the DevTools endpoint did not become ready at http://127.0.0.1:$Port."
