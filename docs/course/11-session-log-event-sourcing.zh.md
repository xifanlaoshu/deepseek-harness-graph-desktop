# 第 11 章：会话日志：系统的事实记录

在传统的 Web 开发或企业级业务系统中，状态持久化通常采用面向可变状态（Mutable State）的 CRUD 模式：一条用户记录、一个购物车或一张订单在关系型数据库中对应一行数据，每次更新操作（`UPDATE`）都会直接覆盖旧的值。然而，当工程师尝试将这种“可变状态覆盖”的心智模型套用到大语言模型（LLM）智能体（Agent）系统时，系统往往会在短时间内陷入难以自拔的泥潭：中断的流式响应无法复原、多步骤工具调用链条在崩溃后出现状态断层、人工干预与历史回放导致上下文错乱，甚至在排查生产事故时发现现场数据已被后续操作彻底破坏。

为了解决这一系列根本性的工程挑战，现代工业级 Agent 运行时（如 DeepSeek Harness）全面拥抱了源自分布式系统与金融级交易架构的设计范式——**事件溯源（Event Sourcing）与仅追加日志（Append-only Event Log）**。

在 DeepSeek Harness 中，一个会话（Session）在本质上不是一个不断被修改的“消息数组”，而是一条由强类型、单调自增序号严格约束、物理不可篡改的**事实记录流（Stream of Facts）**。智能体看到的全部 LLM 提示词历史（Message History）、UI 渲染的交互卡片、待办事项列表（Todos）乃至配置头信息，均是这条底层事件日志在特定时刻的**纯函数动态投影（Pure Functional Projection）**。

本章将深入剖析 DeepSeek Harness 的会话日志与持久化子系统，从事件溯源的数学与工程哲学出发，详解 `Session.deriveMessages()` 动态投影算法、两阶段提议-提交状态机、基于 Zstandard 多帧流与 `node:sqlite` 的底层持久化引擎，以及在面对进程崩溃或系统掉电时确保状态绝对一致的崩溃恢复算法。

---

## 1. 概念映射：从传统系统编程到事件溯源会话

为了帮助具备传统编程经验（C/C++/Java/Go/Rust/Python）的工程师快速建立精准的工程直觉，我们将 Agent 会话日志系统中的核心概念映射到经典操作系统、分布式系统与数据库内核中：

| 智能体 / Harness 概念 | 传统系统编程 / 数据库 / 分布式概念 | 核心工程特性与职责 |
| :--- | :--- | :--- |
| **`Session`** | **数据库预写日志（WAL）/ 分布式 Commit Log（如 Kafka Partition）** | 会话生命周期的唯一事实真源（Source of Truth），仅支持尾部追加，保证严格因果时序。 |
| **`SessionEvent`** | **不可变事务日志帧（Immutable WAL Frame / Journal Record）** | 带有全局单调自增序号（`seq`）和物理时间戳（`time`）的离散业务事实，禁止原地修改。 |
| **`SessionEventMap`** | **编译期多态事件虚表 / 协议缓冲区（Protobuf Oneof / IDL 联合体）** | 通过 TypeScript 声明合并（Declaration Merging）支持插件化扩展的强类型事件词汇表。 |
| **`Session.deriveMessages()`** | **物化视图（Materialized View）/ 状态机折叠投影函数（Fold / Reduce）** | 将细粒度的系统底层事件流，动态折叠过滤为模型推理上下文所需的 `Message[]` 数组。 |
| **`SessionSurface`** | **带历史重写索引的逻辑视图（Versioned Surface Index）** | 维护所有产生模型可见消息的节点序列，支持单调追加与上下文压缩范围替换（`SurfaceOp`）。 |
| **`session/end-seed`** | **检查点隔离屏障（Checkpoint / Replay Epoch Barrier）** | 区分冷启动恢复种子（Seed）与当前进程实时产出（Live）的持久化分界线，防止重复发布。 |
| **`PersistenceCoordinator`** | **存储引擎事务协调器 / 读写分离与缓存管理器（Storage Coordinator）** | 负责多后端适配、LRU 预备态会话缓存、异步批量合并写（Write-Behind）与崩溃对账。 |
| **`SessionWriteBehind`** | **有界写缓冲区（Bounded Write Buffer / Dirty Page Flusher）** | 接收同步事件投递，通过固定延迟窗口（Deadline Window）合并磁盘 I/O，支持显式 `fsync` 屏障。 |
| **`interruptedTurnClosers`** | **崩溃对账补偿事务（Compensating Transaction / ARIES Recovery）** | 在系统异常重启后，识别悬空的未闭合调用，合成错误结果并闭合轮次，恢复确定性状态。 |
| **`TOOL_OUTCOME_UNKNOWN`** | **分布式两阶段提交中的未知决议（In-Doubt State / Unknown Outcome）** | 显式标记已派发但未确认持久化结果的工具调用，强制 LLM 结合幂等性语义决定是否安全重试。 |

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

