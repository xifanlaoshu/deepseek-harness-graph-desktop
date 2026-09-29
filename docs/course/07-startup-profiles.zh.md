# 第 07 章：启动、Profile 与配置叠加

[English](07-startup-profiles.md) | 中文

在现代软件工程中，任何复杂的企业级框架（如 Spring Boot、Kubernetes Kubelet 或 VS Code）都需要一套兼顾**冷启动性能、多租户配置隔离、动态扩展与热更新**的引导架构。而在构建以大语言模型（LLM）为驱动核心的 Agent Harness 系统时，该挑战尤为严峻：系统不仅需要像操作系统微内核一样在数十毫秒内完成服务图依赖注入（DI），还必须支持来自官方预设（Bundles）、个人偏好（Profiles）、全局环境（Home/Env）以及命令行即时参数（CLI Overlays）的任意层叠组合，同时防止类型破坏、内存对象污染与终端状态损坏。

本章将深入 DeepSeek Harness 的引导内核，以系统编程的视角剖析 CLI 启动入口 `apps/cli/src/bin.ts` 的参数解析分发、双锚点 ESM 模块链接、四层配置叠加半格代数、Schemastery 加载期强校验引擎，以及通过 `dump-config` 逆向诊断完整运行时依赖树的底层机制。

---

## 7.1 系统心智模型：微内核引导与配置层叠

将 AI Harness 的启动体系与传统系统软件进行概念映射，可以清晰地建立以下工程直觉：

*   **CLI 引导器 (`dsh/bin.ts`) $\to$ 微内核加载器（Microkernel Bootloader / Dynamic Linker）**：只负责解析最外层启动模式与内核参数，利用动态 ESM `import()` 实现子系统的零开销按需加载，其余参数全部原样透传。
*   **Bundle（预设包） $\to$ 操作系统发行版基线镜像（Base OS Image / Distribution Layer）**：由 npm 声明的不可变基础插件切片，定义了特定应用场景（如 `web` 或 `headless`）的标准功能插件集合。
*   **Profile（运行配置） $\to$ 用户态环境实例（User Environment Overlay）**：位于 `$DSH_HOME/profiles/<name>` 的独立工作空间，包含专有的 `package.json`（外挂插件依赖）与 `cordis.patch.yml`。
*   **四层配置叠加 $\to$ 联合文件系统（UnionFS / OverlayFS）**：底层 Bundle 只读，上层 Profile 与 Home 补丁层层向上覆盖，最顶层 CLI 参数具备最高覆写优先级。
*   **Schemastery 校验 $\to$ 静态类型反射与加载期前置断言（Static Reflection & Fail-Fast Assertion）**：在插件挂载（Mount）与 Fiber 激活（Activation）阶段进行强类型拦截，杜绝脏配置污染运行时。
*   **Fail-Loud 机制 $\to$ 崩溃捕获与 TTY 终端恢复看门狗（Watchdog & Terminal Teardown）**：确保当任何异步插件在挂载期抛出异常时，能够原子级复位终端的 Raw Mode 与 Bracketed Paste 状态，防止 shell 终端挂死。

```
+---------------------------------------------------------------------------------------------------------+
|                                    dsh CLI Ingestion (apps/cli/src/bin.ts)                              |
|   1. loadLayeredEnv() [process.env > local .env > ~/.dsh/.env (Bootstrap Security Filter)]              |
|   2. parseDshArgs()   [Commander Pass-Through: Extracts --profile, --patch, --dump-config]              |
+---------------------------------------------------------------------------------------------------------+
                                                     |
                                                     v Dynamic ESM Import (Mode Dispatch)
+---------------------------------------------------------------------------------------------------------+
|                                  Mode: 'dump-config'               Mode: 'plugin'                       |
|                                (apps/cli/src/dump-config.ts)     (apps/cli/src/plugin.ts)               |
+---------------------------------------------------------------------------------------------------------+
                                                     |
                                                     v Mode: 'profile' (apps/cli/src/profile-boot.ts)
+---------------------------------------------------------------------------------------------------------+
|                                 Profile Preparation & Linker Healing                                    |
|   1. healProfilesModuleFallback() -> Builds Symlink Closure in $DSH_HOME/profiles/node_modules         |
|   2. loadProfile()                -> Two-Anchor Resolution for Bundles (Install Anchor -> Local)        |
+---------------------------------------------------------------------------------------------------------+
                                                     |
                                                     v 4-Layer Semilattice Overlay (applyEntryPatches)
+---------------------------------------------------------------------------------------------------------+
|   [Layer 1: Bundles]   dsh.profile.bundles in sequence (@deepseek-ai/dsh-base, dsh-web-app, ...)       |
|          +                                                                                              |
|   [Layer 2: Profile]   $DSH_HOME/profiles/<name>/cordis.patch.yml                                       |
|          +                                                                                              |
|   [Layer 3: Home]      $DSH_HOME/cordis.patch.yml (Machine-local overrides)                             |
|          +                                                                                              |
|   [Layer 4: CLI/Over]  --patch <path> + Telemetry Opt-out + Agent-Presets Root                          |
+---------------------------------------------------------------------------------------------------------+
                                                     |
                                                     v Cordis Boot Pipeline (packages/boot/app-boot)
+---------------------------------------------------------------------------------------------------------+
|   1. new Context() -> provide(DSH_LAUNCH_ENVIRONMENT_KEY) -> provideCmdline(ctx)                        |
|   2. ctx.plugin(Loader) -> mountRootInclude(cordis:include, root empty YAML)                            |
|   3. Schemastery Load-time Validation (Fail-Fast against Config Schema)                                 |
|   4. assertEntriesActivated(ctx) -> Fiber State Machine Audit (ACTIVE / PENDING / FAILED)               |
|   5. watchUserPatches() -> HMR Watchers on Layer 2 & Layer 3 for Live Hot-Reload                        |
+---------------------------------------------------------------------------------------------------------+
```

---

## 7.2 CLI 启动入口与动态 ESM Import 机制

### 7.2.1 启动入口 `apps/cli/src/bin.ts` 的极简分发设计

在高性能 CLI 设计中，冷启动延迟（Cold-start Latency）是核心指标。若在入口处静态导入整个系统（包括 Web 服务器、数据库驱动、ACP 协议栈、TUI 渲染引擎等），V8 引擎需要解析并编译数百个模块文件，启动耗时将从 40ms 激增至 800ms 以上。

`apps/cli/src/bin.ts` 采用了**微内核动态加载（Microkernel Dynamic Loading）**架构，仅引入参数解析器与环境加载器，通过动态 `import()` 实现启动路径的零冗余加载：

