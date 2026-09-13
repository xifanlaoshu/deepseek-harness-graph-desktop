# 第 09 章：提示词、模型与流式响应

在传统的分布式后端系统或微服务架构中，RPC 调用通常遵循确定性的请求-响应（Request-Response）模式：客户端发起一个强类型的 Protobuf 或 JSON-RPC 报文，服务端执行一段确定的业务逻辑，然后同步或异步返回结果。然而，当系统引入大语言模型（LLM）作为概率型核心推理引擎时，整个通信与状态机模型发生了根本性的范式转移。

大语言模型本质上是一个巨大的、基于高维张量运算的**自回归概率分布函数**。对于每一次调用，它不仅需要消耗庞大的计算资源与显存带宽，而且其输出是以“Token 词法单元”为最小粒度、通过 HTTP Server-Sent Events (SSE) 持续喷涌的单向字节流。

在智能体运行时（Agent Harness）的设计中，提示词（Prompt）的构建不再是简单的字符串模板拼接，而是直接决定了底层 GPU 计算集群中 **KV Cache（键值缓存）** 的复用效率与首字延迟（TTFT, Time-To-First-Token）；同时，流式响应的接收与解析也不仅仅是前端打字机动效的数据源，而是关乎**系统状态恢复、确定性快照重放（Snapshot Replay）、分布式取消（AbortSignal）以及因果一致性事实账本（Event Sourcing）** 的关键命脉。

本章将以 DeepSeek Harness 的生产级源码实现为蓝本，深入拆解 System Prompt 动态装配引擎、LLM Service Definition 抽象层、多 Provider 适配器架构、基于 `eventsource-parser` 的严格 SSE 流式状态机，以及“模型可见即已记录”（Model-Visible is Recorded）这一核心系统不变量。

---

## 1. 概念映射：从传统系统编程到 LLM 与流式系统

为了建立坚实的工程直觉，我们将现代 Agent 系统中的提示词、模型与流式概念映射到传统系统编程与分布式架构中：

| 智能体 / LLM 概念 | 传统系统编程 / 操作系统 / 分布式概念 | 核心工程特性与职责 |
| :--- | :--- | :--- |
| **System Prompt** | **进程启动参数 / 操作系统环境变量 / 固件指令** | 定义模型运行的基本语义规范、能力边界、安全沙箱策略与执行协议。 |
| **Static Prefix** | **共享动态链接库的代码段（`.text` 段，只读且跨进程共享）** | 保持高频不变的文本前缀，触发大模型服务端的 **Prefix Caching**，避免重复 Prefill 计算。 |
| **Dynamic Context** | **堆栈顶部的局部变量帧 / 实时寄存器上下文（Snapshot）** | 每一轮交互注入的动态环境信息（当前时间、工作目录、Git 分支、Claim 状态），随时间单调演化。 |
| **Prompt Variables (`{{var}}`)** | **宏替换 / 链接期符号解析（Link-Time Symbol Resolution）** | 在确定性作用域链（Scope Chain）中对占位符进行严格校验与符号填充，严禁出现未定义的悬空符号。 |
| **LLM Provider Adapter** | **设备驱动程序（Device Driver）/ POSIX 虚拟文件系统 (VFS) 适配层** | 屏蔽底层不同厂商（DeepSeek、OpenAI、Anthropic）专有网络协议与报文格式的差异，提供统一抽象。 |
| **Two-Phase Prepared Call** | **两阶段提交 (2PC) / 事务锁与快照隔离（Snapshot Isolation）** | 在第一阶段锁定模型元数据与运行时默认值（防止配置漂移），在第二阶段执行单次排他流式分发。 |
| **SSE Stream Chunk** | **TCP 滑动窗口中的流式分包 / 异步消息队列中的 Event Frame** | 细粒度、多路复用的差量数据包，包含文本增量、思维链（Reasoning）增量、工具调用（Tool Call）增量。 |
| **Event Sourcing Chunk 落盘** | **数据库 WAL (Write-Ahead Logging) 预写日志** | 每一帧接收到的 Chunk 在进入业务逻辑或 UI 渲染前，必须首先持久化到事实账本，确保崩溃后可完美重建现场。 |
| **Model-Visible is Recorded** | **因果一致性屏障（Causal Consistency Barrier）** | 核心安全与架构不变量：任何进入模型注意力机制或从模型流出的数据，都必须具备全局不可篡改的事实日志。 |

```
               +-------------------------------------------------------------+
               |                  DeepSeek Harness Runtime                   |
               +-------------------------------------------------------------+
                                              |
                     +------------------------+------------------------+
                     |                                                 |
                     v                                                 v
    +---------------------------------+               +---------------------------------+
    |   SystemPrompt.assemble()       |               |    LlmRuntime.prepareCall()     |
    |  - Harness Identity (-100)      |               |  - Resolve Model Info           |
    |  - Deployment Persona (0)       |               |  - Freeze CallConfig Snapshot   |
    |  - Tool Guidance (100..199)     |               |  - Capture Retry Policy         |
    |  - Strict Variable Interpolation|               |  - Materialize Defaults         |
    +---------------------------------+               +---------------------------------+
                     |                                                 |
                     +------------------------+------------------------+
                                              |
                                              v
                              +-------------------------------+
                              |    GenerateOptions Assembly   |
                              |  - System Prompt (Prefix)     |
                              |  - Session Messages (History) |
                              |  - Canonical Tools Ordering   |
                              +-------------------------------+
                                              |
                                              | HTTP POST (SSE stream)
                                              v
                              +-------------------------------+
                              |     DeepSeek / Provider API   |
                              |  - Prefix KV Cache Hit/Miss   |
                              |  - Autoregressive Generation  |
                              +-------------------------------+
                                              |
                                              | text/event-stream
                                              v
                              +-------------------------------+
                              |     EventSourceParserStream   |
                              |  - Framing & UTF-8 Reassembly |
                              |  - Strict [DONE] Validation   |
                              +-------------------------------+
                                              |
                                              | WireChunk
                                              v
                              +-------------------------------+
                              |      translate() Generator    |
                              |  - Reasoning & Text Deltas    |
                              |  - Tool Call JSON Fragment    |
                              |  - Disjoint Token Accounting  |
                              +-------------------------------+
                                              |
                                              | StreamChunk
                                              v
                              +-------------------------------+
                              |   session.append('chunk')     |  <-- WAL 实时落盘 (Crash Recovery)
                              +-------------------------------+
                                              |
                                              v
                              +-------------------------------+
                              |  BlockAssembler.push(chunk)   |
                              +-------------------------------+
```