## 2. 仅追加事件日志（Append-only Event Log）哲学

### 2.1 为什么直接持久化可变聊天数组是致命的错误？

在朴素的 Agent 实现中，开发者通常定义一个类似于 `messages: Message[]` 的数组，并在每个执行阶段直接向该数组追加或修改对象。当需要持久化时，直接将该数组序列化为 `JSON.stringify(messages)` 写入文件或数据库的单个字段。这种模式在简单的玩具级 Demo 中尚能运行，但在真实的复杂工业级生产环境中，会迅速引发以下四个致命问题：

1. **审计事实与因果链条的永久丢失**：一个 `AssistantMessage` 往往包含思维链（Reasoning Content）、文本内容以及多个并行工具调用（Tool Calls）。如果在工具执行过程中，部分工具成功、部分工具失败、用户触发了取消（AbortSignal），或者工具输出了 50MB 的超长内容而被框架动态截断（Spill to Disk），可变消息数组只能记录最终修改后的结果，无法记录“模型在第几毫秒输出了哪个 Chunk”、“哪个工具在第几秒被派发”、“截断前的原始引用是什么”。这使得分布式追踪、错误回溯与离线评测完全失效。
2. **并发与中断恢复的不确定性断层**：大模型生成是一个持续数十秒的流式过程。如果宿主进程在模型流式输出一半或工具执行中途突发崩溃（如 OOM、宿主重启、断电），直接持久化消息数组会导致磁盘上留下一个半截的 JSON 结构，或者丢失整个未完成的轮次。重新加载时，解析器将无法判断该消息是模型正常结束的输出，还是因意外中断被截断的残片。
3. **上下文压缩与历史重写的不可逆性**：为了对抗上下文窗口溢出并节省 Token，Agent 系统通常需要引入“上下文压缩（Compaction）”或“历史摘要”。如果直接在原数组上执行 `splice` 删除或替换旧消息，人类用户在前端 UI 上原本看到的真实对话气泡就会突兀消失，产生“历史被篡改”的糟糕体验；更严重的是，历史被抹除后，系统将彻底失去“无损回放（Lossless Replay）”与分支分叉（Fork Session）的能力。
4. **内存别名与状态污染（Aliasing Hazards）**：在 JavaScript/TypeScript 等引用传递语言中，多个子系统（UI 渲染层、后台任务、模型请求构造器）若共享同一个可变消息对象，任何一个子系统对属性的局部修改（例如为了适配某个特定 Provider 的报文格式而临时修改字段）都会无意中污染全局状态，引发极难排查的幽灵 Bug。

### 2.2 事实账本的核心公理

为了彻底根除上述缺陷，DeepSeek Harness 确立了事件溯源的三大核心公理：

#### 公理一：事实的不可篡改性（Facts are Immutable）
任何已发生的事件（用户输入、模型输出的每个 Token Chunk、工具调用的派发、工具结果的返回、系统时钟的滴答）一旦被追加到日志中，就成为历史事实，**物理上不可修改、不可删除、不可乱序**。

