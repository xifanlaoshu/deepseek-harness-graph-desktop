# Chapter 25: Event Sourcing, Persistence, and Crash Recovery

English | [中文](25-event-sourcing-crash-recovery.zh.md)

In conventional web services and enterprise backends, CRUD (Create, Read, Update, Delete) dominates data persistence. Developers commonly modify state in a relational database such as PostgreSQL or MySQL through an in-place mutation like `UPDATE accounts SET balance = balance - 100 WHERE id = 1`. When the system's driving force becomes an LLM agent that uses **random sampling, multi-turn loops, autonomous tool calls, and external physical side effects**, however, a simple CRUD model can fail and create severe engineering problems.

This chapter examines DeepSeek Harness's data foundation: **event sourcing, its hybrid persistence engines, and the reconciliation algorithm used for reliable crash recovery**. Rather than relying on buzzwords, it traces operating-system calls (`fsync`, `link`, `truncate`), distributed commit logs, Zstandard compressed-frame structure, SQLite WAL, and formal mappings to show systems engineers how to build a robust agent-state engine.

---

## 1. Architectural Overview: Why LLM Agents Need Event Sourcing

```
+---------------------------------------------------------------------------------------------------+
|                                 DeepSeek Harness 状态与持久化全景图                                |
+---------------------------------------------------------------------------------------------------+
                                                  |
                    [ 运行时事实发生 (Runtime Facts Occurred) ]
                                                  |
                                                  v
+---------------------------------------------------------------------------------------------------+
|  SessionEventMap 强类型事件流 (Append-Only Event Ledger)                                           |
|  - 不可变事件: turn/start, user/message, assistant/chunk, tool/call, tool/result, turn/end...        |
|  - 内存保证: deep-freeze, 单调连续整数递增 seq (seq = log.length), 事实不可修改                       |
+---------------------------------------------------------------------------------------------------+
            |                                                           |
            | (纯函数内存投影 Fold/Projection)                            | (异步批处理与耐久性屏障 Flush Barrier)
            v                                                           v
+---------------------------------------------------+   +-----------------------------------------------+
|  CQRS 读模型投影 (Read Projections)               |   |  SessionWriteBehind 写入控制器                 |
|  - deriveMessages(): Message[] (LLM 提示词上下文)  |   |  - Fixed Batching Window (e.g. 200ms)         |
|  - SessionSurface: 拓扑可见消息节点与替换代数       |   |  - Quiescence Barrier 显式排水同步             |
|  - requestHeader(): 提取最新 EpochHeader          |   |  - 失败重试保序与错误隔离                      |
+---------------------------------------------------+   +-----------------------------------------------+
                                                                                |
                                                +-------------------------------+-------------------------------+
                                                |                                                               |
                                                v                                                               v
                        +-----------------------------------------------+       +-----------------------------------------------+
                        |  JSONL + Zstandard 物理存储引擎               |       |  node:sqlite 嵌入式数据库存储引擎 (Schema 17) |
                        |  - Header Line 独立第一帧                      |       |  - STRICT 表约束与外键级联删除                |
                        |  - Concatenated Zstd Frames 批处理帧追加       |       |  - 连续 Chunk Run 物理行压缩打包               |
                        |  - Chunk Runs 动态行折叠 (Pack)                |       |  - WAL 模式 + synchronous=FULL 掉电防护       |
                        |  - 原子发布: POSIX link/unlink, Win32 事务写入 |       |  - Application ID (0x44534850) 强校验        |
                        +-----------------------------------------------+       +-----------------------------------------------+
                                                |                                                               |
                                                +-------------------------------+-------------------------------+
                                                                                |
                                                                                v
                                                +---------------------------------------------------------------+
                                                |  崩溃恢复与对账器 (Crash Recovery & Reconciliation)           |
                                                |  1. 读取最长有效前缀 (Longest Valid Prefix), 裁剪残损尾部      |
                                                |  2. 诊断未闭合调用: TOOL_NOT_STARTED vs TOOL_OUTCOME_UNKNOWN |
                                                |  3. 追加确定性 Synthetic Closers 修复事件 (绝不篡改历史)       |
                                                |  4. 恢复合法 Transcript 拓扑, 安全重启 Agent 循环              |
                                                +---------------------------------------------------------------+
```

### 1.1 Why Traditional CRUD State Storage Fails Agent Systems

Traditional systems programming and web architecture often model state as the latest entity snapshot. A session record, for example, might be a database row with a `messages JSON` column. Whenever an agent receives a model response or tool result, the application runs `UPDATE sessions SET messages = ... WHERE id = ...`. This simple CRUD approach can work for deterministic business logic, but a complex LLM-agent runtime exposes three serious weaknesses:

1. **Loss of non-deterministic auditability**: An LLM samples from a probability distribution. If only the final message array is stored, engineers cannot reconstruct the exact execution context behind a hallucination, accidental deletion of a critical file, or infinite loop. Missing evidence may include streamed token fragments, precise timestamp variations, intermediate retries and backoff, and original context later removed by compaction.

2. **State tearing and race conditions**: Subagents, scheduled jobs, and user interactions may write to the same session concurrently. With overwrite-based storage, concurrent read-modify-write transactions can cause a classic lost update, erasing a model reasoning step or tool-call record.

3. **Failure to track physical side effects across crashes**: Tools affect the external world—for example, by running a shell command over SSH, sending a payment RPC, or writing source files. If power is lost or a process receives `SIGKILL` during a tool call, a CRUD snapshot cannot distinguish a call that was never dispatched from one dispatched but not started, one that succeeded before its result was saved, or one that failed. Blind retries can repeat non-idempotent operations, such as charging an account twice.

### 1.2 Mapping Agent Concepts to Traditional Systems Engineering

The following table maps core agent-runtime concepts to established concepts from operating systems, compilers, and distributed storage:

| Agent concept | Traditional systems-engineering concept | Computational meaning and precise definition |
| :--- | :--- | :--- |
| **Large language model (LLM)** | Probabilistic pure function | A mapping $f: \mathcal{V}^* \to \Delta(\mathcal{V})$ that produces a distribution over the next token given an input token sequence |
| **Token** | Integer lexical-unit ID (`int32` lexical unit) | An integer identifier in the vocabulary, corresponding to a unit after BPE merge-based segmentation |
| **KV Cache** | Memoization cache | Cached prefix key and value tensors in Transformer attention layers, avoiding repeated attention computation over prior tokens |
| **Tool call** | RPC / AST invocation | A structured JSON expression generated by the model and parsed in a sandbox into a system call or RPC |
| **Agent Loop** | Event-driven state-machine loop | A `while(state != TERMINATED) { step(); }` state-transition loop controlled by cooperative cancellation through `AbortSignal` |
| **Harness** | Inversion-of-control dependency-injection container (for example, Cordis or Spring) | Infrastructure that manages service lifecycles, plugin relationships, an event bus, and effect isolation |
| **Event Sourcing** | Append-only commit log / WAL | Immutable factual events record state changes; current state is a pure-function projection folded over history |
| **Projection** | CQRS read-model fold / reduction | $\text{State}_n = \text{Fold}(\text{Events}_{1..n})$: a business view computed by traversing immutable events |
| **Fencing token** | Monotonic distributed exclusion token | A monotonically increasing epoch identifier that lets storage reject late writes from zombie writers |
| **Durability barrier** | Explicit disk flush (`fsync` / WAL commit) | An operation that blocks until kernel page-cache data is flushed to nonvolatile storage |