---

## 2. System Prompt 动态装配引擎与 Prompt Cache 优化

### 2.1 大模型推理的计算瓶颈与 KV Cache 数学精算

在深入 System Prompt 架构前，必须从 GPU 显存与计算复杂度的数学底层理解为什么提示词的组织方式至关重要。

大语言模型在自回归生成第 $t$ 个 Token 时，其注意力机制需要计算当前 Token 的 Query 向量与所有历史 Token（从 $1$ 到 $t-1$）的 Key 和 Value 向量的点积：

$$\text{Attention}(Q, K, V) = \text{Softmax}\left(\frac{Q K^T}{\sqrt{d_k}}\right) V$$

如果每一轮生成都重新计算历史 Token 的 $K$ 和 $V$ 矩阵，Prefill 阶段的时间复杂度将达到 $O(L^2)$（其中 $L$ 为上下文长度）。为了避免重复计算，所有现代推理引擎（如 vLLM、TensorRT-LLM、DeepSeek 推理集群）都会在 GPU 显存中开辟 **KV Cache** 显存池，将每个历史 Token 在每一层计算出的 Key 和 Value 张量固化在显存中。

#### 显存占用精算推导

对于一个拥有 $n_{\text{layers}}$ 层、隐藏维度为 $d_{\text{model}}$、注意力头数为 $n_{\text{heads}}$、每个头的维度为 $d_{\text{head}} = d_{\text{model}} / n_{\text{heads}}$ 的 Transformer 模型，在标准 Multi-Head Attention (MHA) 架构下，采用 FP16 / BF16（每个参数 2 字节）精度时，单个并发请求（Batch Size $b = 1$）、上下文长度为 $L$ 时的 KV Cache 显存消耗公式为：

$$M_{\text{KV-MHA}} = 2 \times 2 \times n_{\text{layers}} \times n_{\text{heads}} \times d_{\text{head}} \times L \times b = 4 \cdot n_{\text{layers}} \cdot d_{\text{model}} \cdot L \quad \text{(Bytes)}$$

对于 DeepSeek-V3 / DeepSeek-R1 采用的 **Multi-Head Latent Attention (MLA)** 架构，Key 和 Value 被投影并压缩为一个低维的潜在向量（Latent Vector）$d_c$（通常 $d_c \ll 2 \cdot n_{\text{heads}} \cdot d_{\text{head}}$），配合解耦的旋转位置编码 $d_R$：

$$M_{\text{KV-MLA}} = 2 \times n_{\text{layers}} \times (d_c + d_R) \times L \times b \quad \text{(Bytes)}$$

#### 手算对比演示

假设我们部署一个 64 层、隐藏维度 $d_{\text{model}} = 8192$、上下文长度 $L = 64\text{k} = 65,536$ Tokens 的大模型：

1. **标准 MHA 架构显存消耗**： $$M_{\text{KV-MHA}} = 4 \times 64 \times 8192 \times 65,536 \times 1 = 137,438,953,472 \text{ Bytes} \approx 128 \text{ GiB}$$ 单个 64k 上下文的会话仅 KV Cache 就需要耗尽两张 NVIDIA H100 (80GB) 显卡的全部显存！

2. **DeepSeek MLA 架构显存消耗（$d_c = 512, d_R = 64$）**： $$M_{\text{KV-MLA}} = 2 \times 64 \times (512 + 64) \times 65,536 \times 1 = 4,831,838,208 \text{ Bytes} \approx 4.5 \text{ GiB}$$ 显存开销降低了近 28 倍，使得长上下文下的 **Prefix Caching（前缀缓存）** 跨会话常驻显存成为可能。

### 2.2 Prefix Caching（前缀缓存）与 Cache-Busting 灾难

现代云端 LLM 服务提供商（尤其是 DeepSeek）引入了服务端 **Prompt Cache（前缀缓存）** 技术。服务端的显存管理器会以固定大小的块（Chunk，如 64 个 Token）为单位，对前缀 Token 序列计算哈希值：

$$h_i = \text{Hash}(h_{i-1} \parallel \text{Token}_{(i-1)B + 1 \dots iB})$$

如果后续请求（无论是同一个 Agent 的多轮对话，还是不同 Agent 实例的初始调用）的前缀 Token 序列与显存中已有的缓存块完全匹配，服务端可以直接命中（Cache Hit）已有的 KV Cache，跳过 Prefill 计算！

$$T_{\text{TTFT}} = \frac{L_{\text{unhit}} \cdot D_{\text{FLOPs}}}{P_{\text{compute}}} + \frac{L_{\text{hit}} \cdot D_{\text{KV-read}}}{B_{\text{mem}}}$$

其中 $P_{\text{compute}}$ 为 GPU 浮点计算算力，$B_{\text{mem}}$ 为显存带宽。由于显存读取速度远快于重新进行矩阵乘法计算，Cache Hit 可以将首字延迟（TTFT）从数十秒降低至数百毫秒，同时云端服务商通常会对缓存命中的 Token 给予高达 **75% ~ 90% 的价格折扣**（例如 DeepSeek 的 Cache Hit 计费仅为未命中的十分之一）。

#### Cache-Busting 灾难案例

如果一个工程师在 System Prompt 的开头写了这样一行代码： `You are an assistant. The current time is 2026-08-25 16:30:15.`

由于时间戳精确到了秒，每一秒都在变化，导致该请求计算出的前缀哈希值 $h_1$ 永远是一个全新的值。**这直接导致整个 System Prompt 以及后续拼接的所有工具定义、历史消息对应的全部 KV Cache 瞬间击穿（Cache Busting）**！系统将彻底丧失服务端缓存优化，计算成本与延迟成倍激增。

### 2.3 动态装配架构：静态稳定前缀 vs 动态运行时上下文

为了从架构层面彻底杜绝 Cache-Busting，DeepSeek Harness 设计了极其严格的提示词分层装配引擎：`@deepseek-ai/dsh-system-prompt`。该引擎将发送给模型的内容严格解耦为两部分：

1. **System Prompt（静态稳定前缀）**：包含全局唯一身份、部署角色设定（Persona）、工具执行规范。它在会话生命周期内是强静态的、顺序确定的，位于输入的最前列，最大化促进 KV Cache 命中。
2. **Context Snapshot（动态后缀 / 独立消息）**：包含易变的运行时状态（当前时间、工作目录、Git 分支、Claim 状态）。它决不污染 System Prompt，而是作为最新一轮的动态上下文快照注入到历史会话中。

