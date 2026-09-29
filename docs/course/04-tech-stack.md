# Chapter 04: The Technology Stack

English | [中文](04-tech-stack.zh.md)

In conventional enterprise software engineering, technology choices determine not just throughput and development efficiency but also the system's physical fault-isolation domains and security boundaries. Building a production-grade autonomous agent harness is far more than calling an LLM API and assembling prompts. It requires precise systems-engineering tradeoffs in operating-system calls, kernel-level process sandboxing, asynchronous I/O scheduling, immutable event persistence, and end-to-end type contracts at microsecond scale.

This chapter examines DeepSeek Harness's full-stack technology choices from a software-engineering and systems-programming perspective. Instead of AI marketing language, it examines operating-system data structures, memory models, and system-call abstractions; explains why each choice was preferred to common alternatives; and traces the ownership and coordination relationships among components.

---

## 4.1 Architecture Overview: Selection Principles and System Layers

### 4.1.1 The Layered Agent Runtime from a Systems-Programming Perspective

In a layered computer-system model, DeepSeek Harness is a **specialized agent microkernel runtime above the operating system's user-space layer**. Its fundamental task is to manage a nondeterministic probabilistic computing component (the LLM) within deterministic, auditable, strongly isolated operating-system abstractions.

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

### 4.1.2 Four Technology-Selection Rules

Four systems-engineering rules govern DeepSeek Harness's architectural decisions:

1. **No host-environment pollution**: A standard Node.js runtime should suffice to start the full development and production environment. Avoid global daemons such as Docker and platform-dependent native C++ compilation during installation (`node-gyp` and Python build dependencies).
2. **Deterministic event sourcing**: The append-only log is the sole source of truth for Session state. UI state, in-memory snapshots, and context windows are derivatives computed from the event ledger by pure projections.
3. **Defense in depth and monotonic privilege reduction**: Every model-triggered operating-system interaction must pass argument validation, permission interception, and kernel-level sandboxing. A spawned subagent's sandbox permissions may only stay the same or narrow; they must never escalate.
4. **End-to-end compile-time and runtime typing**: Strong types apply throughout, from Cordis domain service declarations, Schemastery configuration, and Zod tool arguments to frontend/backend WebSocket RPC messages and the React state bus.

### 4.1.3 Technology-Stack Comparison Table

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

## 4.2 Language and Runtime: Node.js ESM and TypeScript 6

### 4.2.1 Why Native ESM on Node.js ^22.19 / 24?

DeepSeek Harness pins its runtime in the root `package.json` to `"engines": { "node": "^22.19.0 || >=24.0.0" }` and uses `"type": "module"` throughout the monorepo. The decision follows from these system-level considerations:

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

#### 1. Eliminating Native C++ Build Dependencies (No Node-GYP)
Before Node.js 22, high-performance SQLite and Zstandard compression in Node commonly required third-party native extensions such as `better-sqlite3` and `node-zstd`. Cross-platform installation then invoked Python and Visual Studio C++ or GCC toolchains through `node-gyp`. Missing build tools, a mismatched glibc version, or a Node ABI change could stop installation.

Node.js 22.19+ includes `node:sqlite`, with its synchronous `DatabaseSync` class, and native Zstd support in `node:zlib`. Harness uses these facilities to provide **installation in seconds with a TypeScript/JavaScript-based distribution**.

#### 2. Why the Architecture Uses ESM Throughout
CommonJS (CJS) historically uses synchronous `require()`. That creates three problems for a modern agent system:
- **No native top-level await**: Plugins and configuration may need asynchronous setup while modules load, such as initializing remote configuration or loading a security policy. CJS pushes this work into an extra `init()` function, making races easier to introduce.
- **Mutable global module cache**: CJS's `require.cache` is globally mutable. A third-party plugin can deliberately or accidentally replace exports of a loaded module and undermine microkernel isolation; ESM module records expose immutable static bindings after loading.
- **A format divide with browser code**: The Harness Client Face needs to share domain types and pure functions with browser code. ESM is a Web standard, avoiding module-format translation between frontend and backend.