```typescript
#!/usr/bin/env node
/**
 * dsh CLI 启动入口
 * @module @deepseek-ai/dsh/bin
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot'
import { parseDshArgs } from './args.ts'

function readVersion(): string {
  const manifest = JSON.parse(
    readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
  ) as { version?: unknown }
  return typeof manifest.version === 'string' ? manifest.version : '0.0.0'
}

// 1. 同步完成参数解析（不合法参数或 --help/--version 会直接在 parseDshArgs 内部退出）
const invocation = parseDshArgs(process.argv.slice(2), readVersion())

// 2. 依据判别联合（Discriminated Union）进行模式分发，完全按需动态加载模块
switch (invocation.mode) {
  case 'profile': {
    const { runProfile } = await import('./profile-boot.ts')
    await runProfile({
      environment: loadLayeredEnv('dsh'),
      profile: invocation.profile,
      patchFiles: invocation.patches,
      args: invocation.args,
    })
    break
  }
  case 'plugin': {
    const { runPlugin } = await import('./plugin.ts')
    process.exit(runPlugin(invocation.profile, invocation.args))
    break
  }
  case 'dump-config': {
    const { runDumpConfig } = await import('./dump-config.ts')
    runDumpConfig(invocation.profile, invocation.defaultOnly, invocation.patches)
    break
  }
  default: {
    // 静态排他性检查：利用 TypeScript satisfies never 确保模式全覆盖
    invocation satisfies never
    throw new Error(`dsh: unhandled invocation mode ${JSON.stringify(invocation)}`)
  }
}
```

### 7.2.2 Commander 适配器与参数透传边界（Pass-Through Options）

传统 CLI 框架常犯的一个错误是试图在最外层解析所有子模块的命令行标志，这会导致启动器与具体插件（如 Web 服务的 `--port`、TUI 的 `--theme`、Agent 的 `--resume`）强耦合。

DeepSeek Harness 在 `apps/cli/src/args.ts` 中确立了严格的**参数边界原则**：

1.  **启动器专属参数（Launcher-Owned Flags）**：`--profile <name>`、`--patch <path>`、`--dump-config`、`--dump-default-config` 以及子命令 `web`、`plugin`。
2.  **树内应用参数（Verbatim Inner Arguments）**：在遇到第一个启动器不认识的标记时，停止解析，将后续所有 `argv` 令牌原封不动地打包为 `args: string[]`。
3.  **帮助信息分权（Help Ownership）**：`dsh -h`（未指定 profile）输出启动器自身的帮助信息；而 `dsh --profile web --help` 或 `dsh web --help` 则将 `--help` 作为 inner argument 透传给 `web` 插件树，由 Web 应用输出自身的端口、路由等参数帮助。

```typescript
// apps/cli/src/args.ts 核心配置
program
  .name('dsh')
  .version(version, '-V, --version', 'output the version number')
  .helpOption(false)               // 禁用 Commander 默认的全局 -h/--help 拦截
  .allowUnknownOption()            // 遇到未知参数不抛出异常，停止外层消费
  .passThroughOptions()            // 开启透传模式
  .enablePositionalOptions()       // 开启位置参数敏感解析
  .argument('[args...]', 'arguments for the booted profile\'s app')
  .option('--profile <name>', 'the profile under $DSH_HOME/profiles to boot')
  .option('--patch <path>', 'extra patch-list overlay applied after the profile layer', collect)
  .option('--dump-config', 'print the composed profile tree and exit')
  .option('--dump-default-config', 'print the profile tree without its user layer and exit')
```

### 7.2.3 环境变量三层继承与 Bootstrap-Only 注入防护

环境变量是外部控制系统行为的直接通道。DeepSeek Harness 在 `loadLayeredEnv` 中实现了确定性的三层继承快照：

$$\text{FinalEnv} = \text{ProcessEnv} \leftarrow \text{ProjectEnv (./.env)} \leftarrow \text{UserEnv (~/.dsh/.env)}$$

其继承优先级为：**当前操作系统进程环境（Process Env） > 当前工作目录（Project `.env`） > 全局主目录（`~/.dsh/.env`）**。

#### 安全防御：`isBootstrapOnly` 黑名单过滤

如果允许任意 `.env` 文件覆盖诸如 `PATH`、`LD_PRELOAD` 或 `NODE_OPTIONS`，攻击者可以通过在项目仓库中投放恶意的 `.env` 文件，在开发者执行 `dsh` 时实现任意代码执行（RCE）或篡改 Node.js 运行时。

因此，`loadLayeredEnv` 在加载 `.env` 时执行了严格的**引导安全断言**：

```typescript
const BOOTSTRAP_NAMES = new Set([
  'PATH', 'HOME', 'USERPROFILE', 'SHELL',
  'NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS',
  'LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT',
  'BASH_ENV', 'ENV', 'SHELLOPTS', 'BASHOPTS',
  'PYTHONSTARTUP', 'PYTHONPATH', 'RUBYOPT', 'JAVA_TOOL_OPTIONS',
  'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_CONFIG_GLOBAL',
  'EDITOR', 'VISUAL', 'PAGER', 'BROWSER',
  'DEEPSEEK_BASE_URL', 'DEEPSEEK_SEARCH_BASE_URL',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'NODE_TLS_REJECT_UNAUTHORIZED',
])

const BOOTSTRAP_PREFIXES = ['DSH_', 'XDG_', 'DYLD_', 'BASH_FUNC_']

function isBootstrapOnly(name: string): boolean {
  const upper = name.toUpperCase()
  return BOOTSTRAP_NAMES.has(upper) || BOOTSTRAP_PREFIXES.some(prefix => upper.startsWith(prefix))
}
```

任何在 `.env` 文件中试图定义上述变量的操作都会触发加载期立即崩溃（Fail-Fast），提示用户必须通过操作系统的 `export` 显式设置。

### 7.2.4 进程生命周期与 TTY 终端保护看门狗 (`installFailLoud`)

在命令行界面开发中，最棘手的故障之一是：**当一个异步插件挂载失败并抛出 Unhandled Rejection 时，终端停留在 Raw 模式（禁用回显、启用 Bracketed Paste、启用专用键盘协议），导致开发者的 shell 彻底乱码并挂死**。

DeepSeek Harness 通过 `installFailLoud` 实现了带超时的终端复位看门狗：

```
+---------------------------------------------------------------------------------------------+
|                                    installFailLoud Lifecycle                                |
|                                                                                             |
|   [Unhandled Rejection] ---> Latched Guard (Prevent duplicate / cascade teardown rejections)|
|                                    |                                                        |
|                                    v Synchronous Stderr Logging                             |
|                              proc.stderr.write(`${binName}: fatal load failure...`)         |
|                                    |                                                        |
|                                    v Bounded Teardown Race                                  |
|                 +--------------------------------------+---------------------+              |
|                 | Promise.race                         |                     |              |
|                 | 1. release() (ctx.fiber.dispose())   | 2. Timeout (2000ms) |              |
|                 |    Restores TTY Raw Mode & Paste     |    Forces Exit      |              |
|                 +--------------------------------------+---------------------+              |
|                                    |                                                        |
|                                    v Guaranteed Termination                                 |
|                                proc.exit(1)                                                 |
+---------------------------------------------------------------------------------------------+
```