```
+---------------------------------------------------------------------------------------------+
|                                    LLM Request Context Window                               |
+---------------------------------------------------------------------------------------------+
| [System Slot] 100% 静态稳定前缀 (促进跨请求、跨会话 KV Cache 命中)                             |
|  +- Order -100 : harness:identity  ("You are an AI agent powered by DeepSeek Harness.")     |
|  +- Order    0 : deployment:persona ("You are an expert TypeScript architect...")           |
|  +- Order 100..: tool guidance & constraints (Strict ordered JSON Schemas)                  |
+---------------------------------------------------------------------------------------------+
| [Messages Slot: Historical Messages] 历史轮次消息 (按 Append-Only 顺序追加)                    |
|  +- Turn 1 User Message                                                                     |
|  +- Turn 1 Assistant Message (with tool-calls)                                              |
|  +- Turn 1 Tool Result                                                                      |
+---------------------------------------------------------------------------------------------+
| [Messages Slot: Latest Turn Context] 动态演进上下文 (绝不前置污染静态前缀)                      |
|  +- Current Runtime Context Snapshot (Time Context, TMUX Context, Workspace State)         |
|  +- Latest User Followup / Steer Message                                                    |
+---------------------------------------------------------------------------------------------+
```

### 2.4 `SystemPrompt` 服务核心实现解析

让我们剖析 `packages/core/system-prompt/src/index.ts` 中的核心设计与关键算法。

#### (1) 排序与层级覆盖（Order & Layer Shadowing）

每个注册的 `PromptSection` 都包含一个 `order` 数字：
* `-100`：Harness 核心框架身份（`harness:identity`）。
* `0`：部署级别或 Agent Preset 定义的角色设定（`deployment:persona`）。
* `100 ~ 199`：工具集与能力指导文档。

```typescript
export interface PromptSection {
  readonly name: string
  readonly order: number
  readonly text: string | ((context: AssembleContext) => string)
  readonly complete?: boolean
}
```

在多 Agent 嵌套或会话隔离场景下，通过 `ScopedLayers` 实现作用域覆盖：Agent Scope 内部注册的同名 Section（如 `deployment:persona`）会精确遮蔽（Shadow）全局配置，而不会产生重复的提示词段落。

#### (2) 严格的变量插值引擎（Strict Variable Interpolation）

提示词中的变量采用 `{{variable_name}}` 占位符。为了防御由于拼写错误导致的静默失败，`interpolate()` 函数实施了工业级的边界校验：

```typescript
function interpolate(
  input: AssembledSection | AssembledContext,
  variables: Record<string, string | undefined>,
  kind: 'section' | 'context',
): string {
  const text = input.text
  let result = ''
  let last = 0
  for (let open = text.indexOf('{{'); open >= 0; open = text.indexOf('{{', last)) {
    const group = GROUP_AT.exec(text.slice(open))
    if (group === null) {
      if (text.indexOf('}}', open + 2) >= 0) {
        throw new Error(`malformed prompt variable reference at "${text.slice(open, open + 16)}…" in ${kind} "${input.name}"`)
      }
      result += text.slice(last, open + 2)
      last = open + 2
      continue
    }
    const name = group[0].slice(2, -2)
    if (!VARIABLE_NAME.test(name)) {
      throw new Error(`malformed prompt variable reference "{{${name}}}" in ${kind} "${input.name}"`)
    }
    if (!Object.hasOwn(variables, name)) {
      const known = Object.keys(variables)
      throw new Error(`unknown prompt variable "{{${name}}}" in ${kind} "${input.name}"; registered variables: ${known.length > 0 ? known.join(', ') : '(none)'}`)
    }
    const value = variables[name]
    if (value === undefined) {
      throw new Error(`prompt variable "{{${name}}}" has no value for this assembly (${kind} "${input.name}")`)
    }
    result += text.slice(last, open) + value
    last = open + group[0].length
  }
  return result + text.slice(last)
}
```

* **防原型链污染**：使用 `Object.hasOwn(variables, name)` 而非 `variables[name] !== undefined`，防止恶意利用 `toString`、`constructor` 等原型属性绕过校验。
* **非幂等扫描防护**：替换后的变量值不会被再次扫描（Scan Once），彻底杜绝二次插值引发的注入攻击（Prompt Injection / Template Recursion）。

#### (3) 工具定义的字典序归一化（Canonical Tool Ordering）

大模型的 Tools 定义数组如果在每次请求时顺序发生随机抖动（例如由于异步插件加载顺序不同），将破坏工具定义段的 Token 序列一致性，导致 KV Cache 失效。

`SystemPrompt` 实现了确定性的 `orderTools` 算法：默认按 Unicode 码点进行绝对字典序排序（`compareToolNames`）；若配置了显式 `toolOrder`，则强制必须包含 `<unlisted-tools>` 占位符，以受控方式将未声明的工具插入指定位置，确保不同机器、不同环境下的二进制输出 100% 幂等。

#### (4) Complete Section 独占模式与 Waterfall 变换

在某些特定的专业场景下（如执行自动化评估 Benchmark，或切换至原生纯文本代码补全模式），调用方需要完全接管 System Prompt，不希望任何预置的 `harness:identity` 或插件段落介入。

`PromptSection` 支持 `complete: true` 标记。在装配流水线中：
1. 依然执行全局与作用域层级变量解析与 Waterfall 过滤，以便工具和运行时上下文正常计算。
2. 在流水线最后阶段，强制丢弃所有其他段落，仅保留带有 `complete: true` 的唯一权威段落。
3. 若检测到多于一个激活的 `complete: true` 段落，装配引擎立即抛出致命错误，防止策略冲突导致的静默行为漂移。

---

## 3. LLM Service Definition 抽象与多 Provider 适配架构

在企业级 Agent 架构中，上层 Agent Loop 决不能与特定模型厂商的 SDK（如 OpenAI SDK、Anthropic SDK）产生物理耦合。Harness 定义了中立、纯粹的 `LlmRuntime` 服务与抽象基类 `LlmAdapter`。

### 3.1 两阶段调用抽象（Two-Phase Prepared Call）

为什么简单的 `llm.stream(options)` 无法满足企业级可靠性要求？

