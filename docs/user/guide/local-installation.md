# Install and deploy locally

English | [中文](local-installation.zh.md)

This tutorial installs this repository from source and ends with a working Web UI, model route, workspace, and Graph Mode. It is written so a person or an AI executor can complete the installation without guessing between platform-specific commands.

## Execution rules

- Run each command in the shell named above its code block and stop when a verification command fails.
- Do not delete or overwrite an existing checkout, `$DSH_HOME`, `.sessions`, or `.loopx` directory. Back it up or choose a new install root.
- Never place API keys, passwords, or production credentials in commands, Git files, screenshots, or the installation receipt.
- Use a test account and test data for browser automation. Keep the Web server and Chrome debugging endpoints on loopback unless the deployment has an explicit trust policy.
- Keep the source checkout on a local filesystem. Do not build from a network share or a Windows path mounted into WSL when DSH itself runs inside Linux.
- Record the exact Git commit after installation. Upgrades are explicit source updates and builds; this repository does not provide a managed installer or automatic rollback.

## Choose a deployment layout

| Layout | DSH runtime | LoopX | Browser automation |
|---|---|---|---|
| Windows + WSL | Native Windows | WSL 2 persistent broker | Native Chrome |
| Native Windows | Native Windows | Disabled; upstream LoopX does not publish a native-Windows installer | Native Chrome |
| Linux | Native Linux | Native process transport | Installed Google Chrome |
| macOS | Native macOS | Native process transport | Installed Google Chrome |

Graph Mode is included in the Web profile and works without LoopX. Enabling LoopX adds external goal, todo, claim, lease, and settlement coordination; it is not required to open Graph Mode or run local graph workers.

## Shared values and acceptance criteria

Use these values consistently throughout one installation:

| Value | Recommended value | Purpose |
|---|---|---|
| Repository URL | `https://github.com/xifanlaoshu/deepseek-harness.git` | Source distribution to clone |
| Install root | A new local directory without generated build output | Source, build, and default workspace root |
| DSH home | `$DSH_HOME`, otherwise `~/.dsh` | Profiles, settings, credentials, and sessions |
| Web profile | `web` | Base, Web, Graph, and optional profile bundles |
| Web URL | `http://127.0.0.1:3080/` | Default local UI |
| LoopX goal | `dsh-graph-mode` | External coordination goal used by Graph nodes |

A complete installation satisfies all of these checks:

1. Node.js is `22.19.0` or later in the 22.x line, or any supported 24.x-or-later release; Node.js 23.x is not supported.
2. `pnpm --version` prints `11.7.0`, `pnpm install --frozen-lockfile` succeeds, and `pnpm run build` succeeds.
3. `pnpm dsh --profile web --dump-config` succeeds and lists `graph-mode` plus `ui-graph`.
4. The Web URL returns HTTP 200 and the UI can save a model provider and select a workspace.
5. A new session accepts `/graph`, shows the Graph interface, and can run a minimal read-only task.

## Windows + WSL

This layout runs DSH and Chrome natively on Windows while one long-lived provider-owned broker invokes LoopX inside WSL 2. It avoids starting a new WSL process for every coordination operation.

### 1. Install Windows prerequisites

Run in an elevated PowerShell terminal if `winget` requests elevation:

```powershell
winget install --id Git.Git -e
winget install --id OpenJS.NodeJS.LTS -e
winget install --id Microsoft.PowerShell -e
```

Close and reopen PowerShell, then install the repository-pinned pnpm version and verify the toolchain:

```powershell
npm install --global pnpm@11.7.0
git --version
node --version
pnpm --version
node -e "const [major, minor] = process.versions.node.split('.').map(Number); if (!((major === 22 && minor >= 19) || major >= 24)) { console.error('Unsupported Node.js ' + process.versions.node); process.exit(1) }"
if ((pnpm --version).Trim() -ne '11.7.0') { throw 'pnpm 11.7.0 is required' }
```

### 2. Install WSL 2 and LoopX

Run in PowerShell and restart Windows if the command requests it:

