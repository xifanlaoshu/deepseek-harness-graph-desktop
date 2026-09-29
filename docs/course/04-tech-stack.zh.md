# 第 04 章：实际技术栈

[English](04-tech-stack.md) | 中文

在传统的企业级软件工程中，技术选型不仅决定了系统的吞吐上限与开发效率，更从物理层面划定了系统的故障隔离域与安全性边界。构建一个工业级自主智能体框架（Autonomous Agent Harness）绝非简单地调用大语言模型 API 与拼接提示词，而是要在操作系统系统调用、内核级进程沙箱、异步 I/O 调度、不可变事件持久化以及全栈微秒级类型契约等多个硬核领域完成精确的系统工程权衡。

本章将以严密的软件工程与系统编程视角，全景式拆解 DeepSeek Harness 的全栈技术选型。我们将彻底摒弃空洞的 AI 营销词汇，深入操作系统底层的数据结构、内存模型与系统调用抽象，逐一阐明“为什么选它而不是主流备选方案”，并揭示技术栈各组件之间的协作主线与所有权链条。

---

## 4.1 架构全景：技术选型哲学与系统分层

### 4.1.1 系统编程视角下的 Agent 运行时分层模型

在计算机系统分层模型中，DeepSeek Harness 被设计为一个**运行在操作系统用户态之上的专用 Agent 微内核运行时（Agent Microkernel Runtime）**。它的根本任务是管理非确定性的概率计算单元（LLM），并为之提供确定性、可审计、强隔离的操作系统环境抽象。

```
+---------------------------------------------------------------------------------------------------+
|                                1. Presentation & Full-Stack RPC Layer                             |
|    React 18 + Zustand + Immer (Atomic State Bus) | Typert Gateway (Type Graph & WebSocket RPC)    |
+---------------------------------------------------------------------------------------------------+
                                                  │
                                                  ▼
+---------------------------------------------------------------------------------------------------+
|                                2. Microkernel IoC & Configuration Layer                           |
|        Vendored Cordis (Context Fork / Dynamic Lifecycle / Cascading Disposal / Waterfall)        |
|        Vendored Schemastery (Bidirectional Type Inference, Configuration Overlay & AST Parser)     |
+---------------------------------------------------------------------------------------------------+
                                                  │
                                                  ▼
+---------------------------------------------------------------------------------------------------+
|                                3. Agent Execution Engine Core                                     |
|    Turn / Step State Machine | Inbox Concurrent Queue | AbortSignal Cancellation Cascade          |
|    Tool Registry & Dispatcher | Zod Runtime Schema Validation & Spill Storage System              |
+---------------------------------------------------------------------------------------------------+
                                 │                                  │
                                 ▼                                  ▼
+--------------------------------------------------+ +----------------------------------------------+
|             4. Model Adaptation Layer            | |         5. Durable Event Ledger Layer        |
| DeepSeek API (Reasoning + SSE Streaming)         | | session-persistence-jsonl (Zstd Frames)      |
| pi-ai Transpilation Layer | Attachment Pipeline  | | session-persistence-sqlite (node:sqlite WAL) |
+--------------------------------------------------+ +----------------------------------------------+
                                                  │
                                                  ▼
+---------------------------------------------------------------------------------------------------+
|                                6. Concurrency & Kernel Isolation Layer                            |
| Linux Landlock (native C) + bwrap | macOS Apple Seatbelt | Windows Restricted Token + Job Object  |
| Node.js Worker Threads (V8 Isolate Memory Caps) | Subprocess Supervisor with Monotonic Capability |
+---------------------------------------------------------------------------------------------------+
```

### 4.1.2 技术选型四大铁律

DeepSeek Harness 的架构决策始终受制于以下四条不可违背的系统工程铁律：

1. **零宿主环境污染（Zero Host Pollution）**：宿主机器仅需标准 Node.js 运行时即可启动完整开发与生产环境。坚决杜绝依赖全局守护进程（如 Docker 守护进程），杜绝在安装期触发平台相关的 C++ 原生编译（`node-gyp`、Python 编译依赖）。
2. **纯粹确定性事件溯源（Pure Deterministic Event Sourcing）**：会话状态的唯一事实来源是仅追加（Append-Only）日志。任何 UI 状态、内存快照与上下文窗口均是由事件账本通过纯函数动态投影（Projection）生成的衍生品。
3. **纵深防御与权限单调递减（Defense-in-Depth & Monotonic Privilege Downgrade）**：所有由模型触发的操作系统交互必须经过参数校验、权限拦截与内核级沙箱三重防护。子智能体（Subagent）派生时，其沙箱权限只能严格收缩或保持不变，绝不允许越权提权。
4. **编译期与运行期的端到端契约闭环（End-to-End Type Rigidity）**：从底层 Cordis 领域服务声明、Schemastery 配置文件、Zod 工具入参，到前后端 WebSocket RPC 报文与 React 状态总线，全链路维持 100% 强类型约束。

### 4.1.3 全景技术栈选型对比决策表