### 1.3 Immutable Facts and a Formal Derivation

DeepSeek Harness treats **every interaction inside the system as an indelible fact**. Once an event is committed to the log, no component—including the core, plugins, or model—may modify or physically delete it.

#### Formal definitions

Let $\mathcal{E}$ be the discrete event space of the system and $\mathbf{E}_n$ the global event-log sequence for a session:

$$\mathbf{E}_n = [e_0, e_1, e_2, \dots, e_{n-1}] \quad \text{where } e_i \in \mathcal{E}, \; \forall i \in [0, n-1]$$

Each event $e_i$ has a strictly consecutive, monotonically increasing sequence number and a millisecond epoch timestamp:

$$\text{seq}(e_i) = i, \quad \text{time}(e_i) \le \text{time}(e_{i+1})$$

Let $\mathcal{S}$ be the global state space, with initial state $\mathcal{S}_0$. Business state $\mathcal{S}_n$ at step $n$ is defined by a **left fold** of the transition function $f: \mathcal{S} \times \mathcal{E} \to \mathcal{S}$ over $\mathbf{E}_n$:

$$\mathcal{S}_n = \text{Fold}(f, \mathcal{S}_0, \mathbf{E}_n) = f(f(\dots f(\mathcal{S}_0, e_0), e_1 \dots), e_{n-1})$$

For each downstream read model $\mathcal{V}_k$—such as the LLM-visible message history $\mathcal{M}^*$, active todo items $\text{TodoItem}[]$, or request header $\text{EpochHeader}$—there is a deterministic pure projection $\Pi_k: \mathcal{E}^* \to \mathcal{V}_k$:

$$\mathcal{V}_k(n) = \Pi_k(\mathbf{E}_n)$$

Because both $f$ and $\Pi_k$ are pure functions:

1. **Time-travel debugging**: Given any prefix $\mathbf{E}_m$ ($m \le n$), the system can deterministically reconstruct memory and business state at historical point $m$.

2. **Lock-free read projections**: Reads need only an immutable slice of the event array. They do not need to lock persisted data and do not race over mutable event contents.

3. **Deep-freeze safety**: Event objects are recursively traversed and passed to `Object.freeze()` before entering the in-memory array. Attempting to mutate a historical event through a reference throws `TypeError` at runtime.

#### Step-by-step state-fold trace

A three-step interaction illustrates how state $S_k$ and view $\mathcal{V}(k)$ evolve under a pure fold:

$$\mathbf{E}_3 = [e_0, e_1, e_2]$$

- $e_0 = \{ \text{type}: \text{'user/message'}, \text{seq}: 0, \text{data}: \{ \text{content}: \text{"Ping"} \} \}$
- $e_1 = \{ \text{type}: \text{'turn/start'}, \text{seq}: 1, \text{data}: \{ \text{turn}: 1 \} \}$
- $e_2 = \{ \text{type}: \text{'assistant/message'}, \text{seq}: 2, \text{data}: \{ \text{message}: \{ \text{role}: \text{'assistant'}, \text{content}: \text{"Pong"} \} \} \}$

The derivation for each step is:

$$S_0 = \langle \text{messages}: [], \text{openTurn}: \text{null} \rangle$$

$$S_1 = f(S_0, e_0) = \langle \text{messages}: [\text{User("Ping")}], \text{openTurn}: \text{null} \rangle$$

$$S_2 = f(S_1, e_1) = \langle \text{messages}: [\text{User("Ping")}], \text{openTurn}: 1 \rangle$$

$$S_3 = f(S_2, e_2) = \langle \text{messages}: [\text{User("Ping")}, \text{Assistant("Pong")}], \text{openTurn}: 1 \rangle$$

The projection $\Pi_{\text{messages}}(S_3)$ produces this exact conversation array: `[ { role: 'user', content: 'Ping' }, { role: 'assistant', content: 'Pong' } ]`.

#### Memory layout and V8 heap safety

In memory, `Session` maintains a private `private readonly _events: SessionEvent[]` array. A call to `session.append()` performs these operations:

1. **Deep freeze**: Recursively visit payload properties and apply `Object.freeze()` at every level.
2. **Sequence-number assignment**: Set `seq = this._events.length`; callers cannot forge it.
3. **Protected external view**: The `session.events` accessor returns a shallow snapshot of the current frozen array. An external `session.events.push(...)` throws in strict mode, preventing historical edits.

---

## 2. The SessionEventMap Event Bus and Pure Projections

### 2.1 `SessionEventMap` Types and Discriminated Unions

DeepSeek Harness uses TypeScript 6 discriminated unions to constrain every event variant in the session log. Unlike a loose `{ type: string, data: any }` representation, `SessionEvent<T>` lets the TypeScript compiler narrow payloads after `switch (event.type)`, so `event.data` has its valid type.

```ts ignore-check
/**
 * DeepSeek Harness 核心会话事件字典 (SessionEventMap)
 * 采用模块合并（Declaration Merging）支持插件正交扩展
 */
export interface SessionEventMap {
  /** 开启一轮模型循环交互：在声明输入或执行前置注入前写入 */
  'turn/start': { readonly turn: number }

  /** 终结当前轮次交互：携带该轮次结束的强类型根因 */
  'turn/end': { readonly turn: number; readonly reason: TurnEndReason }

  /** 开启一轮交互内部的单步执行（包含一次 LLM 请求及随后触发的全部工具调用） */
  'step/start': { readonly turn: number; readonly step: number }

  /** 关闭单步执行 */
  'step/end': { readonly turn: number; readonly step: number }

  /** 用户角色可见消息：人类输入 Prompt、系统注入上下文或目标延续轮次 */
  'user/message': UserMessage

  /** 模型原生流式 Token 碎片：用于无损高保真重放与流式 UI 渲染 */
  'assistant/chunk': { readonly turn: number; readonly step: number; readonly chunk: StreamChunk }

  /** 单步执行聚合后的模型完整输出（LLM 历史派生直接读取此事件，跳过原始 chunk） */
  'assistant/message': {
    readonly turn: number
    readonly step: number
    readonly message: AssistantMessage
    readonly usage?: TokenUsage
    readonly interrupted?: true
  }

  /** 模型发起的工具调用请求：携带未解析的原始 arguments JSON 字符串 */
  'tool/call': {
    readonly turn: number
    readonly step: number
    readonly callId: CallId
    readonly name: string
    readonly arguments: string
  }

  /** 工具执行完成后的结果事件：模型可见内容、内部失败标识与私有 UI 元数据 */
  'tool/result': {
    readonly turn: number
    readonly step: number
    readonly message: ToolResultMessage
    readonly error?: { readonly name: string; readonly code: string }
    readonly meta?: JsonValue
  }

  /** 任务待办列表全量快照：最后写入者胜（Last-Write-Wins），仅用于 UI 呈现 */
  'todo/write': { readonly todos: readonly TodoItem[] }

  /** 请求信封元数据：包含模型配置、系统提示词快照与工具 Schema 集 */
  'request/header': { readonly header: EpochHeader; readonly reason: RequestHeaderReason }

  /** 路由容量与上下文窗口元数据 */
  'request/context': RequestContext

  /** 构造器种子边界标记：标记此前所有事件来自于冷启动加载或分叉，本进程不重新发布 */
  'session/end-seed': Record<string, never>
}

/** 消息生成型事件类型子集（具备 Surface 拓扑排布元数据） */
export type SurfaceEventType = 'user/message' | 'assistant/message' | 'tool/result'

/** Surface 拓扑排布方式 */
export type SurfaceOp =
  | 'append'
  | { readonly op: 'replace'; readonly start: number; readonly end: number }

/** 单个不可变事件对象包络 */
export type SessionEvent<K extends SessionEventType = SessionEventType> = {
  [T in SessionEventType]: {
    readonly type: T
    readonly seq: number
    readonly time: number
    readonly data: SessionEventMap[T]
    readonly ignorable?: true
  } & (T extends SurfaceEventType ? {
    readonly sourceEventSeqs?: readonly number[]
    readonly surfaceOp?: SurfaceOp
  } : object)
}[K]
```