```powershell
wsl.exe --install -d Ubuntu
wsl.exe --set-default-version 2
wsl.exe -l -v
```

Open the Ubuntu shell and install LoopX's documented prerequisites and release:

```bash
sudo apt-get update
sudo apt-get install -y curl tar python3
curl -fsSL https://huangruiteng.github.io/loopx/install.sh | bash
export PATH="$HOME/.local/bin:$PATH"
loopx doctor
command -v loopx
python3 --version
python3 -c "import sys; assert sys.version_info >= (3, 11), sys.version"
```

Record the exact path printed by `command -v loopx`; the profile patch uses it as `<LOOPX_BIN_IN_WSL>`.

### 3. Clone and build DSH

Run in PowerShell. Select a new install root; the guard deliberately refuses to reuse an existing path.

```powershell
$env:DSH_REPOSITORY_URL = 'https://github.com/xifanlaoshu/deepseek-harness.git'
$env:DSH_INSTALL_ROOT = 'C:\dsh\deepseek-harness'
if (Test-Path -LiteralPath $env:DSH_INSTALL_ROOT) { throw "Install root already exists: $env:DSH_INSTALL_ROOT" }
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $env:DSH_INSTALL_ROOT) | Out-Null
git clone $env:DSH_REPOSITORY_URL $env:DSH_INSTALL_ROOT
Set-Location -LiteralPath $env:DSH_INSTALL_ROOT
pnpm install --frozen-lockfile
pnpm run build
git rev-parse HEAD
pnpm dsh --profile web --dump-config
```

### 4. Initialize the LoopX goal and role identities

Open the Ubuntu shell, change to the same checkout through its `/mnt/<drive>/...` path, and run:

```bash
cd /mnt/c/dsh/deepseek-harness
export PATH="$HOME/.local/bin:$PATH"
loopx start-goal --guided --project . --goal-id dsh-graph-mode --host-surface deepseek-harness --goal-text "Coordinate DeepSeek Harness Graph work"
```

`start-goal --guided` is a preview. Execute the exact apply and verification commands it prints, in order, and continue only when the result confirms the goal was written and synchronized. Then register the worker identities idempotently:

```bash
loopx register-agent --goal-id dsh-graph-mode \
  --agent-id dsh-graph-analyst \
  --agent-id dsh-graph-architect \
  --agent-id dsh-graph-environment \
  --agent-id dsh-graph-engineer \
  --agent-id dsh-graph-reviewer \
  --agent-id dsh-graph-verifier \
  --agent-id dsh-graph-browser-tester \
  --agent-id dsh-graph-writer \
  --execute
loopx status
```

### 5. Enable the persistent WSL provider

Run `pnpm dsh web --no-open` once if `$DSH_HOME/profiles/web` does not exist, stop it with Ctrl+C, then edit `$DSH_HOME/profiles/web/cordis.patch.yml`. Preserve unrelated rows and add or replace only this row, substituting the actual WSL distribution and LoopX executable path:

```yaml
- id: graph-coordination-loopx
  disabled: false
  config:
    goalId: dsh-graph-mode
    roleAgents:
      analyst: dsh-graph-analyst
      architect: dsh-graph-architect
      environment: dsh-graph-environment
      engineer: dsh-graph-engineer
      reviewer: dsh-graph-reviewer
      verifier: dsh-graph-verifier
      browser-tester: dsh-graph-browser-tester
      writer: dsh-graph-writer
    executable: wsl.exe
    executableArgs: ['-d', '<WSL_DISTRO>', '--exec']
    transport: persistent
    brokerPythonExecutable: python3
    brokerCommand: '<LOOPX_BIN_IN_WSL>'
    pathStyle: wsl
    registry: '<WINDOWS_INSTALL_ROOT>/.loopx/registry.json'
    graceMs: 30000
    journalPath: '<WINDOWS_INSTALL_ROOT>/.sessions/graph-coordination-loopx.sqlite'
```

