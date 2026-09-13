# 本地安装与部署

[English](local-installation.md) | 中文

本教程从源码安装本仓库，最终得到可用的 Web UI、模型路由、工作区和 Graph Mode。文档面向人工操作者和 AI 执行器编写，各平台命令都有明确归属，不需要猜测应当选择哪一套步骤。

## 执行规则

- 每个代码块只能在其上方标明的 shell 中执行；任一验证命令失败后立即停止。
- 不得删除或覆盖已有检出目录、`$DSH_HOME`、`.sessions` 或 `.loopx` 目录。先备份，或选择新的安装根目录。
- 不得把 API 密钥、密码或生产凭据写入命令、Git 文件、截图或安装回执。
- 浏览器自动化只能使用测试账号和测试数据。除非部署已有明确的信任策略，否则 Web 服务器和 Chrome 调试端点只能监听回环地址。
- 源码检出目录必须位于本地文件系统。如果 DSH 本身在 Linux 中运行，不得从网络共享或挂载进 WSL 的 Windows 路径执行构建。
- 安装完成后记录准确 Git commit。升级通过显式更新源码并重新构建完成；本仓库不提供托管安装器或自动回滚。

## 选择部署布局

| 布局 | DSH 运行时 | LoopX | 浏览器自动化 |
|---|---|---|---|
| Windows + WSL | 原生 Windows | WSL 2 常驻 Broker | 原生 Chrome |
| 纯 Windows | 原生 Windows | 禁用；LoopX 上游未提供原生 Windows 安装器 | 原生 Chrome |
| Linux | 原生 Linux | 原生进程传输 | 已安装的 Google Chrome |
| macOS | 原生 macOS | 原生进程传输 | 已安装的 Google Chrome |

Graph Mode 已包含在 Web profile 中，不启用 LoopX 也可以工作。启用 LoopX 会增加外部 goal、todo、claim、lease 和 settlement 协调；打开 Graph Mode 或运行本地任务图 worker 并不依赖 LoopX。

## 共享参数与验收条件

同一次安装必须始终使用下面这组参数：

| 参数 | 推荐值 | 用途 |
|---|---|---|
| 仓库 URL | `https://github.com/xifanlaoshu/deepseek-harness.git` | 需要克隆的源码发行仓库 |
| 安装根目录 | 一个不含已有构建产物的新本地目录 | 源码、构建与默认工作区根目录 |
| DSH home | `$DSH_HOME`，未设置时为 `~/.dsh` | profile、设置、凭据与会话 |
| Web profile | `web` | base、Web、Graph 与可选 profile 组合包 |
| Web URL | `http://127.0.0.1:3080/` | 默认本地 UI |
| LoopX goal | `dsh-graph-mode` | Graph 节点使用的外部协调 goal |

完整安装必须通过下面全部检查：

1. Node.js 是 22.x 版本线中的 `22.19.0` 或更高版本，或者受支持的 24.x 及更高版本；不支持 Node.js 23.x。
2. `pnpm --version` 输出 `11.7.0`，`pnpm install --frozen-lockfile` 与 `pnpm run build` 均成功。
3. `pnpm dsh --profile web --dump-config` 成功，并列出 `graph-mode` 与 `ui-graph`。
4. Web URL 返回 HTTP 200，UI 能保存模型提供方并选择工作区。
5. 新会话接受 `/graph`，显示 Graph 界面，并能运行一个最小只读任务。

## Windows + WSL

该布局让 DSH 与 Chrome 在 Windows 原生运行，由 Provider 持有的一个长生命周期 Broker 在 WSL 2 中调用 LoopX，避免每次协调操作都重新创建 WSL 进程。

### 1. 安装 Windows 前置软件

在 PowerShell 中执行；如果 `winget` 要求提权，请使用管理员 PowerShell：

```powershell
winget install --id Git.Git -e
winget install --id OpenJS.NodeJS.LTS -e
winget install --id Microsoft.PowerShell -e
```

关闭并重新打开 PowerShell，再安装仓库固定的 pnpm 版本并验证工具链：

```powershell
npm install --global pnpm@11.7.0
git --version
node --version
pnpm --version
node -e "const [major, minor] = process.versions.node.split('.').map(Number); if (!((major === 22 && minor >= 19) || major >= 24)) { console.error('Unsupported Node.js ' + process.versions.node); process.exit(1) }"
if ((pnpm --version).Trim() -ne '11.7.0') { throw 'pnpm 11.7.0 is required' }
```

### 2. 安装 WSL 2 与 LoopX

在 PowerShell 中执行；如果命令要求重启 Windows，请先完成重启：