```typescript
export const FAIL_LOUD_RELEASE_TIMEOUT_MS = 2_000

export function installFailLoud(
  binName: string,
  proc: FailLoudProcess = process,
  release?: () => Promise<void> | void,
): () => void {
  let exiting = false

  const handler = (err: unknown): void => {
    // 忽略已由 assertEntriesActivated 明确审计并捕获的错误
    if (assembledActivationRejections.has(err)) return
    if (exiting) return
    exiting = true

    // 1. 同步打印错误堆栈，确保即使后续清理卡死，错误日志也不丢失
    proc.stderr.write(`${binName}: fatal load failure: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`)

    if (release === undefined) {
      proc.exit(1)
      return
    }

    // 2. 在有界超时内等待 release() 释放 TTY 资源
    void (async () => {
      let timer!: ReturnType<typeof setTimeout>
      try {
        await Promise.race([
          (async () => release())(),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, FAIL_LOUD_RELEASE_TIMEOUT_MS)
          }),
        ])
      } catch {
        // 清理过程中的次生异常直接吞掉，优先保障退出码与错误主因
      }
      clearTimeout(timer)
      proc.exit(1)
    })()
  }

  proc.on('unhandledRejection', handler)
  return () => proc.off('unhandledRejection', handler)
}
```

---

## 7.3 Profile 与 Bundle 的系统解耦模型

在深入配置叠加之前，必须严格区分 **Bundle** 与 **Profile** 的本质区别：

| 维度 | Bundle（预设包） | Profile（运行环境） |
| :--- | :--- | :--- |
| **物理形式** | 发布的 npm 包（如 `@deepseek-ai/dsh-base`） | 磁盘物理目录（`$DSH_HOME/profiles/<name>`） |
| **归属权** | 框架代码或第三方扩展分发，**只读且不可变** | 终端用户或开发人员本地所有，**完全可读写** |
| **Manifest 声明** | `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` | `"dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", ...] } }` |
| **模块依赖** | 声明在自身的 `package.json` 的 `dependencies` | 声明在 Profile 目录下的 `package.json`（树外插件） |
| **补丁性质** | 提供功能模块的标准拓扑与初始配置 | 对 Bundle 拓扑进行个性化裁决与覆盖 |

```
$DSH_HOME (Default: ~/.dsh)
├── cordis.patch.yml               <-- Layer 3: Machine-wide Home Patch
├── .env                           <-- User-level Environment File
└── profiles/
    ├── node_modules/              <-- Flat Symlink Closure (Maintained by healProfilesModuleFallback)
    │   ├── @deepseek-ai/cordis -> /usr/local/lib/node_modules/@deepseek-ai/cordis
    │   ├── @deepseek-ai/dsh-base -> /usr/local/lib/node_modules/@deepseek-ai/dsh-base
    │   └── @deepseek-ai/dsh-web-app -> /usr/local/lib/node_modules/@deepseek-ai/dsh-web-app
    ├── web/                       <-- Profile: "web"
    │   ├── cordis.yml             <-- Profile Root (Empty array `[]`, anchor for Loader)
    │   ├── cordis.patch.yml       <-- Layer 2: Profile User Patch
    │   ├── package.json           <-- Profile Manifest (declares dsh.profile.bundles)
    │   ├── pnpm-workspace.yaml    <-- Hoisted workspace config for out-of-tree plugins
    │   └── node_modules/          <-- Out-of-tree plugins installed by `dsh plugin add`
    └── headless/                  <-- Profile: "headless"
        ├── cordis.yml
        ├── cordis.patch.yml
        └── package.json
```

### 7.3.1 双锚点模块解析机制（Two-Anchor Resolution）

当 Profile 中的 `package.json` 声明了 `dsh.profile.bundles: ["@deepseek-ai/dsh-base"]` 时，系统如何找到该 Bundle 的代码和补丁文件？

DeepSeek Harness 采用了**双锚点搜索算法（Two-Anchor Resolution）**：
1.  **Anchor 1（安装目录锚点 - Installation Anchor）**：优先从 `dsh` CLI 自身的安装根目录（`apps/cli/package.json`）开始向上查找。这确保了内置 Bundle 始终与运行中的 `dsh` 二进制保持完全一致的版本，绝不被本地残留污染。
2.  **Anchor 2（Profile 目录锚点 - Profile Anchor）**：若在安装目录找不到（例如用户安装的第三方社区 Bundle），则从 `$DSH_HOME/profiles/<name>/package.json` 展开查找。

```typescript
export function resolveBundleDir(
  binName: string,
  packageName: string,
  installAnchor: string,
  profileDir: string,
): string {
  for (const anchor of [installAnchor, join(profileDir, 'package.json')]) {
    const dir = packageDirFromAnchor(anchor, packageName)
    if (dir !== undefined) return dir
  }
  throw new Error(
    `${binName}: cannot resolve profile bundle ${JSON.stringify(packageName)} from the dsh installation or ${profileDir}; `
    + `run 'dsh plugin --profile ${basename(profileDir)} install' if its dependency is not installed`,
  )
}

function packageDirFromAnchor(anchor: string, packageName: string): string | undefined {
  // 利用 createRequire 解析搜索路径，无需目标包显式 export "./package.json"
  for (const searchPath of createRequire(anchor).resolve.paths(packageName) ?? []) {
    const candidate = join(searchPath, packageName)
    if (existsSync(join(candidate, 'package.json'))) return candidate
  }
  return undefined
}
```

### 7.3.2 扁平模块回退目录自愈算法（Symlink Closure Healing）

对于树外插件（Out-of-tree plugins，即用户通过 `dsh plugin --profile web add <pkg>` 自行安装的插件），它们通常将核心包（如 `@deepseek-ai/cordis`、`@deepseek-ai/dsh-agent`）声明为 `peerDependencies`。

为了让 Node.js 原生的模块解析链能够顺利找到这些 Peer 依赖，且不强制用户重复安装数百兆的内置运行时包，DeepSeek Harness 在 `$DSH_HOME/profiles/node_modules` 维护了一个**自愈符号链接闭包（Self-healing Symlink Closure）**。

其自愈算法基于**广度优先搜索（BFS）**遍历 CLI 安装依赖图的传递闭包：

