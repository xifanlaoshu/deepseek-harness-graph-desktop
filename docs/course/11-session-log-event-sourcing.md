# Chapter 11: The session log as the system's record of fact

English | [中文](11-session-log-event-sourcing.zh.md)

Traditional web applications and enterprise systems commonly persist mutable state through CRUD: a user, shopping cart, or order occupies a row in a relational database, and each update (`UPDATE`) overwrites its previous value. Applying that mutable-state model to large language model (LLM) agent systems soon causes serious problems: interrupted streams cannot be reconstructed, multi-step tool chains lose state across crashes, human intervention and historical replay corrupt context, and subsequent operations can destroy the evidence needed to investigate production incidents.

To address these fundamental engineering challenges, production agent runtimes such as DeepSeek Harness adopt patterns from distributed systems and financial transaction systems: **event sourcing and an append-only event log**.

In DeepSeek Harness, a session is not a message array that is continually edited. It is an immutable **stream of facts** with strongly typed events and strictly increasing sequence numbers. The LLM message history seen by the agent, UI interaction cards, todo lists, and even configuration headers are **pure functional projections** of that underlying event log at a given point in time.

This chapter examines the session log and persistence subsystem. It starts with the mathematical and engineering rationale for event sourcing, then explains the `Session.deriveMessages()` projection algorithm, the two-phase propose-and-commit state machine, persistence engines built on concatenated Zstandard frames and `node:sqlite`, and crash-recovery algorithms for maintaining consistent state after process failure or power loss.

---

## 1. Concept mapping: from systems programming to event-sourced sessions

For engineers familiar with C, C++, Java, Go, Rust, or Python, the following table relates the agent session log to concepts from operating systems, distributed systems, and database engines:

| Agent / Harness concept | Systems programming / database / distributed-systems analogue | Engineering properties and responsibilities |
| :--- | :--- | :--- |
| **`Session`** | **Database write-ahead log (WAL) / distributed commit log (such as a Kafka partition)** | Sole source of truth for a session's lifetime; supports only tail appends and preserves causal order. |
| **`SessionEvent`** | **Immutable WAL frame / journal record** | A discrete fact with a globally increasing sequence number (`seq`) and a physical timestamp (`time`); cannot be changed in place. |
| **`SessionEventMap`** | **Compile-time event dispatch table / Protobuf oneof or IDL union** | A strongly typed event vocabulary that plugins extend through TypeScript declaration merging. |
| **`Session.deriveMessages()`** | **Materialized view / state-machine fold or reduce function** | Folds and filters low-level events into the `Message[]` needed for model inference context. |
| **`SessionSurface`** | **Versioned logical view index** | Maintains the sequence of nodes producing model-visible messages; supports appends and range replacement during context compaction (`SurfaceOp`). |
| **`session/end-seed`** | **Checkpoint / replay-epoch barrier** | Marks the persistence boundary between restored seed events and events produced by the current process, preventing duplicate publication. |
| **`PersistenceCoordinator`** | **Storage transaction coordinator / read-write and cache manager** | Adapts multiple backends, caches prepared sessions with LRU eviction, batches asynchronous writes, and reconciles crashes. |
| **`SessionWriteBehind`** | **Bounded write buffer / dirty-page flusher** | Accepts synchronous event delivery, coalesces disk I/O in a bounded deadline window, and supports explicit `fsync` barriers. |
| **`interruptedTurnClosers`** | **Crash-reconciliation compensating transaction / ARIES recovery** | Finds unresolved calls after a crash, synthesizes error results, and closes turns to restore deterministic state. |
| **`TOOL_OUTCOME_UNKNOWN`** | **In-doubt result in distributed two-phase commit** | Explicitly marks a dispatched tool call whose persisted result is unknown, requiring the LLM to consider idempotency before retrying. |

```
                                +-------------------------------------------------------+
                                |               Agent Execution Loop                    |
                                +-------------------------------------------------------+
                                                            |
                                                            | 1. Synchronous Emit
                                                            v
                                +-------------------------------------------------------+
                                |                  Session (In-Memory)                  |
                                |  - seq = log.length (Strict Contiguity)               |
                                |  - Deep-frozen JSON data snapshot                     |
                                |  - SurfaceManager (Incremental Validation)            |
                                +-------------------------------------------------------+
                                   |                                                 |
         2. Dynamic Message        |                                                 | 3. session/event
            Fold Projection        v                                                 v    Notification
+------------------------------------+                                  +------------------------------------+
|     Session.deriveMessages()       |                                  |       Persistence Coordinator      |
|  - Walk Surface Nodes              |                                  |  - Write-Behind Batch Queue        |
|  - Filter Chunks & Boundaries      |                                  |  - LRU Preparation Cache          |
|  - Materialize Frozen Message[]    |                                  |  - Crash Tail Detection            |
+------------------------------------+                                  +------------------------------------+
                 |                                                                         |
                 v                                                                         | 4. Batch Flush
+------------------------------------+                                                     v
|      LLM Request Assembly          |                                  +------------------------------------+
|  - Prefix KV Cache Alignment       |                                  |        Concrete Backend Seam       |
|  - Frozen Context Passing          |                                  |  - JSONL + Zstandard Frames        |
+------------------------------------+                                  |  - SQLite STRICT Tables (WAL Mode) |
                                                                        +------------------------------------+
```

---

## 2. Why use an append-only event log?

### 2.1 Why is persisting a mutable chat array dangerous?

In a simple agent implementation, developers may append to or modify a `messages: Message[]` array at each execution stage, then persist `JSON.stringify(messages)` as one file or database field. This can work in a small demo, but a production system quickly encounters four serious problems:

1. **Loss of audit facts and causality**: An `AssistantMessage` can contain reasoning content, text, and several parallel tool calls. Some tools may succeed while others fail; a user may cancel through an AbortSignal; or the framework may spill a 50 MB tool output to disk. A mutable message array records only its final state, not when a particular chunk appeared, when a tool was dispatched, or what reference existed before truncation. Distributed tracing, incident reconstruction, and offline evaluation then lose essential evidence.
2. **Uncertain concurrency and interruption recovery**: Model generation can stream for tens of seconds. If the host crashes midway through a stream or tool call because of OOM, restart, or power loss, directly persisted message arrays can leave incomplete JSON or lose the unfinished turn altogether. On reload, the parser cannot distinguish normal completion from an interrupted fragment.
3. **Irreversible compaction and history rewriting**: Agent systems use context compaction or summaries to stay within the model's context window and reduce token use. Calling `splice` on the original array makes real conversation bubbles disappear from the UI, making history appear altered. Erasing those events also removes lossless replay and session-forking capability.
4. **Aliasing and state contamination**: In JavaScript and TypeScript, the UI, background jobs, and model-request builder may share a mutable message object. A local change in one subsystem—for example, a temporary field adjustment for a provider's wire format—can accidentally contaminate global state and create difficult-to-diagnose bugs.