#### 公理二：严格单调连续序号契约（Strict Sequence Contiguity）
每个进入会话的事件必须分配一个从 $0$ 开始、严格单调递增且无空洞的整型序号： $$\text{seq}(e_i) = i, \quad \text{for } i \in \{0, 1, 2, \dots, N-1\}$$ 这意味着在任何时刻，日志的长度必然等于下一条事件的期望序号： $$\text{session.seq} \equiv \text{session.log.length}$$ 如果底层持久化后端在读取或恢复时发现 $\text{seq}(e_k) \neq k$，说明底层存储发生了严重的数据损坏或丢帧，系统将立刻拒绝加载，绝不带伤运行。

#### 公理三：状态是事件的纯函数投影（State is a Pure Function of Events）
系统中的任何瞬时状态 $S_t$（包括当前展示给 LLM 的上下文历史、当前待办事项列表、当前模型的系统配置头），都必须能够通过确定性纯函数 $\mathcal{F}$ 从初始状态 $S_0$ 和事件序列 $[e_0, e_1, \dots, e_t]$ 演算而来： $$S_t = \text{fold}(\mathcal{F}, S_0, [e_0, e_1, \dots, e_t])$$

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

### 2.3 `SessionEventMap`：强类型事件词汇表与声明合并

在 TypeScript 架构中，一个高度可扩展的系统必须允许第三方插件向核心运行时注入专有的日志事件，同时又不能丧失强类型推导和编译器级别的静态类型安全。DeepSeek Harness 通过 TypeScript 的 **声明合并（Declaration Merging）** 机制完美实现了这一目标。

核心包 `@deepseek-ai/dsh-session` 定义了基准的 `SessionEventMap` 接口：

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

当外部插件（例如上下文压缩插件 `@deepseek-ai/dsh-compaction` 或钩子拦截协议 `@deepseek-ai/dsh-hook-protocol`）引入新的事实时，只需在自己的模块声明文件中进行接口叠加：

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

#### 判别联合与未知事件的优雅降级协议：`ignorable: true`

基于 `SessionEventMap`，DeepSeek Harness 构建了类型完备的事件信封 `SessionEvent<T>`：

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

> **关键架构决策：为什么禁止对 `SessionEvent.type` 使用 `assertNever`？** > 由于 `SessionEventMap` 是通过声明合并动态扩展的开放联合体，任何消费端代码（如状态机遍历器或事件分发器）在编写 `switch (event.type)` 时，**严禁**在 `default` 分支中使用 `assertNever(event)`。未知的插件事件是合法的业务事实，核心运行时在匹配完已知核心事件后，必须在 `default` 中安全放行，以确保系统向前向后的插件兼容性。

---

## 3. `Session.deriveMessages()` 动态投影算法

### 3.1 动态投影的数学形式化推导

在 Agent 系统中，大语言模型无法直接理解底层的细粒度日志事件（如 `turn/start`、`assistant/chunk`、`hook/invoked`）。模型调用要求输入一个严格符合对话角色规范的消息序列 $\mathbf{M} = [m_1, m_2, \dots, m_K]$，其中 $m_i \in \text{Message}$。

动态投影算法的核心任务，就是定义一个投影算子 $\Pi$，将不可变的事件序列 $\mathbf{E} = [e_0, e_1, \dots, e_{N-1}]$ 映射为模型可见的历史消息序列 $\mathbf{M}$： $$\mathbf{M} = \Pi(\mathbf{E})$$

#### 投影复杂度的演进：从 $O(N^2)$ 到 $O(\Delta N)$

假设在整个会话执行过程中，共发生了 $T$ 次模型调用（Step），在第 $t$ 次调用时，日志长度为 $N_t$。