#### 3. Comparing Bun and Deno
- **Bun**: Despite strong single-process startup and JavaScript benchmark performance, it still has edge cases in complex subprocess-tree supervision, Windows handle inheritance, named-pipe IPC, and cross-platform POSIX signal delivery (`SIGTERM`, `SIGINT`, `SIGKILL`). For an enterprise harness that must run reliably over long periods, Node.js 22 LTS offers mature cross-platform operating-system compatibility.
- **Deno**: Deno has a strong security model, but its npm compatibility layer still differs subtly in parts of the large frontend ecosystem, including Vite plugins and some low-level test tools. Its distinct permission model also does not map directly to fine-grained Linux Landlock or Windows DACL controls.

### 4.2.2 TypeScript 6 Strict Mode and Discriminated-Union State Machines

In Harness, TypeScript is not only a static checker but also a **formal description of the domain state machine**. The repository enables `strict: true`, `exactOptionalPropertyTypes: true`, and `noUncheckedIndexedAccess: true`.

#### Discriminated Unions as Algebraic Data Types

Within the agent loop, the internal state of each Step and Turn is modeled as a mutually exclusive sum type. The compiler prevents transition logic from accessing fields absent from the current state variant.

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

## 4.3 Modularity and Inversion of Control: Vendored Cordis and Schemastery

### 4.3.1 Why Cordis for Microkernel IoC?

Conventional enterprise backends often use NestJS, Inversify, or Spring Framework. Their IoC containers center on singleton and request scopes suited to stateless HTTP APIs. Those scopes are insufficient for a complex autonomous-agent system:

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

DeepSeek Harness vendors and customizes the Cordis microkernel. Its main engineering advantages are:

1. **Tree-structured context forks**: When the primary agent starts a background job, executes a Graph node, or spawns a subagent, it can call `ctx.fork()` to create an isolated child context. The child inherits the parent's service topology but can override selected providers, such as its workspace path, cancellation signal, or restricted sandbox level.
2. **Deterministic cascading resource disposal (`ctx.effect()`)**: Tool plugins, event-bus listeners (`ctx.on`), timers, and background handles loaded during execution are registered with the current Context's fiber. When that child context is disposed, its resources are deregistered together, preventing listener leaks (`MaxListenersExceededWarning`) and orphaned handles in the Node.js process.
3. **Event waterfalls and bail interception**: Rich event-dispatch semantics let a security-guard plugin synchronously stop an invalid tool call before it reaches the operating system.

### 4.3.2 Schemastery: One Definition and Bidirectional Type Inference

In a large monorepo, separately maintaining a TypeScript `interface`, a JSON Schema validator, and a YAML configuration example invites drift between them and can break configuration loading in production.

Harness uses vendored Schemastery to define the shared data contract:

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

## 4.4 Engineering, Dependency Isolation, and Builds: pnpm 11, tsdown, and Vite

### 4.4.1 pnpm 11 Workspaces and Dependency-Graph Isolation

In a monorepo with more than 50 packages, dependency management is fundamental to stability. Traditional npm or Yarn 1.x uses a flattened `node_modules` layout, which can create **phantom dependencies**:

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

- **Content-addressable storage (CAS)**: pnpm uses a global SHA-512-based hard-link store. Storing each dependency once substantially reduces disk usage and speeds up CI installation.
- **Strict symlink isolation**: Each package's `node_modules` contains symlinks only to dependencies declared in its `package.json`. Importing an undeclared module immediately produces a module-not-found error, exposing dependency-graph mistakes during local development.

### 4.4.2 Dual-Face Build Pipeline (`tsdown` and Vite)

DeepSeek Harness uses a **dual-face build pipeline**. With the `DSH_BUILD_FACE` environment variable, the same source tree produces outputs for different execution environments:

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

- **`tsdown` speed**: Built on the Rust-based Rolldown and Oxc parser, `tsdown` combines fast bundling with Rollup-style tree shaking. A full monorepo build falls from roughly 45 seconds with traditional tsc/webpack to less than 2.5 seconds.

---

## 4.5 Model Layer and Protocol Adaptation: DeepSeek API and pi-ai

### 4.5.1 SSE Streaming Throughput and Backpressure

LLM token output is time-sensitive. The official DeepSeek API has two output streams: a reasoning trace (`reasoning_content`) and final content (`content`).

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

To prevent rapid network delivery from exhausting Node.js memory (OOM), Harness uses a Web Streams API pipeline with backpressure control:

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

## 4.6 Persistence and the Event Record: JSONL + Zstandard and node:sqlite

The persistence layer supports crash recovery and auditable replay of the DeepSeek Harness state machine.

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