Use absolute Windows paths for `<WINDOWS_INSTALL_ROOT>`; `pathStyle: wsl` converts them before the broker invokes LoopX. Start DSH from the checkout root so the remaining relative Graph stores resolve to that installation. Verify the rendered row before starting the server:

```powershell
Set-Location -LiteralPath $env:DSH_INSTALL_ROOT
pnpm dsh --profile web --dump-config | Select-String -Pattern 'graph-coordination-loopx|transport: persistent|pathStyle: wsl'
```

### 6. Install browser automation and start

Install Google Chrome Stable, then install the source bundle into the Web profile and start DSH:

```powershell
winget install --id Google.Chrome -e
Set-Location -LiteralPath $env:DSH_INSTALL_ROOT
pnpm dsh plugin --profile web add ./packages/bundle/browser-chrome-devtools
pnpm dsh web --no-open
```

Keep this terminal open. The managed browser starts only when an agent first calls a browser tool and is closed when the bundle is disposed.

## Native Windows

Native Windows supports DSH, the Web UI, Graph Mode, local workers, SQLite scheduling and resource control, and managed Chrome automation. The upstream LoopX installer requires a macOS or Linux shell, so a pure-Windows deployment leaves `graph-coordination-loopx` disabled. Do not install an unverified same-name Windows package or point the provider at a compatibility wrapper.

### 1. Install, clone, and build

Run in PowerShell:

```powershell
winget install --id Git.Git -e
winget install --id OpenJS.NodeJS.LTS -e
winget install --id Google.Chrome -e
npm install --global pnpm@11.7.0
$env:DSH_REPOSITORY_URL = 'https://github.com/xifanlaoshu/deepseek-harness.git'
$env:DSH_INSTALL_ROOT = 'C:\dsh\deepseek-harness'
if (Test-Path -LiteralPath $env:DSH_INSTALL_ROOT) { throw "Install root already exists: $env:DSH_INSTALL_ROOT" }
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $env:DSH_INSTALL_ROOT) | Out-Null
git clone $env:DSH_REPOSITORY_URL $env:DSH_INSTALL_ROOT
Set-Location -LiteralPath $env:DSH_INSTALL_ROOT
node -e "const [major, minor] = process.versions.node.split('.').map(Number); if (!((major === 22 && minor >= 19) || major >= 24)) { console.error('Unsupported Node.js ' + process.versions.node); process.exit(1) }"
if ((pnpm --version).Trim() -ne '11.7.0') { throw 'pnpm 11.7.0 is required' }
pnpm install --frozen-lockfile
pnpm run build
git rev-parse HEAD
```

### 2. Install the browser bundle and start

```powershell
Set-Location -LiteralPath $env:DSH_INSTALL_ROOT
pnpm dsh plugin --profile web add ./packages/bundle/browser-chrome-devtools
pnpm dsh --profile web --dump-config | Select-String -Pattern 'graph-mode|ui-graph|browser-chrome-devtools'
pnpm dsh web --no-open
```

If LoopX coordination becomes required, stop DSH and migrate this deployment to the Windows + WSL layout; the existing DSH home and source checkout can remain in place.

## Windows background service

Both Windows layouts can run DSH as a per-user background service. The installer uses Task Scheduler with the current user's interactive token instead of the Windows Service Control Manager: WSL distributions, the user's DSH home, and visible Chrome automation are unavailable or unreliable from the non-interactive Session 0 used by SCM services.

Stop any manually started DSH process, open PowerShell in the repository root, and install the service:

```powershell
pwsh -NoProfile -File .\scripts\windows\dsh-service.ps1 install
```

The task starts immediately and after every login. A supervisor restarts an unexpectedly exited DSH child after five seconds; Task Scheduler also restarts the supervisor if it exits. The service gives Node an 8,192 MB V8 old-space limit by default. Pass `-MaxOldSpaceSizeMB 12288` to `install` when a machine has enough physical memory and exceptionally large cold sessions require more; this setting limits the JavaScript heap rather than total process memory, and changing it requires `install -Force`. Installation fails when another process already serves the selected port. Check the task, exact PIDs, state paths, configured old-space limit, and HTTP health with:

```powershell
pwsh -NoProfile -File .\scripts\windows\dsh-service.ps1 status
```

Use the same manager for lifecycle operations:

```powershell
pwsh -NoProfile -File .\scripts\windows\dsh-service.ps1 restart
pwsh -NoProfile -File .\scripts\windows\dsh-service.ps1 stop
pwsh -NoProfile -File .\scripts\windows\dsh-service.ps1 start
pwsh -NoProfile -File .\scripts\windows\dsh-service.ps1 uninstall
```

The default task is `DeepSeekHarnessWeb`; runtime state and rotated stdout/stderr logs are under `%LOCALAPPDATA%\DeepSeekHarness\Service`. `uninstall` preserves these diagnostic files. The task records the repository, DSH home, Node executable, and port supplied at installation, so stop the service before moving or updating the checkout and reinstall with `install -Force` after changing Node.js or those paths. The service runs only while that user is logged in; a non-interactive server deployment that does not require WSL or visible Chrome needs a separate SCM wrapper and service-owned DSH home.

## Linux

The commands below target Ubuntu or Debian. On Fedora or RHEL, install the equivalent `git`, `curl`, `tar`, `python3`, C/C++ compiler, and `make` packages with `dnf` before continuing.

### 1. Install prerequisites and Node.js

```bash
sudo apt-get update
sudo apt-get install -y git curl tar python3 build-essential
python3 -c "import sys; assert sys.version_info >= (3, 11), sys.version"
curl https://get.volta.sh | bash
export VOLTA_HOME="$HOME/.volta"
export PATH="$VOLTA_HOME/bin:$HOME/.local/bin:$PATH"
volta install node@24 pnpm@11.7.0
node -e "const [major, minor] = process.versions.node.split('.').map(Number); if (!((major === 22 && minor >= 19) || major >= 24)) { console.error('Unsupported Node.js ' + process.versions.node); process.exit(1) }"
test "$(pnpm --version)" = '11.7.0'
```

### 2. Clone and build

```bash
export DSH_REPOSITORY_URL='https://github.com/xifanlaoshu/deepseek-harness.git'
export DSH_INSTALL_ROOT="$HOME/src/deepseek-harness"
test ! -e "$DSH_INSTALL_ROOT" || { echo "Install root already exists: $DSH_INSTALL_ROOT" >&2; exit 1; }
mkdir -p "$(dirname "$DSH_INSTALL_ROOT")"
git clone "$DSH_REPOSITORY_URL" "$DSH_INSTALL_ROOT"
cd "$DSH_INSTALL_ROOT"
pnpm install --frozen-lockfile
pnpm run build
git rev-parse HEAD
```

### 3. Install and initialize LoopX

```bash
curl -fsSL https://huangruiteng.github.io/loopx/install.sh | bash
export PATH="$HOME/.local/bin:$PATH"
loopx doctor
loopx start-goal --guided --project . --goal-id dsh-graph-mode --host-surface deepseek-harness --goal-text "Coordinate DeepSeek Harness Graph work"
```

Execute the guided command's exact apply and verification commands before registering the same eight role identities shown in the Windows + WSL section. Record `command -v loopx` as `<LOOPX_BIN>`.

### 4. Enable native LoopX and start

Initialize the Web profile once, stop it, and add the following row to `$DSH_HOME/profiles/web/cordis.patch.yml`. Copy the complete `roleAgents` mapping from the Windows + WSL row.

```yaml
- id: graph-coordination-loopx
  disabled: false
  config:
    goalId: dsh-graph-mode
    roleAgents:
      analyst: dsh-graph-analyst
      architect: dsh-graph-architect
      environment: dsh-graph-environment
      engineer: dsh-graph-engineer
      reviewer: dsh-graph-reviewer
      verifier: dsh-graph-verifier
      browser-tester: dsh-graph-browser-tester
      writer: dsh-graph-writer
    executable: '<LOOPX_BIN>'
    transport: process
    pathStyle: native
    registry: '<ABSOLUTE_DSH_INSTALL_ROOT>/.loopx/registry.json'
    journalPath: '<ABSOLUTE_DSH_INSTALL_ROOT>/.sessions/graph-coordination-loopx.sqlite'
```