在具备热重载（HMR）、配置动态覆盖（Overlay Config）与多轮重试机制的复杂系统中，如果在执行调用期间底层的配置发生了变化（例如管理员通过 Web UI 修改了默认 temperature 或重试策略），或者在模型元数据解析与实际 HTTP 发送之间存在时间差，极易发生**配置与端点裂脑（Split-Brain Drift）**。

因此，`LlmRuntime` 引入了不可变的 **两阶段调用模型（Two-Phase Prepared Call）**：

```typescript
export interface PreparedLlmCall {
  readonly config: LlmCallConfig
  readonly retryPolicy: ResolvedRetryPolicy
  readonly context?: LlmModelContext
  readonly inputModalities?: readonly ModelModality[]
  readonly adapterDefaults: LlmCallConfigAdapterDefaults
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}
```

```
   Phase 1: Preparation (锁定元数据与能力)
   Agent Loop -------------------------> LlmRuntime.prepareCall(config)
                                              |
                                              | 1. 查询 Adapter 路由
                                              | 2. 解析模型元数据 (resolveModel)
                                              | 3. 物化默认参数 (defaultMaxTokens / reasoningEffort)
                                              | 4. deepFreeze() 不可变冻结
                                              v
   Agent Loop <------------------------- 返回 PreparedLlmCall (一次性句柄)
       |
       | 记录 request/header 到 Session Log (因果锁固)
       |
       v
   Phase 2: Execution (单次排他分发)
   Agent Loop -------------------------> PreparedLlmCall.stream(options)
                                              |
                                              | 校验 callConfigEquals(options, preparedConfig)
                                              | 防御二次分发 (dispatched flag CAS)
                                              | 触发 llm/stream Waterfall 拦截管道
                                              v
                                         LlmAdapter.stream(options)
```

1. **第一阶段（`prepareCall`）**：传入候选调用配置，适配器解析模型上下文长度（`contextWindow`）、默认最大 Token 数（`defaultMaxTokens`）、推理努力等级（`reasoningEffort`），并生成深度冻结（`deepFreeze`）的快照对象。
2. **第二阶段（`stream`）**：使用准备好的句柄发起流式分发。该句柄具有**单次使用保证（Single-Use Enforcement）**，一旦被分发立即置位 `dispatched = true`；若配置在调用前被篡改，立即抛出 `INVALID_PREPARED_CALL`。

### 3.2 `DeepSeekAdapter`：原生直接通信与传输韧性

`packages/llm/llm-deepseek/src/adapter.ts` 是 Harness 针对 DeepSeek API 的高性能原生适配器，完全基于原生 `fetch` 与 SSE 解析，摆脱了庞大第三方 SDK 的依赖与黑盒隐患。

#### (1) 空闲超时看门狗（Idle Watchdog）

大模型在生成长文本或深度思考模式（Reasoning / Thinking Mode）时，首字生成时间可能较长，但在传输开始后，Token 之间的间隔通常是毫秒级的。传统的整体请求超时（Total Timeout）极难配置：设置太短会截断长思考，设置太长则无法及时发现底层 TCP 假死。

`DeepSeekAdapter` 采用了高精度的 **Idle Watchdog（空闲看门狗）** 机制：

```typescript
using watchdog = idleWatchdog(upstream, connection.streamIdleTimeoutMs, STREAM_IDLE_TIMEOUT_CODE)
const iterator = this.request(
  options,
  watchdog.signal,
  connection,
  apiKey,
  userId,
  attachments,
  () => { watchdog.pulse() }, // 每次收到有效 TCP 字节或 SSE 活动时触发 pulse() 刷新看门狗
)[Symbol.asyncIterator]()
```

只要网络持续有数据分块到达，看门狗计时器就会被不断重置；一旦网络中断且超过 `streamIdleTimeoutMs`（默认 300 秒）未收到任何字节，看门狗立即发出超时中断信号，将假死连接精准熔断。

#### (2) 基于 Files API 的大图像异步卸载策略

当用户输入包含高分辨率图片时，直接将大量 Base64 编码内联在 JSON 请求体中会导致请求体积膨胀 33% 以上，引发网关 HTTP 413 错误，并极大增加内存复制开销。

`DeepSeekAdapter` 内置了图像卸载策略（Image Offload Policy）：
* **优先 Files API**：自动将图片通过 DeepSeek Files API 异步上传，获取 `file_id`，在会话消息中仅传输轻量级的引用。
* **智能过期与驱逐恢复**：维护进程级 `DeepSeekFileStore`，记录文件上传哈希与生命周期。若服务端返回文件过期或未找到（`providerRejectedFileId`），适配器自动捕获异常，失效本地索引，并在同一调用事务中平滑回退（Fallback）到 Base64 内联重试，对上层 Agent 完全透明。

### 3.3 `pi-ai` 适配器与通用模型网关集成

除了原生直连的 DeepSeek 适配器，Harness 通过 `packages/llm/llm-pi-ai` 提供了对广泛第三方模型生态（如 OpenAI、Anthropic Claude、Google Gemini、Mistral、Ollama、Groq）的适配支持。

`pi-ai` 适配器将 Harness 标准的 `GenerateOptions`（消息列表、工具 Schema、采样温度、Stop 序列）映射为底层统一的多模型驱动协议，并自动处理不同提供商专有的能力特性差异：
* **思维链协议抹平**：例如 Anthropic Claude 3.7 Sonnet 的 `thinking` 块、OpenAI o-series 的 `reasoning_effort` 以及 DeepSeek R1 的 `reasoning_content`，统一映射为 Harness 的 `reasoning-delta` 与 `ReasoningBlock`。
* **工具调用协议抹平**：兼容不同网关对于并行工具调用（Parallel Tool Calling）的 ID 生成机制与参数片段流式组装协议。

### 3.4 `llm/stream` Waterfall 拦截流水线

在 `LlmRuntime` 中，每一次流式调用都会经过 Cordis 事件总线的 Waterfall 流水线拦截：

```typescript
declare module '@deepseek-ai/cordis' {
  interface Events {
    'llm/stream'(this: LlmRuntime, options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk>
  }
}
```

这为整个系统提供了极强的可扩展性，各类中间件插件可以通过注册 `llm/stream` 实现切面注入：
1. **自动重试中间件（`@deepseek-ai/dsh-llm-retry`）**：在遇到网络抖动、HTTP 429 限流或服务端 503 错误时，按照指数退避（Exponential Backoff with Jitter）算法自动重试，对上层透明。
2. **流量录制与快照回放（Replay Middleware）**：在开发与集成测试环境下，拦截真实的外部请求，将流式 Chunk 序列完整录制为本地 JSON 快照；在离线回放测试中直接重放快照流，实现 0 成本、100% 确定性的端到端回归验证。
3. **动态路由与故障转移（Failover Routing）**：当主 Provider 持续发生超时或配额耗尽时，动态切换路由至备用模型端点。