- **朴素投影算法（全量重算）**：如果每次调用模型前，都对全量事件重新进行一次线性遍历扫描，第 $t$ 次调用的计算开销为 $O(N_t)$。整个会话的总计算复杂度为： $$\text{Total Time} = \sum_{t=1}^T O(N_t) = O(T \cdot N) = O(N^2)$$ 在长达数十轮、包含成千上万个 Chunk 的长生命周期任务中，$O(N^2)$ 的开销将导致严重的 CPU 瓶颈与事件循环卡顿。

- **增量投影算法（增量维护 + 代次失效）**：DeepSeek Harness 将投影过程拆解为两个正交的数据结构：
  1. **`SessionSurface` 索引**：仅追踪那些能够产生消息的节点序号列表 $\mathbf{I}_{\text{surface}} = [s_1, s_2, \dots, s_k]$，其中 $s_i \in \mathbb{N}$。
  2. **`derived` 消息缓存**：缓存已投影的消息对象，并维护当前已处理的 Surface 游标 $\text{derivedNodes}$。

当发生普通尾部追加（`surfaceOp: 'append'`）时，算法只需处理新增的 Surface 节点： $$\Delta \mathbf{M} = [\text{deriveEventMessage}(e_s) \mid s \in \mathbf{I}_{\text{surface}}[\text{derivedNodes} : |\mathbf{I}_{\text{surface}}|]]$$ 计算复杂度降为 $O(\Delta N) = O(1)$ 均摊开销。

当发生上下文压缩替换（`surfaceOp: { op: 'replace', start, end }`）时，`SurfaceManager` 递增代次计数器 $\text{replaceGeneration} \leftarrow \text{replaceGeneration} + 1$，缓存失效，重新执行一次 $O(K)$ 的重建（其中 $K \ll N$ 为当前 Surface 节点数）。

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

### 3.2 节点投影纯函数：`deriveEventMessage`

`deriveEventMessage(event)` 是一个无副作用的纯函数，它严格规定了单个日志事件如何转化为模型消息：

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

### 3.3 `SurfaceManager` 状态机与因果追溯（Provenance）断言

`SurfaceManager` 负责在事件写入日志前进行**两阶段提议-提交校验**，确保 Surface 的拓扑结构在任何时刻都保持合法。

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

### 3.4 手算推导：10 步事件折叠与 Surface 演化过程

为了彻底理解 Surface 管理器与 `deriveMessages()` 的内部演进，我们给出一个包含常规交互、工具调用以及上下文压缩替换（Compaction）的完整手算追踪示例：

| 步骤 | 追加事件类型与核心数据 | `surfaceOp` | `sourceEventSeqs` | `SessionSurface.nodes` 数组变动 | `replaceGen` | `deriveMessages()` 派生消息输出 |
| :---: | :--- | :--- | :--- | :--- | :---: | :--- |
| **0** | `request/header` (Config, Tools) | *None* | *None* | `[]` | 0 | `[]` (无消息) |
| **1** | `user/message` ("List files") | `'append'` | `[]` | `[1]` | 0 | `[UserMessage("List files")]` |
| **2** | `turn/start` (turn: 1) | *None* | *None* | `[1]` | 0 | `[UserMessage]` |
| **3** | `assistant/chunk` ("Let me check")| *None* | *None* | `[1]` | 0 | `[UserMessage]` (Chunk 忽略) |
| **4** | `assistant/message` (Call: `ls`) | `'append'` | `[3]` | `[1, 4]` | 0 | `[UserMessage, AsstMessage(Calls:[ls])]` |
| **5** | `tool/call` (id: "c1", `ls`) | *None* | *None* | `[1, 4]` | 0 | `[UserMessage, AsstMessage]` |
| **6** | `tool/result` (id: "c1", `["a.ts"]`)| `'append'` | `[5]` | `[1, 4, 6]` | 0 | `[UserMessage, AsstMessage, ToolResult]` |
| **7** | `assistant/message` ("Done") | `'append'` | `[]` | `[1, 4, 6, 7]` | 0 | `[UserMessage, AsstMessage, ToolResult, AsstMessage]` |
| **8** | `turn/end` (completed) | *None* | *None* | `[1, 4, 6, 7]` | 0 | `[UserMessage, AsstMessage, ToolResult, AsstMessage]` |
| **9** | `user/message` (Summary Compaction)| `{op:'replace', start:1, end:6}` | `[1, 4, 6]` | `[9, 7]` (节点 1,4,6 被替换为 9) | **1** | `[UserMessage(Summary), AsstMessage("Done")]` |