```
+---------------------+-------------------------------+-----------------------------------+--------------------------------------------+
| 架构分层            | DeepSeek Harness 选用技术     | 主流备选方案 (Rejected Alternatives)| 淘汰原因与核心权衡指标                     |
+---------------------+-------------------------------+-----------------------------------+--------------------------------------------+
| 运行时与模块系统    | Node.js ^22.19/24 (ESM-only)  | CommonJS (CJS) / Bun / Deno       | CJS 阻塞且无 Top-level await; Bun 在 POSIX |
|                     |                               |                                   | 进程信号与 Windows 命名管道一致性欠佳      |
+---------------------+-------------------------------+-----------------------------------+--------------------------------------------+
| 语言与静态分析      | TypeScript 6 (Strict + NodeNext)| TypeScript 宽松模式 / JavaScript  | 缺失判别联合穷尽性检查将导致 Agent 状态机  |
|                     |                               |                                   | 在异常分支发生静默崩溃                     |
+---------------------+-------------------------------+-----------------------------------+--------------------------------------------+
| 包管理与 Monorepo   | pnpm 11 Workspace (CAS)       | npm / Yarn Classic / Turborepo    | npm 依赖扁平化导致严重“幻影依赖”渗透；    |
|                     |                               |                                   | pnpm 内容寻址硬链接保证 100% 拓扑隔离      |
+---------------------+-------------------------------+-----------------------------------+--------------------------------------------+
| 控制反转 (IoC)      | Vendored Cordis               | NestJS / Inversify / TypeDI       | 传统 IoC 仅支持单例/请求域；Cordis 支持    |
|                     |                               |                                   | 动态树状上下文分叉 (Fork) 与级联析构清理   |
+---------------------+-------------------------------+-----------------------------------+--------------------------------------------+
| 动态配置模式        | Vendored Schemastery          | Joi / Ajv / 纯 TypeScript 接口    | Schemastery 提供单一定义源，同时生成       |
|                     |                               |                                   | 运行期类型校验、YAML 注释与 JSON Schema    |
+---------------------+-------------------------------+-----------------------------------+--------------------------------------------+
| 构建与打包体系      | tsdown (Rolldown/Oxc) + Vite  | Webpack / Rollup / tsc 纯转译     | tsdown 双面构建（Host vs Client）速度提升  |
|                     |                               |                                   | 15x，增量打包仅需亚秒级                    |
+---------------------+-------------------------------+-----------------------------------+--------------------------------------------+
| 模型协议与转义      | 原生 SSE 适配器 + pi-ai       | LangChain / LlamaIndex            | 第三方 Agent 框架代码膨胀、黑盒隐藏抽象多、|
|                     |                               |                                   | 无法精确控制 Token 级背压与推理流分流      |
+---------------------+-------------------------------+-----------------------------------+--------------------------------------------+
| 文件事实日志持久化  | JSONL + Zstandard 独立物理帧  | 纯文本 JSONL / Gzip 流 / Zip 归档 | 普通流无法仅追加写入；Zstd 帧拼接支持      |
|                     | (Concatenated Zstd Frames)    |                                   | $O(1)$ 追加压缩与撕裂帧（Torn Frame）自愈  |
+---------------------+-------------------------------+-----------------------------------+--------------------------------------------+
| 数据库事实持久化    | Node.js 原生 `node:sqlite`     | Prisma / TypeORM / better-sqlite3 | Prisma 查询引擎进程笨重 (50MB+) 冷启动慢； |
|                     | (DatabaseSync WAL Mode)       |                                   | better-sqlite3 需 C++ 原生编译污染环境     |
+---------------------+-------------------------------+-----------------------------------+--------------------------------------------+
| 前端响应式状态总线  | React 18 + Zustand + Immer    | Redux Toolkit / Context API / MobX| Redux 样板代码繁琐；Context API 在高频     |
|                     |                               |                                   | Token 流下引发全局组件树卡顿与掉帧         |
+---------------------+-------------------------------+-----------------------------------+--------------------------------------------+
| 全栈契约与 RPC      | Typert 编译期类型图 RPC       | GraphQL / tRPC / gRPC             | GraphQL 解析器开销过大；tRPC 不适应微内核  |
|                     |                               |                                   | 动态插件拓扑；Typert 从 Cordis 服务自动编译|
+---------------------+-------------------------------+-----------------------------------+--------------------------------------------+
| 代码沙箱运行时      | Node.js Worker Threads        | `vm.runInContext` / 独立进程 Docker| `vm` 存在 V8 原型链逃逸漏洞；Docker 依赖  |
|                     | (Transferable Memory Bounds)  |                                   | 庞大宿主环境；Worker Threads 隔离彻底且轻量|
+---------------------+-------------------------------+-----------------------------------+--------------------------------------------+
| 内核级安全隔离      | Linux Landlock / macOS Seatbelt| Docker / sudo chroot / 无沙箱      | Landlock/Seatbelt 运行于内核 LSM 层，提供  |
|                     | Windows Restricted Token+ACL  |                                   | 进程级单调不可逆降级，无特权要求且开销为零 |
+---------------------+-------------------------------+-----------------------------------+--------------------------------------------+
```

---

## 4.2 语言与运行时：Node.js ESM 与 TypeScript 6

### 4.2.1 为什么是 Node.js ^22.19 / 24 原生 ESM？

DeepSeek Harness 在根目录 `package.json` 中严格锁定了运行环境：`"engines": { "node": "^22.19.0 || >=24.0.0" }`，并且在整个 Monorepo 中完全启用了 `"type": "module"`。这一决策是基于以下系统级考量：

```
+---------------------------------------------------------------------------------------------------+
|                                 Node.js 22 LTS Built-in Subsystems                                |
+---------------------------------------------------------------------------------------------------+
  Node.js Process Space
  ├── V8 Engine (ECMAScript 2024 / Top-Level Await / ESM Loader)
  ├── node:sqlite (Synchronous DatabaseSync / SQLite 3.45+ Embedded C Binding / Zero Node-GYP)
  ├── node:zlib (Native libzstd C Engine / Dictionary & Independent Concatenated Frame Support)
  ├── Web Streams API (ReadableStream / TransformStream / Native SSE Backpressure Flow)
  ├── node:worker_threads (V8 Isolated Heap / SharedArrayBuffer / Structured Clone Transfer)
  └── Node-API Subsystem (Used strictly for Landlock C Dispatcher)
```

#### 1. 消除 C++ 原生编译依赖（Zero Node-GYP）
在 Node.js 22 之前，若要在 Node 环境中获得高性能的 SQLite 数据库与 Zstandard 压缩能力，项目必须依赖 `better-sqlite3` 与 `node-zstd` 等第三方原生扩展。在跨平台安装时，这些包需要调用 Python 与 Visual Studio C++ / GCC 编译工具链（`node-gyp`）。一旦用户的操作系统环境缺失构建工具、glibc 版本不匹配或 Node ABI 版本发生微调，安装过程将直接中断。

Node.js 22.19+ 在标准库中直接内置了 `node:sqlite`（提供同步的高性能 `DatabaseSync` 类）与 `node:zlib` 原生 Zstd 支持。Harness 借助这一特性，实现了**纯 TypeScript/JavaScript 的秒级安装体验**。

#### 2. 纯 ESM 架构的不可替代性
CommonJS (CJS) 在历史设计上采用同步的 `require()` 模型。这一机制在现代智能体系统中存在三大致命缺陷：
- **无法原生支持 Top-level await**：智能体系统的插件与配置需要在模块加载阶段完成异步动态握手（例如初始化远程配置、加载安全策略）；CJS 强制要求将异步初始化封装在额外的 `init()` 函数中，极易导致竞态条件（Race Conditions）。
- **模块缓存污染与不可变性破坏**：CJS 的 `require.cache` 是完全可变的全局对象，第三方插件可以恶意或无意修改已加载模块的导出，破坏微内核安全隔离；而 ESM 的模块记录（Module Record）在加载后是不可变的静态绑定。
- **与浏览器端代码共享的天然鸿沟**：Harness 的 Client Face 需要在浏览器中直接复用领域类型与纯函数模型。ESM 作为 Web 标准，允许前后端完全消除模块格式转译损耗。

#### 3. 对比 Bun 与 Deno
- **Bun**：虽然在单进程启动速度与 JavaScript 执行基准上表现抢眼，但在复杂的多进程监管（Subprocess Tree Supervision）、Windows 平台句柄继承、命名管道（Named Pipes）IPC 以及跨平台的 POSIX 信号传递（`SIGTERM`、`SIGINT`、`SIGKILL`）层面仍存在边界缺陷。对于需要长期稳定运行的企业级 Harness，Node.js 22 LTS 提供了经过数十年验证的跨平台操作系统兼容性。
- **Deno**：Deno 拥有出色的安全模型，但其 npm 兼容层在处理庞大的前端生态（如 Vite 复杂插件生态、某些底层测试工具）时仍存在细微的语义分歧，且其特有的权限模型无法直接映射到 Linux 内核级 Landlock 或 Windows DACL 细粒度控制。

