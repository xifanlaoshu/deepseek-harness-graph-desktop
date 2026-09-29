# Chapter 07: Startup, Profiles, and Configuration Overlays

English | [中文](07-startup-profiles.zh.md)

Complex enterprise frameworks such as Spring Boot, Kubernetes Kubelet, and VS Code need a boot architecture that balances **cold-start performance, tenant configuration isolation, dynamic extension, and hot reload**. The challenge is sharper for an LLM-driven agent harness: it must inject a service dependency graph in tens of milliseconds, like an operating-system microkernel, while composing official bundles, personal profiles, global home/environment settings, and command-line overlays in arbitrary layers. It must also prevent type violations, in-memory object contamination, and terminal-state damage.

This chapter examines DeepSeek Harness startup from a systems-programming perspective: argument parsing and dispatch in the CLI entry point `apps/cli/src/bin.ts`, two-anchor ESM module resolution, the four-layer configuration-overlay semilattice, strict load-time validation with Schemastery, and diagnosis of the complete runtime dependency tree with `dump-config`.

---

## 7.1 Mental Model: Microkernel Boot and Configuration Layers

Comparing agent-harness startup with conventional systems software provides a useful engineering model:

*   **CLI launcher (`dsh/bin.ts`) $\to$ microkernel bootloader / dynamic linker**: It parses only the outer startup mode and kernel arguments, uses dynamic ESM `import()` to load subsystems on demand without upfront cost, and passes every other argument through unchanged.
*   **Bundle $\to$ base operating-system image / distribution layer**: An immutable base set of plugins declared through npm defines the standard capabilities for an application mode such as `web` or `headless`.
*   **Profile $\to$ user-environment overlay**: An independent workspace at `$DSH_HOME/profiles/<name>` contains its own `package.json` for external plugin dependencies and `cordis.patch.yml`.
*   **Four-layer configuration overlay $\to$ union file system (UnionFS / OverlayFS)**: The base bundle is read-only; profile and home patches override it in order, and command-line arguments have the highest priority.
*   **Schemastery validation $\to$ static type reflection and fail-fast load assertions**: Strict type validation at plugin mount and fiber activation prevents invalid configuration from reaching the runtime.
*   **Fail-loud handling $\to$ crash capture and TTY recovery watchdog**: If an asynchronous plugin throws during mounting, it restores terminal raw mode and bracketed-paste state atomically so the shell does not remain unusable.

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

## 7.2 CLI Entry Point and Dynamic ESM Imports

### 7.2.1 Minimal Dispatch in `apps/cli/src/bin.ts`

Cold-start latency is a central concern for a high-performance CLI. Statically importing the entire system at entry—including the web server, database driver, ACP stack, and TUI renderer—would make V8 parse and compile hundreds of modules, potentially raising startup time from 40 ms to more than 800 ms.

`apps/cli/src/bin.ts` uses **microkernel-style dynamic loading**. It imports only the argument parser and environment loader up front, then uses dynamic `import()` so each startup path loads only what it needs:

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

### 7.2.2 Commander Adapter and Pass-Through Argument Boundary

A common mistake in CLI frameworks is to parse every subsystem's flags at the outermost layer. That couples the launcher to plugin-specific flags such as the web server's `--port`, the TUI's `--theme`, and an agent's `--resume`.

In `apps/cli/src/args.ts`, DeepSeek Harness defines a strict **argument ownership rule**:

1.  **Launcher-owned flags**: `--profile <name>`, `--patch <path>`, `--dump-config`, `--dump-default-config`, and the `web` and `plugin` subcommands.
2.  **Verbatim application arguments**: At the first unrecognized flag, the launcher stops parsing and puts all remaining `argv` tokens into `args: string[]` without modification.
3.  **Help ownership**: `dsh -h` without a profile shows launcher help. `dsh --profile web --help` and `dsh web --help` pass `--help` to the `web` plugin tree, where the web app describes its own port, routes, and other options.

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

### 7.2.3 Three-Tier Environment Precedence and Bootstrap-Only Protection

Environment variables directly control external behavior. `loadLayeredEnv` in DeepSeek Harness creates a deterministic snapshot from three sources:

$$\text{FinalEnv} = \text{ProcessEnv} \leftarrow \text{ProjectEnv (./.env)} \leftarrow \text{UserEnv (~/.dsh/.env)}$$

The precedence is **current process environment > project `.env` in the working directory > global home `~/.dsh/.env`**.

#### Security: `isBootstrapOnly` Blocklist Filtering

If arbitrary `.env` files could override `PATH`, `LD_PRELOAD`, or `NODE_OPTIONS`, an attacker could place a malicious `.env` in a repository and execute arbitrary code or alter the Node.js runtime when a developer runs `dsh`.