### 2.2 Three axioms of the factual log

DeepSeek Harness applies three event-sourcing axioms to avoid those failures:

#### Axiom 1: facts are immutable
Once an event—user input, a model token chunk, tool dispatch, tool result, or system clock tick—is appended, it becomes a historical fact. It **cannot be physically modified, deleted, or reordered**.

#### Axiom 2: sequence numbers are strictly contiguous
Every session event receives an integer sequence number starting at $0$, increasing strictly without gaps: $$\text{seq}(e_i) = i, \quad \text{for } i \in \{0, 1, 2, \dots, N-1\}$$ Therefore, the log length always equals the next expected sequence number: $$\text{session.seq} \equiv \text{session.log.length}$$ If the persistence backend finds $\text{seq}(e_k) \neq k$ on read or recovery, it indicates corruption or a missing frame. The system refuses to load the log rather than continue with damaged state.

#### Axiom 3: state is a pure projection of events
Any state $S_t$—including the LLM context history, current todo list, and model configuration header—must be derivable from initial state $S_0$ and event sequence $[e_0, e_1, \dots, e_t]$ through a deterministic pure function $\mathcal{F}$: $$S_t = \text{fold}(\mathcal{F}, S_0, [e_0, e_1, \dots, e_t])$$

```
+---------------------------------------------------------------------------------------------------+
|                                 Canonical Append-Only Event Log                                   |
|                                                                                                   |
| [seq:0] request/header      (LlmCallConfig, System Prompt, Tool Schemas)                          |
| [seq:1] user/message        (Role: user, Content: "Refactor auth module")                         |
| [seq:2] turn/start          (Turn: 1)                                                             |
| [seq:3] step/start          (Turn: 1, Step: 1)                                                    |
| [seq:4] assistant/chunk     (Delta: "I will check ", Reasoning: "Analyze entry...")               |
| [seq:5] assistant/chunk     (Delta: "the directory structure.")                                  |
| [seq:6] assistant/message   (Complete Assembled Message + Usage: 450 tokens)                      |
| [seq:7] tool/call           (CallId: "call_1", Name: "fs_list_dir", Arguments: "{\"path\":\"src\"}")|
| [seq:8] tool/result         (CallId: "call_1", Message: ToolResultMessage, Meta: { count: 12 })  |
| [seq:9] step/end            (Turn: 1, Step: 1)                                                    |
| [seq:10] turn/end           (Turn: 1, Reason: { kind: "completed" })                              |
+---------------------------------------------------------------------------------------------------+
                                                  |
                         +------------------------+------------------------+
                         |                                                 |
                         v                                                 v
+-------------------------------------------------+     +-----------------------------------------+
|        Model-Visible Surface Projection         |     |          UI Audit & Telemetry           |
|                                                 |     |                                         |
| 1. [seq:1] UserMessage: "Refactor auth module"  |     | - Exact Token Latency Tracking          |
| 2. [seq:6] AssistantMessage (Content & Calls)   |     | - Tool Duration & Diff Presentation     |
| 3. [seq:8] ToolResultMessage                    |     | - Full Turn/Step Lifecycle Visualization|
+-------------------------------------------------+     +-----------------------------------------+
```

### 2.3 `SessionEventMap`: a strongly typed event vocabulary and declaration merging

An extensible TypeScript system must let third-party plugins add their own log events without giving up inference or compile-time type safety. DeepSeek Harness uses TypeScript **declaration merging** for this purpose.

The core package `@deepseek-ai/dsh-session` defines the base `SessionEventMap` interface:

```typescript
/**
 * 会话事实日志的基础事件映射接口
 * 允许各子系统与外部插件通过 TypeScript 声明合并（Declaration Merging）进行无缝扩充
 */
export interface SessionEventMap {
  /** 开启一个新的业务轮次（Turn） */
  'turn/start': { turn: number }

  /** 闭合一个业务轮次，记录结构化终止原因 */
  'turn/end': { turn: number; reason: TurnEndReason }

  /** 开启轮次内的一个执行步骤（Step：单次模型推理 + 工具执行） */
  'step/start': { turn: number; step: number }

  /** 闭合执行步骤 */
  'step/end': { turn: number; step: number }

  /** 模型可见的用户角色消息（包括人类输入、注入上下文、Goal 引导等） */
  'user/message': UserMessage

  /** 底层原始流式分片，保留 Token 级别的回放保真度 */
  'assistant/chunk': { turn: number; step: number; chunk: StreamChunk }

  /** 单步骤内组装完成的模型响应消息，携带权威的 Token 消耗统计 */
  'assistant/message': {
    turn: number
    step: number
    message: AssistantMessage
    usage?: TokenUsage
    interrupted?: true
  }

  /** 模型发起的工具调用请求（保留原始未解析的 JSON 参数字符串） */
  'tool/call': { turn: number; step: number; callId: CallId; name: string; arguments: string }

  /** 工具执行完成返回的结果、内部错误标识及展示用元数据 */
  'tool/result': {
    turn: number
    step: number
    message: ToolResultMessage
    error?: { name: string; code: string }
    meta?: JsonValue
  }

  /** 待办事项全量快照（最后写入生效，纯日志 UI 状态，不参与派生历史） */
  'todo/write': { todos: TodoItem[] }

  /** 请求信封快照：调用配置、渲染后的 System Prompt 与组装好的工具 Schema */
  'request/header': { header: EpochHeader; reason: RequestHeaderReason }

  /** 路由元数据：记录解析后的模型提供方、模型名称与上下文容量上限 */
  'request/context': RequestContext

  /** 冷启动种子回放结束标记：标识物理存储中历史数据与当前进程实时写入的分界 */
  'session/end-seed': Record<string, never>
}
```

When external plugins such as `@deepseek-ai/dsh-compaction` or `@deepseek-ai/dsh-hook-protocol` introduce new facts, they extend that interface in their own module declarations:

```typescript
// 在 packages/plugins/compaction/src/types.ts 中扩展
declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap {
    'compaction/start': { compactionId: string; targetRange: { start: number; end: number } }
    'compaction/summary': { compactionId: string; summaryText: string; tokensSaved: number }
    'compaction/end': { compactionId: string; status: 'success' | 'failed' }
  }
}

// 在 packages/plugins/hook-protocol/src/types.ts 中扩展
declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap {
    'hook/invoked': { hookName: string; handlerId: string; payload: JsonValue }
    'hook/result': { hookName: string; handlerId: string; outcome: 'pass' | 'block' | 'modify' }
  }
}
```

#### Discriminated unions and the `ignorable: true` rule for unknown events

DeepSeek Harness derives the typed event envelope `SessionEvent<T>` from `SessionEventMap`:

```typescript
export type SessionEventType = keyof SessionEventMap

export type SurfaceEventType = 'user/message' | 'assistant/message' | 'tool/result'

export type SurfaceOp =
  | 'append'
  | { op: 'replace'; start: number; end: number }

export type SessionEvent<T extends SessionEventType = SessionEventType> = {
  [K in SessionEventType]: {
    type: K
    /** 会话内部严格单调连续的序号 */
    seq: number
    /** Unix Epoch 毫秒时间戳 */
    time: number
    /** 强类型载荷数据，必须满足可无损 JSON 序列化 */
    data: SessionEventMap[K]
    /**
     * 未知类型跳过标记：
     * 若缺失（undefined），当低版本运行时遇到未知 type 时必须拒绝加载（Refuse）；
     * 若显式标记为 true，表示该事件为非关键信息记录，低版本运行时可安全跳过并继续加载。
     */
    ignorable?: true
  } & (K extends SurfaceEventType ? {
    /** 当前事件所引用的前序事件 seq 列表（如组装消息所引用的 chunks，或 replace 所遮蔽的节点） */
    sourceEventSeqs?: number[]
    /** 声明当前事件如何加入有序 Surface */
    surfaceOp?: SurfaceOp
  } : object)
}[T]
```

> **Why must `assertNever` not be used for `SessionEvent.type`?** > Declaration merging makes `SessionEventMap` an open union. A consumer such as a state-machine walker or event dispatcher **must not** call `assertNever(event)` in the `default` branch of `switch (event.type)`. Unknown plugin events are valid facts; the core runtime must safely pass them through in `default` after handling known core events so plugins remain compatible across versions.

---

## 3. The `Session.deriveMessages()` projection algorithm

### 3.1 A mathematical formulation

An LLM cannot consume fine-grained log events such as `turn/start`, `assistant/chunk`, and `hook/invoked` directly. A model call requires a role-structured message sequence $\mathbf{M} = [m_1, m_2, \dots, m_K]$, where $m_i \in \text{Message}$.

The projection algorithm defines an operator $\Pi$ that maps the immutable event sequence $\mathbf{E} = [e_0, e_1, \dots, e_{N-1}]$ to the model-visible message history $\mathbf{M}$: $$\mathbf{M} = \Pi(\mathbf{E})$$

#### Projection complexity: from $O(N^2)$ to $O(\Delta N)$

Suppose a session makes $T$ model calls (steps), and the log length at call $t$ is $N_t$.

- **Naive projection (full recomputation)**: Scanning every event before each model call costs $O(N_t)$ at call $t$. Across the session, that becomes: $$\text{Total Time} = \sum_{t=1}^T O(N_t) = O(T \cdot N) = O(N^2)$$ In a long-running task with dozens of turns and thousands of chunks, this quadratic work creates a CPU bottleneck and stalls the event loop.

- **Incremental projection (incremental maintenance and generation invalidation)**: DeepSeek Harness separates projection into two independent data structures:
  1. **The `SessionSurface` index**: Tracks only sequence numbers for nodes that can produce messages, $\mathbf{I}_{\text{surface}} = [s_1, s_2, \dots, s_k]$, where $s_i \in \mathbb{N}$.
  2. **The `derived` message cache**: Stores projected messages and the $\text{derivedNodes}$ cursor for processed surface nodes.

For a normal tail append (`surfaceOp: 'append'`), the algorithm processes only new surface nodes: $$\Delta \mathbf{M} = [\text{deriveEventMessage}(e_s) \mid s \in \mathbf{I}_{\text{surface}}[\text{derivedNodes} : |\mathbf{I}_{\text{surface}}|]]$$ This reduces work to $O(\Delta N) = O(1)$ amortized per append.

For a context-compaction replacement (`surfaceOp: { op: 'replace', start, end }`), `SurfaceManager` increments $\text{replaceGeneration} \leftarrow \text{replaceGeneration} + 1$, invalidates the cache, and rebuilds it once in $O(K)$ time, where $K \ll N$ is the current number of surface nodes.

```
+-------------------------------------------------------------------------------------------------------+
|                                    Event Sourcing Log [0..N-1]                                        |
|  [0] req/hdr   [1] user/msg   [2] turn/st   [3] chunk   [4] chunk   [5] asst/msg   [6] tool/call ...  |
+-------------------------------------------------------------------------------------------------------+
        |              |                           |           |            |
        | (Ignored)    | (Surface Node 0)          | (Ignored) | (Ignored)  | (Surface Node 1)
        v              v                           v           v            v
+-------------------------------------------------------------------------------------------------------+
|                                  SessionSurface (Ordered Nodes Index)                                 |
|  nodes = [ 1, 5, 8, 12, ... ]                          replaceGeneration = 0                          |
+-------------------------------------------------------------------------------------------------------+
        |              |                                                    |
        | Pure Fold    | deriveEventMessage(log[1])                         | deriveEventMessage(log[5])
        v              v                                                    v
+-------------------------------------------------------------------------------------------------------+
|                             Derived Messages Cache (Shared Deep-Frozen)                               |
|  [                                                                                                    |
|    { id: "msg-user-1", role: "user", content: "..." },                                                |
|    { id: "msg-asst-1", role: "assistant", content: [{ type: "text", text: "..." }] },                |
|    ...                                                                                                |
|  ]                                                                                                    |
+-------------------------------------------------------------------------------------------------------+
```

### 3.2 The pure node projection function: `deriveEventMessage`

`deriveEventMessage(event)` is side-effect-free and defines exactly how one log event becomes a model message:

```typescript
/**
 * 纯函数：将单个会话事件投影为 LLM 消息
 * @param event 待投影的日志事件
 * @returns 派生出的 Message 对象；对于非 Surface 事件或空内容消息，返回 null
 */
export function deriveEventMessage(event: SessionEvent): Message | null {
  switch (event.type) {
    case 'user/message': {
      // 普通用户输入与注入上下文（Injected Context）原样透传
      // 保持 model-visible content 的绝对确定性，严禁在此处附加动态外框
      return event.data
    }
    case 'assistant/message': {
      // 过滤空内容消息：因 max-tokens 截断且尚未输出文本的步骤，
      // 虽记录 assistant/message 以保存用量，但绝不能将空轮次注入 Provider 请求
      if (event.data.message.content.length === 0) {
        return null
      }
      return event.data.message
    }
    case 'tool/result': {
      // 工具执行结果投影为 user 角色下的 tool-result 内容块
      return event.data.message
    }
    default:
      // 结构标记（turn/step boundaries）、细粒度 chunks、请求头快照等均不投影为消息
      return null
  }
}
```

### 3.3 The `SurfaceManager` state machine and provenance assertions

`SurfaceManager` performs **two-phase propose-and-commit validation** before an event enters the log, keeping the surface topology valid at all times.

```typescript
export interface SurfaceFoldReplacement {
  seq: number
  start: number
  end: number
  shadowedSeqs: number[]
}

export interface SessionSurface {
  readonly nodes: readonly number[]
  readonly replaceGeneration: number
}

interface SurfaceReplacePlan extends SurfaceFoldReplacement {
  kind: 'replace'
  startIdx: number
  endIdx: number
}

type SurfacePlan =
  | { kind: 'append'; seq: number }
  | SurfaceReplacePlan

export class SurfaceManager implements SessionSurface {
  private _nodes: number[] = []
  private _replaceGeneration = 0
  private _lastProcessedSeq: number
  private _pendingPlan?: { event: SessionEvent; expectedSeq: number; plan: SurfacePlan | undefined }

  constructor(
    private readonly log: readonly SessionEvent[],
    private readonly baseSeq = 0,
  ) {
    this._lastProcessedSeq = baseSeq - 1
  }

  get nodes(): readonly number[] {
    this.processDelta()
    return this._nodes
  }

  get replaceGeneration(): number {
    this.processDelta()
    return this._replaceGeneration
  }

  /**
   * 第一阶段：在事件正式 push 进 log 之前执行预校验（Pre-validation）
   * 确保替换区间存在、因果追溯完整、工具结果重写合法
   */
  validateNext(event: SessionEvent): void {
    this.processDelta()
    const expectedSeq = this.baseSeq + this.log.length
    if (event.seq !== expectedSeq) {
      throw new Error(`Session event seq ${event.seq} is not contiguous; expected ${expectedSeq}`)
    }

    const plan = this.planSurfaceEvent(event, expectedSeq)
    this._pendingPlan = { event, expectedSeq, plan }
  }

  private processDelta(): void {
    const tailSeq = this.baseSeq + this.log.length - 1
    for (let seq = this._lastProcessedSeq + 1; seq <= tailSeq; seq++) {
      const index = seq - this.baseSeq
      const event = this.log[index]!

      if (this._pendingPlan?.event === event && this._pendingPlan.expectedSeq === seq) {
        this.applyPlan(this._pendingPlan.plan)
      } else {
        const plan = this.planSurfaceEvent(event, seq)
        this.applyPlan(plan)
      }

      if (this._pendingPlan && this._pendingPlan.expectedSeq <= seq) {
        this._pendingPlan = undefined
      }
      this._lastProcessedSeq = seq
    }
  }

  private planSurfaceEvent(event: SessionEvent, expectedSeq: number): SurfacePlan | undefined {
    if (!isSurfaceEligibleType(event.type)) {
      const raw = event as unknown as { surfaceOp?: unknown; sourceEventSeqs?: unknown }
      if (raw.surfaceOp !== undefined || raw.sourceEventSeqs !== undefined) {
        throw new Error(`Event "${event.type}" is not surface-eligible and cannot carry surface metadata`)
      }
      return undefined
    }

    const rawSurface = event as SessionEvent & { surfaceOp?: SurfaceOp; sourceEventSeqs?: number[] }
    const op = rawSurface.surfaceOp
    if (!op) {
      throw new Error(`Surface event "${event.type}" requires a valid surfaceOp marker`)
    }

    if (op === 'append') {
      this.assertProvenance(event, [])
      return { kind: 'append', seq: expectedSeq }
    }

    // 校验 replace 算子的范围合法性
    const startIdx = this._nodes.indexOf(op.start)
    if (startIdx === -1) {
      throw new Error(`Surface replace: start seq ${op.start} not found in active surface`)
    }
    const endIdx = this._nodes.indexOf(op.end)
    if (endIdx === -1) {
      throw new Error(`Surface replace: end seq ${op.end} not found in active surface`)
    }
    if (startIdx > endIdx) {
      throw new Error(`Surface replace: start index ${startIdx} exceeds end index ${endIdx}`)
    }

    const shadowedSeqs = this._nodes.slice(startIdx, endIdx + 1)
    // 因果追溯校验：replace 节点必须在 sourceEventSeqs 中显式声明所有被它遮蔽的节点
    this.assertProvenance(event, shadowedSeqs)

    return {
      kind: 'replace',
      seq: expectedSeq,
      start: op.start,
      end: op.end,
      startIdx,
      endIdx,
      shadowedSeqs,
    }
  }

  private assertProvenance(event: SessionEvent, shadowedSeqs: readonly number[]): void {
    const raw = event as SessionEvent & { sourceEventSeqs?: number[] }
    const sources = new Set<number>(raw.sourceEventSeqs ?? [])

    // 检查是否有前向引用非法序号（引用了未来尚未发生的事件）
    for (const src of sources) {
      if (src >= event.seq) {
        throw new Error(`Provenance violation: sourceEventSeq ${src} >= current seq ${event.seq}`)
      }
    }

    // 检查是否完全覆盖了所有被遮蔽的节点
    const missing = shadowedSeqs.filter(seq => !sources.has(seq))
    if (missing.length > 0) {
      throw new Error(`Surface replace: sourceEventSeqs must cover all shadowed nodes; missing: ${missing.join(', ')}`)
    }
  }

  private applyPlan(plan: SurfacePlan | undefined): void {
    if (!plan) return
    if (plan.kind === 'append') {
      this._nodes.push(plan.seq)
    } else if (plan.kind === 'replace') {
      // 在原位置将 [startIdx..endIdx] 区间替换为新的单条压缩节点
      this._nodes.splice(plan.startIdx, plan.endIdx - plan.startIdx + 1, plan.seq)
      this._replaceGeneration += 1
    }
  }
}
```

### 3.4 Worked example: ten event-folding steps and surface evolution

The following trace shows ordinary interaction, a tool call, and context-compaction replacement to illustrate how the surface and `deriveMessages()` evolve:

| Step | Appended event and key data | `surfaceOp` | `sourceEventSeqs` | Change to `SessionSurface.nodes` | `replaceGen` | Messages derived by `deriveMessages()` |
| :---: | :--- | :--- | :--- | :--- | :---: | :--- |
| **0** | `request/header` (Config, Tools) | *None* | *None* | `[]` | 0 | `[]` (no messages) |
| **1** | `user/message` ("List files") | `'append'` | `[]` | `[1]` | 0 | `[UserMessage("List files")]` |
| **2** | `turn/start` (turn: 1) | *None* | *None* | `[1]` | 0 | `[UserMessage]` |
| **3** | `assistant/chunk` ("Let me check")| *None* | *None* | `[1]` | 0 | `[UserMessage]` (chunk ignored) |
| **4** | `assistant/message` (Call: `ls`) | `'append'` | `[3]` | `[1, 4]` | 0 | `[UserMessage, AsstMessage(Calls:[ls])]` |
| **5** | `tool/call` (id: "c1", `ls`) | *None* | *None* | `[1, 4]` | 0 | `[UserMessage, AsstMessage]` |
| **6** | `tool/result` (id: "c1", `["a.ts"]`)| `'append'` | `[5]` | `[1, 4, 6]` | 0 | `[UserMessage, AsstMessage, ToolResult]` |
| **7** | `assistant/message` ("Done") | `'append'` | `[]` | `[1, 4, 6, 7]` | 0 | `[UserMessage, AsstMessage, ToolResult, AsstMessage]` |
| **8** | `turn/end` (completed) | *None* | *None* | `[1, 4, 6, 7]` | 0 | `[UserMessage, AsstMessage, ToolResult, AsstMessage]` |
| **9** | `user/message` (Summary Compaction)| `{op:'replace', start:1, end:6}` | `[1, 4, 6]` | `[9, 7]` (nodes 1, 4, and 6 replaced by 9) | **1** | `[UserMessage(Summary), AsstMessage("Done")]` |

At step 9, compaction proceeds as follows:
1. `SurfaceManager` identifies the range from sequence 1 through 6 in `nodes`: indices `0..2`, holding `[1, 4, 6]`.
2. After validation, `splice(0, 3, 9)` reconstructs `nodes` as `[9, 7]`.
3. `replaceGeneration` becomes 1, invalidating the `Session.deriveMessages()` cache and rebuilding the shorter model context.

---

## 4. Persistence engines and the coordinator

### 4.1 The persistence capability seam (`SessionPersistence`)

In the Cordis dependency-injection container, the in-memory `Session` is separate from physical persistence. `ctx.sessions` is an in-memory state machine, while `ctx.sessionPersistence` is the **capability seam** defining a persistence contract independent of the storage medium:

```typescript
export interface SessionPersistence {
  /** 定位会话对应的物理工件路径提示（如 JSONL 文件路径；SQLite 返回 undefined） */
  locate(meta: SessionHeader): SessionLocation | undefined

  /** 创建并初始化持久化存储 */
  create(id: SessionId, meta: SessionHeader, seed?: readonly SessionEvent[]): Promise<void>

  /** 追加一批连续且已通过校验的事件 */
  append(id: SessionId, events: readonly SessionEvent[]): Promise<void>

  /**
   * 预备态加载（Session Preparation）：
   * 执行冷读取、解压、校验、内存崩溃对账，并将 Session 驻留于 LRU 缓存中
   */
  prepare(id: SessionId, signal?: AbortSignal): Promise<SessionPreparation>

  /** 逻辑只读探测：返回不可变的快照视图，不触发物理修复写入 */
  inspect(id: SessionId, signal?: AbortSignal): Promise<SessionInspection>

  /** 物理加载并提交崩溃修复写入 */
  load(id: SessionId, signal?: AbortSignal): Promise<Session>

  /** 从指定 seq 开始高效读取事件物理后缀 */
  readFrom(id: SessionId, fromSeq: number, signal?: AbortSignal): Promise<SessionEvent[]>

  /** 列出所有已持久化的会话元数据头 */
  list(signal?: AbortSignal): Promise<SessionHeader[]>
}
```

### 4.2 The bounded asynchronous write queue (`SessionWriteBehind`)

During a high-frequency stream of 50–100 `assistant/chunk` events per second, synchronously calling `fsync` or `pwrite` for every `session.append()` would create severe disk I/O congestion and CPU context switching.

`SessionWriteBehind` implements a nonblocking write controller with a **fixed deadline window and explicit barrier draining**:

```typescript
export interface SessionWriteBehindOptions {
  /** 队列从空变为非空后，触发批量写入的最大等待时间（如 200ms） */
  readonly maxDelayMs: number
  /** 底层持久化写入回调 */
  readonly write: (events: readonly SessionEvent[]) => Promise<void>
  /** 异常上报回调 */
  readonly reportBackgroundFailure: (error: unknown) => void
}

export class SessionWriteBehind {
  private pending: SessionEvent[] = []
  private timer?: ReturnType<typeof setTimeout>
  private active?: Promise<void>
  private barrier?: Promise<void>
  private deadlineExpired = false
  private automaticPaused = false

  constructor(private readonly options: SessionWriteBehindOptions) {}

  get hasWork(): boolean {
    return this.pending.length > 0 || this.active !== undefined
  }

  /**
   * 同步入队：将深拷贝后的事件放入 pending 缓冲，启动或复用定时器
   */
  enqueue(event: SessionEvent): void {
    const wasEmpty = this.pending.length === 0
    this.pending.push(structuredClone(event))

    if (this.barrier !== undefined) return

    if (this.automaticPaused) {
      this.automaticPaused = false
      this.deadlineExpired = false
      this.armTimer()
    } else if (wasEmpty) {
      this.armTimer()
    }
  }

  /**
   * 显式 Durability 屏障：取消定时等待，强制将所有未写入数据立即刷盘并等待完成
   */
  flush(): Promise<void> {
    if (this.barrier !== undefined) return this.barrier
    this.cancelTimer()
    this.deadlineExpired = false
    this.automaticPaused = false

    const { promise, resolve, reject } = Promise.withResolvers<void>()
    this.barrier = promise
    void this.drainBarrier(resolve, reject)
    return promise
  }

  private armTimer(): void {
    this.timer = setTimeout(() => {
      this.timer = undefined
      if (this.active !== undefined) {
        // 当前有正在执行的物理写入，记录超时标记，待上一批完成后立即衔接下一批
        this.deadlineExpired = true
        return
      }
      this.startBackground()
    }, this.options.maxDelayMs)
  }

  private cancelTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  private startBackground(): void {
    const active = this.startWrite(true)
    void active.then(
      () => { this.continueAutomatic() },
      () => {},
    )
  }

  private continueAutomatic(): void {
    if (this.barrier !== undefined || this.pending.length === 0) return
    if (this.deadlineExpired) {
      this.deadlineExpired = false
      this.startBackground()
    }
  }

  private async drainBarrier(resolve: () => void, reject: (reason?: unknown) => void): Promise<void> {
    try {
      if (this.active !== undefined) {
        await Promise.allSettled([this.active])
        this.automaticPaused = false
      }
      while (this.pending.length > 0) {
        await this.startWrite(false)
      }
      this.barrier = undefined
      resolve()
    } catch (error: unknown) {
      this.barrier = undefined
      reject(error)
    }
  }

  private startWrite(background: boolean): Promise<void> {
    // 原创性原子切片：将当前 pending 队列完整移出作为独立批次
    const batch = this.pending.splice(0)
    this.cancelTimer()
    this.deadlineExpired = false

    const operation = Promise.resolve().then(() => this.options.write(batch))
    const active = operation
      .catch((error: unknown) => {
        // 错误恢复：若物理写入失败，将未持久化的批次完整回退到 pending 头部
        this.pending = batch.concat(this.pending)
        this.cancelTimer()
        this.deadlineExpired = false
        this.automaticPaused = true
        if (background) {
          this.options.reportBackgroundFailure(error)
        }
        throw error
      })
      .finally(() => {
        this.active = undefined
      })

    this.active = active
    return active
  }
}
```