### 2.2 Deriving History with the Pure `deriveMessages()` Projection

An LLM API does not consume an event stream. APIs such as OpenAI Chat Completions, Anthropic Messages, and DeepSeek accept a conventional `Message[]` array. Traditional architectures often store a redundant `messages` table. In DeepSeek Harness, **the LLM message array is never independently persisted**; it is derived from the event stream by a pure projection.

```
事件流 (Append-Only Event Ledger)
[0] user/message ("请分析系统崩溃原因") -----------------------------> Role: 'user' (Content: "请分析系统崩溃原因")
[1] request/header (config, tools...)   [跳过: 仅系统状态]
[2] turn/start { turn: 1 }              [跳过: 结构标记]
[3] step/start { turn: 1, step: 1 }     [跳过: 结构标记]
[4] assistant/chunk (Token: "我")       [跳过: chunk 不参与历史]
[5] assistant/chunk (Token: "将")       [跳过: chunk 不参与历史]
[6] assistant/message (ToolCall: read) ---------------------------> Role: 'assistant' (ToolCalls: [read_log])
[7] tool/call { callId: "c1", name: "read" } [跳过: 结构调用]
[8] tool/result { callId: "c1", content: "Error 500" } ----------> Role: 'user' (ToolResult: "Error 500")
[9] step/end { turn: 1, step: 1 }       [跳过: 结构标记]
[10] step/start { turn: 1, step: 2 }    [跳过: 结构标记]
[11] assistant/message ("发现未捕获异常") -------------------------> Role: 'assistant' (Content: "发现未捕获异常")
[12] step/end { turn: 1, step: 2 }      [跳过: 结构标记]
[13] turn/end { turn: 1, reason: 'completed' } [跳过: 结构标记]
                                                                        |
                                                                        v
                                                    派生得到的权威上下文 (Message[])
```

The projection $\Pi_{\text{messages}}: \mathbf{E} \to \mathcal{M}^*$ follows a strict dimensionality-reduction rule:

$$\Pi_{\text{messages}}(e) = \begin{cases} [e.\text{data}] & \text{if } e.\text{type} = \text{'user/message'} \\ [e.\text{data}.\text{message}] & \text{if } e.\text{type} = \text{'assistant/message'} \land e.\text{data}.\text{message}.\text{content} \neq \emptyset \\ [\text{FormatToolResult}(e.\text{data})] & \text{if } e.\text{type} = \text{'tool/result'} \\ \emptyset & \text{otherwise (e.g. chunks, structural boundary events)} \end{cases}$$

Important protections at this interface:

1. **Raw token-fragment filtering**: `assistant/chunk` supports live UI streaming and detailed replay, but never enters `deriveMessages()`, preventing duplicate message growth.

2. **Removal of empty truncated messages**: If a model request hits `max-tokens` before generating its first token, `usage` may still be recorded on an `assistant/message` event, but its `content` is empty. The projection explicitly discards it so the downstream model API does not receive an invalid empty assistant message.

### 2.3 `SessionSurface` Topology and Positional Replacement

During long-horizon tasks or context compaction, an agent may summarize the first 50 turns and hide their detailed messages from the model's attention.

A CRUD implementation might run `DELETE FROM messages WHERE id IN (...)`, destroying immutable history and making audit replay impossible. DeepSeek Harness instead uses the **`SessionSurface` positional-replacement model**.

```
物理事件日志 (不可变追加):
  Seq 0: user/message "原始长任务输入..." (Surface Node #0)
  Seq 1: assistant/message "步骤 1 思考与调用" (Surface Node #1)
  Seq 2: tool/result "步骤 1 超长执行结果" (Surface Node #2)
  ...
  Seq 20: user/message (Compaction Summary, surfaceOp: { op: 'replace', start: 0, end: 2 }) (Surface Node #20)

逻辑 Surface 投影视图 (LLM 模型所见):
  [Node #20] (摘要内容) -> [Node #3] -> [Node #4] ...
  (Node #0, #1, #2 在逻辑上被 Node #20 遮蔽/Shadowed，但物理日志完整无损！)
```

`SessionSurface` keeps an ordered array of visible event positions, `nodes: number[]`, and a monotonically increasing `replaceGeneration: number`. When an event with a `replace` operation is appended:

- Historical nodes in the interval $[start, end]$ are removed from the logically visible array;
- The replacement event is inserted at the original position;
- Its `sourceEventSeqs` explicitly identifies every underlying `seq` it shadows;
- The incremental cache manager compares `replaceGeneration`: without replacement, projection costs $O(\Delta N_{\text{new}})$; with replacement, it performs a deterministic rebuild.

### 2.4 How Immutable Event Logs Interact with KV Cache Prefix Hits

Transformer self-attention has quadratic complexity in sequence length, $O(L^2)$. Modern inference systems such as vLLM, SGLang, and DeepSeek Inference Engine use **Prefix Caching / Radix Attention** to retain the key-value vectors for historical prompt tokens in GPU memory (the KV Cache).

Let $\mathbf{T}_{1..k}$ be the first $k$ tokens in the session history. With an immutable append-only log, the prompt sent on each Agent Loop request follows a monotonic-prefix relationship:

$$\mathbf{T}_{\text{prompt}}^{(step + 1)} = \mathbf{T}_{\text{prompt}}^{(step)} \mathbin{\Vert} \Delta \mathbf{T}_{\text{new}}$$

The model server can therefore **reuse the matching prefix in its KV Cache**. Time to first token (TTFT) then requires attention work for only the new suffix $\Delta \mathbf{T}_{\text{new}}$, reducing computation from $O((L + \Delta L)^2)$ to $O(L \cdot \Delta L + \Delta L^2)$.

In contrast, a CRUD in-place edit to an earlier message changes token hashes from that point forward. Subsequent KV Cache entries cannot be reused, reducing cache hits and increasing inference latency and compute cost.

---

## 3. Persistence Mechanisms and Storage-Engine Design

DeepSeek Harness offers two persistence backends for immutable event logs: **JSONL plus concatenated Zstandard frames**, and an **embedded SQLite engine (Schema 17)**.

### 3.1 Cross-Platform JSONL with Concatenated Zstandard Frames

JSON Lines (JSONL) is a widely used plain-text log format in LLM systems because it is readable and appendable as a stream. Plain JSONL also repeats many keys, including `"turn"`, `"step"`, `"content"`, and `"type"`, increasing disk usage.