在第 9 步发生 Compaction 时：
1. `SurfaceManager` 识别出待遮蔽区间为 `nodes` 中从序号 1 到 6 的子序列（即索引 `0..2` 对应的节点 `[1, 4, 6]`）。
2. 校验通过后执行 `splice(0, 3, 9)`，`nodes` 列表瞬间重构为 `[9, 7]`。
3. `replaceGeneration` 递增至 1，触发 `Session.deriveMessages()` 缓存失效，重新生成精简后的模型消息上下文。

---

## 4. 底层持久化引擎架构与协调器（Persistence Coordinator）

### 4.1 持久化能力 Seam（`SessionPersistence`）

在 Cordis 依赖注入容器中，会话在内存中的表示（`Session`）与具体的物理持久化机制严格解耦。`ctx.sessions` 是纯内存状态机，而 `ctx.sessionPersistence` 作为**能力 Seam（Capability Seam）**，定义了一套与物理介质无关的标准持久化契约：

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

### 4.2 异步有界写入批处理队列（`SessionWriteBehind`）

高频流式传输（每秒产生 50~100 个 `assistant/chunk` 事件）若对每次 `session.append()` 都同步执行一次系统调用（`fsync` 或 `pwrite`），将导致灾难性的磁盘 I/O 拥塞与 CPU 上下文切换。

`SessionWriteBehind` 实现了一个**固定截止时间窗口（Fixed Deadline Window）+ 显式屏障排空**的非阻塞写控制器：

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

## 5. 存储后端实现：JSONL + Zstandard 与 SQLite

### 5.1 JSONL + 拼接 Zstandard 压缩帧引擎

#### 文件系统安全路径编码：`encodeSegment`
在持久化到磁盘目录时，`SessionId` 是不受信任的外部字符串，可能包含路径遍历字符（如 `../../etc/passwd`）、操作系统保留字符（`CON`, `PRN`, `AUX`, `:`）、或者 UTF-16 孤立代理对（Lone Surrogates）。DeepSeek Harness 实现了单射（Injective）安全编码：

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

#### 拼接 Zstandard 帧（Concatenated Zstandard Frames）
传统压缩文件（如单个 `.tar.gz`）无法支持高效的增量追加写入：每次追加都必须解压全量文件再重新压缩。DeepSeek Harness 利用了 **Zstandard 规范中天然支持多帧拼接（Concatenated Frames）** 的物理特性：
- 文件的第一帧包含 JSON 格式的 `SessionHeader` 元数据行；
- 随后的每个持久化写入批次，均被独立压缩为一个完整的、携带 CRC32 校验和的独立 Zstandard Frame 直接追加到文件尾部；
- 读取时，解压器可以按物理帧顺序依次扫描解码；若系统崩溃导致最后一帧写了一半（Torn Frame），前序所有已闭合的帧均完全不受损！

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

#### 零解压快速帧边界扫描器：`scanZstdFrames`

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

### 5.2 Node `node:sqlite` 同步引擎与 WAL 模式

对于需要单文件多会话聚合管理或需要支持根据 `seq` 随机索引后缀读取（`readFrom`）的场景，DeepSeek Harness 提供了基于 Node.js 官方内置 `node:sqlite` 的后端实现。

#### 严格类型表结构（STRICT Tables）

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

#### 数据库安全加固与持久性 Pragma 参数配置

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

## 6. 崩溃恢复（Crash Recovery）与对账修复算法

### 6.1 崩溃窗口分析：为什么系统必然会在任意两行字节之间崩溃？