```powershell
wsl.exe --install -d Ubuntu
wsl.exe --set-default-version 2
wsl.exe -l -v
```

打开 Ubuntu shell，安装 LoopX 文档规定的前置软件与发行版：

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

记录 `command -v loopx` 输出的准确路径；profile patch 会把它作为 `<LOOPX_BIN_IN_WSL>` 使用。

### 3. 克隆并构建 DSH

在 PowerShell 中执行。选择一个新的安装根目录；保护检查会刻意拒绝复用已有路径。

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

### 4. 初始化 LoopX goal 与角色身份

打开 Ubuntu shell，通过对应的 `/mnt/<drive>/...` 路径进入同一个检出目录，然后执行：

```bash
cd /mnt/c/dsh/deepseek-harness
export PATH="$HOME/.local/bin:$PATH"
loopx start-goal --guided --project . --goal-id dsh-graph-mode --host-surface deepseek-harness --goal-text "Coordinate DeepSeek Harness Graph work"
```

`start-goal --guided` 只生成预览。按顺序执行它输出的准确 apply 与验证命令，只有结果确认 goal 已写入并完成同步后才能继续。然后以幂等方式注册 worker 身份：

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

### 5. 启用 WSL 常驻 Provider

如果 `$DSH_HOME/profiles/web` 不存在，先运行一次 `pnpm dsh web --no-open`，再按 Ctrl+C 停止。编辑 `$DSH_HOME/profiles/web/cordis.patch.yml`，保留无关配置项，只新增或替换下面这一项，并代入真实的 WSL 发行版与 LoopX 可执行文件路径：

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

`<WINDOWS_INSTALL_ROOT>` 必须使用绝对 Windows 路径；`pathStyle: wsl` 会在 Broker 调用 LoopX 前完成转换。必须从检出目录根部启动 DSH，才能让其余相对 Graph 存储路径解析到本次安装。在启动服务器前检查渲染后的配置项：

```powershell
Set-Location -LiteralPath $env:DSH_INSTALL_ROOT
pnpm dsh --profile web --dump-config | Select-String -Pattern 'graph-coordination-loopx|transport: persistent|pathStyle: wsl'
```

### 6. 安装浏览器自动化并启动

安装 Google Chrome Stable，再把源码组合包安装进 Web profile 并启动 DSH：

```powershell
winget install --id Google.Chrome -e
Set-Location -LiteralPath $env:DSH_INSTALL_ROOT
pnpm dsh plugin --profile web add ./packages/bundle/browser-chrome-devtools
pnpm dsh web --no-open
```

保持该终端运行。受管理浏览器只会在 agent 第一次调用浏览器工具时启动，并在组合包被释放时关闭。

## 纯 Windows

纯 Windows 支持 DSH、Web UI、Graph Mode、本地 worker、SQLite 调度和资源控制，以及受管理的 Chrome 自动化。LoopX 上游安装器要求 macOS 或 Linux shell，因此纯 Windows 部署会保持 `graph-coordination-loopx` 禁用。不得安装未经验证的同名 Windows 包，也不得把 Provider 指向兼容性包装程序。

### 1. 安装、克隆与构建

在 PowerShell 中执行：

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

### 2. 安装浏览器组合包并启动

```powershell
Set-Location -LiteralPath $env:DSH_INSTALL_ROOT
pnpm dsh plugin --profile web add ./packages/bundle/browser-chrome-devtools
pnpm dsh --profile web --dump-config | Select-String -Pattern 'graph-mode|ui-graph|browser-chrome-devtools'
pnpm dsh web --no-open
```

如果后续需要 LoopX 协调，请停止 DSH 并迁移到 Windows + WSL 布局；已有 DSH home 与源码检出目录可以继续使用。

## Windows 后台服务

两种 Windows 布局都可以把 DSH 作为当前用户的后台服务运行。安装程序使用任务计划程序和当前用户的交互式令牌，而不是 Windows 服务控制管理器：SCM 服务使用非交互式 Session 0，无法可靠使用 WSL 发行版、用户的 DSH home 和可视化 Chrome 自动化。

先停止所有手动启动的 DSH 进程，在仓库根目录打开 PowerShell，然后安装服务：

```powershell
pwsh -NoProfile -File .\scripts\windows\dsh-service.ps1 install
```

任务会立即启动，并在每次登录后启动。监督进程会在 DSH 子进程意外退出五秒后重新启动它；如果监督进程退出，任务计划程序也会将其重启。该服务默认为 Node 配置 8,192 MB V8 old-space 上限。如果机器具有足够物理内存，且异常大的冷会话需要更多内存，可在 `install` 时传入 `-MaxOldSpaceSizeMB 12288`；该设置限制 JavaScript 堆而非进程总内存，更改后需要执行 `install -Force`。所选端口已被其他进程监听时，安装会失败。使用下面的命令检查任务、准确 PID、状态路径、已配置 old-space 上限和 HTTP 健康状态：