DeepSeek Harness uses **Zstandard (RFC 8878) concatenated-frame decompression** to retain appendability while compressing the log.

```
+---------------------------------------------------------------------------------------------------+
|                            session.jsonl.zstd 物理存储二进制文件结构                                |
+---------------------------------------------------------------------------------------------------+
| Frame 0: SessionHeader (独立第一帧)                                                               |
| [Magic: 0xFD2FB528] [Frame Header] [Compressed HeaderLine JSON + \n] [32-bit CRC32]             |
+---------------------------------------------------------------------------------------------------+
| Frame 1: Flush Batch 1 Events (首批事件)                                                          |
| [Magic: 0xFD2FB528] [Frame Header] [Compressed EventLines 0..15 + \n] [32-bit CRC32]             |
+---------------------------------------------------------------------------------------------------+
| Frame 2: Flush Batch 2 Events (第二批事件)                                                        |
| [Magic: 0xFD2FB528] [Frame Header] [Compressed EventLines 16..42 + \n] [32-bit CRC32]            |
+---------------------------------------------------------------------------------------------------+
| ...                                                                                               |
+---------------------------------------------------------------------------------------------------+
| Frame K: (Torn Frame / 崩溃残缺帧)                                                                |
| [Magic: 0xFD2FB528] [Frame Header] [Half Written Compressed Bytes...] (EOF 截断, CRC32 缺失)      |
+---------------------------------------------------------------------------------------------------+
```

#### Zstandard frame binary structure

Under the Zstandard specification, each independently decompressible frame has this structure:

1. **Magic number**: The four-byte little-endian constant `0xFD2FB528`.
2. **Frame Header Descriptor** (one byte):
   - Bits 0–1: Dictionary ID flag ($0 \Rightarrow$ no dictionary)
   - Bit 2: Content Checksum flag ($1 \Rightarrow$ a four-byte CRC32 trailer)
   - Bit 3: Reserved bit (must be 0)
   - Bit 4: Unused bit
   - Bit 5: Single Segment flag
   - Bit 6-7: Frame Content Size flag
3. **Compressed blocks**: One or more blocks, each with a three-byte block header indicating whether it is the last block, its type, and its size, followed by FSE (Finite State Entropy) and Huffman-encoded literals and matches.
4. **Content checksum**: A four-byte little-endian CRC32 checksum using the standard polynomial $P(x) = \text{0xEDB88320}$.

#### Packing consecutive chunks into physical lines

During streaming, each model token produces an `assistant/chunk` event. A long conversation can therefore contain thousands of tiny records. The lossless `packChunkRuns()` algorithm merges consecutive text fragments from the same `turn` and `step` into one physical `text-chunks`, `reasoning-chunks`, or `tool-call-chunks` line before writing a batch:

```json
{"type":"text-chunks","turn":1,"step":1,"firstSeq":10,"chunks":["执","行","数","据","库","迁","移"]}
```

This reduces JSON serialization overhead and increases the effectiveness of Zstandard dictionary matching by more than 300%.

#### Comparing physical storage requirements

The following measurements compare disk usage for an engineering-agent benchmark with 1,000 interaction turns:

| Storage format | Size at 100 turns | Size at 1,000 turns | Write throughput (events/s) | Supports physical truncation during repair? |
| :--- | :--- | :--- | :--- | :--- |
| **Unpacked JSONL** | $4.82 \text{ MB}$ | $48.6 \text{ MB}$ | $\sim 12,000$ | Yes (truncate at a line break) |
| **Packed-chunk JSONL (`packChunks`)** | $1.94 \text{ MB}$ | $19.2 \text{ MB}$ | $\sim 28,000$ | Yes (truncate at a line break) |
| **Concatenated Zstd frames (`packChunks + zstd`)** | **$380 \text{ KB}$** | **$3.65 \text{ MB}$** | $\sim 24,000$ | **Yes (truncate at an independent frame)** |
| **SQLite Schema 17 (WAL mode)** | $1.42 \text{ MB}$ | $14.8 \text{ MB}$ | $\sim 18,000$ | Yes (roll back a database transaction) |

These figures indicate that `packChunks + zstd` achieves **92.5% space reduction** while retaining incremental append and per-frame corruption recovery.

### 3.2 Embedded SQLite Engine (`node:sqlite`, Schema 17)

For fast immediate queries, random suffix reads by `seq` (`readFrom`), and strong ACID transactions, Harness provides a preferred backend based on the built-in `node:sqlite` module in Node 22+.

```sql
-- Application ID 校验: 0x44534850 ('DSHP' 的 ASCII 16 进制)
PRAGMA application_id = 1146312784;
PRAGMA user_version = 17;
PRAGMA foreign_keys = ON;

CREATE TABLE persistence_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  store_id  TEXT NOT NULL
) STRICT;

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

#### Important implementation details

- **STRICT tables**: SQLite 3.37+'s `STRICT` keyword rejects weakly typed implicit conversions and enforces stored field types.
- **WAL and `synchronous=FULL`**: Write-Ahead Logging improves concurrent read/write throughput; forcing `synchronous` to `FULL` (2) flushes each transaction before returning to resist power loss.
- **Busy-wait deadlines and retries**: Because SQLite file locks contend across threads and processes, connection initialization uses a `deadline`-driven retry loop with backoff for `SQLITE_BUSY` (error code 5):

$$t_{\text{wait}} = \min \left( \Delta t_{\text{retry}}, \; \max \left( 0, \lceil t_{\text{deadline}} - t_{\text{now}} \rceil \right) \right)$$

### 3.3 Asynchronous Write Batching and Durability Barriers

Calling `fsync()` for every event, including each token chunk, would throttle output to below $100 \text{ ops/sec}$ because a physical flush takes time (roughly $0.5 \sim 2\text{ ms}$ on NVMe SSDs and $10 \sim 15\text{ ms}$ on spinning disks).

DeepSeek Harness therefore uses the **`SessionWriteBehind` asynchronous batch controller**.

```
事件产生 (Session.append) ---> [ 同步内存入队 (Enqueue) ] ---> 立即返回调用方 (0 阻塞)
                                          |
                                          | (启动固定定时器: writeBatchMaxDelayMs = 200ms)
                                          v
                              [ 定时器触发 / 显式 Flush 触发 ]
                                          |
                                          v
                              [ 切分当前待写入批次 batch = pending.splice(0) ]
                                          |
                                          v
                              [ 批量序列化并执行底层物理写入与 fsync ]
                                          |
                     +--------------------+--------------------+
                     |                                         |
                     v (成功)                                   v (失败)
          [ 清空 Active Promise ]                 [ 将 batch 重新插入 pending 队列头部 ]
          [ 释放 Flush 屏障等待者 ]               [ 暂停自动定时器, 抛出异常至错误通道 ]