在分布式系统或单机 Agent 系统中，系统崩溃可能发生在执行生命周期的**任意纳秒**：

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

### 6.2 物理级修复：撕裂尾部截断（Torn Tail Truncation）

当 `PersistenceCoordinator` 在冷启动加载日志时，首先启动物理级扫描：
1. 若文件尾部存在无法通过 JSON 解析的半行文本，或无法通过 Zstandard 块头校验的撕裂尾部，计算出最后一个合法物理帧或换行符的字节偏移量 `committedBytes`。
2. 在以读写模式打开文件句柄后，调用操作系统底层的 `ftruncate(fd, committedBytes)` 物理截断破损尾部，消除磁盘脏数据。

### 6.3 逻辑级修复：`interruptedTurnClosers` 状态平衡算法

物理截断完成后，内存中得到的是一个语法完整但逻辑上可能“悬挂开放”的合法事件前缀。此时必须通过 `interruptedTurnClosers` 算法合成最小闭合事件集。

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

### 6.4 为什么未结束调用必须标记为 `TOOL_OUTCOME_UNKNOWN` 而绝不能隐式抹除？

在崩溃恢复设计中，初学者常犯的一个严重错误是：“既然工具没执行完，直接把上一条 `assistant/message` 里的工具调用删掉，或者把日志截断回模型调用前不就行了吗？”

这种做法在具有外部副作用的系统中是**灾难性的**：
1. **真实世界副作用的不可逆性**：如果该工具是一个转账接口、Docker 容器创建接口、或是 Git 代码提交接口，在进程崩溃前，网络报文很可能已经到达外部服务器并成功执行。如果系统在重启后隐式抹除该调用，大模型在重新看到上下文时，会认为该操作从未发生，从而发起**二次重复执行（Double Execution / Double Spending）**。
2. **LLM 语义层面的显式决策权**：通过将未完成调用显式闭合为带有 `TOOL_OUTCOME_UNKNOWN` 错误码的 `tool/result` 消息，大模型在恢复执行时会明确获知：“该操作已发出，但由于系统崩溃无法确认执行结果”。模型可以结合工具的元数据（是否幂等、是否只读），自主采取防御措施（例如先调用 `status_check` 或 `file_stat` 检查外部环境，或向人类用户确认），从而实现具备工业级容错能力的智能韧性。

---

## 7. 生产级踩坑指南与最佳实践

### 7.1 坑 1：并发读写导致 `SessionSurface` 缓存与事件日志漂移

- **故障现象**：在 Web Client 中，当用户快速连续发送两条消息或触发取消时，前端报错 `Surface replace: start seq not found in surface`，随后会话彻底无法加载。
- **根本原因**：在异步执行流中，某个异步观察者在事件尚未正式推入 `session.log` 之前，通过闭包提前读取了 `session.surface.nodes`，导致 Surface 管理器的预备状态与实际提交状态错位。
- **排查与防御**：
  1. 严格遵循 `SurfaceManager` 的两阶段提议-提交协议：在 `validateNext(event)` 成功后，必须且只能由 `session.append()` 内部在同一个微任务滴答内完成 `log.push()`。
  2. 在 `Session` 类中引入重入保护锁 `entry.appending`，严禁在 `session/event` 广播回调执行期间递归调用 `session.append()`。

### 7.2 坑 2：流式 Chunk 全量落盘引发的磁盘 I/O 放大

- **故障现象**：在长文本输出场景下，磁盘 I/O 使用率达到 100%，Node.js 主线程事件循环延迟（Event Loop Lag）飙升至 500ms 以上。
- **根本原因**：对每一次几字节的 SSE Chunk 都触发一次 JSON 序列化并写入磁盘文件，产生了巨大的小文件 I/O 放大。
- **排查与防御**：
  1. 引入 `packChunkRuns` 存储编码优化：在写入物理介质前，将同一轮次内连续的 `assistant/chunk` 序列打包为单行的 `text-chunks` 存储记录：
     ```json
     {"type":"text-chunks","turn":1,"step":1,"startSeq":10,"chunks":["Hello"," world","!"]}
     ```
  2. 启用 `SessionWriteBehind` 的 200ms 有界批处理窗口，确保物理写入以至少 4KB/8KB 的块大小对齐刷盘。