```powershell
pwsh -NoProfile -File .\scripts\windows\dsh-service.ps1 status
```

使用同一个管理脚本执行生命周期操作：

```powershell
pwsh -NoProfile -File .\scripts\windows\dsh-service.ps1 restart
pwsh -NoProfile -File .\scripts\windows\dsh-service.ps1 stop
pwsh -NoProfile -File .\scripts\windows\dsh-service.ps1 start
pwsh -NoProfile -File .\scripts\windows\dsh-service.ps1 uninstall
```

默认任务名是 `DeepSeekHarnessWeb`；运行时状态以及轮转后的 stdout/stderr 日志位于 `%LOCALAPPDATA%\DeepSeekHarness\Service`。`uninstall` 会保留这些诊断文件。健康探针接受已认证的根响应或 DSH 精确的未认证浏览器挑战，因此 `status` 和 `restart` 不需要把启动令牌复制给服务管理器。任务会记录安装时提供的仓库、DSH home、Node 可执行文件和端口，因此移动或更新检出目录前必须停止服务；Node.js 或这些路径变化后，使用 `install -Force` 重新安装。该服务只在对应用户已登录时运行；不需要 WSL 或可视化 Chrome 的非交互式服务器部署需要单独的 SCM 包装程序和服务专用 DSH home。

## Linux

下面的命令面向 Ubuntu 或 Debian。在 Fedora 或 RHEL 上，请先使用 `dnf` 安装等价的 `git`、`curl`、`tar`、`python3`、C/C++ 编译器和 `make` 包。

### 1. 安装前置软件与 Node.js

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

### 2. 克隆与构建

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

### 3. 安装并初始化 LoopX

```bash
curl -fsSL https://huangruiteng.github.io/loopx/install.sh | bash
export PATH="$HOME/.local/bin:$PATH"
loopx doctor
loopx start-goal --guided --project . --goal-id dsh-graph-mode --host-surface deepseek-harness --goal-text "Coordinate DeepSeek Harness Graph work"
```

先执行 guided 命令输出的准确 apply 与验证命令，再注册 Windows + WSL 章节所列的同一组八个角色身份。把 `command -v loopx` 的结果记录为 `<LOOPX_BIN>`。

### 4. 启用原生 LoopX 并启动

先初始化一次 Web profile 并停止进程，再把下面的配置项加入 `$DSH_HOME/profiles/web/cordis.patch.yml`。从 Windows + WSL 配置项复制完整的 `roleAgents` 映射。

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

通过发行版支持的软件源安装 Google Chrome Stable，然后执行：

```bash
cd "$DSH_INSTALL_ROOT"
pnpm dsh plugin --profile web add ./packages/bundle/browser-chrome-devtools
pnpm dsh --profile web --dump-config | grep -E 'graph-mode|ui-graph|graph-coordination-loopx|browser-chrome-devtools'
pnpm dsh web --no-open
```

## macOS

### 1. 安装前置软件与 Node.js

如果尚未安装 Xcode 命令行工具，先安装它，再通过 Volta 安装 Node.js 与 pnpm：

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

如果命令打开了系统安装对话框，请等待 Xcode 安装完成后再继续。如果 Python 断言失败，请通过 Homebrew 或 Python.org macOS 安装器安装 Python 3.11 或更高版本，打开新终端并重新通过断言，再安装 LoopX。

### 2. 克隆、构建并配置 LoopX

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

执行 guided 命令输出的准确 apply 与验证命令，注册 Windows + WSL 章节所列的八个角色身份，并使用 Linux 章节的原生 LoopX profile 配置项，把 `command -v loopx` 返回的绝对路径写入配置。

### 3. 安装 Chrome 自动化并启动

安装 Google Chrome Stable，然后执行：

```bash
cd "$DSH_INSTALL_ROOT"
pnpm dsh plugin --profile web add ./packages/bundle/browser-chrome-devtools
pnpm dsh --profile web --dump-config | grep -E 'graph-mode|ui-graph|graph-coordination-loopx|browser-chrome-devtools'
pnpm dsh web --no-open
```

## 配置第一个模型与工作区