### 4.6.1 Why Concatenated Independent Zstandard Frames?

#### Limitations of Conventional Approaches
- **One complete JSON document**: As the Session grows, appending an event requires serializing tens of megabytes of history again and overwriting the file. Write amplification reaches $O(N^2)$.
- **Uncompressed JSONL**: Appending a line takes $O(1)$ time, but agent sessions with substantial code, file diffs, and multimodal Base64 data can quickly consume hundreds of megabytes and saturate I/O bandwidth.
- **Traditional Gzip stream**: Gzip does not seamlessly concatenate independent compressed blocks in this approach; appending data requires rewriting the stream's end, preventing a truly append-only stream.

#### Concatenating Zstandard Frames
The Zstandard specification permits direct physical concatenation of separately compressed frames. For each transaction flush, Harness uses `node:zlib` to compress the current batch of events into a complete independent frame, with its own header, blocks, and CRC32 checksum, then calls filesystem `append` to add it to the end of the file:

```
+---------------------------------------------------------------------------------------------------+
|                        Physical Zstandard Concatenated Frame Layout                               |
+---------------------------------------------------------------------------------------------------+
  0x0000: [Frame 0: 512 Bytes]   --> Magic: 0xFD2FB528 | Header | Compressed Payload | Checksum
  0x0200: [Frame 1: 1024 Bytes]  --> Magic: 0xFD2FB528 | Header | Compressed Payload | Checksum
  0x0600: [Frame 2: 768 Bytes]   --> Magic: 0xFD2FB528 | Header | Compressed Payload | Checksum
  0x0900: [Torn Frame: 42 Bytes] --> System Crashed During Write! (Incomplete Magic or Block)
```

#### Torn-Frame Detection and Truncation
An operating-system crash or power loss may leave an incomplete tail of bytes. When Harness loads a Session log, it scans the physical frames using the following algorithm and truncates a torn tail:

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

### 4.6.2 Why `node:sqlite` Instead of Prisma or TypeORM?

Harness uses Node.js's built-in `node:sqlite` for concurrent Sessions, full-text search, and random metadata queries.

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

- **Comparison**:
  - **Prisma**: Requires a platform-specific Rust engine binary at build time, increases the package by more than 50 MB, and produces multi-table ORM joins that offer little benefit to an append-only event model.
  - **TypeORM / Sequelize**: Depend on extensive decorator metadata and complex reflection, leaving many `any` leaks in type safety.
  - **`node:sqlite`**: Built into Node.js 22, with no external dependencies and nanosecond-scale native synchronous operations, fitting the Harness event-sourcing model.

---

## 4.7 Frontend and Full-Stack RPC: React 18, Zustand, Immer, and Typert

### 4.7.1 React 18 Concurrent Rendering and Zustand/Immer State Flow

When an LLM streams 50–100 tokens per second, the frontend UI faces substantial rendering pressure.

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

- **Zustand atomic selectors**: With conventional React Context, a change to a provider's value can rerender every child using that context. Zustand lets components select a precise slice, such as `useStore(state => state.turns[turnId].status)`; React Fiber reconciles a component only when that selected slice changes reference.
- **Immer immutable structural sharing**: Hand-written spread copies (`{ ...state, a: { ...state.a, b: ... } }`) are error-prone for deeply nested agent task trees and create unnecessary garbage. Immer intercepts writes through a Proxy and creates new references only along modified paths, reducing garbage-collection pressure.

### 4.7.2 Typert: Automatic Type-Graph Inference and Bidirectional WebSocket RPC

Harness developed the `Typert` compilation framework in place of conventional REST APIs or GraphQL:

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

## 4.8 Concurrency Isolation and Kernel Sandboxes: Worker Threads, Landlock, and Seatbelt

### 4.8.1 Thread-Level Isolation with Node.js Worker Threads

For untrusted JavaScript or Python code, Harness prohibits Node's built-in `vm` module because of the V8 prototype-chain escape vulnerability described here. Instead, it uses `Worker Threads` with strict resource limits:

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

### 4.8.2 Kernel Sandbox Matrix for Three Operating Systems

To prevent an agent from running `rm -rf /` through Bash or scanning a local network, Harness provides native sandbox adapters for each host operating system:

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