---

## 4. SSE 协议状态机与 `eventsource-parser` 流式解析

### 4.1 Server-Sent Events (SSE) 协议规范与边界缺陷

HTTP SSE 是基于长连接文本传输的流式协议。服务端响应头标记为 `Content-Type: text/event-stream`，数据以事件块组织，每个字段以冒号分隔，事件之间以双换行符 `\n\n` 结尾：

```http
HTTP/1.1 200 OK
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive

data: {"choices":[{"delta":{"reasoning_content":"Let's analyze"}}]}

data: {"choices":[{"delta":{"content":"Hello"}}]}

data: [DONE]

```

在底层的 TCP/IP 传输中，操作系统底层的 TCP 缓冲区与网络 MTU（通常为 1500 字节）会导致数据流被任意切割。一个完整的 UTF-8 多字节字符（如中文汉字占用 3 字节）或一个完整的 JSON 字符串可能被跨包截断为两个 TCP 数据段：

```
TCP Segment 1: "data: {\"choices\":[{\"delta\":{\"content\":\"\xE4\xBD"
TCP Segment 2: "\xA0\"}}]}\n\n"
```

如果直接使用朴素的按行分割（`split('\n')`）或简单的 `JSON.parse`，解析器必将在跨包边界处直接抛出异常崩溃。

### 4.2 流式处理流水线架构

DeepSeek Harness 构建了一条完全基于标准 Web Streams API 的响应处理流水线：

```
+---------------------------------------------------------------------------------------+
|                              SSE Stream Decoding Pipeline                             |
+---------------------------------------------------------------------------------------+
|  ReadableStream<Uint8Array> (底层原始 TCP 字节流)                                       |
+---------------------------------------------------------------------------------------+
                                           |
                                           v  .pipeThrough(new TextDecoderStream())
+---------------------------------------------------------------------------------------+
|  ReadableStream<string> (处理跨分包的 UTF-8 多字节解码，输出合法的 JS 字符串流)            |
+---------------------------------------------------------------------------------------+
                                           |
                                           v  .pipeThrough(new EventSourceParserStream())
+---------------------------------------------------------------------------------------+
|  SSE Events Stream (解析 SSE Framing 协议帧，聚合 multi-data 行，忽略注释与心跳)        |
+---------------------------------------------------------------------------------------+
                                           |
                                           v  parseSse() 异步生成器
+---------------------------------------------------------------------------------------+
|  Payloads Stream (提取 data: 内容，严格校验终结哨兵 [DONE])                              |
+---------------------------------------------------------------------------------------+
                                           |
                                           v  translate() 状态机
+---------------------------------------------------------------------------------------+
|  StreamChunk Stream (将底层 Wire JSON 转换为 Harness 强类型多路复用流式事件)            |
+---------------------------------------------------------------------------------------+
```

```typescript
export async function* parseSse(
  stream: ReadableStream<BufferSource>,
  onComment?: (comment: string) => void,
): AsyncGenerator<string> {
  const events = stream
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new EventSourceParserStream({ onComment }))
  for await (const { data } of events) {
    yield data
    if (data === DONE) return
  }
  throw new LlmError('SSE stream ended without [DONE]', 'STREAM_CLOSED')
}
```

* **严格哨兵验证**：`[DONE]` 是 OpenAI / DeepSeek 协议中明确标志响应正常完结的哨兵标记。如果底层 TCP 连接在发送 `[DONE]` 之前异常中断（例如网关超时掐断连接），`parseSse` 决不会静默退出，而是显式抛出 `STREAM_CLOSED` 异常，阻止将残缺的输出误判为正常完成。

### 4.3 状态机转换器：`translate()` 与分块装配

底层服务端返回的 JSON 结构是非常松散的，且 DeepSeek R1 会将思维链（`reasoning_content`）与正文内容（`content`）交替或先后推送。`translate()` 函数将无序的原始 Payload 转换为 Harness 标准的强类型 `StreamChunk`：

```typescript
export type StreamChunk =
  | { type: 'block-start'; index: number; blockType: ContentBlockType }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: CallId; name?: string; argumentsDelta: string }
  | { type: 'block-end'; index: number; block: ContentBlock }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'finish'; reason: FinishReason; replayState?: ReplayEnvelope }
```

#### Token 计费不相交对账（Disjoint Token Counting）

在 API 对账与 Token 预算计量中存在一个极其隐蔽但致命的坑：**不同厂商对 `prompt_tokens` 的定义不同**。
* DeepSeek API 返回的 `prompt_tokens` 是**总输入 Token 数量**（包含命中缓存的 Token 与未命中的 Token）： $$\text{prompt\_tokens} = \text{prompt\_cache\_hit\_tokens} + \text{prompt\_cache\_miss\_tokens}$$
* 如果框架直接使用 `prompt_tokens` 作为未缓存 Token，再加上 `cacheReadTokens`，就会导致 Token 消耗被**重复双重计算（Double Counting）**！

Harness 严格执行 **Disjoint Token Counting（互斥不相交计数规范）**：

```typescript
export function mapUsage(usage: WireUsage): TokenUsage {
  const cacheRead = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens
  const reasoning = usage.completion_tokens_details?.reasoning_tokens
  return {
    inputTokens: usage.prompt_tokens - (cacheRead ?? 0), // 精准减去命中缓存部分
    outputTokens: usage.completion_tokens,
    ...cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {},
    ...reasoning !== undefined ? { reasoningTokens: reasoning } : {},
  }
}
```

---

## 5. 核心不变量：“模型可见即已记录”与事件实时落盘

在分布式系统与数据库理论中，预写日志（WAL）是不变性与可恢复性的基石。在 DeepSeek Harness 中，这一哲学被提升为最高级别的系统不变量：

> **核心架构不变量：模型可见即已记录（Model-Visible is Recorded）** > 任何已经输入给大模型上下文的数据，以及任何大模型已经生成并被运行时感知的输出，必须在产生或消费发生的同一时间截面上，作为不可变的事件持久化到 Session Log 中。