```
                               SessionWriteBehind 状态转换机

       +-------------------------------------------------------------------------+
       |                                                                         |
       v                                                                         |
+--------------+   enqueue(e)   +--------------+   Timer Fire   +--------------+ | Batch Success
|     IDLE     | -------------> | TIMER_ARMED  | -------------> | WRITING_DISK |-+
+--------------+ (wasEmpty=true)+--------------+ (active=false) +--------------+
       ^                               |                               |
       | flush() Barrier               | flush() Barrier               | Batch Failure
       |                               v                               v
+------------------------------------------------------------------------------+
|                         DRAINING_BARRIER / PAUSED                            |
|  - Cancel Timer                                                              |
|  - Await Active In-flight IO                                                 |
|  - Prepend Failed Batch to Queue Head                                        |
|  - Drain All Pending Batches Sequentially to Quiescence                      |
+------------------------------------------------------------------------------+
```

---

## 5. Storage backends: JSONL with Zstandard and SQLite

### 5.1 JSONL with concatenated Zstandard frames

#### Filesystem-safe path encoding: `encodeSegment`
When persisting to a directory, `SessionId` is an untrusted external string. It may contain traversal text such as `../../etc/passwd`, reserved OS names or characters such as `CON`, `PRN`, `AUX`, and `:`, or unpaired UTF-16 surrogates. DeepSeek Harness uses an injective safe encoding:

```typescript
export function encodeSegment(raw: string): string {
  if (raw.length === 0) throw new Error('Cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    // 仅放行字母、数字、点、下划线、减号
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      out += ch
    } else {
      out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
    }
  }
  return out
}
```

#### Concatenated Zstandard frames
A conventional compressed file such as one `.tar.gz` cannot be appended efficiently without decompressing and recompressing the whole file. DeepSeek Harness uses **Zstandard's support for concatenated frames**:
- The first frame contains a JSON `SessionHeader` metadata line.
- Each subsequent persistence batch is independently compressed into a complete Zstandard frame with a CRC32 checksum and appended directly to the file.
- On read, the decoder scans frames in physical order. If a crash leaves the final frame torn, all preceding complete frames remain intact.

```
+---------------------------------------------------------------------------------------------------+
|                            Session Storage File (session.jsonl.zstd)                              |
|                                                                                                   |
| [Frame 0: Header]  Magic: 0xFD2FB528 | Descriptor | Payload: {"type":"session",...}\n | CRC32    |
| [Frame 1: Batch 1] Magic: 0xFD2FB528 | Descriptor | Payload: 10 Events JSONL lines...  | CRC32    |
| [Frame 2: Batch 2] Magic: 0xFD2FB528 | Descriptor | Payload: 25 Events JSONL lines...  | CRC32    |
| [Frame 3: Torn !!] Magic: 0xFD2FB528 | (Interrupted by Crash / Incomplete Byte Stream)            |
+---------------------------------------------------------------------------------------------------+
                                                  |
                                                  | scanZstdFrames()
                                                  v
+---------------------------------------------------------------------------------------------------+
|  Valid Frames: [Frame 0 (0..256), Frame 1 (256..1024), Frame 2 (1024..4096)]                      |
|  Torn Start Offset: 4096  ---> Trigger Physical Truncation: ftruncate(fd, 4096)                   |
+---------------------------------------------------------------------------------------------------+
```

#### Fast frame-boundary scanning without decompression: `scanZstdFrames`

```typescript
const ZSTD_MAGIC = 0xFD2FB528

export interface ZstdFrameRange {
  start: number
  end: number
}

export interface ZstdFrameScan {
  frames: ZstdFrameRange[]
  tornStart?: number
}

/**
 * 在不执行解压计算的前提下，通过解析 Zstd 帧头与块头元数据，极速定位完整的物理帧边界
 */
export function scanZstdFrames(buffer: Buffer, maxFrames = Number.POSITIVE_INFINITY): ZstdFrameScan {
  const frames: ZstdFrameRange[] = []
  let offset = 0

  while (offset < buffer.length) {
    const start = offset
    // 检查是否具备完整的 4 字节 Magic Number
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`Corrupt Zstandard session log: invalid magic 0x${buffer.readUInt32LE(offset).toString(16)} at byte ${offset}`)
    }
    offset += 4

    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1

    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeFlag = descriptor >>> 6
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes

    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes

    // 遍历帧内部的所有 Block
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3

      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }

    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }

    frames.push({ start, end: offset })
    if (frames.length === maxFrames) return { frames }
  }

  return { frames }
}
```

### 5.2 The synchronous Node `node:sqlite` engine in WAL mode

For applications that need to manage multiple sessions in one file or read a suffix indexed by `seq` through `readFrom`, DeepSeek Harness provides a backend based on Node.js's built-in `node:sqlite`.

#### Strictly typed tables (STRICT tables)