```typescript
export function healProfilesModuleFallback(installAnchor: string, home: string = resolveDshHome()): void {
  const profilesDir = join(home, PROFILES_DIR)
  const modulesDir = join(profilesDir, 'node_modules')
  mkdirSync(modulesDir, { recursive: true })

  const appManifest = JSON.parse(readFileSync(installAnchor, 'utf8')) as ProfileManifest
  const links = new Map<string, string>()
  if (appManifest.name !== undefined) links.set(appManifest.name, dirname(installAnchor))

  // BFS 遍历依赖图闭包，Nearest-wins 规则
  const queue: { anchor: string; manifest: ProfileManifest }[] = [
    { anchor: installAnchor, manifest: appManifest },
  ]

  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    const allDeps = [
      ...Object.keys(next.manifest.dependencies ?? {}),
      ...Object.keys(next.manifest.peerDependencies ?? {}),
    ]
    for (const dep of allDeps) {
      if (links.has(dep)) continue
      const dir = packageDirFromAnchor(next.anchor, dep)
      if (dir === undefined) continue
      links.set(dep, dir)
      const manifestPath = join(dir, 'package.json')
      queue.push({
        anchor: manifestPath,
        manifest: JSON.parse(readFileSync(manifestPath, 'utf8')) as ProfileManifest,
      })
    }
  }

  // 跨平台原子符号链接维护（Windows 使用 junction，POSIX 使用 symlink）
  for (const [packageName, target] of links) {
    const link = join(modulesDir, packageName)
    mkdirSync(dirname(link), { recursive: true })
    ensureSymlink(link, target)
  }
}
```

---

## 7.4 四层配置叠加链（The 4-Layer Configuration Overlay Chain）

配置叠加是 DeepSeek Harness 组装运行时插件树的核心算法。所有配置最终都会收敛为一个 Cordis Entry 列表。

```
+---------------------------------------------------------------------------------------------------------+
|                                    4-Layer Configuration Overlay Pipeline                               |
|                                                                                                         |
|   +-------------------------------------------------------------------------------------------------+   |
|   | Layer 1: Bundle Base Layers (in dsh.profile.bundles sequence)                                   |   |
|   | e.g. @deepseek-ai/dsh-base -> @deepseek-ai/dsh-web-app                                          |   |
|   | Defines baseline plugins: session-sqlite, llm-openai, tool-fs, web-host                         |   |
|   +-------------------------------------------------------------------------------------------------+   |
|                                                    |                                                    |
|                                                    v applyEntryPatches                                  |
|   +-------------------------------------------------------------------------------------------------+   |
|   | Layer 2: Profile User Patch ($DSH_HOME/profiles/<name>/cordis.patch.yml)                        |   |
|   | e.g. Custom LLM temperature, custom prompt sections, enabled tools                              |   |
|   +-------------------------------------------------------------------------------------------------+   |
|                                                    |                                                    |
|                                                    v applyEntryPatches                                  |
|   +-------------------------------------------------------------------------------------------------+   |
|   | Layer 3: Machine-wide Home Patch ($DSH_HOME/cordis.patch.yml)                                   |   |
|   | e.g. Global proxy settings, enterprise telemetry endpoint, hardware sandbox caps                |   |
|   +-------------------------------------------------------------------------------------------------+   |
|                                                    |                                                    |
|                                                    v applyEntryPatches                                  |
|   +-------------------------------------------------------------------------------------------------+   |
|   | Layer 4: CLI Flags & Ephemeral Overlays (--patch <path>)                                        |   |
|   | e.g. dsh --patch ./debug.yml, DSH_TELEMETRY_DISABLED switch, Shipped Presets Root               |   |
|   +-------------------------------------------------------------------------------------------------+   |
|                                                    |                                                    |
|                                                    v Output                                             |
|                             Composed EntryOptions[] Mounts to Cordis Loader                             |
+---------------------------------------------------------------------------------------------------------+
```

### 7.4.1 配置叠加的数学形式化：半格代数（Semilattice Overlay Algebra）

我们可以将配置叠加过程抽象为一个**有界半格（Bounded Join-Semilattice）代数结构**。

设配置树状态空间为 $\mathcal{C}$，其中每个配置项 $e \in \mathcal{C}$ 可表示为元组： $$e = \langle \text{id}, \text{name}, \text{config}, \text{disabled}, \text{group} \rangle$$

设补丁操作空间为 $\mathcal{P}$。定义补丁操作符 $\oplus: \mathcal{C} \times \mathcal{P} \to \mathcal{C}$：

$$\text{Apply}(C, P) = C \oplus P$$