```

#### A mathematical model of the batch window

Let $t_k$ be the enqueue timestamp of event $k$, and $\Delta t_{\text{window}}$ the maximum batch delay (default $200\text{ ms}$). The active batch's trigger time $T_{\text{trigger}}$ is bounded by:

$$T_{\text{trigger}} = \min \left( t_{\text{first\_pending}} + \Delta t_{\text{window}}, \; T_{\text{explicit\_flush}} \right)$$

Regardless of how many events arrive during the $\Delta t_{\text{window}}$ interval—for example, one `assistant/message` and ten `tool/call` events—they are packed into **one I/O transaction** with one `fsync`. At the end of an Agent Step, before invoking a tool or returning control to the user, the framework calls `await ctx.sessions.flush(session)`. `SessionWriteBehind` then cancels its timer and passes the flush barrier only after all pending writes are physically durable.

#### Cross-platform atomic publication

Writing a newly created session log directly to its final path could leave a partial file after a crash. Harness uses platform-specific atomic publication:

- **POSIX (Linux / macOS)**: Write to a temporary file with a random suffix (`session.jsonl.tmp.XXXXXX`) and call `handle.sync()`, then `link(tmp, finalPath)`. If the final path exists, `link()` fails atomically with `EEXIST`, preventing an overwrite. Finally, `syncDirPosix(dir)` syncs the parent directory descriptor so the directory entry is durable.
- **Windows (Win32)**: Use a native Windows file-creation API with `FILE_FLAG_WRITE_THROUGH` and dedicated transactional rename logic to preserve crash consistency on NTFS.

---

## 4. Crash Recovery and Reconciliation Algorithms

In distributed and single-host systems, **crashes are expected operational events**. An agent architecture that omits crash recovery from its state-machine design is incomplete.

### 4.1 Crash Windows and Incomplete-State Categories

A typical agent turn passes through the following milestones; power can fail or the process can crash after any one of them:

```
 时序点 T0: [turn/start] 落盘
 时序点 T1: [step/start] 落盘
 时序点 T2: [assistant/message] (包含 ToolCall: "delete_database") 落盘
   =======> 崩溃窗口 A: 模型已声明调用，但底层尚未记录 tool/call 事件
 时序点 T3: [tool/call] { callId: "c1", name: "delete_database" } 落盘
   =======> 崩溃窗口 B: 磁盘已记录 tool/call 开始执行，但工具执行中途崩溃，无 tool/result
 时序点 T4: 工具执行完毕，[tool/result] 落盘
 时序点 T5: [step/end] 落盘
   =======> 崩溃窗口 C: step 已正常结束，但整个 turn 尚未闭合 (无 turn/end)
 时序点 T6: [turn/end] 落盘
```

When a cold session log is loaded from disk, the persistence backend first finds the **longest physically valid prefix**:

1. If the tail contains half-written JSON or a damaged Zstandard frame whose CRC32 check fails, the scanner identifies the final complete record's byte offset, `committedBytes`, and physically trims the torn tail with `truncate()`.
2. The reconciliation algorithm then examines the physically validated event array for incomplete logical state-machine transitions.

### 4.2 Diagnosing Unclosed Calls

A single pass over historical events maintains three cursors:

- `openTurn: number | null`: The currently open turn number;
- `openStep: number | null`: The currently open step number;
- `pendingCalls: Map<CallId, { step: number, callSeq?: number }>`: Tool calls that have not yet been closed.

```
对账扫描算法状态转移流程：
  1. 遇到 'turn/start'  -> openTurn = turn, 清空 pendingCalls
  2. 遇到 'turn/end'    -> openTurn = null, 清空 pendingCalls
  3. 遇到 'step/start'  -> openStep = step
  4. 遇到 'step/end'    -> openStep = null, 清空 pendingCalls
  5. 遇到 'assistant/message' -> 提取 content 中的全部 tool-call 块，存入 pendingCalls[callId] = { step }
  6. 遇到 'tool/call'   -> pendingCalls[callId].callSeq = event.seq (标记该工具已进入物理启动)
  7. 遇到 'tool/result' -> 从 pendingCalls 中删除该 callId (标记该工具已闭合)
```

#### Diagnostic branch 1: `TOOL_NOT_STARTED`

- **Signature**: An `assistant/message` contains a model tool-call request in its `content`, but no corresponding `tool/call` event appears anywhere in the session log.
- **Physical fact**: The crash happened before Harness dispatched the tool. Its physical side effect **definitely never began**.
- **Repair**: Use code `TOOL_NOT_STARTED` in a synthetic `tool/result`, and tell the model that the call was interrupted before it started and may safely be requested again if needed.

#### Diagnostic branch 2: `TOOL_OUTCOME_UNKNOWN` (critical safeguard)

- **Signature**: A `tool/call` event exists, but the file ends without another event carrying the same `callId`: the corresponding `tool/result` is absent.
- **Physical fact**: The tool process might have run some or all of its commands—for example, charging through an HTTP request or writing part of a file—before the result was persisted. **The external side effect is unknown.**
- **Safety rule**: **Never blindly rerun that tool during crash recovery.**
- **Repair**: Use code `TOOL_OUTCOME_UNKNOWN` in a synthetic `tool/result`. Its defensive content tells the model: “The tool call was interrupted after it was recorded, but no result was durably recorded. Its outcome is unknown. Decide whether to retry from the tool semantics: retry only if the operation is read-only or idempotent; if it may have side effects, first verify external state or ask the user. Do not retry blindly.”

### 4.3 Appending Repair Events Without Changing History

A tempting repair strategy is to edit an earlier event—for example, remove the tool call from `assistant/message`. **That violates the immutability rule of event sourcing.**

DeepSeek Harness instead uses **pure append**. Synthetic closer events that rebalance the state machine receive strictly consecutive `seq` values after the last valid event. Their `time` values inherit the last real event's timestamp rather than inventing a future wall-clock time:

```
[原始历史 (不可修改)]
...
Event #100: assistant/message (ToolCall: c1, c2)
Event #101: tool/call (c1)
[断电崩溃发生 / 重启恢复进入]
=========================================================
[追加合成修复事件 (Synthetic Repair Events)]
Event #102: tool/result (c1, Error: TOOL_OUTCOME_UNKNOWN, surfaceOp: 'append', sourceEventSeqs: [101])
Event #103: tool/result (c2, Error: TOOL_NOT_STARTED, surfaceOp: 'append')
Event #104: step/end { turn: 1, step: 2 }
Event #105: turn/end { turn: 1, reason: { kind: 'interrupted' } }
```

On `turn/end`, the `interrupted` reason is **generated only by the crash-recovery engine**; the normal Agent Loop never emits it. Consumers and the UI can use that marker to explain that a session was interrupted and safely recovered.

---

## 5. Hands-On: Build an Event Projection Engine and Crash Recoverer

This section builds two complete, strongly typed TypeScript modules: an event projection engine and a crash reconciliation recoverer.

### 5.1 Exercise One: Event Model and Pure Projection Engine (`projection.ts`)

Create a file and implement a typed projection with caching and positional replacement:

```ts ignore-check
/**
 * 模块：事件投影引擎 (Projection Engine)
 * 职责：纯函数式计算状态视图，将不可变事件流转换为 LLM 对话上下文与请求配置
 */

export type SessionId = string & { readonly __brand: unique symbol }
export type CallId = string & { readonly __brand: unique symbol }
export type MessageId = string & { readonly __brand: unique symbol }

export type Role = 'user' | 'assistant' | 'system'

export interface TextContentBlock {
  readonly type: 'text'
  readonly text: string
}

export interface ToolCallContentBlock {
  readonly type: 'tool-call'
  readonly id: CallId
  readonly name: string
  readonly arguments: string
}

export interface ToolResultContentBlock {
  readonly type: 'tool-result'
  readonly toolCallId: CallId
  readonly content: readonly TextContentBlock[]
  readonly isError?: boolean
}