For this reason, `loadLayeredEnv` applies a strict **bootstrap security assertion** while reading `.env`:

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

Defining any listed variable in `.env` fails immediately at load time and tells the user to set it explicitly in the operating-system environment with `export` instead.

### 7.2.4 Process Lifecycle and the TTY Recovery Watchdog (`installFailLoud`)

One difficult CLI failure occurs when an asynchronous plugin rejects during mounting and **leaves the terminal in raw mode, with echo disabled, bracketed paste enabled, or a special keyboard protocol active; the developer's shell then appears corrupted or hung**.

DeepSeek Harness uses `installFailLoud` as a timeout-bounded terminal recovery watchdog:

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

## 7.3 Separating Profiles from Bundles

Before examining configuration overlays, distinguish **bundles** from **profiles**:

| Dimension | Bundle | Profile |
| :--- | :--- | :--- |
| **Physical form** | Published npm package such as `@deepseek-ai/dsh-base` | Directory on disk (`$DSH_HOME/profiles/<name>`) |
| **Ownership** | Distributed by the framework or third parties; **read-only and immutable** | Owned locally by an end user or developer; **fully writable** |
| **Manifest declaration** | `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` | `"dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", ...] } }` |
| **Module dependencies** | Declared in its own `package.json` under `dependencies` | Declared in the profile directory's `package.json` for out-of-tree plugins |
| **Patch role** | Provides the default module topology and initial configuration | Customizes and overrides the bundle topology |

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

### 7.3.1 Two-Anchor Module Resolution

When a profile's `package.json` declares `dsh.profile.bundles: ["@deepseek-ai/dsh-base"]`, how does the system find the bundle code and patch file?

DeepSeek Harness uses **two-anchor resolution**:
1.  **Anchor 1, the installation anchor**: Search first from the `dsh` CLI's installation root (`apps/cli/package.json`). This keeps built-in bundles at exactly the same version as the running `dsh` binary, unaffected by stale local copies.
2.  **Anchor 2, the profile anchor**: If the bundle is not in the installation, as with a third-party bundle installed by the user, search from `$DSH_HOME/profiles/<name>/package.json`.

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

### 7.3.2 Self-Healing Flat Module Fallback Directory

Out-of-tree plugins installed by users with `dsh plugin --profile web add <pkg>` commonly declare core packages such as `@deepseek-ai/cordis` and `@deepseek-ai/dsh-agent` in `peerDependencies`.

To let Node.js resolve those peer dependencies without forcing users to reinstall hundreds of megabytes of built-in runtime packages, DeepSeek Harness maintains a **self-healing closure of symlinks** in `$DSH_HOME/profiles/node_modules`.

The repair algorithm traverses the transitive closure of the CLI installation's dependency graph with **breadth-first search (BFS)**:

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

## 7.4 The Four-Layer Configuration Overlay Chain

Configuration overlays are the central algorithm for assembling the DeepSeek Harness runtime plugin tree. Every configuration source ultimately produces one list of Cordis entries.

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

### 7.4.1 Formalizing Configuration Overlays as Semilattice Algebra

The configuration-overlay process can be modeled as a **bounded join-semilattice**.

Let $\mathcal{C}$ be the configuration-tree state space. Each entry $e \in \mathcal{C}$ is a tuple: $$e = \langle \text{id}, \text{name}, \text{config}, \text{disabled}, \text{group} \rangle$$

Let $\mathcal{P}$ be the patch-operation space, and define $\oplus: \mathcal{C} \times \mathcal{P} \to \mathcal{C}$:

$$\text{Apply}(C, P) = C \oplus P$$