```
                                  Agent Loop Step Execution
                                             |
                                             v
                           +-----------------------------------+
                           |  stream = preparedCall.stream()   |
                           +-----------------------------------+
                                             |
                                             | for await (const chunk of stream)
                                             v
                           +-----------------------------------+
                           | 1. WAL 预写日志实时落盘            |
                           |    seq = session.append(          |
                           |      'assistant/chunk',           |
                           |      { turn, step, chunk }        |
                           |    ).seq                          |
                           +-----------------------------------+
                                             |
                                             v
                           +-----------------------------------+
                           | 2. 内存聚合器                     |
                           |    assembler.push(chunk)          |
                           |    chunkSeqs.push(seq)            |
                           +-----------------------------------+
                                             |
                                             v
                           +-----------------------------------+
                           | 3. 用户 / UI 消费 / WebSocket 推送|
                           +-----------------------------------+
```

### 5.1 为什么细粒度 `assistant/chunk` 必须实时逐帧落盘？

很多简易的 Agent 框架只在模型完整响应结束后才将整条消息保存到数据库中。这种做法在生产环境中存在极其严重的缺陷：

1. **崩溃恢复与断点保护（Crash Recovery & Interruption Preservation）**： 当大模型生成一个 4000 Token 的复杂代码方案时，耗时可能长达 30 秒。如果在第 28 秒时发生进程 OOM、物理机断电、宿主崩溃或用户点击了“取消（Cancel）”，如果只在终态落盘，这 28 秒内产生的所有推理成果和 Token 消耗都将彻底丢失。 在 Harness 中，由于每个 Chunk 已经实时写入 Session Log，当捕获到 `signal.aborted` 时，Agent Loop 可以立刻从 `BlockAssembler` 中提取 `interruptedBlocks()`，并生成带有 `interrupted: true` 标记的 `assistant/message` 固化到日志中：
   ```typescript
   if (signal.aborted) {
     const content = assembler.interruptedBlocks()
     if (content.length > 0) {
       this.session.append('assistant/message', {
         turn,
         step,
         message: createAssistantMessage({
           content,
           source: { provider: request.provider, model: request.model },
         }),
         interrupted: true,
         ...assembler.usage === undefined ? {} : { usage: assembler.usage },
       }, { surfaceOp: 'append', sourceEventSeqs: chunkSeqs })
     }
   }
   ```
2. **确定性快照重放（Deterministic Snapshot Replay）与审计**： 在离线测试、故障复盘或 Web 前端重新连接时，通过按序列号遍历 `assistant/chunk` 事件，系统能够以微秒级的因果顺序 100% 真实还原模型吐字的完整时序过程，包括每一个字符的出现时刻与思维链的展开动态。

### 5.2 违反不变量的灾难性后果剖析

若违反“模型可见即已记录”不变量，系统将陷入以下三大灾难：

#### (1) 对账分裂与上下文漂移（Split-Brain Context Drifting）

如果系统为了性能，将某些动态注入的环境变量（例如当前活跃的 Claim 任务 ID）直接拼入 Prompt 发给模型，却没有在 Session Log 中记录对应的 `runtime/context` 事件。 当系统崩溃重启或进行下一轮对话时，`session.deriveMessages()` 仅能从持久化的事件流中恢复历史消息。此时，模型在上一轮看到的上下文与下一轮恢复出来的历史上下文产生了物理断层。模型会产生严重的**自相矛盾与幻觉雪崩**，坚称自己从未收到过之前的指令，甚至重复执行具有危险副作用的外部工具。

#### (2) 幂等性破坏与工具重复调用（Tool Execution Replay Hazard）

如果模型生成的 `tool-call` 增量没有实时记录，在网络抖动导致连接重试时，系统无法判断上一次生成的 Tool ID 是什么，可能导致向外部系统（如支付网关、云资源创建、数据库写入）发送重复的 RPC 请求，引发严重的资金与数据损失。

#### (3) 权限越权与安全审计失真（Security Audit Breakdown）

在受限沙箱模式下，模型生成的所有输入输出构成了不可抵赖的因果审计链。若存在未经记录的临时 Prompt 注入，安全监控系统将无法复原攻击者的 Prompt 注入（Prompt Injection）攻击路径，给生产安全留下不可修复的黑盒漏洞。

---

## 6. 完整工业级 TypeScript 源码实现

为了让读者完全掌握本章的核心技术，下面给出一个类型完备、生产级的精简版提示词装配与流式 LLM 执行引擎完整实现。该实现严格遵循 Cordis 架构思想、包含 AbortSignal 协作式取消、看门狗超时监控与事件溯源落盘机制。