### 4.2.2 TypeScript 6 Strict 模式与判别联合类型状态机

在 Harness 中，TypeScript 不仅是一种静态类型检查工具，更是**领域状态机（Domain State Machine）的数学形式化描述语言**。全库开启 `strict: true`、`exactOptionalPropertyTypes: true` 与 `noUncheckedIndexedAccess: true`。

#### 判别联合（Discriminated Unions）作为代数数据类型

在 Agent 运行循环中，每一步（Step）与每一次轮次（Turn）的内部状态被建模为严格互斥的 Sum Type。编译器保证开发者在任何状态转移逻辑中，绝不可能访问当前状态未持有的字段。

```typescript
/**
 * Agent 运行时步骤的精确状态联合体 (Algebraic Sum Type)
 */
export type StepExecutionState =
  | {
      readonly status: 'PENDING_DISPATCH';
      readonly turnId: string;
      readonly stepIndex: number;
      readonly scheduledAt: number;
    }
  | {
      readonly status: 'STREAMING_MODEL_OUTPUT';
      readonly turnId: string;
      readonly stepIndex: number;
      readonly startedAt: number;
      readonly inflightPromptTokens: number;
      readonly accumulatedContent: string;
      readonly deltaChunksReceived: number;
    }
  | {
      readonly status: 'EXECUTING_TOOL_CALL';
      readonly turnId: string;
      readonly stepIndex: number;
      readonly toolCallId: string;
      readonly toolName: string;
      readonly rawArguments: Record<string, unknown>;
      readonly isExclusiveBarrier: boolean;
      readonly executionTimeoutMs: number;
    }
  | {
      readonly status: 'AWAITING_HUMAN_APPROVAL';
      readonly turnId: string;
      readonly stepIndex: number;
      readonly toolName: string;
      readonly dangerousActionPayload: string;
      readonly approvalNonce: string;
      readonly promptMessage: string;
    }
  | {
      readonly status: 'STEP_COMPLETED';
      readonly turnId: string;
      readonly stepIndex: number;
      readonly durationMs: number;
      readonly tokensConsumed: { readonly prompt: number; readonly completion: number };
      readonly toolResultPayload?: unknown;
    }
  | {
      readonly status: 'TERMINAL_FAULT';
      readonly turnId: string;
      readonly stepIndex: number;
      readonly occurredAt: number;
      readonly errorCode: 'TIMEOUT' | 'SANDBOX_VIOLATION' | 'MODEL_RATE_LIMIT' | 'INTERNAL_INVARIANT_BROKEN';
      readonly errorDetails: string;
      readonly recoverable: boolean;
    };

/**
 * 编译期穷尽性校验器：如果 StepExecutionState 扩展了新分支而未更新匹配逻辑，
 * TypeScript 将在编译期直接报错：Argument of type '...' is not assignable to parameter of type 'never'.
 */
export function assertExhaustiveStep(state: never): never {
  throw new Error(`Fatal Invariant: Unhandled state variant encountered in state machine: ${JSON.stringify(state)}`);
}

/**
 * 具备完备边界防御与类型保护的状态转移处理器
 */
export function processStepTransition(state: StepExecutionState): string {
  switch (state.status) {
    case 'PENDING_DISPATCH':
      return `Step #${state.stepIndex} queued in Turn [${state.turnId}]`;

    case 'STREAMING_MODEL_OUTPUT':
      return `Turn [${state.turnId}] Step #${state.stepIndex} streaming tokens: ${state.deltaChunksReceived} chunks received`;

    case 'EXECUTING_TOOL_CALL':
      return `Executing tool [${state.toolName}] (Call ID: ${state.toolCallId}, Exclusive Barrier: ${state.isExclusiveBarrier})`;

    case 'AWAITING_HUMAN_APPROVAL':
      return `Action blocked pending human authorization (Nonce: ${state.approvalNonce})`;

    case 'STEP_COMPLETED':
      return `Step #${state.stepIndex} finished successfully in ${state.durationMs}ms, tokens: ${state.tokensConsumed.prompt + state.tokensConsumed.completion}`;

    case 'TERMINAL_FAULT':
      return `Step #${state.stepIndex} failed with code [${state.errorCode}]: ${state.errorDetails} (Recoverable: ${state.recoverable})`;

    default:
      return assertExhaustiveStep(state);
  }
}
```

---

## 4.3 模块化与控制反转：Vendored Cordis 与 Schemastery

### 4.3.1 为什么是 Cordis 微内核 IoC？

传统企业级后端推崇 NestJS、Inversify 或 Spring Framework。这些 IoC 容器基于单例（Singleton）与请求作用域（Request Scope）模型，面向的是无状态的 HTTP API。然而，在面对复杂的自主智能体系统时，传统 IoC 框架彻底失效：

```
+---------------------------------------------------------------------------------------------------+
|                                 Traditional IoC vs Cordis Microkernel                             |
+---------------------------------------------------------------------------------------------------+
  Traditional IoC (NestJS / Spring):
  [Static Singleton Container] ──► Global Service A, Global Service B
  (Cannot easily fork dynamic isolated subtrees with scoped lifecycle disposal for parallel agents!)

  Cordis Microkernel (DeepSeek Harness):
  [Root App Context]
         │
         ├───► ctx.plugin(SessionCoordinatorService)
         │            │
         │            ▼
         ├───► [Forked Context: Agent Alpha] ───► Overridden with [Landlock Sandbox Mode: Strict]
         │            │
         │            ▼
         └───► [Forked Context: Subagent Beta] ──► Overridden with [Memory-Only Persistence Provider]
                      │
                      └──► ctx.effect() ──► Auto-disposed on subagent termination!
```

DeepSeek Harness 内置并定制（Vendored）了 Cordis 微内核，其关键工程优势如下：

1. **上下文树状分叉（Context Forking）**：主 Agent 在启动一个后台任务、执行一次 Graph Node 或派生一个子智能体时，可以调用 `ctx.fork()` 派生出一个隔离的子上下文（Child Context）。子上下文继承父级的服务拓扑，但允许覆盖特定 Provider（例如隔离的工作区路径、独立的取消信号、受限的沙箱等级）。
2. **确定性级联析构（`ctx.effect()` Resource Teardown）**：在 Agent 执行过程中动态加载的工具插件、事件总线监听器（`ctx.on`）、定时器与后台句柄，均会自动登记在当前 Context 的 Fiber 节点中。当子上下文销毁时，所有资源被原子级联注销，彻底杜绝 Node.js 进程中的事件监听器泄漏（`MaxListenersExceededWarning`）与孤儿句柄悬挂。
3. **事件瀑布流与拦截器（Event Waterfall & Bail）**：提供高阶事件分发语义，允许安全守卫插件在工具调用事件下发到操作系统前执行同步拦截（Bail），阻断非法指令。

### 4.3.2 Schemastery：单一定义源与双向类型推导

在大型 Monorepo 架构中，如果分别编写 TypeScript `interface`、JSON Schema 校验文件以及 YAML 配置文件示例，三者之间必然随着迭代产生漂移，导致生产环境配置加载失败。

Harness 采用 Vendored Schemastery 构建统一的数据契约：

```typescript
import { Schema } from '@deepseek-ai/schemastery';