1. **Linux (Landlock LSM)**: Call the Landlock LSM system calls introduced in Linux 5.13 to construct filesystem-access rules in the kernel before starting a child process. Once `landlock_restrict_self` runs, filesystem permissions for the process tree are permanently and monotonically restricted. Later malicious scripts cannot bypass those restrictions, even through SUID escalation.
2. **macOS (Apple Seatbelt)**: Generate a dedicated TinyScheme sandbox profile and use the macOS TrustedBSD kernel framework to restrict file writes and network socket binding.
3. **Windows (`sandbox-windows-acl`)**: Use Win32 APIs to create a restricted token without dangerous privileges such as `SeDebugPrivilege`; place the child process in a `JobObject` to limit memory and CPU cores; create a unique temporary `Workspace SID` for each task; and adjust directory DACLs to deny access to the host's other drives.

---

## 4.9 End-to-End Coordination and Ownership

In the DeepSeek Harness runtime, components do not operate independently. They coordinate end to end through a strict **ownership chain**:

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

### Three-Part Ownership Pattern Across Packages

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

## 4.10 Production Pitfalls and Diagnosis

### 4.10.1 Pitfall 1: Concurrent Asynchronous Zstd Appends Interleave Frames

- **Symptom**: Several agents write events to the same Session log concurrently. After a restart, the loader reports `corrupt Zstandard session log: invalid frame magic at byte 4096`.
- **Underlying cause**: Node.js `fs.promises.appendFile()` can result in multiple asynchronous operating-system calls. Two concurrent frame appends can interleave disk writes, inserting frame B's header inside a block of frame A and corrupting the physical format.
- **Production remedy**: Use a **write-behind queue** with one Promise chain to serialize physical appends strictly:

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

### 4.10.2 Pitfall 2: Large Cross-Thread Transfers Cause GC Pauses

- **Symptom**: An agent reads a 50 MB log and passes it to a Worker Thread for code parsing. The Node.js main event loop freezes for as long as 300 ms, visibly stalling the Web UI.
- **Underlying cause**: By default, `worker.postMessage(obj)` uses V8's `Structured Clone` algorithm. It recursively traverses and deep-copies the object tree synchronously on the main thread, increasing garbage collection in the main V8 heap.
- **Production remedy**: Transfer ownership of an `ArrayBuffer` with Transferable Objects for zero-copy delivery:

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

### 4.10.3 Pitfall 3: Inherited Windows ACLs Permit Sandbox Escape

- **Symptom**: An agent receives a restricted Windows workspace at `C:\temp\agent_workspace`, yet its child process can still read sensitive files in parent directories.
- **Underlying cause**: Windows NTFS inherits access-control entries (ACEs) by default. Even if the new directory has a restricted SID, it implicitly inherits full read access for the Users group from `C:\`.
- **Production remedy**: When initializing the sandbox directory's security descriptor, explicitly set `PROTECTED_DACL_SECURITY_INFORMATION` to prevent all parent rules from being inherited.

---

## 4.11 Chapter Summary and Self-Check

### Architectural Takeaways

1. **Runtime foundation**: Native ESM on Node.js ^22.19/24, with `node:sqlite` and `node:zlib`, removes the native C++ build chain (no Node-GYP) and provides consistent high-performance infrastructure across platforms.
2. **IoC and lifecycle**: Vendored Cordis offers dynamic context forks and cascading `ctx.effect()` disposal beyond conventional IoC; Schemastery provides bidirectional type and schema derivation from one definition.
3. **Deterministic persistence**: Independent concatenated Zstandard frames and `node:sqlite` WAL provide a dual persistence mechanism with $O(1)$ append performance and microsecond-scale recovery from torn writes.
4. **Defense-in-depth sandboxing**: Linux Landlock, macOS Seatbelt, and Windows Restricted Token/Job Object establish a monotonically narrowing execution-security barrier at the operating-system kernel level.

### Engineer's Self-Check

- [ ] Can you explain why an agent microkernel needs context forks rather than simple singleton dependency injection?
- [ ] Can you explain to your team the physical advantage of concatenated Zstandard frames over conventional Gzip for append-only logs?
- [ ] Why use Zustand atomic selectors rather than React Context for a high-frequency LLM token stream?
- [ ] Do you understand the mechanics of zero-copy Transferable Objects when passing large contexts between workers?
- [ ] Can you explain how Linux Landlock system calls monotonically and irreversibly reduce a process's permissions without root privileges?