Given a base list $C_0 = [e_1, e_2, \dots, e_n]$ and patch list $P = [p_1, p_2, \dots, p_m]$:
1.  **If $p_j$ is an insertion ($p_j.\text{insert} = [e'_{1}, \dots]$)**:
    *   If target group $p_j.\text{id}$ is specified: $$C_{\text{target}}.\text{config} \leftarrow C_{\text{target}}.\text{config} \cup p_j.\text{insert}$$
    *   If no target group is specified: $$C \leftarrow C \cup p_j.\text{insert}$$
2.  **If $p_j$ is an override ($p_j.\text{id} = k$)**: Find entry $e_k$ with $\text{id} = k$ in the current tree or a nested group, then override its fields: $$e_k \leftarrow \left( e_k \setminus \text{keys}(p_j) \right) \cup p_j$$

For the four-layer system, the final runtime configuration $C_{\text{final}}$ is a monotonic fold starting from an empty baseline $C_{\emptyset} = []$:

$$C_{\text{final}} = C_{\emptyset} \oplus P_{\text{bundle\_1}} \oplus P_{\text{bundle\_2}} \dots \oplus P_{\text{profile}} \oplus P_{\text{home}} \oplus P_{\text{cli\_patches}} \oplus P_{\text{ephemeral}}$$

#### Complexity
In one pass through `applyEntryPatches`:
1.  Build a global ID map $\mathcal{M}: \text{ID} \to \text{EntryNode}$: $$T_{\text{index}} = O(N)$$ Here $N$ counts all entries, including those in nested groups.
2.  Apply $M$ patches:
    *   ID lookup takes $O(1)$ time.
    *   Inserting new nodes and updating the index takes $O(|p_j.\text{insert}|)$.
    *   The total complexity is $$\Theta(N + \sum_{j=1}^M (1 + |p_j.\text{insert}|)) = O(N + M)$$. Hundreds of plugin configurations can therefore be combined in linear time.

### 7.4.2 Why Deep Recursive Merging Is Deliberately Excluded

Traditional configuration systems, such as Webpack Merge or Lodash `mergeWith`, often merge recursively. In a plugin-based microkernel, however, **recursive deep merging causes many subtle bugs**.

For example, a bundle defines a default allowlist:
```yaml
# Bundle 默认配置
id: tool-fs
config:
  allowedPaths: ['/workspace', '/tmp']
  readOnly: true
```
Suppose a user wants `cordis.patch.yml` to allow only `/sandbox`:
```yaml
# 用户 Profile 补丁
- id: tool-fs
  config:
    allowedPaths: ['/sandbox']
```
With recursive deep merging, an array rule that appends or overrides by index could produce `allowedPaths: ['/sandbox', '/tmp']`, creating a serious **permission-escape vulnerability**.

DeepSeek Harness therefore applies this rule: **a patch located by ID replaces the whole top-level configuration object; it does not merge fields recursively**. To change a plugin's configuration, the user must explicitly provide its entire required `config` block.

### 7.4.3 Avoiding Object Aliasing with `structuredClone`

Long-running services with HMR reapply patches frequently.

If a parsed YAML object is inserted into the tree by reference:
```typescript
// 错误示例：共享引用污染
const parsedPatches = yaml.load(...)
tree.push(...parsedPatches[0].insert)
// 后续 Layer 4 的补丁直接修改了该对象的属性
tree[0].config.port = 8080
```
The original `parsedPatches[0]` template is now contaminated in place. When a user saves a change to `cordis.patch.yml` and HMR recomputes the configuration, the system tries to restore the bundle default but finds that the in-memory bundle template already contains `port: 8080`. **Configuration drifts and cannot be restored**.

DeepSeek Harness uses `structuredClone` in `composeLive` and `applyEntryPatches` to isolate deep copies:

```typescript
const composeLive = (): PatchOptions[] => structuredClone([
  ...composed.bundlePatches,
  ...loadOptionalPatches(NAME, composed.profile.patchPath) ?? [],
  ...loadOptionalPatches(NAME, homePatchPath()) ?? [],
  ...composed.overlays,
])
```

---

## 7.5 How Schemastery Validates Configuration

In a microkernel dependency-injection container, a misspelled configuration field or wrong type can leave a plugin in an unexpected startup state. The agent state machine might then fail in an edge case only after dozens of conversation turns.

DeepSeek Harness uses `@deepseek-ai/schemastery` (through `z` or `Schema`) as a **schema compiler and runtime validator**.

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

### 7.5.1 Deriving Static Types and Runtime Schemas Together

In plugin development, the TypeScript configuration interface and its runtime Schemastery schema correspond one to one:

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

### 7.5.2 Failing at Load Time Instead of Much Later

The harness distinguishes two failure stages:

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

#### Two Startup Audits: `assertEntriesLoaded` and `assertEntriesActivated`

After Cordis mounts all plugins, `dsh-app-boot` audits every entry:

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

## 7.6 Inspecting the Runtime Tree with `dump-config`

When startup fails or several overlays produce unexpected behavior, guessing is inefficient. DeepSeek Harness provides `dsh --profile <name> --dump-config` to compose configuration offline and trace where each entry came from.

### 7.6.1 Positional Prefix Snapshot Diffing

Without starting the runtime or executing `!!js` code, `renderConfigDump` reproduces the four-layer overlay performed by `boot()`. **Positional prefix snapshot diffing** then identifies the origin of each entry and the layers that changed it:

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

The resulting YAML places `# ==` comments with each entry's original and patching layers above consecutive blocks.

### 7.6.2 Command-Line Examples

#### 1. Print the Complete Web Profile Tree
```bash
dsh --profile web --dump-config
```

Example output:
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

#### 2. Print the Bundle Tree Without User Overrides (Recovery Diagnosis)
If a syntax error in the user's `cordis.patch.yml` prevents CLI startup, `--dump-default-config` bypasses user layers and prints the original bundle configuration:
```bash
dsh --profile web --dump-default-config
```

---

## 7.7 Complete Production-Grade TypeScript Implementation: Boot and Overlay Engine

The following complete microkernel boot and overlay engine is designed for industrial production. It includes full type declarations, error isolation, asynchronous resource cleanup, and cancellation support.

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

## 7.8 Production Failure Modes and Troubleshooting

### Failure 1: Concurrent Junction Creation on Windows Fails with `EEXIST`

*   **Symptom**: Starting several `dsh` subprocesses concurrently on Windows, for example through Graph Mode scheduling or parallel tests, causes some to fail with `Error: EEXIST: file already exists, symlink`.
*   **Root cause**: While `healProfilesModuleFallback` maintains symlinks in `$DSH_HOME/profiles/node_modules`, two processes can both find a link absent with `lstat` and both call `symlinkSync(target, link, 'junction')`. The second call throws `EEXIST`.
*   **Fix**: Catch `EEXIST` and recheck that the existing link points to the intended target. If it does, treat the concurrent operation as an idempotent success:
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

### Failure 2: HMR Cannot Restore Bundle Defaults After a Configuration Edit (Object Aliasing)

*   **Symptom**: A developer changes the `session-storage` path in `profiles/web/cordis.patch.yml`, and the saved change takes effect. Removing the patch should restore the bundle default, but the system keeps the changed path.
*   **Root cause**: The Include plugin inserts the parsed object directly into the tree when first mounted. A later patch's `target[key] = value` mutates the bundle object in place. By the time the patch is removed and configuration recomposed, the in-memory bundle object has already changed.
*   **Fix**: Every HMR-triggered `composeLive()` must use `structuredClone` to create a fresh deep copy of the bundle patch array.

### Failure 3: Terminal Remains in Raw Mode After a Plugin Crash

*   **Symptom**: A TUI plugin throws during activation. After `dsh` exits, the user's Bash or Zsh terminal no longer echoes input or handles Enter normally; recovery requires typing `reset` without visible feedback.
*   **Root cause**: The TUI plugin takes control of the terminal with `process.stdin.setRawMode(true)` in its constructor. When asynchronous activation fails, Node.js calls `process.exit(1)` without running disposal.
*   **Fix**: Use the `installFailLoud` watchdog with a 2000 ms deadline in `Promise.race`, and call `ctx.fiber.dispose()` in the `release` hook to restore the terminal.

### Failure 4: `!!js` Injection Enables Uncontrolled Code Execution

*   **Symptom**: A configuration file from an untrusted source contains:
    ```yaml
    - id: malicious
      config:
        payload: !!js process.mainModule.require('child_process').execSync('rm -rf /')
    ```
*   **Root cause**: The `js-yaml` default `DEFAULT_SCHEMA` permits execution of arbitrary JavaScript functions.
*   **Fix**: DeepSeek Harness defines `entryListSchema` to parse `!!js` scalars strictly as AST expression nodes `{ __jsExpr: string }`. At load time the node is passed only as a literal and never executed through `eval()`; evaluation occurs only inside a controlled Cordis Context in the specified sandbox.

### Failure 5: An ID-Based Override Omits a Required Field and Fails Schemastery Validation

*   **Symptom**: A user overrides only `port` in `cordis.patch.yml`:
    ```yaml
    - id: web-host
      config:
        port: 9090
    ```
    Startup fails with `ValidationError: web-host: missing required field "host"`.
*   **Root cause**: DeepSeek Harness patches use **whole-config replacement**, not deep merging. The original bundle's `host: "127.0.0.1"` is replaced by `{ port: 9090 }`.
*   **Fix**: An override must declare all fields required by that entry. Alternatively, inspect the original bundle definition with `dsh --dump-config`, then copy and adjust it completely.

---

## 7.9 Hands-On Exercises

1.  **Implement a custom profile template**: Register a `custom-agent` template in `packages/boot/app-boot/src/profile.ts` composed of `@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-tool-terminal`, and a custom `sqlite-logger`. Write a unit test showing that `initProfile` initializes the directory structure.
2.  **Write a configuration-conflict detector**: Extend `renderConfigDump` to detect when a CLI `--patch` and a user-profile patch make contradictory changes to the same field of the same plugin, and print a warning comment at the start of the YAML output.
3.  **Verify live HMR reload**: Start `dsh --profile web`, then change a prompt plugin's configuration in `~/.dsh/profiles/web/cordis.patch.yml` from another terminal. Observe whether the console reports a smooth configuration refresh and reactivates the corresponding fiber without a process restart.