export type ContentBlock = TextContentBlock | ToolCallContentBlock | ToolResultContentBlock

export interface Message {
  readonly id: MessageId
  readonly role: Role
  readonly content: readonly ContentBlock[]
}

export interface LlmCallConfig {
  readonly provider: string
  readonly model: string
  readonly temperature?: number
}

export interface EpochHeader {
  readonly config: LlmCallConfig
  readonly system?: string
}

export type TurnEndReason =
  | { readonly kind: 'completed' }
  | { readonly kind: 'aborted' }
  | { readonly kind: 'error'; readonly error: { readonly message: string; readonly code: string } }
  | { readonly kind: 'max-tokens' }
  | { readonly kind: 'interrupted' }

export interface SessionEventMap {
  'turn/start': { readonly turn: number }
  'turn/end': { readonly turn: number; readonly reason: TurnEndReason }
  'step/start': { readonly turn: number; readonly step: number }
  'step/end': { readonly turn: number; readonly step: number }
  'user/message': { readonly id: MessageId; readonly content: readonly ContentBlock[] }
  'assistant/chunk': { readonly turn: number; readonly step: number; readonly delta: string }
  'assistant/message': { readonly turn: number; readonly step: number; readonly message: Message; readonly interrupted?: true }
  'tool/call': { readonly turn: number; readonly step: number; readonly callId: CallId; readonly name: string; readonly arguments: string }
  'tool/result': { readonly turn: number; readonly step: number; readonly message: Message; readonly error?: { readonly name: string; readonly code: string } }
  'request/header': { readonly header: EpochHeader }
}

export type SessionEventType = keyof SessionEventMap
export type SurfaceEventType = 'user/message' | 'assistant/message' | 'tool/result'

export type SurfaceOp =
  | 'append'
  | { readonly op: 'replace'; readonly start: number; readonly end: number }

export type SessionEvent<K extends SessionEventType = SessionEventType> = {
  [T in SessionEventType]: {
    readonly type: T
    readonly seq: number
    readonly time: number
    readonly data: SessionEventMap[T]
    readonly sourceEventSeqs?: readonly number[]
    readonly surfaceOp?: SurfaceOp
  }
}[K]

/**
 * 纯函数：将单个事件转换为模型可见的 Message 实体
 */
export function deriveEventMessage(event: SessionEvent): Message | null {
  switch (event.type) {
    case 'user/message': {
      return {
        id: event.data.id,
        role: 'user',
        content: event.data.content,
      }
    }
    case 'assistant/message': {
      // 若助手输出内容为空（如受限直接中断），则从 LLM 视界中剔除
      if (event.data.message.content.length === 0) {
        return null
      }
      return event.data.message
    }
    case 'tool/result': {
      return event.data.message
    }
    default:
      // chunks, request/header, turn/step 边界事件均不产生 Message
      return null
  }
}

/**
 * 纯函数：折叠事件流以计算最新的 Request Header
 */
export function foldRequestHeader(events: readonly SessionEvent[]): EpochHeader | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event !== undefined && event.type === 'request/header') {
      return event.data.header
    }
  }
  return undefined
}

/**
 * Surface 拓扑管理者：处理 Append 与 Positional Replace 投影折叠
 */
export class SurfaceManager {
  private _nodes: number[] = []
  private _replaceGeneration = 0

  constructor(events: readonly SessionEvent[] = []) {
    this.foldAll(events)
  }

  get nodes(): readonly number[] {
    return this._nodes
  }

  get replaceGeneration(): number {
    return this._replaceGeneration
  }

  /**
   * 提交单个事件进入 Surface 拓扑
   */
  append(event: SessionEvent): void {
    if (!this.isSurfaceEvent(event)) {
      return
    }

    const op = event.surfaceOp ?? 'append'
    if (op === 'append') {
      this._nodes.push(event.seq)
    } else if (typeof op === 'object' && op.op === 'replace') {
      const startIndex = this._nodes.indexOf(op.start)
      const endIndex = this._nodes.indexOf(op.end)

      if (startIndex === -1 || endIndex === -1 || startIndex > endIndex) {
        throw new Error(`Invalid replace operation: range [${op.start}, ${op.end}] not found in surface`)
      }

      // 替换拓扑节点：删除被遮蔽区间，插入新事件 seq
      this._nodes.splice(startIndex, endIndex - startIndex + 1, event.seq)
      this._replaceGeneration++
    }
  }

  private foldAll(events: readonly SessionEvent[]): void {
    for (const ev of events) {
      this.append(ev)
    }
  }

  private isSurfaceEvent(event: SessionEvent): event is SessionEvent<SurfaceEventType> {
    return event.type === 'user/message' || event.type === 'assistant/message' || event.type === 'tool/result'
  }
}

/**
 * 高性能会话投影聚合器
 */
export class SessionProjectionAggregator {
  private surface = new SurfaceManager()
  private messageCache = new Map<number, Message>()
  private cachedDerivedMessages: Message[] | null = null
  private lastGeneration = -1

  constructor(private readonly events: readonly SessionEvent[]) {
    for (const ev of events) {
      this.surface.append(ev)
    }
  }

  /**
   * 获取 LLM 上下文消息列表 (带增量缓存支持)
   */
  deriveMessages(): readonly Message[] {
    if (this.cachedDerivedMessages !== null && this.lastGeneration === this.surface.replaceGeneration) {
      return this.cachedDerivedMessages
    }

    const result: Message[] = []
    for (const seq of this.surface.nodes) {
      let msg = this.messageCache.get(seq)
      if (!msg) {
        const ev = this.events[seq]
        if (ev) {
          const derived = deriveEventMessage(ev)
          if (derived) {
            msg = Object.freeze(derived)
            this.messageCache.set(seq, msg)
          }
        }
      }
      if (msg) {
        result.push(msg)
      }
    }

    this.cachedDerivedMessages = Object.freeze(result)
    this.lastGeneration = this.surface.replaceGeneration
    return this.cachedDerivedMessages
  }
}
```

### 5.2 Exercise Two: Production-Style Crash Diagnosis and Reconciliation (`recovery.ts`)

Next, implement a recoverer covering physically torn records, unclosed state-machine transitions, and synthetic repair events:

```ts ignore-check
/**
 * 模块：崩溃诊断与对账恢复引擎 (Crash Recovery & Reconciliation)
 * 职责：读取受损/中断的会话日志，分析未闭合调用，生成确定性合成修复事件
 */

import type {
  SessionEvent,
  TurnEndReason,
  CallId,
  MessageId,
  ToolResultMessage,
} from './projection.ts'

export const TOOL_NOT_STARTED = 'TOOL_NOT_STARTED'
export const TOOL_OUTCOME_UNKNOWN = 'TOOL_OUTCOME_UNKNOWN'

export interface ReconciliationReport {
  readonly isClean: boolean
  readonly orphanedTurn: number | null
  readonly orphanedStep: number | null
  readonly unclosedCalls: ReadonlyArray<{
    readonly callId: CallId
    readonly name: string
    readonly step: number
    readonly status: 'NOT_STARTED' | 'OUTCOME_UNKNOWN'
  }>
  readonly syntheticClosers: readonly SessionEvent[]
}

/**
 * 核心对账算法：计算使会话日志达到平衡所需的确定性 Synthetic Closer 事件集
 */