```sql
-- 单例持久化全局状态表
CREATE TABLE persistence_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  store_id  TEXT NOT NULL
) STRICT;

-- 会话元数据表
CREATE TABLE sessions (
  id               TEXT PRIMARY KEY,
  version          INTEGER NOT NULL,
  created_at       INTEGER NOT NULL,
  cwd              TEXT,
  parent_session   TEXT,
  seed_length      INTEGER,
  origin           TEXT,
  delegation_depth INTEGER,
  agent_preset     TEXT,
  incarnation      TEXT NOT NULL,
  revision         INTEGER NOT NULL
) STRICT;

-- 会话事件明细表（复合主键保证物理单调与排他）
CREATE TABLE events (
  session_id        TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq               INTEGER NOT NULL,
  type              TEXT NOT NULL,
  time              INTEGER NOT NULL,
  data              ANY NOT NULL,
  source_event_seqs ANY,
  surface_op        TEXT,
  ignorable         INTEGER CHECK (ignorable IS NULL OR ignorable IN (0, 1)),
  PRIMARY KEY (session_id, seq)
) STRICT;
```

#### Database hardening and durability PRAGMAs

```typescript
export async function openDatabase(
  Database: typeof import('node:sqlite').DatabaseSync,
  path: string,
  journalMode: 'wal' | 'delete' | 'truncate' | 'persist',
  busyTimeoutMs: number,
): Promise<import('node:sqlite').DatabaseSync> {
  const db = new Database(path, { timeout: busyTimeoutMs })
  try {
    // 1. 关闭不安全的扩展与内存映射，防御注入与段错误
    db.exec('PRAGMA trusted_schema = OFF;')
    db.exec('PRAGMA mmap_size = 0;')
    db.exec('PRAGMA foreign_keys = ON;')

    // 2. 配置日志模式（推荐 WAL 模式）
    db.exec(`PRAGMA journal_mode = ${journalMode};`)

    // 3. 启用最高的物理同步保证（FULL 级别 fsync 屏障）
    db.exec('PRAGMA synchronous = FULL;')

    return db
  } catch (error: unknown) {
    db.close()
    throw error
  }
}
```

---

## 6. Crash recovery and reconciliation

### 6.1 Crash windows: why failure can occur between any two bytes

In either a distributed system or a single-machine agent system, a crash can occur at **any nanosecond** of execution:

```
                              崩溃窗口（Crash Windows）全景分析

时间轴 t  执行阶段                                  潜在崩溃状态与物理表现
  |
  +-- [窗口 A] 模型正在流式输出 Chunk               磁盘仅写入部分 assistant/chunk，无 assistant/message
  |
  +-- [窗口 B] 模型已输出完毕，工具派发前           assistant/message 已落盘（声明了 tool-calls），无 tool/call
  |
  +-- [窗口 C] 工具正在操作系统执行耗时任务         tool/call 已落盘，无对应 callId 的 tool/result
  |
  +-- [窗口 D] 工具执行完毕，结果尚未刷盘           外部文件已物理修改，但磁盘日志无 tool/result 记录
  |
  +-- [窗口 E] 全部步骤完成，turn/end 写入前        全量步骤执行完毕，但 turn/end 缺失，轮次处于悬挂开启态
```

### 6.2 Physical repair: truncating a torn tail

On cold-start log loading, `PersistenceCoordinator` first scans the physical data:
1. If the tail contains an incomplete line that cannot be parsed as JSON or a torn Zstandard frame that fails header validation, calculate `committedBytes`, the offset of the last valid frame or newline.
2. Open the file for reading and writing, then call `ftruncate(fd, committedBytes)` to remove the damaged tail bytes.

### 6.3 Logical repair: the `interruptedTurnClosers` state-balancing algorithm

After physical truncation, memory contains a syntactically valid event prefix that may still have open logical operations. The `interruptedTurnClosers` algorithm must synthesize the minimal set of closing events.

```typescript
export const TOOL_NOT_STARTED = 'TOOL_NOT_STARTED'
export const TOOL_OUTCOME_UNKNOWN = 'TOOL_OUTCOME_UNKNOWN'

/**
 * 核心崩溃恢复状态机：
 * 遍历已落盘的事件前缀，计算并返回闭合悬挂轮次所必需的确定性合成事件序列
 */
export function interruptedTurnClosers(events: readonly SessionEvent[]): SessionEvent[] {
  let openTurn: number | null = null
  let openStep: number | null = null

  // 维护当前处于 pending 状态的工具调用：callId -> { step, callSeq }
  const pendingCalls = new Map<CallId, { step: number; callSeq?: number }>()

  for (const event of events) {
    switch (event.type) {
      case 'turn/start':
        openTurn = event.data.turn
        openStep = null
        pendingCalls.clear()
        break
      case 'turn/end':
        openTurn = null
        openStep = null
        pendingCalls.clear()
        break
      case 'step/start':
        openStep = event.data.step
        break
      case 'step/end':
        openStep = null
        pendingCalls.clear()
        break
      case 'assistant/message':
        // 登记 assistant message 中声明的所有工具调用块
        for (const block of event.data.message.content) {
          if (block.type === 'tool-call') {
            pendingCalls.set(block.id, { step: event.data.step })
          }
        }
        break
      case 'tool/call':
        // 若存在显式 tool/call 事件，记录其 seq 作为因果追溯引用
        {
          const entry = pendingCalls.get(event.data.callId)
          if (entry) {
            entry.callSeq = event.seq
          }
        }
        break
      case 'tool/result':
        // 工具结果已落盘，移出未决集合
        pendingCalls.delete(event.data.message.source.callId)
        break
      default:
        break
    }
  }

  // 若日志完全平衡（无悬挂开放的 turn），无需任何修复
  const last = events.at(-1)
  if (openTurn === null || last === undefined) {
    return []
  }

  let seq = last.seq + 1
  const time = last.time // 复用最后一条物理事件的时间戳，保持确定性与单调性
  const closers: SessionEvent[] = []

  // 1. 优先闭合所有未决的工具调用
  for (const [callId, { step, callSeq }] of pendingCalls) {
    const started = callSeq !== undefined
    const message: ToolResultMessage = freezeMessage({
      id: MessageId(`interrupted-tool-result-${callId}-${seq}`),
      role: 'user',
      source: { kind: 'tool', callId },
      content: [{
        type: 'tool-result',
        toolCallId: callId,
        isError: true,
        content: [{
          type: 'text',
          text: started
            ? 'The tool call was interrupted after it was recorded, but no result was durably recorded. Its outcome is unknown. Decide whether to retry from the tool semantics: retry only if the operation is read-only or idempotent; if it may have side effects, first verify external state or ask the user. Do not retry blindly.'
            : 'The tool call was interrupted before the Harness recorded it as started. Retry it if it is still needed.',
        }],
      }],
    })

    closers.push({
      type: 'tool/result',
      seq: seq++,
      time,
      data: {
        turn: openTurn,
        step,
        message,
        error: started
          ? { name: 'ToolOutcomeUnknownError', code: TOOL_OUTCOME_UNKNOWN }
          : { name: 'ToolNotStartedError', code: TOOL_NOT_STARTED },
      },
      surfaceOp: 'append',
      ...(started ? { sourceEventSeqs: [callSeq] } : {}),
    })
  }

  // 2. 闭合未闭合的 Step
  if (openStep !== null) {
    closers.push({
      type: 'step/end',
      seq: seq++,
      time,
      data: { turn: openTurn, step: openStep },
    })
  }

  // 3. 闭合未闭合的 Turn，标记为合成的 interrupted 状态
  closers.push({
    type: 'turn/end',
    seq: seq++,
    time,
    data: { turn: openTurn, reason: { kind: 'interrupted' } },
  })

  return closers
}
```