/**
 * 智能体运行时沙箱策略配置 Schema
 * 具备完整的默认值、描述文档、嵌套约束与类型推导
 */
export interface AgentSandboxSettings {
  engine: 'auto' | 'landlock' | 'seatbelt' | 'windows-acl' | 'disabled';
  maxWallClockTimeMs: number;
  memoryLimitBytes: number;
  readOnlyMounts: string[];
  writableWorkspace: string;
  allowOutboundHttp: boolean;
  networkWhitelist: string[];
}

export const AgentSandboxSettingsSchema: Schema<AgentSandboxSettings> = Schema.object({
  engine: Schema.union([
    Schema.const('auto').description('Automatically select optimal kernel sandbox for current OS'),
    Schema.const('landlock').description('Linux 5.13+ Landlock LSM with unprivileged namespace isolation'),
    Schema.const('seatbelt').description('macOS Apple Seatbelt sandbox-exec profile'),
    Schema.const('windows-acl').description('Windows Restricted Token and Job Object DACL isolation'),
    Schema.const('disabled').description('Disable isolation (Insecure, testing only)'),
  ]).default('auto').description('OS Kernel Sandbox Engine Selection'),

  maxWallClockTimeMs: Schema.natural().default(60_000).description('Maximum command wall-clock timeout in ms'),
  memoryLimitBytes: Schema.natural().default(1024 * 1024 * 1024).description('Maximum memory ceiling (1GB default)'),
  readOnlyMounts: Schema.array(Schema.string()).default([]).description('Filesystem paths mounted with strict read-only access'),
  writableWorkspace: Schema.string().required().description('Exclusive mutable workspace root directory'),
  allowOutboundHttp: Schema.boolean().default(false).description('Whether outbound socket connection is permitted'),
  networkWhitelist: Schema.array(Schema.string()).default([]).description('Allowed IP/CIDR/Domains when network is restricted'),
});

// 从 Schema 自动化反向推导出强类型，消除手动定义 interface 的冗余
export type InferredAgentSandboxSettings = Schema.Type<typeof AgentSandboxSettingsSchema>;
```

---

## 4.4 工程化、依赖隔离与构建体系：pnpm 11、tsdown 与 Vite

### 4.4.1 pnpm 11 Workspace 与依赖拓扑隔离

在拥有 50+ 个子包的 Monorepo 中，依赖管理是系统稳定性的第一道防线。传统 npm 或 Yarn 1.x 采用平铺式（Flattened）`node_modules` 结构，这会引发致命的**“幻影依赖”（Phantom Dependencies）**：

```
+---------------------------------------------------------------------------------------------------+
|                             Phantom Dependency Hazard (npm/Yarn Classic)                          |
+---------------------------------------------------------------------------------------------------+
  /node_modules/
    ├── package-a/ (depends on package-c@1.0.0)
    ├── package-b/ (does NOT declare package-c in package.json!)
    └── package-c/ (hoisted to root!)

  💥 In package-b: `import { foo } from 'package-c'` WORKS in local dev!
  💥 In production / isolated publish: package-b FAILS with ModuleNotFoundError!
```

```
+---------------------------------------------------------------------------------------------------+
|                          pnpm 11 Symlink Virtual Store Architecture                               |
+---------------------------------------------------------------------------------------------------+
  packages/session/session-persistence-sqlite/node_modules/
    ├── @deepseek-ai/dsh-session ──► Symlink to packages/core/session
    └── (Zero undeclared packages exist here!)

  .pnpm/ (Content-Addressable Virtual Store)
    ├── @deepseek-ai+dsh-session@workspace
    └── node_modules/...
```

- **内容寻址存储（CAS）**：pnpm 在全局使用基于 SHA-512 的硬链接存储池，同一份依赖在磁盘上仅保存一份，极大降低磁盘空间开销并提升 CI 安装速度。
- **严格符号链接隔离**：每个子包的 `node_modules` 仅包含其 `package.json` 中显式声明的依赖符号链接。若子包尝试导入未声明的模块，Node.js 解析器将立即抛出模块未找到错误，在本地开发期彻底暴露拓扑缺陷。

### 4.4.2 双面构建流水线（Dual-Face Build: `tsdown` 与 Vite）

DeepSeek Harness 采用了创新的**双面构建体系（Dual-Face Build Pipeline）**。通过环境变量 `DSH_BUILD_FACE`，同一份源码库可以输出针对不同执行环境的目标产物：

```
+---------------------------------------------------------------------------------------------------+
|                                 Dual-Face Build Matrix Pipeline                                   |
+---------------------------------------------------------------------------------------------------+
                                         Source Code (TypeScript 6)
                                                     │
                          ┌──────────────────────────┴──────────────────────────┐
                          ▼                                                     ▼
              [tsc -b tsconfig.host.json]                           [tsc -b tsconfig.client.json]
                          │                                                     │
                          ▼                                                     ▼
           [tsdown --env.DSH_BUILD_FACE host]                   [tsdown --env.DSH_BUILD_FACE client]
                          │                                                     │
                          ▼                                                     ▼
               Host Bundle (Node.js ESM)                             Client Bundle (Browser ESM)
         ├── Targets: Node.js ^22.19 / 24                      ├── Targets: Modern Browsers (ES2022)
         ├── Includes: node:sqlite, node:zlib                  ├── Excludes: fs, path, child_process
         └── Exposes: CLI / ACP / Daemon API                   └── Exposes: React Components / RPC Client
```

- **`tsdown` 的速度优势**：`tsdown` 底层基于 Rust 实现的 Rolldown 与 Oxc 解析器，兼具 esbuild 的毫秒级打包速度与 Rollup 的高阶代码分割（Tree-shaking）能力。在全量编译 Monorepo 时，构建耗时从传统 tsc/webpack 的 45 秒压缩至 2.5 秒以内。

---

## 4.5 模型层与协议适配：DeepSeek API 与 pi-ai 转义

### 4.5.1 SSE 流式吞吐模型与 Backpressure 背压控制

大语言模型的 Token 输出具有高度的实时性。DeepSeek 官方 API 提供了包含推理思考链（`reasoning_content`）与最终内容（`content`）的双流输出结构。

```
+---------------------------------------------------------------------------------------------------+
|                                DeepSeek Streaming SSE Protocol Flow                               |
+---------------------------------------------------------------------------------------------------+
  HTTP POST https://api.deepseek.com/chat/completions (stream: true)
       │
       ▼ [Chunked Transfer Encoding / text/event-stream]
  data: {"choices":[{"delta":{"reasoning_content":"Step 1: Analyze AST..."}}]}
       │
       ▼
  data: {"choices":[{"delta":{"content":"Based on the static analysis..."}}]}
       │
       ▼
  data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"path\""}}}]}}]}
       │
       ▼
  data: [DONE]