```typescript
/**
 * @file mini-streaming-llm-engine.ts
 * 生产级提示词装配与流式 LLM 执行引擎参考实现
 */

import { EventEmitter } from 'node:events'

// ============================================================================
// 1. 核心领域类型定义 (Domain Types)
// ============================================================================

export type CallId = string & { readonly __brand: unique symbol }
export const CallId = (id: string): CallId => id as CallId

export interface ToolSchema {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface PromptSection {
  name: string
  order: number
  text: string | ((vars: Record<string, string>) => string)
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool-call'; id: CallId; name: string; arguments: string }

export type StreamChunk =
  | { type: 'block-start'; index: number; blockType: 'text' | 'reasoning' | 'tool-call' }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: CallId; name?: string; argumentsDelta: string }
  | { type: 'block-end'; index: number; block: ContentBlock }
  | { type: 'usage'; usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number } }
  | { type: 'finish'; reason: { kind: 'stop' | 'tool-calls' | 'max-tokens' | 'error' | 'aborted' } }

export interface GenerateOptions {
  provider: string
  model: string
  system?: string
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: ContentBlock[] | string }>
  tools?: ToolSchema[]
  signal?: AbortSignal
}

// ============================================================================
// 2. 提示词装配服务 (SystemPrompt Assembler)
// ============================================================================

export class SystemPromptService {
  private sections = new Map<string, PromptSection>()
  private variables = new Map<string, string>()

  constructor() {
    // 默认注入框架基础身份
    this.registerSection({
      name: 'harness:identity',
      order: -100,
      text: 'You are an AI agent powered by DeepSeek Harness.',
    })
  }

  registerSection(section: PromptSection): () => void {
    if (this.sections.has(section.name)) {
      throw new Error(`Section "${section.name}" is already registered`)
    }
    this.sections.set(section.name, section)
    return () => this.sections.delete(section.name)
  }

  setVariable(name: string, value: string): void {
    this.variables.set(name, value)
  }

  private interpolate(template: string): string {
    const varRegex = /\{\{([a-zA-Z0-9_]+)\}\}/g
    return template.replace(varRegex, (_, varName: string) => {
      const val = this.variables.get(varName)
      if (val === undefined) {
        throw new Error(`Missing prompt variable: "{{${varName}}}"`)
      }
      return val
    })
  }

  assemble(): string {
    const sorted = [...this.sections.values()].sort((a, b) => a.order - b.order)
    const rendered: string[] = []
    for (const sec of sorted) {
      const raw = typeof sec.text === 'function' ? sec.text(Object.fromEntries(this.variables)) : sec.text
      const text = this.interpolate(raw).trim()
      if (text.length > 0) rendered.push(text)
    }
    return rendered.join('\n\n')
  }
}

// ============================================================================
// 3. SSE 字节流与事件解析器 (Robust SSE Parser)
// ============================================================================

export async function* parseSseStream(
  byteStream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const textStream = byteStream.pipeThrough(new TextDecoderStream())
  const reader = textStream.getReader()
  let buffer = ''

  try {
    while (true) {
      signal?.throwIfAborted()
      const { done, value } = await reader.read()
      if (done) break
      buffer += value

      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? '' // 保持尾部未闭合数据块

      for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed.startsWith('data:')) {
          const payload = trimmed.slice(5).trim()
          yield payload
          if (payload === '[DONE]') return
        }
      }
    }
  } finally {
    reader.releaseLock()
  }

  if (buffer.trim() === 'data: [DONE]') return
  throw new Error('SSE stream terminated unexpectedly without [DONE] sentinel')
}

// ============================================================================
// 4. DeepSeek 适配器与多路复用转换 (DeepSeek Adapter & Translator)
// ============================================================================

export class MiniDeepSeekAdapter {
  constructor(
    private readonly baseURL: string,
    private readonly apiKey: string,
  ) {}

  async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    const signal = options.signal
    signal?.throwIfAborted()

    const body = {
      model: options.model,
      stream: true,
      messages: [
        ...(options.system ? [{ role: 'system', content: options.system }] : []),
        ...options.messages.map(m => ({
          role: m.role,
          content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        })),
      ],
      stream_options: { include_usage: true },
    }

    const response = await fetch(`${this.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
        'accept': 'text/event-stream',
      },
      body: JSON.stringify(body),
      signal,
    })

    if (!response.ok) {
      const errText = await response.text().catch(() => '')
      throw new Error(`DeepSeek API HTTP ${response.status}: ${errText}`)
    }
    if (!response.body) throw new Error('Response body is empty')

    // 状态机聚合器
    let textIndex = -1
    let textContent = ''
    let reasoningIndex = -1
    let reasoningContent = ''
    let nextIndex = 0

    for await (const payload of parseSseStream(response.body, signal)) {
      if (payload === '[DONE]') break
      const chunk = JSON.parse(payload)

      // 1. 处理 Usage (Disjoint Token 计数)
      if (chunk.usage) {
        const cached = chunk.usage.prompt_tokens_details?.cached_tokens ?? chunk.usage.prompt_cache_hit_tokens ?? 0
        yield {
          type: 'usage',
          usage: {
            inputTokens: chunk.usage.prompt_tokens - cached,
            outputTokens: chunk.usage.completion_tokens,
            cacheReadTokens: cached > 0 ? cached : undefined,
          },
        }
      }

      const choice = chunk.choices?.[0]
      if (!choice) continue
      const delta = choice.delta

      // 2. 处理 Reasoning Delta
      if (delta?.reasoning_content) {
        if (reasoningIndex === -1) {
          reasoningIndex = nextIndex++
          yield { type: 'block-start', index: reasoningIndex, blockType: 'reasoning' }
        }
        reasoningContent += delta.reasoning_content
        yield { type: 'reasoning-delta', index: reasoningIndex, text: delta.reasoning_content }
      }

      // 3. 处理 Text Delta
      if (delta?.content) {
        if (textIndex === -1) {
          textIndex = nextIndex++
          yield { type: 'block-start', index: textIndex, blockType: 'text' }
        }
        textContent += delta.content
        yield { type: 'text-delta', index: textIndex, text: delta.content }
      }
    }

    // 闭合所有已开启的 Block
    if (reasoningIndex !== -1) {
      yield { type: 'block-end', index: reasoningIndex, block: { type: 'reasoning', text: reasoningContent } }
    }
    if (textIndex !== -1) {
      yield { type: 'block-end', index: textIndex, block: { type: 'text', text: textContent } }
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

// ============================================================================
// 5. 聚合器与 Session Log 实时落盘协同 (Assembler & WAL Storage)
// ============================================================================

export class MiniSessionLedger extends EventEmitter {
  private events: Array<{ seq: number; type: string; data: unknown }> = []
  private nextSeq = 1

  append(type: string, data: unknown): { seq: number } {
    const record = { seq: this.nextSeq++, type, data }
    this.events.push(record)
    this.emit('event', record)
    return { seq: record.seq }
  }

  getEvents() {
    return [...this.events]
  }
}

export async function executeAgentStepWithWal(
  adapter: MiniDeepSeekAdapter,
  options: GenerateOptions,
  session: MiniSessionLedger,
): Promise<ContentBlock[]> {
  const signal = options.signal
  const assembledBlocks: ContentBlock[] = []
  const chunkSeqs: number[] = []

  try {
    const stream = adapter.stream(options)
    for await (const chunk of stream) {
      signal?.throwIfAborted()

      // 核心不变量：模型可见即已记录 (WAL 实时落盘)
      const { seq } = session.append('assistant/chunk', { chunk })
      chunkSeqs.push(seq)

      if (chunk.type === 'block-end') {
        assembledBlocks.push(chunk.block)
      }
    }

    // 终态消息落盘
    session.append('assistant/message', {
      content: assembledBlocks,
      sourceSeqs: chunkSeqs,
    })

    return assembledBlocks
  } catch (error) {
    if (signal?.aborted) {
      session.append('assistant/message', {
        content: assembledBlocks,
        interrupted: true,
        sourceSeqs: chunkSeqs,
      })
    }
    throw error
  }
}
```

---

## 7. 生产环境真实故障与排查指南

在企业级生产环境中，提示词装配与流式通信链路往往是故障高发区。本节总结了五个经典故障场景及精准定位修复方案。

### 故障 1：Prompt Cache 命中率断崖式下跌与 TTFT 飙升

* **故障现象**：监控大盘显示，系统平均 TTFT（首字延迟）从 350ms 突然恶化到 4.8s，同时调用账单金额在用户量未发生显著增长的情况下激增了 4 倍。
* **根因定位**：某个业务插件在 `SystemPrompt.section` 中注册了一段带有动态生成的会话唯一 ID 的提示词段落：`[Session UUID: eb962368-ae94...]`，且该段落的 `order` 被错误配置为 `-50`（排在 Persona 之前）。由于每次新会话的 UUID 均不相同，导致大模型服务端的 Prompt Cache 在第 10 个 Token 处全部击穿，后续数千 Token 的 Persona 和工具 Schema 完全无法复用缓存。
* **修复方案**：
  1. 实施静态代码分析门禁（Linter），严禁在 `SystemPrompt` 中引入非确定性变量。
  2. 将所有会话级动态标识移动到历史消息末尾的 `runtime/context` 快照中。

### 故障 2：跨分包边界导致 SSE JSON.parse 偶发报 `SyntaxError`

* **故障现象**：在高并发大吞吐场景下，日志中偶尔出现 `SyntaxError: Unexpected end of JSON input` 或 `malformed SSE payload`，导致大约 0.3% 的用户请求异常中断。
* **根因定位**：底层使用了简单的字符流缓冲分割，当底层网络发生 TCP 分段重组时，中文或特殊字符的 UTF-8 字节序跨越了两个 `data:` 分块，且 `TextDecoder` 没有以流式模式（Stream Mode）保持状态，输出了带乱码的 `\uFFFD` 替代字符，导致后续 JSON 解析崩溃。
* **修复方案**：全面接入 `@eventsource-parser` 或标准的 `TextDecoderStream` 管道流，确保底层字节流在经历 UTF-8 组帧与双换行协议确认后再交由上层 JSON 解析器。

### 故障 3：用户取消（Abort）后遗留孤立 TCP 连接与计费浪费

* **故障现象**：用户在客户端连续快速发起取消并重新提问，服务端虽然捕获到了 `AbortError` 并停止了 UI 渲染，但云端 LLM 供应商的后台依然显示前序请求在持续生成，Token 消耗量持续累加。
* **根因定位**：在调用 `fetch` 时传递了 `signal`，但在流式迭代器（`for await...of`）被 `break` 或 `throw` 退出时，没有显式调用 `response.body.cancel()` 或调用底层迭代器的 `return()` 方法，导致底层 HTTP/2 连接没有向服务端发送 `RST_STREAM` 帧，远端模型仍在空转生成。
* **修复方案**：在生成器中使用 `finally` 块绑定 `iterator.return?.()`，并使用 `consumer.abort()` 确保双向断开。

### 故障 4：缓存 Token 统计重叠引发的账单计量对账负数

* **故障现象**：在计费与计量微服务对账时，出现 `inputTokens < 0` 的严重数据异常，导致财务结算报表校验失败。
* **根因定位**：某个适配器在处理 DeepSeek 响应时，误将 `prompt_tokens` 当作未缓存 Token，执行了 `inputTokens = prompt_tokens - prompt_cache_hit_tokens`，而在某些第三方聚合网关中，`prompt_tokens` 已经被网关扣减过了缓存部分，导致二次相减后产生负数。
* **修复方案**：在 `mapUsage` 中增加防御性断言与边界裁剪：`Math.max(0, rawPromptTokens - cacheHitTokens)`，并严格通过字段层级（`prompt_tokens_details`）进行语义嗅探。

### 故障 5：HMR 热重载期间的模型元数据裂脑

* **故障现象**：开发人员在热重载修改了配置后，模型请求报错 `UNSUPPORTED_REASONING_EFFORT: model does not support reasoning effort "high"`。
* **根因定位**：请求的参数来自旧版本的配置缓存，而底层分发的适配器已经切换到了不支持该参数的新模型端点，配置与端点出现裂脑。
* **修复方案**：采用 Harness 的 **两阶段 `prepareCall` 机制**，将模型元数据查询与调用配置绑定为不可变的单代（Generation-Bound）事务对象，确保每一次分发都严格在同一配置代数内闭环。

---

## 8. 思考题与动手实验

为了巩固本章所学的硬核知识，请尝试完成以下三个动手实验与思考题：

1. **Prompt Cache 命中率对比实验**： 编写一个基准测试脚本，分别以“动态时间戳置顶”和“动态时间戳放入运行时上下文后缀”两种方式连续向 DeepSeek API 发送 10 轮请求，统计并对比两者的 `prompt_cache_hit_tokens`、平均 TTFT 延迟与总计费差异。
2. **手写一个 SSE 乱码注入防御测试**： 构造一个 Mock HTTP SSE 服务器，故意将汉字“中”（UTF-8 编码为 `E4 B8 AD`）拆分成两个 TCP 数据包发送（包 1: `E4 B8`，包 2: `AD`），并在中间插入 100ms 延迟。使用 `parseSseStream` 验证你的解析器是否能 100% 正确解码而不出现 `\uFFFD`。
3. **断点恢复对账测试**： 在 `executeAgentStepWithWal` 执行期间，当接收到第 10 个 Chunk 时主动触发 `abortController.abort()`。检查 `MiniSessionLedger` 中记录的 `assistant/chunk` 序列与最终生成的 `assistant/message` 的 `content`，验证 `interruptedBlocks` 是否被完整保留且因果标记正确。

---

## 9. 本章小结与下章预告

本章深入解构了 DeepSeek Harness 在提示词装配、模型抽象与流式通信领域的设计哲学与工程落地：

1. **System Prompt 架构**：通过静态稳定前缀与动态上下文后缀的解耦，最大化利用服务端 KV Cache（Prefix Caching），从根本上降低 TTFT 与计算开销。
2. **两阶段调用抽象**：通过 `prepareCall` 与不可变快照，消除了并发与配置热重载下的配置漂移与裂脑风险。
3. **严格流式解析**：基于 `eventsource-parser` 状态机与 `[DONE]` 哨兵机制，提供了鲁棒的跨分包解析与看门狗超时监控。
4. **核心不变量**：“模型可见即已记录”确保了系统的可恢复性、确定性快照重放与因果一致性。

在下一章中，我们将进入 **【第 10 章：工具体系与副作用控制】**，深入探讨工具注册表、exclusive 屏障与受限并发组、参数 Zod 校验、沙箱拦截与超长输出 Spill 策略，敬请期待！