### 7.3 坑 3：未正确处理 `firstLiveSeq` 导致历史回放事件触发二次副作用

- **故障现象**：当从磁盘恢复一个带有历史工具调用的会话时，系统重新向用户发送了大量的外部 Webhook 通知或重新执行了自动化脚本。
- **根本原因**：会话恢复时，下游插件监听了 `session/event` 事件，但未能区分该事件是来自冷启动种子（Seed）还是当前进程实时产生的新事件。
- **排查与防御**：
  1. `Session` 构造函数在加载种子事件时，**严禁**触发 `session/event` 事件广播。
  2. `Session` 实例显式公开只读属性 `firstLiveSeq`，并在存储中持久化 `session/end-seed` 边界事件；下游只对 `event.seq >= session.firstLiveSeq` 的实时事件执行外部副作用。

### 7.4 坑 4：Windows 平台文件句柄未关闭导致的 EBUSY 竞争

- **故障现象**：在 Windows 生产环境下，会话在快速 Fork 或重启时抛出 `EBUSY: resource busy or locked, rename/unlink`。
- **根本原因**：Windows 操作系统具备严格的文件排他锁定机制，之前的读取流或未完成的异步写入句柄未显式关闭时，任何后续的文件删除或替换均会失败。
- **排查与防御**：
  1. 统一采用 TypeScript `using` 语法与 `Symbol.dispose` 资源管理协议，确保 `SessionPreparation` 与文件句柄在离开作用域时被同步、幂等地释放。
  2. 文件写入采用 `.tmp` 临时文件 + `fs.renameSync` 原子替换策略，在 Windows 平台上为重命名操作增加带有指数退避的重试机制。

---

## 8. 本章小结与系统架构自检清单

### 8.1 核心架构自检清单

完成本章学习后，你可以对照以下 10 个关键指标对自研或生产环境中的 Agent 会话系统进行架构体检：

- [ ] **不可变性校验**：会话日志中的所有事件对象在写入后是否均被 `deepFreeze` 冻结？是否存在任何可以在内存中被修改的公开属性？
- [ ] **严格序号连续性**：是否强制推行 $\text{seq} = 0, 1, 2, \dots, N-1$ 契约？系统能否在发现序号空洞时第一时间拒绝加载？
- [ ] **动态投影纯度**：`deriveMessages()` 是否为无副作用的纯函数？是否严格保证不向模型投递内容为空的残留消息？
- [ ] **Surface 索引解耦**：上下文压缩（Compaction）是否通过声明式 `replace` 算子维护 Surface 索引，而不是直接修改或截断底层事实日志？
- [ ] **因果追溯闭包**：所有的 Surface 替换操作是否在 `sourceEventSeqs` 中完整声明了被其遮蔽的全部前序节点？
- [ ] **异步批量写控制**：持久化层是否具备类似于 `SessionWriteBehind` 的有界窗口合并机制？高频流式传输是否会阻塞主事件循环？
- [ ] **物理多帧压缩**：落盘文件是否采用了类似于拼接 Zstandard 帧的格式，以兼顾极高的压缩比与增量尾部追加能力？
- [ ] **物理撕裂截断**：系统重启时是否具备 `scanZstdFrames` 或逐行 JSON 语法扫描能力，能否在解压前精准定位并截断半写状态的破损字节？
- [ ] **未知结果显式化**：崩溃后遗留的未闭合工具调用是否被精准标记为 `TOOL_OUTCOME_UNKNOWN`，而非被隐式抹除或伪造为成功？
- [ ] **声明合并兼容性**：第三方插件扩展的事件是否支持 `ignorable: true` 标记？核心状态机在处理事件联合体时是否避免了 `assertNever` 导致的崩溃？