export function reconcileInterruptedSession(events: readonly SessionEvent[]): ReconciliationReport {
  let openTurn: number | null = null
  let openStep: number | null = null

  // 追踪未闭合调用的状态
  // key: CallId, value: { name, step, callSeq }
  const pendingCalls = new Map<CallId, { name: string; step: number; callSeq?: number }>()

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
        for (const block of event.data.message.content) {
          if (block.type === 'tool-call') {
            pendingCalls.set(block.id, {
              name: block.name,
              step: event.data.step,
            })
          }
        }
        break

      case 'tool/call': {
        const entry = pendingCalls.get(event.data.callId)
        if (entry) {
          entry.callSeq = event.seq
        }
        break
      }

      case 'tool/result': {
        // tool/result 正常闭合调用
        for (const block of event.data.message.content) {
          if (block.type === 'tool-result') {
            pendingCalls.delete(block.toolCallId)
          }
        }
        break
      }

      default:
        break
    }
  }

  // 若 turn 已正常闭合且无事件，说明处于干净平衡状态
  const lastEvent = events.at(-1)
  if (openTurn === null || lastEvent === undefined) {
    return {
      isClean: true,
      orphanedTurn: null,
      orphanedStep: null,
      unclosedCalls: [],
      syntheticClosers: [],
    }
  }

  let nextSeq = lastEvent.seq + 1
  const recoveryTime = lastEvent.time // 确定性复用最后已知时间戳
  const syntheticClosers: SessionEvent[] = []
  const diagnosticCalls: Array<{
    callId: CallId
    name: string
    step: number
    status: 'NOT_STARTED' | 'OUTCOME_UNKNOWN'
  }> = []

  // 1. 优先闭合挂起的工具调用 (LLM 协议规定：未闭合的 ToolCall 会导致下游拒绝处理)
  for (const [callId, info] of pendingCalls) {
    const isStarted = info.callSeq !== undefined
    const status = isStarted ? 'OUTCOME_UNKNOWN' : 'NOT_STARTED'
    const errorCode = isStarted ? TOOL_OUTCOME_UNKNOWN : TOOL_NOT_STARTED

    diagnosticCalls.push({
      callId,
      name: info.name,
      step: info.step,
      status,
    })

    const failureMessage: ToolResultMessage = {
      id: `synthetic-msg-${callId}-${nextSeq}` as MessageId,
      role: 'user',
      content: [{
        type: 'tool-result',
        toolCallId: callId,
        isError: true,
        content: [{
          type: 'text',
          text: isStarted
            ? `[CRASH RECOVERY] The tool invocation "${info.name}" (${callId}) was recorded as STARTED, but no result was persisted before process crash. Side-effects are UNKNOWN. Do not blindly retry non-idempotent operations.`
            : `[CRASH RECOVERY] The tool invocation "${info.name}" (${callId}) was requested by assistant, but Harness crashed BEFORE execution began. It is SAFE to retry.`,
        }],
      }],
    }

    const toolResultEvent: SessionEvent<'tool/result'> = {
      type: 'tool/result',
      seq: nextSeq++,
      time: recoveryTime,
      data: {
        turn: openTurn,
        step: info.step,
        message: failureMessage,
        error: {
          name: isStarted ? 'ToolOutcomeUnknownError' : 'ToolNotStartedError',
          code: errorCode,
        },
      },
      surfaceOp: 'append',
      ...(isStarted ? { sourceEventSeqs: [info.callSeq!] } : {}),
    }
    syntheticClosers.push(toolResultEvent)
  }

  // 2. 闭合悬挂的 step
  if (openStep !== null) {
    const stepEndEvent: SessionEvent<'step/end'> = {
      type: 'step/end',
      seq: nextSeq++,
      time: recoveryTime,
      data: {
        turn: openTurn,
        step: openStep,
      },
    }
    syntheticClosers.push(stepEndEvent)
  }

  // 3. 闭合悬挂的 turn，写入专有的 interrupted 结束标识
  const turnEndReason: TurnEndReason = { kind: 'interrupted' }
  const turnEndEvent: SessionEvent<'turn/end'> = {
    type: 'turn/end',
    seq: nextSeq++,
    time: recoveryTime,
    data: {
      turn: openTurn,
      reason: turnEndReason,
    },
  }
  syntheticClosers.push(turnEndEvent)

  return {
    isClean: false,
    orphanedTurn: openTurn,
    orphanedStep: openStep,
    unclosedCalls: diagnosticCalls,
    syntheticClosers: Object.freeze(syntheticClosers),
  }
}
```

### 5.3 Exercise Three: Simulate and Test End-to-End Crash Cases

These cases test the engine against representative crashes:

```ts ignore-check
import { reconcileInterruptedSession, TOOL_OUTCOME_UNKNOWN, TOOL_NOT_STARTED } from './recovery.ts'
import { SessionProjectionAggregator, type SessionEvent, type CallId, type MessageId } from './projection.ts'

function runCrashSimulationTest() {
  console.log('=== 开始崩溃对账与恢复仿真测试 ===\n')

  const now = Date.now()
  const rawEvents: SessionEvent[] = [
    { type: 'user/message', seq: 0, time: now, data: { id: 'm0' as MessageId, content: [{ type: 'text', text: '请帮我扣除 100 元并发送确认邮件' }] }, surfaceOp: 'append' },
    { type: 'request/header', seq: 1, time: now, data: { header: { config: { provider: 'deepseek', model: 'deepseek-chat' } } } },
    { type: 'turn/start', seq: 2, time: now, data: { turn: 1 } },
    { type: 'step/start', seq: 3, time: now, data: { turn: 1, step: 1 } },
    {
      type: 'assistant/message',
      seq: 4,
      time: now,
      data: {
        turn: 1,
        step: 1,
        message: {
          id: 'm1' as MessageId,
          role: 'assistant',
          content: [
            { type: 'tool-call', id: 'call_pay_999' as CallId, name: 'deduct_balance', arguments: '{"amount":100}' },
            { type: 'tool-call', id: 'call_mail_888' as CallId, name: 'send_email', arguments: '{"to":"user@test.com"}' },
          ],
        },
      },
      surfaceOp: 'append',
    },
    // 假设 deduct_balance 已记录 tool/call 开始，但随即便遭遇突发掉电，无 tool/result
    { type: 'tool/call', seq: 5, time: now, data: { turn: 1, step: 1, callId: 'call_pay_999' as CallId, name: 'deduct_balance', arguments: '{"amount":100}' } },
    // send_email 甚至连 tool/call 都没有记录就发生了崩溃
  ]

  console.log(`[1] 原始受损日志加载完成，事件总数: ${rawEvents.length}`)

  // 执行崩溃对账诊断
  const report = reconcileInterruptedSession(rawEvents)

  console.log(`[2] 诊断完成 -> isClean: ${report.isClean}, 孤立轮次: ${report.orphanedTurn}, 孤立单步: ${report.orphanedStep}`)
  console.log('[3] 未闭合调用诊断详情:')
  for (const call of report.unclosedCalls) {
    console.log(`    - CallId: ${call.callId} (${call.name}) -> 诊断状态: ${call.status}`)
  }

  // 验证断言
  if (report.unclosedCalls.find(c => c.callId === ('call_pay_999' as CallId))?.status !== 'OUTCOME_UNKNOWN') {
    throw new Error('断言失败: call_pay_999 必须诊断为 OUTCOME_UNKNOWN')
  }
  if (report.unclosedCalls.find(c => c.callId === ('call_mail_888' as CallId))?.status !== 'NOT_STARTED') {
    throw new Error('断言失败: call_mail_888 必须诊断为 NOT_STARTED')
  }

  // 合并合成事件，构建恢复后的完整日志
  const repairedEvents = [...rawEvents, ...report.syntheticClosers]
  console.log(`\n[4] 追加合成修复事件完成，恢复后事件总数: ${repairedEvents.length}`)

  // 再次进行对账验证，此时必须为 Clean 状态
  const secondCheck = reconcileInterruptedSession(repairedEvents)
  if (!secondCheck.isClean) {
    throw new Error('断言失败: 修复后的日志必须处于 Clean 平衡状态')
  }
  console.log('[5] 二次验证通过: 状态机已完全闭合！')

  // 测试投影引擎在修复后日志上的表现
  const projection = new SessionProjectionAggregator(repairedEvents)
  const messages = projection.deriveMessages()
  console.log(`\n[6] 投影生成 LLM 提示词消息列表，消息数量: ${messages.length}`)
  console.log(JSON.stringify(messages, null, 2))

  console.log('\n=== 崩溃对账与恢复仿真测试全部成功通过！ ===')
}