1. 打开 `http://127.0.0.1:3080/`，进入**设置 → 模型**。
2. 添加 DeepSeek 路由或自定义 OpenAI 兼容路由。通过设置表单保存 API 密钥，不得把密钥写入本仓库。
3. 对于本地 llama.cpp 端点，填写其回环 `baseURL`、API 协议、模型 ID、上下文窗口、输出上限和支持的推理档位。字段详情以[模型配置指南](./providers.zh.md)为准。
4. 添加并选择目标工作区。除非部署 patch 修改了路径，否则 Graph artifact 与 SQLite 状态使用 DSH 启动目录下的 `.sessions` 目录树。
5. 新建会话，输入 `/graph`，先提交一个小型只读仓库分析，再尝试代码修改或浏览器测试。

## 验证安装

保持 DSH 运行，并打开第二个终端。

Windows PowerShell：

```powershell
$response = Invoke-WebRequest -UseBasicParsing http://127.0.0.1:3080/
if ($response.StatusCode -ne 200) { throw "Unexpected HTTP status $($response.StatusCode)" }
```

Linux 或 macOS：

```bash
curl -fsS -o /dev/null http://127.0.0.1:3080/
```

在 UI 中完成下面的功能检查：

1. 确认模型页面显示已配置的提供方，且没有凭据缺失错误。
2. 确认普通会话能在所选工作区回答一条单行提示词。
3. 确认 `/graph` 能打开 Graph Mode，设置中显示预期角色与模型。
4. 提交“Inspect the repository README and return one factual summary without changing files.”。
5. 如果启用了 LoopX，确认 `loopx status` 显示所配置的 goal，且 Graph 节点能取得 claim，而不是出现 `GRAPH_COORDINATION_CLAIM_FAILED`。
6. 如果安装了浏览器组合包，让 browser-test 节点打开一个回环测试页面，并把一张截图保存到相对工作区的 `test-evidence/` 路径。

## 升级、备份与恢复

修改检出目录前，先按 Ctrl+C 停止 DSH。备份 `$DSH_HOME`、工作区 `.sessions` 目录、工作区 `.loopx` 目录，以及所有必须保留的测试证据目录。

只能更新干净的部署检出目录：

```bash
git status --short
git fetch origin
git pull --ff-only
pnpm install --frozen-lockfile
pnpm run build
git rev-parse HEAD
```

PowerShell 使用相同的 Git 与 pnpm 命令。如果 `git status --short` 输出任何内容，立即停止并保留或审查这些变更；不得自动重置接收方的文件。

如需回滚代码，请在一个新的独立目录检出先前记录的 commit，执行锁定依赖安装与构建，停止当前进程，再让旧检出目录使用同一个 DSH home 启动。操作前必须备份持久状态，因为该预发布项目可能拒绝读取由更新 schema 写入的数据。

## 故障排查

| 现象 | 检查项 | 修正方式 |
|---|---|---|
| `Cannot find module` 或缺少 `lib`／前端输出 | 构建结果与当前 commit | 在检出目录根部执行 `pnpm install --frozen-lockfile`，再执行 `pnpm run build` |
| Node.js 不受支持或原生依赖构建失败 | `node --version`、编译工具、pnpm 版本 | 安装受支持的 Node.js、平台构建工具与 pnpm 11.7.0，在不修改 lockfile 的前提下重新安装 |
| 3080 端口被占用 | 已有 DSH 或其他本地服务 | 停止旧进程，或运行 `pnpm dsh web --no-open --port 3081` |
| Windows + WSL 出现 `GRAPH_COORDINATION_CLAIM_FAILED` | `wsl.exe -l -v`、`loopx doctor`、Broker 路径、registry 路径 | 启动所选 WSL 发行版，修正 `<WSL_DISTRO>` 与 `<LOOPX_BIN_IN_WSL>`，再验证 goal 与角色注册 |
| LoopX 提示 goal 或 agent 不存在 | guided goal 回执与 `loopx register-agent` 结果 | 完成 guided apply 命令，并在重启 DSH 前注册所有已启用的 Graph worker 角色 |
| 浏览器工具不存在 | profile 依赖与渲染配置 | 重新执行源码组合包安装；源码变化后重新构建并重启 Web profile |
| Chrome 已打开，但截图没有送入 Qwen | 模型输入模态与 llama.cpp 多模态 projector | 为准确模型路由声明 `input: [text, image]`，并验证端点接受图片内容 |
| 截图路径位于工作区根目录之外 | 浏览器工具的路径参数 | 使用相对于调用会话工作区的路径；Graph worker 会把隔离副本中的证据作为 artifact 发布 |
| 模型拒绝推理强度 | 准确模型声明的推理档位 | 在该模型路由上配置受支持档位，或在 Graph 设置中选择已声明档位 |

## 安装回执

安装程序或 AI 执行器必须返回下面的回执，其中不得包含机密信息：

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