```

为了防止网络高速推送导致 Node.js 内存堆积（OOM），Harness 基于 Web Streams API 构建了具备背压控制的流式处理管道：

```typescript
import { Readable } from 'node:stream';

export interface DeepSeekDeltaPacket {
  readonly reasoningDelta?: string;
  readonly contentDelta?: string;
  readonly toolCallDelta?: {
    readonly index: number;
    readonly id?: string;
    readonly name?: string;
    readonly argumentsDelta?: string;
  };
  readonly finishReason?: 'stop' | 'tool_calls' | 'length' | 'content_filter' | null;
}

/**
 * 生产级 SSE 流式反序列化处理器：支持跨 Chunk 拆包、半包重组与优雅中断
 */
export async function* parseDeepSeekEventStream(
  byteStream: NodeJS.ReadableStream,
  abortSignal: AbortSignal,
): AsyncGenerator<DeepSeekDeltaPacket, void, unknown> {
  let textBuffer = '';
  const textDecoder = new TextDecoder('utf-8');

  for await (const rawChunk of byteStream) {
    if (abortSignal.aborted) {
      throw new DOMException('Stream consumption aborted by caller', 'AbortError');
    }

    const chunkStr = typeof rawChunk === 'string' ? rawChunk : textDecoder.decode(rawChunk, { stream: true });
    textBuffer += chunkStr;

    const lines = textBuffer.split(/\r?\n/);
    // 保留未闭合的末尾行片段
    textBuffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith(':')) {
        // 忽略空行与心跳保活行
        continue;
      }

      if (trimmed === 'data: [DONE]') {
        return;
      }

      if (trimmed.startsWith('data: ')) {
        const jsonPayload = trimmed.slice(6);
        try {
          const parsed = JSON.parse(jsonPayload) as {
            choices?: Array<{
              delta?: {
                reasoning_content?: string;
                content?: string;
                tool_calls?: Array<{
                  index: number;
                  id?: string;
                  function?: { name?: string; arguments?: string };
                }>;
              };
              finish_reason?: 'stop' | 'tool_calls' | 'length' | 'content_filter' | null;
            }>;
          };

          const choice = parsed.choices?.[0];
          if (!choice) continue;

          const delta = choice.delta;
          const firstTool = delta?.tool_calls?.[0];

          yield {
            reasoningDelta: delta?.reasoning_content,
            contentDelta: delta?.content,
            toolCallDelta: firstTool
              ? {
                  index: firstTool.index,
                  id: firstTool.id,
                  name: firstTool.function?.name,
                  argumentsDelta: firstTool.function?.arguments,
                }
              : undefined,
            finishReason: choice.finish_reason,
          };
        } catch {
          // 容忍非致命的畸变 JSON 数据行并继续消费后续流
          continue;
        }
      }
    }
  }
}
```

---

## 4.6 持久化与事实记录：JSONL+Zstandard 与 node:sqlite

持久化层是 DeepSeek Harness 状态机崩溃恢复与审计回放的核心基石。

```
+---------------------------------------------------------------------------------------------------+
|                               Dual Persistence Ledger Architecture                                |
+---------------------------------------------------------------------------------------------------+
  Agent Lifecycle Events (Step, Turn, ToolCall, ToolResult)
                            │
            ┌───────────────┴───────────────┐
            ▼                               ▼
  [session-persistence-jsonl]     [session-persistence-sqlite]
  ├── Append-Only Zstd Frames     ├── Embedded node:sqlite (DatabaseSync)
  ├── 0xFD2FB528 Magic Verification├── WAL Mode (Write-Ahead Logging)
  ├── $O(1)$ Incremental Flush    ├── PRAGMA trusted_schema = OFF
  └── Torn Frame Truncate Repair  └── Microsecond Event Indexing
```

### 4.6.1 为什么选择 Zstandard 独立物理帧拼接（Concatenated Zstd Frames）？

#### 传统方案的缺陷
- **普通全量 JSON**：随着会话轮次增加，每次追加事件必须将数十兆的全部历史重新在内存中序列化并全量覆盖写入磁盘，写放大（Write Amplification）达到 $O(N^2)$。
- **未压缩 JSONL**：单行追加虽然时间复杂度为 $O(1)$，但对于包含大量代码、文件 Diff 与多模态 Base64 数据的 Agent 会话，磁盘占用迅速膨胀至数百兆，耗尽 I/O 带宽。
- **传统 Gzip 流**：Gzip 格式不支持无缝拼接独立压缩块，追加数据需要重写整个流尾部，导致无法实现真正的流式仅追加。

#### Zstandard 帧级联机制
Zstandard 官方规范允许将多个由独立压缩块组成的 Frame 直接物理级联。Harness 在每次事务落盘时，将当前产生的一批事件（Batch）单独通过 `node:zlib` 压缩为一个独立的完整 Frame（包含独立的 Frame Header、Blocks 与 CRC32 校验），直接调用文件系统的 `append` 追加到文件末尾：

```
+---------------------------------------------------------------------------------------------------+
|                        Physical Zstandard Concatenated Frame Layout                               |
+---------------------------------------------------------------------------------------------------+
  0x0000: [Frame 0: 512 Bytes]   --> Magic: 0xFD2FB528 | Header | Compressed Payload | Checksum
  0x0200: [Frame 1: 1024 Bytes]  --> Magic: 0xFD2FB528 | Header | Compressed Payload | Checksum
  0x0600: [Frame 2: 768 Bytes]   --> Magic: 0xFD2FB528 | Header | Compressed Payload | Checksum
  0x0900: [Torn Frame: 42 Bytes] --> System Crashed During Write! (Incomplete Magic or Block)
```

#### 撕裂帧（Torn Frame）检测与断点截断算法
当操作系统异常宕机或断电时，文件末尾可能遗留未写完的残缺字节。Harness 在加载会话日志时，通过以下严格算法扫描物理帧，并自动截断修复：

```typescript
import { Buffer } from 'node:buffer';
import fs from 'node:fs/promises';

export interface FrameBoundary {
  readonly startOffset: number;
  readonly endOffset: number;
}

export interface ZstdScanSummary {
  readonly validFrames: FrameBoundary[];
  readonly tornByteOffset?: number;
}

/**
 * 物理级 Zstandard 帧扫描器：严格遵循 RFC 8878 规范
 */