runCrashSimulationTest()
```

---

## 6. Production Troubleshooting and Pitfalls

At production scale, event-sourced agent systems with file persistence can encounter difficult edge cases. The following four cases summarize operational constraints and troubleshooting procedures.

### 6.1 Failure One: Concurrent Instances and Session ID Collisions

- **Symptom**: Operators start the same agent instance on two machines with duplicate working-directory or ID settings. On-disk `session.jsonl` records become interleaved, and `seq` values are missing or duplicated.
- **Cause**: Without a central coordination lock, such as a LoopX lease, two independent processes can concurrently `append` to one file. Their kernel write positions interleave, invalidating the assumption that `seq = log.length` remains consecutive.
- **Defense and diagnosis**:
  1. **CWD scope isolation**: Harness includes `projectKey(cwd)` when computing a path. If an identical SessionId belongs to a different `cwd`, it raises `SessionIdCollisionError` and refuses to start.
  2. **Monotonic revision optimistic lock**: The SQLite backend uses a monotonically increasing `revision` field. The file backend compares an `ino:size:mtimeNs` fingerprint while reading. A changed physical fingerprint aborts the write and triggers a retry.

### 6.2 Failure Two: Blind Retries of Non-Idempotent Tools Damage Money or Data

- **Symptom**: An agent running `execute_sql_migration` or `pay_vendor_invoice` loses network connectivity. A general HTTP or agent retry policy runs the migration twice or pays the vendor twice.
- **Cause**: A network interruption or process crash is treated as an ordinary tool-argument error. As noted above, the result of an unclosed call is `TOOL_OUTCOME_UNKNOWN`.
- **Diagnosis and repair requirements**:
  - **Classify tool metadata**: Tools registered with Harness must declare idempotency properties (`isReadOnly: boolean`, `isIdempotent: boolean`).
  - **Block automatic replay**: The recovery warning has highest priority. Only tools marked `isReadOnly: true` or explicitly declared idempotent may retry without user confirmation. A non-idempotent write must pause and alert a human for confirmation.

### 6.3 Failure Three: Power Loss Damages Directory Entries or Tears SQLite Data

- **Symptom**: A test machine loses power. After restart, the newly created session directory exists, but `session.jsonl` is empty, or SQLite reports `file is not a database`.
- **Cause**: On Linux, writing data and calling `fsync(file_fd)` makes the file's data pages durable, **not necessarily the parent directory metadata entry that names it**. If the parent directory descriptor is not synced after `mkdir` or file creation, power loss can remove the directory entry.
- **Repair**: Harness follows a **two-level `fsync` protocol**, syncing the parent directory and data file around creation:

```ts ignore-check
// 必须显式同步父目录描述符与目标数据文件
await syncDirPosix(dirname(finalPath))
await handle.sync()
```

The SQLite backend enforces `PRAGMA synchronous = FULL` and `PRAGMA foreign_keys = ON`; it does not use `synchronous = OFF` just to improve benchmark scores.

### 6.4 Failure Four: Leaked `SessionPreparation` Handles Exhaust Memory and Locks

- **Symptom**: Node.js memory usage rises over several days. Attempts to `prepare` a historical session often fail with `cannot prepare session while it is live`.
- **Cause**: Application code calls `ctx.sessionPersistence.prepare(id)` to load a session, then throws before invoking `preparation[Symbol.dispose]()`. The persistence controller's preparation queue (LRU Cache) and exclusive lock retain the Session object, preventing garbage collection and blocking another preparation.
- **Repair**: Use TypeScript 5.2+ Explicit Resource Management with `using`:

```ts ignore-check
// 确保离开作用域时通过 Disposable 协议自动且幂等地释放 reservation
using preparation = await ctx.sessionPersistence.prepare(sessionId)
await doBusinessLogic(preparation.session)
```

---

## 7. Chapter Summary and Architectural Implications

This chapter examined event sourcing and persistence recovery as foundations for an LLM-agent system. It explained why overwrite-based CRUD is insufficient for non-deterministic multi-turn execution and traced DeepSeek Harness's design through several systems-engineering mechanisms:

1. **Immutable fact ledger**: A monotonically increasing, discriminated `SessionEventMap` stream is the single source of truth. Business views, including the LLM-visible prompt history, are derived by pure folds.

2. **Hybrid high-performance persistence backends**:
   - **JSONL + Zstandard** uses concatenated frames, independent frame checks, packing of consecutive token chunks, and cross-platform atomic hard-link publication to combine compression with appendability and readability;
   - **SQLite Schema 17** uses STRICT tables and WAL flushes for random reads over large session collections and ACID transactions.

3. **Deterministic crash reconciliation**: Scanning the longest physically valid prefix distinguishes `TOOL_NOT_STARTED` from `TOOL_OUTCOME_UNKNOWN`. Repair **never mutates history; it only appends synthetic events**, avoiding blind repetition of non-idempotent side effects.

---

## 8. Hands-On Exercises and Further Questions

1. **Exercise 1: Build a CRC32-Aware Torn-Log Truncator**
   - Write a Node.js script that reads a `session.jsonl` file with a deliberately appended half-line of invalid bytes.
   - Use `scanLog` to calculate the valid `committedBytes`, call `fs.truncate()` to repair the file, and verify that `JSON.parse` can read the repaired records without data loss.

2. **Exercise 2: Extend SessionEventMap with a Custom Read-Only Projection**
   - Use TypeScript declaration merging to extend `SessionEventMap` with `'audit/file-modified': { path: string; linesChanged: number }`.
   - Write a pure `deriveFileModificationReport(events)` projection that folds the log into counts of modified files and changed lines.

3. **Further Question: Adopting a Session Across Hot Module Reloads (HMR)**
   - When a server reloads after a code change, its in-memory `Session` object is destroyed while the underlying agent process may continue. How should `PersistenceCoordinator` use `adoptLivePrefix` to bind the physical log to a new in-memory Session without injecting `turn/end { reason: 'interrupted' }`?