对于一个基础配置列表 $C_0 = [e_1, e_2, \dots, e_n]$ 与补丁列表 $P = [p_1, p_2, \dots, p_m]$：
1.  **若 $p_j$ 为插入操作（$p_j.\text{insert} = [e'_{1}, \dots]$）**：
    *   若指定了目标组 $p_j.\text{id}$： $$C_{\text{target}}.\text{config} \leftarrow C_{\text{target}}.\text{config} \cup p_j.\text{insert}$$
    *   若未指定目标组： $$C \leftarrow C \cup p_j.\text{insert}$$
2.  **若 $p_j$ 为覆盖操作（$p_j.\text{id} = k$）**： 在当前树及其嵌套 Group 树中查找 $\text{id} = k$ 的条目 $e_k$，执行全字段覆盖更新： $$e_k \leftarrow \left( e_k \setminus \text{keys}(p_j) \right) \cup p_j$$

对于四层配置系统，最终运行配置 $C_{\text{final}}$ 为从空基线 $C_{\emptyset} = []$ 出发的单调折叠（Fold）过程：

$$C_{\text{final}} = C_{\emptyset} \oplus P_{\text{bundle\_1}} \oplus P_{\text{bundle\_2}} \dots \oplus P_{\text{profile}} \oplus P_{\text{home}} \oplus P_{\text{cli\_patches}} \oplus P_{\text{ephemeral}}$$

#### 复杂度推导
在 `applyEntryPatches` 的单次扫描中：
1.  构建全局 ID 映射表 $\mathcal{M}: \text{ID} \to \text{EntryNode}$： $$T_{\text{index}} = O(N)$$ 其中 $N$ 为当前树中所有条目（含递归 Group 子项）的总节点数。
2.  执行 $M$ 个补丁操作：
    *   ID 寻址：$O(1)$ 查找时间。
    *   插入新节点并动态增量索引：$O(|p_j.\text{insert}|)$。
    *   整体时间复杂度严格为： $$\Theta(N + \sum_{j=1}^M (1 + |p_j.\text{insert}|)) = O(N + M)$$ 该算法在线性时间内即可完成数百个插件配置的合并。

### 7.4.2 为什么禁止“深度递归合并”（No Deep Merge by Design）？

传统配置系统（如 Webpack Merge 或 Lodash `mergeWith`）常采用递归合并策略。然而在插件化微内核架构中，**递归深度合并是绝大多数隐蔽 Bug 的根源**。

例如，Bundle 中定义了一个默认的白名单列表：
```yaml
# Bundle 默认配置
id: tool-fs
config:
  allowedPaths: ['/workspace', '/tmp']
  readOnly: true
```
若用户在 `cordis.patch.yml` 中希望将权限严格限制为仅允许 `/sandbox`：
```yaml
# 用户 Profile 补丁
- id: tool-fs
  config:
    allowedPaths: ['/sandbox']
```
如果采用递归深度合并（数组合并规则为追加或索引覆盖），最终结果将演化为 `allowedPaths: ['/sandbox', '/tmp']`，造成严重的**安全权限逃逸漏洞**。

因此，DeepSeek Harness 确立了铁律：**按 ID 定位的 Patch 实行顶级配置对象整体替换（Whole-Config Replacement），不进行递归字段合并**。用户若要修改某个插件的配置，必须显式书写该插件所需的完整 `config` 块。

### 7.4.3 内存对象防御：引用别名污染（Aliasing Bug）与 `structuredClone`

在支持热重载（HMR）的长生命周期服务中，补丁的重新应用非常频繁。

若直接将解析后的 YAML 对象引用插入树中：
```typescript
// 错误示例：共享引用污染
const parsedPatches = yaml.load(...)
tree.push(...parsedPatches[0].insert)
// 后续 Layer 4 的补丁直接修改了该对象的属性
tree[0].config.port = 8080
```
此时，`parsedPatches[0]` 在内存中的原始模板已经被原地（In-Place）污染！当用户修改并保存 `cordis.patch.yml` 触发 HMR 重新计算时，系统尝试回退到 Bundle 默认值，却发现内存中的 Bundle 模板已被写入了 `port: 8080`，导致**配置状态漂移且永远无法还原**。

DeepSeek Harness 在 `composeLive` 与 `applyEntryPatches` 中强制执行 `structuredClone` 深拷贝隔离：

```typescript
const composeLive = (): PatchOptions[] => structuredClone([
  ...composed.bundlePatches,
  ...loadOptionalPatches(NAME, composed.profile.patchPath) ?? [],
  ...loadOptionalPatches(NAME, homePatchPath()) ?? [],
  ...composed.overlays,
])
```

---

## 7.5 Schemastery 配置校验引擎工作原理

在微内核依赖注入容器中，若某个插件在启动时因为配置字段拼写错误或类型不匹配而陷入非预期状态，可能会导致整个 Agent 状态机在运行数十轮对话后才在某个边缘分支崩溃。

DeepSeek Harness 引入了 `@deepseek-ai/schemastery`（以 `z` 或 `Schema` 形式使用）作为系统的**模式编译器与运行时契约守护者**。

```
+---------------------------------------------------------------------------------------------------------+
|                                    Schemastery Validation Flow                                          |
|                                                                                                         |
|   YAML / Patch Data: { apiKey: "sk-...", temperature: 0.7, extraField: "invalid" }                      |
|                                      |                                                                  |
|                                      v Schema Function Execution (Config(raw))                          |
|   +-------------------------------------------------------------------------------------------------+   |
|   | 1. Structural Type Assertion: z.object({ apiKey: z.string(), temperature: z.number().default(0) }) |   |
|   | 2. Transformation & Coercion: Type Casting, Defaults Filling, Strip / Reject Unknowns           |   |
|   | 3. Expression Node Preservation: Keep { __jsExpr: "process.env.KEY" } literal                   |   |
|   +-------------------------------------------------------------------------------------------------+   |
|             |                                                                 |                         |
|    [Schema Matches]                                                 [Validation Mismatch]               |
|             |                                                                 |                         |
|             v                                                                 v                         |
|   Mount Fiber -> state: FIBER_ACTIVE                           Immediate Boot Reject (Fail-Fast)        |
|   (or FIBER_PENDING if waiting DI)                             Loader Unwinds Context & Disposes Fiber   |
+---------------------------------------------------------------------------------------------------------+
```

### 7.5.1 契约定义：静态类型与运行时 Schema 的双向推导

在插件开发中，配置的 TypeScript 静态接口与运行时 Schemastery Schema 具有一一对应关系：

```typescript
import z from '@deepseek-ai/schemastery'

// 1. TypeScript 静态类型
export interface LlmAdapterConfig {
  apiKey: string
  baseURL?: string
  timeoutMs?: number
  temperature?: number
  models?: string[]
}

// 2. 运行时 Schemastery 契约
export const Config: z<LlmAdapterConfig> = z.object({
  apiKey: z.string().required().description('API Secret Key for LLM provider'),
  baseURL: z.string().default('https://api.deepseek.com/v1').description('Endpoint URL'),
  timeoutMs: z.natural().default(60_000).description('Request timeout in milliseconds'),
  temperature: z.number().min(0).max(2).default(0.7).description('Sampling temperature'),
  models: z.array(z.string()).default(['deepseek-chat', 'deepseek-reasoner']),
})
```

### 7.5.2 加载期快速失败 vs 运行时延迟报错

在 Harness 架构中，错误被严格划分为两个阶段：

```
+---------------------------------------------------------------------------------------------------------+
|                                 Fail-Fast Boundary vs Runtime Error                                     |
+---------------------------------------------------------------------------------------------------------+
| [Phase 1: Boot / Load-Time]                                                                             |
|   - YAML Syntax Errors (e.g. Broken indentation)          --> parsePatchList() Throws                   |
|   - Schemastery Validation Failure (e.g. timeoutMs: "abc")--> Loader.create() Rejection                 |
|   - Missing Bundle / Unresolvable Module Specifier        --> assertEntriesLoaded() Throws              |
|   - Circular Dependency or Missing DI Service             --> assertEntriesActivated() Throws           |
|                                                                                                         |
|   ===> Outcome: Context Disposed immediately, Process exits with code 1, Terminal restored safely.      |
+---------------------------------------------------------------------------------------------------------+
                                                     |
                                                     v (If all assertions pass)
+---------------------------------------------------------------------------------------------------------+
| [Phase 2: Runtime / Execution-Time]                                                                     |
|   - Remote LLM 503 Overloaded / 401 Invalid Key           --> Caught by llm-retry / Agent Turn Recovery |
|   - Tool Execution Error (e.g. ENOENT file not found)     --> Formatted as ToolResult message to Model  |
|   - User Interrupt (Ctrl+C / SIGINT)                      --> AbortSignal cancellation in Fiber         |
+---------------------------------------------------------------------------------------------------------+
```

#### 启动期双重审计：`assertEntriesLoaded` 与 `assertEntriesActivated`

当 Cordis 完成所有插件的挂载后，`dsh-app-boot` 会执行无死角审计：

```typescript
export async function assertEntriesActivated(ctx: Context, binName: string): Promise<void> {
  // 审计 1：验证所有已启用条目是否都成功生成了 Fiber（防止模块解析静默失败）
  assertEntriesLoaded(ctx, binName)

  const failures: string[] = []
  const rejectionReasons: unknown[] = []

  // 审计 2：检查每个 Fiber 的状态机
  for (const entry of ctx.loader.entries()) {
    const fiber = entry.fiber
    if (fiber === undefined || entry.disabled) continue

    const state = fiber.state
    if (state === FIBER_ACTIVE) continue

    if (state === FIBER_FAILED) {
      // 提取导致 Fiber 崩溃的深层原始堆栈
      try {
        await fiber.await()
      } catch (error) {
        rejectionReasons.push(error)
        failures.push(`${entry.options.name}: ${formatActivationError(error)}`)
      }
      continue
    }

    if (state === FIBER_PENDING) {
      // 分析未满足的依赖注入服务名称
      const missing = Object.keys(fiber.inject).filter(service => fiber.ctx.get(service) === undefined)
      const subject = missing.length === 1 ? 'service' : 'services'
      failures.push(`${entry.options.name}: pending (waiting for ${subject}: ${missing.join(', ') || 'unknown'})`)
    }
  }

  if (failures.length > 0) {
    if (rejectionReasons.length > 0) {
      await observeLoaderRejectionCheckpoint(rejectionReasons)
    }
    const noun = failures.length === 1 ? 'entry' : 'entries'
    throw new Error(`${binName}: ${String(failures.length)} ${noun} did not activate\n${failures.join('\n')}`)
  }
}
```

---

## 7.6 实战观测：通过 `dump-config` 逆向运行树

当系统启动异常，或者覆盖层过多导致配置行为不符合预期时，盲目猜测是最低效的排错方式。DeepSeek Harness 提供了离线配置合成与溯源工具：`dsh --profile <name> --dump-config`。

### 7.6.1 前缀快照差分算法（Positional Prefix Snapshot Diffing）

`renderConfigDump` 算法在完全不启动运行时、不执行 `!!js` 代码的前提下，精确复刻 `boot()` 的四层叠加过程，并通过**位置快照差分（Prefix Snapshot Diffing）**计算出每个配置项的具体来源和修改者：

```
Base Rows [A, B]
   |
   v Snapshot 1 (+ Bundle Layers)   ---> Rows [A', B, C]     (A modified by Bundle, C inserted)
   |
   v Snapshot 2 (+ Profile Patch)   ---> Rows [A'', B, C]    (A modified by Profile)
   |
   v Snapshot 3 (+ Home Patch)      ---> Rows [A'', B, C']   (C modified by Home)
   |
   v Snapshot 4 (+ CLI --patch)     ---> Rows [A'', B, C', D](D inserted by CLI)
```

最终生成的 YAML 会按连续块插入 `# ==` 注释，标明每个条目的原始层与修改层。

### 7.6.2 命令行使用演练

#### 1. 打印 Web Profile 的完整组合树
```bash
dsh --profile web --dump-config
```

输出样例：
```yaml
# == @deepseek-ai/dsh-base
- id: cordis-timer
  name: '@deepseek-ai/cordis-plugin-timer'

# == @deepseek-ai/dsh-base, patched by ~/.dsh/profiles/web/cordis.patch.yml
- id: session-storage
  name: '@deepseek-ai/dsh-session-persistence-sqlite'
  config:
    databasePath: ~/.dsh/sessions.db
    journalMode: WAL

# == @deepseek-ai/dsh-web-app, patched by ~/.dsh/cordis.patch.yml
- id: web-host
  name: '@deepseek-ai/dsh-web-host'
  config:
    host: 127.0.0.1
    port: 8080
    cors: true

# == extra-patch.yml
- id: custom-logger
  name: '@deepseek-ai/dsh-logger-json'
  config:
    level: debug
```

#### 2. 打印不含用户覆盖的纯净 Bundle 树（灾难恢复诊断）
当用户的 `cordis.patch.yml` 写错语法导致 CLI 无法启动时，可以使用 `--dump-default-config` 绕过用户层，直接输出官方原始 Bundle 定义：
```bash
dsh --profile web --dump-default-config
```

---

## 7.7 完整工业级 TypeScript 源码实现：引导与配置叠加引擎

下面给出符合工业级生产标准的微内核引导与配置叠加引擎完整实现。代码具备完备的类型声明、错误边界隔离、异步资源清理及取消支持。

```typescript
/**
 * harness-kernel-boot.ts
 * 生产级微内核引导器与四层配置叠加引擎
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve, basename, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import * as yaml from 'js-yaml'
import z from '@deepseek-ai/schemastery'

// ============================================================================
// 1. 类型系统定义
// ============================================================================

export interface EntryOptions {
  id?: string
  name?: string
  config?: unknown
  disabled?: boolean | null
  group?: boolean | null
  [key: string]: unknown
}

export interface PatchOptions {
  id?: string
  insert?: EntryOptions[]
  name?: string
  config?: unknown
  disabled?: boolean | null
  group?: boolean | null
  [key: string]: unknown
}

export interface ProfileManifest {
  name?: string
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  dsh?: {
    bundle?: { patch: string }
    profile?: { bundles?: string[] }
  }
}

export interface ConfigDumpLayer {
  label: string
  patches: PatchOptions[]
}

export interface BootOptions {
  binName: string
  profileName: string
  installAnchor: string
  homeDir: string
  extraPatches: string[]
  signal?: AbortSignal
}

// ============================================================================
// 2. YAML Schema 与 AST 支持（保留 !!js 表达式）
// ============================================================================

const JsExprType = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: (data: unknown) => typeof data === 'string',
  construct: (data: string) => ({ __jsExpr: data }),
  predicate: (data: unknown) => typeof data === 'object' && data !== null && '__jsExpr' in data,
  represent: (data: unknown) => (data as { __jsExpr: string }).__jsExpr,
})

export const EntryListYamlSchema = yaml.JSON_SCHEMA.extend(JsExprType)

// ============================================================================
// 3. 配置叠加核心算法 (applyEntryPatches)
// ============================================================================

/**
 * 按照半格代数规则，将补丁列表单向折叠到基础条目树上
 */
export function applyEntryPatches(
  data: EntryOptions[],
  patches: PatchOptions[] | undefined,
  warn: (message: string, ...args: unknown[]) => void = () => {},
): EntryOptions[] {
  // 必须深拷贝，严禁直接原地修改输入对象
  const result: EntryOptions[] = structuredClone(data)
  if (!patches || patches.length === 0) return result

  const entryMap = new Map<string, EntryOptions>()

  const indexEntries = (entries: EntryOptions[]): void => {
    for (const entry of entries) {
      if (entry.id) entryMap.set(entry.id, entry)
      if (entry.group && Array.isArray(entry.config)) {
        indexEntries(entry.config as EntryOptions[])
      }
    }
  }

  // 1. 建立现有树的索引
  indexEntries(result)

  // 2. 依次应用每个补丁
  for (const patch of patches) {
    const { id, insert, name, ...overrides } = patch

    // 分支 A: 插入操作
    if (insert && Array.isArray(insert)) {
      if (id) {
        const target = entryMap.get(id)
        if (!target) {
          warn('patch insert: target entry ID %s not found, skipping', id)
          continue
        }
        if (!target.group) {
          warn('patch insert: target entry %s is not a group, skipping', id)
          continue
        }
        if (!Array.isArray(target.config)) {
          target.config = []
        }
        (target.config as EntryOptions[]).push(...insert)
      } else {
        result.push(...insert)
      }
      // 动态将新插入的节点纳入索引，允许后续补丁继续针对该节点进行修改
      indexEntries(insert)
      continue
    }

    // 分支 B: 覆盖操作
    if (!id) {
      warn('patch: non-insert patch must provide a target ID, skipping')
      continue
    }

    const target = entryMap.get(id)
    if (!target) {
      warn('patch: target ID %s not found in composition tree, skipping', id)
      continue
    }

    if (name && name !== target.name) {
      warn('patch: module name mismatch for %s (expected %s, got %s), skipping', id, target.name, name)
      continue
    }

    // 执行属性覆写（跳过 id 自身）
    for (const [key, value] of Object.entries(overrides)) {
      if (key === 'id') continue
      target[key] = value
    }
  }

  return result
}

// ============================================================================
// 4. 双锚点模块解析与 Profile 载入
// ============================================================================

export function resolveBundleDir(
  binName: string,
  packageName: string,
  installAnchor: string,
  profileDir: string,
): string {
  const anchors = [installAnchor, join(profileDir, 'package.json')]
  for (const anchor of anchors) {
    const req = createRequire(anchor)
    const paths = req.resolve.paths(packageName) ?? []
    for (const searchPath of paths) {
      const candidate = join(searchPath, packageName)
      if (existsSync(join(candidate, 'package.json'))) {
        return candidate
      }
    }
  }
  throw new Error(`${binName}: failed to resolve bundle "${packageName}" from install anchor or profile dir`)
}

export function loadPatchFile(binName: string, filePath: string, optional = false): PatchOptions[] {
  if (!existsSync(filePath)) {
    if (optional) return []
    throw new Error(`${binName}: required patch file not found: ${filePath}`)
  }
  try {
    const content = readFileSync(filePath, 'utf8')
    const parsed = yaml.load(content, { schema: EntryListYamlSchema })
    if (!Array.isArray(parsed)) {
      throw new Error(`patch file ${filePath} must contain a top-level YAML array`)
    }
    return parsed as PatchOptions[]
  } catch (error) {
    throw new Error(`${binName}: failed to parse patch file ${filePath}: ${String(error)}`)
  }
}

// ============================================================================
// 5. 离线 dump-config 生成引擎
// ============================================================================

export function renderConfigDump(
  binName: string,
  baseConfigPath: string,
  layers: ConfigDumpLayer[],
  warn: (msg: string) => void = console.warn,
): string {
  const baseContent = readFileSync(baseConfigPath, 'utf8')
  const baseEntries = yaml.load(baseContent, { schema: EntryListYamlSchema }) as EntryOptions[]
  if (!Array.isArray(baseEntries)) {
    throw new Error(`${binName}: base config must be a top-level array`)
  }

  const baseLabel = basename(baseConfigPath)
  const snapshot = (layerCount: number, recordedWarnings: string[]): EntryOptions[] => {
    const flattened = structuredClone(layers.slice(0, layerCount).flatMap(l => l.patches))
    return applyEntryPatches(baseEntries, flattened, (msg, ...args) => {
      recordedWarnings.push(msg.replace(/%s/g, () => String(args.shift())))
    })
  }

  let previous = baseEntries
  let previousWarningsCount = 0
  const entryLayerHistory: { origin: string; patchedBy: string[] }[] = baseEntries.map(() => ({
    origin: baseLabel,
    patchedBy: [],
  }))

  let composed = baseEntries
  for (let i = 1; i <= layers.length; i++) {
    const layer = layers[i - 1]
    const warnings: string[] = []
    composed = snapshot(i, warnings)

    for (const w of warnings.slice(previousWarningsCount)) {
      warn(`${binName}: [${layer.label}] ${w}`)
    }
    previousWarningsCount = warnings.length

    const beforeStrings = previous.map(e => JSON.stringify(e))
    for (let idx = 0; idx < composed.length; idx++) {
      if (idx >= beforeStrings.length) {
        entryLayerHistory.push({ origin: layer.label, patchedBy: [] })
      } else if (JSON.stringify(composed[idx]) !== beforeStrings[idx]) {
        entryLayerHistory[idx]?.patchedBy.push(layer.label)
      }
    }
    previous = composed
  }

  // 格式化输出带注释的 YAML
  const outputLines: string[] = []
  let currentHeader: string | undefined
  let chunk: EntryOptions[] = []

  const flushChunk = (): void => {
    if (currentHeader && chunk.length > 0) {
      outputLines.push(`# == ${currentHeader}`)
      outputLines.push(yaml.dump(chunk, { schema: EntryListYamlSchema, noRefs: true }).trimEnd())
      chunk = []
    }
  }

  for (let idx = 0; idx < composed.length; idx++) {
    const record = entryLayerHistory[idx]
    const header = record.patchedBy.length === 0
      ? record.origin
      : `${record.origin}, patched by ${record.patchedBy.join(', ')}`

    if (header !== currentHeader) {
      flushChunk()
      currentHeader = header
    }
    chunk.push(composed[idx])
  }
  flushChunk()

  return outputLines.join('\n') + '\n'
}