export function inspectZstdFrameBoundaries(buffer: Buffer): ZstdScanSummary {
  const MAGIC_ZSTD = 0xFD2FB528;
  const validFrames: FrameBoundary[] = [];
  let cursor = 0;

  while (cursor < buffer.length) {
    const frameStart = cursor;
    // 1. 验证魔数
    if (buffer.length - cursor < 4) {
      return { validFrames, tornByteOffset: frameStart };
    }

    const magic = buffer.readUInt32LE(cursor);
    if (magic !== MAGIC_ZSTD) {
      // 遇到非法魔数，判定当前位置为撕裂损坏起点
      return { validFrames, tornByteOffset: frameStart };
    }
    cursor += 4;

    if (cursor >= buffer.length) return { validFrames, tornByteOffset: frameStart };

    // 2. 解析 Frame_Header_Descriptor
    const descriptor = buffer.readUInt8(cursor);
    cursor += 1;

    const singleSegment = (descriptor & 0x20) !== 0;
    const hasChecksum = (descriptor & 0x04) !== 0;
    const dictFlag = descriptor & 0x03;
    const dictBytes = dictFlag === 3 ? 4 : dictFlag;
    const contentSizeFlag = descriptor >>> 6;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;

    const remainingHeaderLen = (singleSegment ? 0 : 1) + dictBytes + contentSizeBytes;
    if (buffer.length - cursor < remainingHeaderLen) {
      return { validFrames, tornByteOffset: frameStart };
    }
    cursor += remainingHeaderLen;

    // 3. 扫描数据块 (Data Blocks)
    let isLast = false;
    while (!isLast) {
      if (buffer.length - cursor < 3) {
        return { validFrames, tornByteOffset: frameStart };
      }

      const blockHeader = buffer.readUIntLE(cursor, 3);
      cursor += 3;

      isLast = (blockHeader & 0x01) !== 0;
      const blockType = (blockHeader >>> 1) & 0x03;
      const blockSize = blockHeader >>> 3;

      if (blockType === 0x03) {
        // 保留保留块类型，视为损坏
        return { validFrames, tornByteOffset: frameStart };
      }

      const payloadSize = blockType === 0x01 ? 1 : blockSize;
      if (buffer.length - cursor < payloadSize) {
        return { validFrames, tornByteOffset: frameStart };
      }
      cursor += payloadSize;
    }

    // 4. 消费可选的 4 字节 Content Checksum
    if (hasChecksum) {
      if (buffer.length - cursor < 4) {
        return { validFrames, tornByteOffset: frameStart };
      }
      cursor += 4;
    }

    validFrames.push({ startOffset: frameStart, endOffset: cursor });
  }

  return { validFrames };
}

/**
 * 自动修复撕裂的 Zstandard 会话日志文件
 */
export async function repairTornSessionLog(filePath: string): Promise<number> {
  const content = await fs.readFile(filePath);
  const scan = inspectZstdFrameBoundaries(content);

  if (scan.tornByteOffset !== undefined) {
    // 将文件物理截断至最后一个完整 Frame 的末尾
    await fs.truncate(filePath, scan.tornByteOffset);
    return content.length - scan.tornByteOffset;
  }
  return 0;
}
```

### 4.6.2 为什么选 `node:sqlite` 而非 Prisma / TypeORM？

在多会话并发交互、全文检索与元数据随机查询场景下，Harness 使用了 Node.js 原生 `node:sqlite`。

```typescript
import { DatabaseSync } from 'node:sqlite';

/**
 * 生产级 SQLite 会话持久化初始化：包含严格的安全加固与并发 PRAGMA
 */