### 6.4 Why unfinished calls must be marked `TOOL_OUTCOME_UNKNOWN`

A common crash-recovery mistake is to delete the tool call from the preceding `assistant/message`, or truncate the log to before the model call, because the tool did not finish.

For operations with external side effects, this is **dangerous**:
1. **Irreversible real-world effects**: A transfer, Docker container creation, or Git commit may already have reached the external server and succeeded before the process crashed. If recovery silently erases the call, the LLM sees no record of it and may perform it **a second time (double execution or double spending)**.
2. **An explicit decision for the LLM**: Closing the unfinished call with a `tool/result` carrying `TOOL_OUTCOME_UNKNOWN` tells the model that the operation was dispatched but its result cannot be confirmed after the crash. The model can use tool metadata such as idempotency or read-only status to decide on safeguards: check external state with `status_check` or `file_stat`, or ask the user for confirmation. This supports resilient recovery without assuming an outcome.

---

## 7. Production failure modes and practices

### 7.1 Concurrent reads and writes desynchronize `SessionSurface` from the log

- **Symptom**: When a user sends two messages quickly or cancels in the web client, the frontend reports `Surface replace: start seq not found in surface`, and the session can no longer load.
- **Cause**: An asynchronous observer reads `session.surface.nodes` through a closure before the event has been pushed into `session.log`, leaving the surface manager's prepared state out of step with the committed log.
- **Diagnosis and prevention**:
  1. Follow the `SurfaceManager` two-phase propose-and-commit protocol. After `validateNext(event)` succeeds, only `session.append()` may perform `log.push()`, within the same microtask tick.
  2. Use the `entry.appending` reentrancy guard in `Session`; never call `session.append()` recursively during a `session/event` broadcast callback.

### 7.2 Writing every streaming chunk amplifies disk I/O

- **Symptom**: During long text generation, disk I/O reaches 100% and Node.js main-thread event-loop lag rises above 500 ms.
- **Cause**: Serializing and writing every few-byte SSE chunk separately creates heavy small-write amplification.
- **Diagnosis and prevention**:
  1. Use the `packChunkRuns` storage encoding: before writing to physical storage, pack consecutive `assistant/chunk` events in one turn into a single `text-chunks` record:
     ```json
     {"type":"text-chunks","turn":1,"step":1,"startSeq":10,"chunks":["Hello"," world","!"]}
     ```
  2. Enable `SessionWriteBehind`'s bounded 200 ms batching window so physical writes flush in blocks of at least 4 KB or 8 KB.

### 7.3 Mishandling `firstLiveSeq` repeats side effects during replay

- **Symptom**: Restoring a session with historical tool calls sends many webhook notifications again or reruns automation scripts.
- **Cause**: A downstream plugin listens to `session/event` during recovery but cannot distinguish cold-start seed events from new events produced by the current process.
- **Diagnosis and prevention**:
  1. The `Session` constructor **must not** broadcast `session/event` while loading seed events.
  2. Expose the read-only `firstLiveSeq` property on `Session` and persist the `session/end-seed` boundary event. Downstream consumers perform external side effects only for live events with `event.seq >= session.firstLiveSeq`.

### 7.4 Unclosed Windows file handles cause EBUSY races

- **Symptom**: A session fork or restart on Windows fails with `EBUSY: resource busy or locked, rename/unlink`.
- **Cause**: Windows enforces strict file locking. A prior read stream or unfinished asynchronous write handle that was not explicitly closed prevents later deletion or replacement.
- **Diagnosis and prevention**:
  1. Use TypeScript `using` and `Symbol.dispose` consistently so `SessionPreparation` and file handles are released synchronously and idempotently on scope exit.
  2. Write through a `.tmp` file and replace atomically with `fs.renameSync`; on Windows, retry rename operations with exponential backoff.

---

## 8. Summary and architecture checklist

### 8.1 Core architecture checklist

Use these ten indicators to review the architecture of an agent session system you build or operate:

- [ ] **Immutability**: Are all event objects frozen with `deepFreeze` after insertion into the session log? Are any public properties still mutable in memory?
- [ ] **Strict sequence continuity**: Does the system enforce $\text{seq} = 0, 1, 2, \dots, N-1$ and refuse to load a log as soon as it finds a gap?
- [ ] **Pure projection**: Is `deriveMessages()` side-effect-free? Does it avoid sending residual empty-content messages to the model?
- [ ] **Independent surface index**: Does context compaction maintain the surface index through a declarative `replace` operator instead of modifying or truncating the underlying factual log?
- [ ] **Complete provenance**: Does every surface replacement declare all shadowed predecessor nodes in `sourceEventSeqs`?
- [ ] **Asynchronous batching**: Does persistence use a bounded coalescing window like `SessionWriteBehind`? Can high-frequency streaming block the main event loop?
- [ ] **Multi-frame compression**: Does the on-disk format use concatenated Zstandard frames or a comparable format to combine high compression with incremental tail appends?
- [ ] **Torn-tail truncation**: On restart, can `scanZstdFrames` or line-by-line JSON scanning locate and truncate partially written bytes before decompression?
- [ ] **Explicit unknown outcomes**: Are unfinished tool calls left by a crash marked `TOOL_OUTCOME_UNKNOWN` rather than erased or falsely reported as successful?
- [ ] **Declaration-merging compatibility**: Can third-party plugin events carry `ignorable: true`? Does the core state machine avoid crashing on the open event union through `assertNever`?