// ============================================================================
// 6. 核心组装与引导主控函数
// ============================================================================

export async function composeAndBootProfile(options: BootOptions): Promise<EntryOptions[]> {
  const { binName, profileName, installAnchor, homeDir, extraPatches, signal } = options

  if (signal?.aborted) {
    throw new Error(`${binName}: boot aborted by signal`)
  }

  const profileDir = join(homeDir, 'profiles', profileName)
  const manifestPath = join(profileDir, 'package.json')
  if (!existsSync(manifestPath)) {
    throw new Error(`${binName}: profile "${profileName}" not found at ${profileDir}`)
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ProfileManifest
  const bundleNames = manifest.dsh?.profile?.bundles ?? []

  // 收集四层补丁
  const allLayers: ConfigDumpLayer[] = []

  // Layer 1: Bundles
  for (const bundleName of bundleNames) {
    const bundleDir = resolveBundleDir(binName, bundleName, installAnchor, profileDir)
    const bundlePkg = JSON.parse(readFileSync(join(bundleDir, 'package.json'), 'utf8')) as ProfileManifest
    const patchRelPath = bundlePkg.dsh?.bundle?.patch ?? 'cordis.patch.yml'
    const patchAbsPath = join(bundleDir, patchRelPath)
    allLayers.push({
      label: bundleName,
      patches: loadPatchFile(binName, patchAbsPath, false),
    })
  }

  // Layer 2: Profile Patch
  const profilePatchPath = join(profileDir, 'cordis.patch.yml')
  allLayers.push({
    label: profilePatchPath,
    patches: loadPatchFile(binName, profilePatchPath, true),
  })

  // Layer 3: Home Patch
  const homePatchPath = join(homeDir, 'cordis.patch.yml')
  allLayers.push({
    label: homePatchPath,
    patches: loadPatchFile(binName, homePatchPath, true),
  })

  // Layer 4: Extra CLI Patches
  for (const extraPath of extraPatches) {
    const absPath = resolve(extraPath)
    allLayers.push({
      label: absPath,
      patches: loadPatchFile(binName, absPath, false),
    })
  }

  // 计算最终 Entry 列表
  const flattenedPatches = allLayers.flatMap(l => l.patches)
  const finalEntries = applyEntryPatches([], flattenedPatches)

  return finalEntries
}
```

---

## 7.8 生产环境避坑指南与故障排查清单（Failure Modes & Troubleshooting）

### 故障 1：Windows 环境下 Junction 符号链接并发写入崩溃（`EEXIST`）

*   **故障现象**：在 Windows 平台上并发启动多个 `dsh` 子进程（例如在 Graph Mode 调度或并行测试时），部分进程崩溃报错：`Error: EEXIST: file already exists, symlink`。
*   **根因分析**：`healProfilesModuleFallback` 在维护 `$DSH_HOME/profiles/node_modules` 符号链接时，如果两个进程同时执行 `lstat` 均发现软链接不存在，随后同时调用 `symlinkSync(target, link, 'junction')`，后到达的进程会抛出 `EEXIST`。
*   **修复方案**：捕获 `EEXIST` 异常并复检现存软链接目标是否一致；若目标一致则视为并发幂等成功，直接忽略：
    ```typescript
    try {
      symlinkSync(target, link, 'junction')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST'
        && lstatSync(link).isSymbolicLink()
        && readlinkSync(link) === target) {
        return // 竞态安全：目标一致，视为正常成功
      }
      throw error
    }
    ```

### 故障 2：HMR 热重载下配置修改后无法回滚到 Bundle 默认值（内存别名污染）

*   **故障现象**：开发者在 `profiles/web/cordis.patch.yml` 中修改了 `session-storage` 的路径，保存后生效。随后开发者删除了该条补丁，期望恢复 Bundle 的默认路径，但系统仍然使用刚才修改的值。
*   **根因分析**：Include 插件在初次挂载时将解析得到的对象直接放进树中，后续 Patch 对象的 `target[key] = value` 操作原地（In-Place）修改了 Bundle 对象堆内存。删除 Patch 后重新合并时，Bundle 的内存对象已被污染。
*   **修复方案**：在每次 HMR 触发 `composeLive()` 时，必须使用 `structuredClone` 重新深拷贝 Bundle 补丁数组。

### 故障 3：插件崩溃后终端处于 Raw Mode / 乱码挂死

*   **故障现象**：某个包含 TUI 的插件在激活期抛出异常，`dsh` 退出后，用户的 Bash/Zsh 终端不再回显输入的字符，按回车无法正常换行，必须盲打 `reset` 才能恢复。
*   **根因分析**：TUI 插件在构造函数中通过 `process.stdin.setRawMode(true)` 夺取了终端控制权，但在异步激活失败时，Node.js 的 `process.exit(1)` 直接终止了进程，未能触发析构逻辑。
*   **修复方案**：接入 `installFailLoud` 看门狗机制，在 `Promise.race` 中设置 2000ms 强制超时，并在 `release` 钩子中执行 `ctx.fiber.dispose()` 完成终端复位。

### 故障 4：`!!js` 表达式注入导致的不受控代码执行

*   **故障现象**：在加载不可信来源的配置文件时，配置文件包含：
    ```yaml
    - id: malicious
      config:
        payload: !!js process.mainModule.require('child_process').execSync('rm -rf /')
    ```
*   **根因分析**：`js-yaml` 默认的 `DEFAULT_SCHEMA` 支持任意 JavaScript 函数执行。
*   **修复方案**：DeepSeek Harness 定制了 `entryListSchema`，将 `!!js` 标量严格解析为 AST 表达式节点 `{ __jsExpr: string }`。该节点在加载期只作为字面量传递，绝不通过 `eval()` 执行；仅在受控的 Cordis Context 内部通过指定沙箱环境进行求值。

### 故障 5：按 ID 覆盖配置时遗漏必填字段导致 Schemastery 拦截

*   **故障现象**：用户在 `cordis.patch.yml` 中仅覆盖 `port`：
    ```yaml
    - id: web-host
      config:
        port: 9090
    ```
    启动时报错：`ValidationError: web-host: missing required field "host"`。
*   **根因分析**：DeepSeek Harness 的 Patch 采用**整块替换（Whole-Config Replacement）**而非深度合并。原 Bundle 中的 `host: "127.0.0.1"` 被整体覆写为 `{ port: 9090 }`。
*   **修复方案**：在覆盖配置时，必须完整声明该条目所需的所有字段，或通过 `dsh --dump-config` 查看原 Bundle 定义并进行完整复制调整。

---

## 7.9 课后动手练习

1.  **实现自定义 Profile 模板**： 在 `packages/boot/app-boot/src/profile.ts` 中注册一个新的模板 `custom-agent`，该模板由 `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-tool-terminal` 与自定义的 `sqlite-logger` 组成。编写单元测试验证通过 `initProfile` 可以自动初始化该目录结构。
2.  **编写配置冲突检测器**： 扩展 `renderConfigDump`，当检测到某个 CLI `--patch` 与用户 Profile 补丁对同一个插件的同一字段进行了相互矛盾的修改时，在输出的 YAML 头部以 Warning 注释形式打印冲突预警。
3.  **HMR 实时重载验证**： 启动 `dsh --profile web`，在另一个终端修改 `~/.dsh/profiles/web/cordis.patch.yml` 中的某个提示词插件配置，观察控制台是否在不重启进程的前提下平滑刷新配置并触发相关 Fiber 的重新激活。