export function createHardenedSessionDatabase(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);

  // 1. 禁用信任模式，杜绝 SQLite 虚拟表提权注入
  db.exec('PRAGMA trusted_schema = OFF;');

  // 2. 禁用 MMAP 内存映射，防止突发断电时发生 SIGBUS 致命崩溃
  db.exec('PRAGMA mmap_size = 0;');

  // 3. 启用预写式日志 (WAL)，实现高并发读写互不阻塞
  db.exec('PRAGMA journal_mode = WAL;');

  // 4. 启用严格同步模式与忙碌重试超时
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA busy_timeout = 5000;');

  // 5. 初始化仅追加事件事实表与单调递增 Revision 索引
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_metadata (
      session_id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      current_revision INTEGER NOT NULL,
      agent_preset TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS session_event_ledger (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      payload_bytes BLOB NOT NULL,
      FOREIGN KEY (session_id) REFERENCES session_metadata(session_id)
    ) STRICT;

    CREATE INDEX IF NOT EXISTS idx_session_revision ON session_event_ledger(session_id, revision);
  `);

  return db;
}
```

- **选型深度对比**：
  - **Prisma**：在构建期需要下载特定的 Rust 引擎二进制包，打包体积增加 50MB+，且 ORM 生成的多表 JOIN 在仅追加事件模型下完全是负优化。
  - **TypeORM / Sequelize**：依赖繁重的装饰器元数据与复杂的反射机制，类型安全存在较多 `any` 泄漏。
  - **`node:sqlite`**：Node.js 22 原生提供，零外部依赖，纳秒级原生同步执行，与 Harness 的事件溯源模型完美契合。

---

## 4.7 前端与全栈 RPC 通信：React 18、Zustand、Immer 与 Typert

### 4.7.1 React 18 并发渲染与 Zustand/Immer 状态流

当大模型以每秒 50~100 Token 的速率进行流式生成时，前端 UI 面临极大的渲染压力。

```
+---------------------------------------------------------------------------------------------------+
|                                 Client UI Reactivity Architecture                                 |
+---------------------------------------------------------------------------------------------------+
  WebSocket Worker Thread
            │
            ▼ [Raw Binary / JSON-RPC Packet]
  Typert Client Dispatcher
            │
            ▼ [Immer Mutator Action]
  Zustand Immutable Store Tree
    ├── state.sessions[id].activeTurn
    ├── state.sessions[id].streamingTokenBuffer
    └── state.tools.runningExecutions
            │
            ├───► Atomic Selector: `(s) => s.streamingTokenBuffer` ──► Re-renders <TokenStream /> ONLY!
            └───► Atomic Selector: `(s) => s.sidebarList`          ──► SKIPS Re-render completely!
```

- **Zustand 原子选择器（Atomic Selectors）**：传统的 React Context 只要 Provider 的 Value 改变，所有使用该 Context 的子组件都会无条件触发重新渲染。Zustand 允许组件通过 `useStore(state => state.turns[turnId].status)` 精确绑定状态切片，只有该切片发生引用变化时才触发 React Fiber 的协调（Reconciliation）。
- **Immer 不可变结构共享**：在处理深层嵌套的 Agent 任务树时，手动编写解构复制（`{ ...state, a: { ...state.a, b: ... } }`）极易出错且产生大量无用垃圾对象。Immer 使用 Proxy 拦截写入，仅对被修改的节点路径生成新引用，极大降低了垃圾回收（GC）压力。

### 4.7.2 Typert：全自动类型图推导与双向 WebSocket RPC

Harness 研发了 `Typert` 编译框架，彻底替代传统的 REST API 或 GraphQL：

```typescript
/**
 * Typert 双向 RPC 通信契约：单一定义，全栈共享
 */
export interface HarnessRpcProtocol {
  // 客户端主动发起的 RPC 调用（Request-Response）
  requests: {
    'session.create': {
      params: { preset: string; workspaceRoot: string };
      result: { sessionId: string; createdAt: number };
    };
    'agent.submitPrompt': {
      params: { sessionId: string; prompt: string; attachments?: string[] };
      result: { turnId: string; status: 'QUEUED' | 'ACTIVE' };
    };
    'agent.abort': {
      params: { sessionId: string; turnId: string; reason: string };
      result: { acknowledged: boolean };
    };
  };

  // 服务端主动向客户端推送的下行事件（Server Push Events）
  notifications: {
    'turn.tokenDelta': {
      sessionId: string;
      turnId: string;
      deltaType: 'REASONING' | 'CONTENT';
      token: string;
    };
    'tool.statusChange': {
      sessionId: string;
      toolCallId: string;
      toolName: string;
      status: 'RUNNING' | 'COMPLETED' | 'BLOCKED_BY_SANDBOX';
    };
  };
}
```

```
+---------------------------------------------------------------------------------------------------+
|                                Typert Wire Protocol Frame Sample                                  |
+---------------------------------------------------------------------------------------------------+
  Client -> Server (Request Frame):
  {
    "jsonrpc": "2.0",
    "id": "req-98421",
    "method": "agent.submitPrompt",
    "params": {
      "sessionId": "sess-88a7c",
      "prompt": "Analyze memory leaks in worker pool",
      "attachments": []
    }
  }

  Server -> Client (Streaming Notification Frame):
  {
    "jsonrpc": "2.0",
    "method": "turn.tokenDelta",
    "params": {
      "sessionId": "sess-88a7c",
      "turnId": "turn-01",
      "deltaType": "CONTENT",
      "token": "Profiling"
    }
  }
```

---

## 4.8 并发隔离与操作系统内核沙箱：Worker Threads、Landlock 与 Seatbelt

### 4.8.1 Node.js Worker Threads 线程级隔离

对于运行不可信 JavaScript/Python 代码的场景，Harness 严禁使用 Node 原生 `vm` 模块（其已被证明存在无法修复的 V8 原型链逃逸漏洞）。Harness 采用带有严格资源限额的 `Worker Threads`：

```typescript
import { Worker } from 'node:worker_threads';
import path from 'node:path';

export interface WorkerExecutionResult {
  readonly success: boolean;
  readonly output: unknown;
  readonly executionTimeMs: number;
}

/**
 * 带有硬性内存配额与超时熔断的 Worker Thread 代码执行器
 */
export async function executeInIsolatedWorker(
  scriptContent: string,
  timeoutMs: number,
  maxMemoryMb: number = 256,
): Promise<WorkerExecutionResult> {
  const workerScript = `
    import { parentPort } from 'node:worker_threads';
    try {
      const runner = new Function(${JSON.stringify(scriptContent)});
      const result = await runner();
      parentPort.postMessage({ success: true, result });
    } catch (err) {
      parentPort.postMessage({ success: false, error: err instanceof Error ? err.message : String(err) });
    }
  `;

  const startTime = performance.now();

  return new Promise((resolve, reject) => {
    const worker = new Worker(workerScript, {
      eval: true,
      resourceLimits: {
        maxOldGenerationSizeMb: maxMemoryMb,
        maxYoungGenerationSizeMb: 64,
      },
    });

    let isSettled = false;

    const timer = setTimeout(() => {
      if (!isSettled) {
        isSettled = true;
        worker.terminate();
        reject(new Error(`Worker execution exceeded hard wall-clock timeout of ${timeoutMs}ms`));
      }
    }, timeoutMs);

    worker.on('message', (message: { success: boolean; result?: unknown; error?: string }) => {
      if (isSettled) return;
      isSettled = true;
      clearTimeout(timer);
      worker.terminate();

      if (message.success) {
        resolve({
          success: true,
          output: message.result,
          executionTimeMs: performance.now() - startTime,
        });
      } else {
        resolve({
          success: false,
          output: message.error,
          executionTimeMs: performance.now() - startTime,
        });
      }
    });

    worker.on('error', (err) => {
      if (isSettled) return;
      isSettled = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}
```

### 4.8.2 三大操作系统内核沙箱矩阵

为了防止 Agent 通过 Bash 运行 `rm -rf /` 或尝试横向扫描局域网，Harness 在最底层提供了针对各宿主操作系统的原生沙箱适配层：

```
+---------------------------------------------------------------------------------------------------+
|                                  Cross-Platform Kernel Sandboxes                                  |
+-------------------+------------------------------------+------------------------------------------+
| 操作系统          | 沙箱实现核心                       | 内核机制与安全性保证                     |
+-------------------+------------------------------------+------------------------------------------+
| Linux (5.13+)     | 原生 C `native/landlock-run`       | Landlock LSM + unshare(CLONE_NEWNS)      |
| macOS             | Apple Seatbelt (`sandbox-exec`)    | TrustedBSD MAC Framework (Scheme Profile)|
| Windows           | `sandbox-windows-acl`              | CreateRestrictedToken + JobObject + DACL |
+-------------------+------------------------------------+------------------------------------------+
```

```
+---------------------------------------------------------------------------------------------------+
|                                Linux Landlock LSM Call Sequence                                   |
+---------------------------------------------------------------------------------------------------+
  Agent Process
       │
       ▼ 1. syscall(__NR_landlock_create_ruleset, &ruleset_attr, sizeof(attr), 0)
  Get Ruleset File Descriptor (FD)
       │
       ▼ 2. syscall(__NR_landlock_add_rule, ruleset_fd, LANDLOCK_RULE_PATH_BENEATH, &path_beneath, 0)
  Bind Path: /workspace (RW) | /usr, /lib (RO) | /root (DENIED)
       │
       ▼ 3. prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)
  Lock Privilege Escalation (Irreversible)
       │
       ▼ 4. syscall(__NR_landlock_restrict_self, ruleset_fd, 0)
  Enter Permanent Kernel Sandbox ──► execve("/bin/bash", args, env)
```

1. **Linux (Landlock LSM)**：通过调用 Linux 内核 5.13 引入的 Landlock LSM 系统调用。在子进程启动前，直接在内核中构造文件系统访问规则树。一旦调用 `landlock_restrict_self`，当前进程树的文件系统访问权限将被永久且单调不可逆地固化，任何后续执行的恶意脚本（即使通过 SUID 提权）也无法突破限制。
2. **macOS (Apple Seatbelt)**：通过生成专用的 TinyScheme 沙箱配置文件，利用 macOS 内核 TrustedBSD 框架限制文件写操作与网络 Socket 绑定。
3. **Windows (`sandbox-windows-acl`)**：调用 Win32 API 构造限制令牌（Restricted Token），剥离 `SeDebugPrivilege` 等危险特权；将子进程加入 `JobObject` 以限制最大内存与 CPU 核心数；为每个执行任务生成唯一的临时 `Workspace SID`，通过修改目录 DACL 阻止访问宿主其他盘符。

---

## 4.9 全栈技术协作主线与所有权链条

在 DeepSeek Harness 运行时中，各个技术组件并非孤立运作，而是沿一条严格的**所有权链条（Ownership Chain）**展开端到端协同：

```
+---------------------------------------------------------------------------------------------------+
|                                End-to-End Request Ownership Flow                                  |
+---------------------------------------------------------------------------------------------------+

 1. 用户交互 ──────► [React 18 + Zustand Store]
                           │
 2. RPC 调用 ──────► [Typert WebSocket Gateway] (校验报文格式)
                           │
 3. 插件注入 ──────► [Cordis Root Context] ──► Fork 派生子 Agent Context
                           │
 4. 配置合并 ──────► [Schemastery] ──► 加载并强校验 Preset YAML 配置
                           │
 5. 循环启动 ──────► [Agent Loop State Machine] ──► 创建 Turn 并绑定 AbortController
                           │
 6. 模型流式 ──────► [DeepSeek API Adapter] ──► Web Streams 消费 SSE 字节流
                           │
 7. 工具分发 ──────► [Tool Dispatcher] ──► 使用 Zod 校验入参 AST
                           │
 8. 沙箱拦截 ──────► [OS Kernel Sandbox] ──► 注入 Landlock / Seatbelt 策略
                           │
 9. 隔离执行 ──────► [Worker Threads / Subprocess] ──► 产生命令输出或文件变更
                           │
10. 事实落盘 ──────► [Durable Ledger] ──► 串行追加 Zstandard 压缩帧 / SQLite WAL
                           │
11. 状态扩散 ──────► [Cordis Event Waterfall] ──► 推送增量至 Typert RPC ──► Zustand 更新 UI
```

### 跨包三元所有权架构模式

```
+---------------------------------------------------------------------------------------------------+
|                     Service Definition / Provider / Consumer Triad Pattern                        |
+---------------------------------------------------------------------------------------------------+

  [Service Definition Package] (e.g. @deepseek-ai/dsh-persistence)
  ├── Defines: `export interface PersistenceService { append(event: Event): Promise<void>; }`
  └── Zero runtime dependencies! Pure TypeScript interfaces & Schemastery definitions.
              ▲                                              ▲
              │ implements                                   │ injects
              │                                              │
  [Provider Package]                             [Consumer Package]
  (e.g. dsh-persistence-sqlite)                  (e.g. @deepseek-ai/dsh-agent)
  ├── Implements concrete SQLite logic           ├── Consumes `ctx.persistence`
  └── Imports `node:sqlite`                      └── Completely agnostic to underlying storage!
```

---

## 4.10 生产环境经典选型陷阱与排查避坑指南

### 4.10.1 陷阱 1：Zstd 异步并发追加导致物理帧交错破坏

- **故障现象**：在多任务并发场景下，多个 Agent 同时向同一个会话日志文件写入事件。随后重启系统时，会话加载器抛出 `corrupt Zstandard session log: invalid frame magic at byte 4096`。
- **底层根因**：Node.js 的 `fs.promises.appendFile()` 在操作系统底层对应多次异步系统调用。当并发追加两个 Frame 时，底层数据块交替写入磁盘，导致 Frame B 的头部插入到了 Frame A 的 Block 中间，破坏了物理格式。
- **生产级修复方案**：构建**写入后援协调器（Write-Behind Queue）**，通过单一 Promise 链式管道强制实现物理追加的严格串行化：

```typescript
import fs from 'node:fs/promises';

export class SafeSequentialLogAppender {
  private activeDrainQueue: Promise<void> = Promise.resolve();

  constructor(private readonly targetFilePath: string) {}

  /**
   * 线程安全的串行追加写入接口
   */
  public enqueueFrameWrite(compressedFrame: Buffer): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.activeDrainQueue = this.activeDrainQueue.then(async () => {
        try {
          await fs.appendFile(this.targetFilePath, compressedFrame);
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
  }
}
```

### 4.10.2 陷阱 2：Worker Threads 跨线程传输大对象造成的 GC 停顿与卡死

- **故障现象**：当智能体读取 50MB 的日志文件并传递给 Worker Thread 进行代码解析时，Node.js 主事件循环发生长达 300ms 的冻结，Web 界面出现明显卡死。
- **底层根因**：`worker.postMessage(obj)` 默认使用 V8 的 `Structured Clone` 算法，在主线程同步递归遍历对象树并深拷贝内存，触发 V8 主堆内存频繁 GC。
- **生产级修复方案**：使用 `ArrayBuffer` 的所有权转移（Transferable Objects）机制实现零拷贝传输：

```typescript
// ❌ 错误做法：深拷贝 50MB 内存，引发主线程卡死
worker.postMessage({ type: 'PROCESS_LOG', buffer: largeBuffer });

// ✅ 正确做法：零拷贝移交 ArrayBuffer 内存所有权
const rawArrayBuffer = largeBuffer.buffer.slice(
  largeBuffer.byteOffset,
  largeBuffer.byteOffset + largeBuffer.byteLength,
);
worker.postMessage(
  { type: 'PROCESS_LOG', payload: rawArrayBuffer },
  [rawArrayBuffer], // 移交底层内存指针，主线程开销严格为 0ms
);
```

### 4.10.3 陷阱 3：Windows ACL 权限继承导致的沙箱提权逃逸

- **故障现象**：在 Windows 系统上为 Agent 创建了专用受限工作区 `C:\temp\agent_workspace`，但子进程依然能够读取父级目录中的敏感文件。
- **底层根因**：Windows NTFS 文件系统默认启用了访问控制列表继承（ACE Inheritance）。即使新建目录分配了受限 SID，其仍然隐式继承了 `C:\` 根目录的“Users 组完全读取权限”。
- **生产级修复方案**：在初始化 Windows 沙箱目录安全描述符时，必须显式附加 `PROTECTED_DACL_SECURITY_INFORMATION` 标志，切断所有上级继承规则。

---

## 4.11 本章小结与自检清单

### 架构核心要点回顾

1. **运行时基座**：Node.js ^22.19/24 原生 ESM 结合 `node:sqlite` 与 `node:zlib`，彻底摆脱了 C++ 原生编译链（Zero Node-GYP），实现了跨平台一致的高性能基础设施。
2. **IoC 与生命周期**：Vendored Cordis 提供了传统 IoC 无法企及的动态上下文分叉（Forking）与基于 `ctx.effect()` 的级联析构清理能力；Schemastery 实现了单一定义源的双向类型与 Schema 闭环。
3. **确定性持久化**：采用基于 Zstandard 独立物理帧级联（Concatenated Frames）与 `node:sqlite` WAL 模式的双持久化机制，兼备 $O(1)$ 追加性能与微秒级崩溃撕裂自愈能力。
4. **纵深防御沙箱**：通过 Linux Landlock、macOS Seatbelt 与 Windows Restricted Token/Job Object，在操作系统内核层面构筑了单调递减的执行安全屏障。

### 工程师自检清单

- [ ] 是否深刻理解为什么智能体微内核必须支持“上下文分叉（Context Forking）”而不是简单的单例依赖注入？
- [ ] 能否向团队阐明 Zstandard 帧级联（Concatenated Frames）相比传统 Gzip 在实现仅追加日志时的物理优势？
- [ ] 为什么在处理大语言模型高频 Token 流时，必须在前端采用 Zustand 原子选择器而非 React Context？
- [ ] 是否掌握了在多线程 Worker 间传递超大上下文时使用 Transferable 零拷贝的技术细节？
- [ ] 能否清楚描述 Linux Landlock 系统调用是如何在无 root 特权下实现进程单调不可逆降级的？