Install Google Chrome Stable through the distribution's supported package source, then run:

```bash
cd "$DSH_INSTALL_ROOT"
pnpm dsh plugin --profile web add ./packages/bundle/browser-chrome-devtools
pnpm dsh --profile web --dump-config | grep -E 'graph-mode|ui-graph|graph-coordination-loopx|browser-chrome-devtools'
pnpm dsh web --no-open
```

## macOS

### 1. Install prerequisites and Node.js

Install the Xcode command-line tools if they are absent, then install Node.js and pnpm with Volta:

```bash
xcode-select -p >/dev/null 2>&1 || xcode-select --install
curl https://get.volta.sh | bash
export VOLTA_HOME="$HOME/.volta"
export PATH="$VOLTA_HOME/bin:$HOME/.local/bin:$PATH"
volta install node@24 pnpm@11.7.0
git --version
python3 --version
python3 -c "import sys; assert sys.version_info >= (3, 11), sys.version"
node -e "const [major, minor] = process.versions.node.split('.').map(Number); if (!((major === 22 && minor >= 19) || major >= 24)) { console.error('Unsupported Node.js ' + process.versions.node); process.exit(1) }"
test "$(pnpm --version)" = '11.7.0'
```

Wait for the Xcode installer to finish before continuing when it opens a system dialog. If the Python assertion fails, install Python 3.11 or later through Homebrew or the Python.org macOS installer, open a new terminal, and repeat the assertion before installing LoopX.

### 2. Clone, build, and configure LoopX

```bash
export DSH_REPOSITORY_URL='https://github.com/xifanlaoshu/deepseek-harness.git'
export DSH_INSTALL_ROOT="$HOME/src/deepseek-harness"
test ! -e "$DSH_INSTALL_ROOT" || { echo "Install root already exists: $DSH_INSTALL_ROOT" >&2; exit 1; }
mkdir -p "$(dirname "$DSH_INSTALL_ROOT")"
git clone "$DSH_REPOSITORY_URL" "$DSH_INSTALL_ROOT"
cd "$DSH_INSTALL_ROOT"
pnpm install --frozen-lockfile
pnpm run build
curl -fsSL https://huangruiteng.github.io/loopx/install.sh | bash
export PATH="$HOME/.local/bin:$PATH"
loopx doctor
loopx start-goal --guided --project . --goal-id dsh-graph-mode --host-surface deepseek-harness --goal-text "Coordinate DeepSeek Harness Graph work"
```

Execute the guided command's exact apply and verification commands, register the eight role identities shown in the Windows + WSL section, and use the native LoopX profile row from the Linux section with the absolute path from `command -v loopx`.

### 3. Install Chrome automation and start

Install Google Chrome Stable, then run:

```bash
cd "$DSH_INSTALL_ROOT"
pnpm dsh plugin --profile web add ./packages/bundle/browser-chrome-devtools
pnpm dsh --profile web --dump-config | grep -E 'graph-mode|ui-graph|graph-coordination-loopx|browser-chrome-devtools'
pnpm dsh web --no-open
```

## Configure the first model and workspace

1. Open `http://127.0.0.1:3080/` and go to **Settings → Models**.
2. Add a DeepSeek route or a custom OpenAI-compatible route. Store API keys through the settings form; do not write them into this repository.
3. For a local llama.cpp endpoint, enter its loopback `baseURL`, API protocol, model id, context window, output cap, and supported reasoning levels. The [model configuration guide](./providers.md) owns the field details.
4. Add and select the intended workspace. Graph artifacts and SQLite state use the DSH launch directory's `.sessions` tree unless a deployment patch changes those paths.
5. Start a new session, enter `/graph`, and submit a small read-only repository analysis before attempting code changes or browser tests.

## Verify the installation

With DSH running, use a second terminal.

On Windows PowerShell:

```powershell
$response = Invoke-WebRequest -UseBasicParsing http://127.0.0.1:3080/
if ($response.StatusCode -ne 200) { throw "Unexpected HTTP status $($response.StatusCode)" }
```

On Linux or macOS:

```bash
curl -fsS -o /dev/null http://127.0.0.1:3080/
```

Complete this functional check in the UI:

1. Confirm the Models page shows the configured provider without a missing-credential error.
2. Confirm a normal session can answer a one-line prompt in the selected workspace.
3. Confirm `/graph` opens Graph Mode and its settings show the expected roles and models.
4. Submit “Inspect the repository README and return one factual summary without changing files.”
5. If LoopX is enabled, confirm `loopx status` shows the configured goal and that the Graph node obtains a claim rather than `GRAPH_COORDINATION_CLAIM_FAILED`.
6. If the browser bundle is installed, ask a browser-test node to open a loopback test page and save one screenshot to a workspace-relative `test-evidence/` path.

## Upgrade, back up, and recover

Stop DSH with Ctrl+C before changing the checkout. Back up `$DSH_HOME`, the workspace `.sessions` directory, the workspace `.loopx` directory, and any test-evidence directory that must be retained.

Update only a clean deployment checkout:

```bash
git status --short
git fetch origin
git pull --ff-only
pnpm install --frozen-lockfile
pnpm run build
git rev-parse HEAD
```

On PowerShell, the same Git and pnpm commands apply. If `git status --short` prints anything, stop and preserve or review those changes; do not reset a recipient's files automatically.

To roll back code, check out the previously recorded commit in a separate new directory, run the locked install and build there, stop the current process, and start the previous checkout with the same DSH home. Back up durable state first because this pre-release project may reject data written by a newer schema.

## Troubleshooting

| Symptom | Check | Correction |
|---|---|---|
| `Cannot find module` or missing `lib`/frontend output | Build result and current commit | Run `pnpm install --frozen-lockfile`, then `pnpm run build` in the checkout root |
| Unsupported Node.js or native dependency build failure | `node --version`, compiler tools, pnpm version | Install a supported Node.js release, platform build tools, and pnpm 11.7.0; reinstall without changing the lockfile |
| Port 3080 is busy | Existing DSH or another local service | Stop the old process or run `pnpm dsh web --no-open --port 3081` |
| `GRAPH_COORDINATION_CLAIM_FAILED` on Windows + WSL | `wsl.exe -l -v`, `loopx doctor`, broker path, registry path | Start the selected WSL distribution, correct `<WSL_DISTRO>` and `<LOOPX_BIN_IN_WSL>`, and verify the goal and role registrations |
| LoopX says the goal or agent is absent | Guided goal receipt and `loopx register-agent` result | Complete the guided apply commands and register every enabled Graph worker role before restarting DSH |
| Browser tools are absent | Profile dependency and rendered config | Re-run the source bundle install, rebuild after source changes, and restart the Web profile |
| Chrome opens but screenshots do not reach Qwen | Model input modalities and llama.cpp multimodal projector | Declare `input: [text, image]` for the exact model route and verify the endpoint accepts image content |
| Screenshot path is outside workspace roots | Browser tool path argument | Use a path relative to the calling session workspace; Graph workers publish isolated-copy evidence as artifacts |
| A model rejects reasoning effort | Exact model's advertised reasoning levels | Configure supported levels on that model route or select an advertised level in Graph settings |

## Installation receipt

The installer or AI executor should return this receipt without secrets:

```yaml
platform: windows-wsl | windows | linux | macos
repository: https://github.com/xifanlaoshu/deepseek-harness.git
installRoot: <absolute-path>
dshHome: <absolute-path>
commit: <git-rev-parse-head>
node: <node-version>
pnpm: 11.7.0
webUrl: http://127.0.0.1:3080/
httpCheck: pass | fail
modelCheck: pass | fail
workspaceCheck: pass | fail
graphCheck: pass | fail
loopxCheck: pass | disabled | fail
browserCheck: pass | skipped | fail
notes: <non-secret-corrections-or-empty>
```
