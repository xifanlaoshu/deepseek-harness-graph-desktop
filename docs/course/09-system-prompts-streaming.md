# Chapter 09: Prompts, Models, and Streaming Responses

English | [中文](09-system-prompts-streaming.zh.md)

In a conventional distributed backend or microservice architecture, RPC calls usually follow a deterministic request-response model: a client sends a strongly typed Protobuf or JSON-RPC message, the server runs defined business logic, and a result returns synchronously or asynchronously. Introducing an LLM as the probabilistic core reasoning engine changes both the communication and state-machine models.

An LLM is effectively a large **autoregressive probability-distribution function** built from high-dimensional tensor operations. Each call consumes substantial compute and GPU-memory bandwidth. Its output arrives as a one-way byte stream of token-sized increments over HTTP Server-Sent Events (SSE).

In an agent harness, prompt construction is more than string-template concatenation: it directly affects **KV Cache** reuse in the GPU cluster and time to first token (TTFT). Likewise, receiving and parsing a streaming response is more than feeding a frontend typing animation. It is central to **state recovery, deterministic snapshot replay, distributed cancellation through AbortSignal, and a causally consistent event-sourced record**.

Using DeepSeek Harness source as the reference, this chapter examines the dynamic system-prompt assembler, the LLM Service Definition, multiple provider adapters, a strict SSE streaming state machine built on `eventsource-parser`, and the system invariant that model-visible content is recorded.

---

## 1. Mapping Systems-Programming Concepts to LLM Streaming

The following table relates prompts, models, and streaming in an agent system to familiar systems-programming and distributed-system concepts:

| Agent / LLM concept | Systems-programming / operating-system / distributed analogue | Engineering responsibility |
| :--- | :--- | :--- |
| **System Prompt** | **Process launch arguments / operating-system environment variables / firmware instructions** | Defines model behavior, capability limits, sandbox policies, and execution protocol. |
| **Static Prefix** | **The read-only, cross-process shared `.text` section of a shared library** | Keeps frequently reused text stable so server-side **prefix caching** avoids repeated prefill computation. |
| **Dynamic Context** | **A top-of-stack local frame / live register snapshot** | Injects changing environment information on each Turn (time, working directory, Git branch, claim status). |
| **Prompt Variables (`{{var}}`)** | **Macro substitution / link-time symbol resolution** | Strictly validates and fills placeholders in a deterministic scope chain; undefined symbols are rejected. |
| **LLM Provider Adapter** | **Device driver / POSIX virtual filesystem (VFS) adapter** | Presents one interface across provider-specific network protocols and message formats (DeepSeek, OpenAI, Anthropic). |
| **Two-Phase Prepared Call** | **Two-phase commit (2PC) / transaction lock and snapshot isolation** | Freezes model metadata and runtime defaults first to avoid configuration drift, then dispatches one exclusive stream. |
| **SSE Stream Chunk** | **Streaming TCP segments / event frames in an asynchronous queue** | Fine-grained multiplexed deltas for text, reasoning, and tool calls. |
| **Persisted Event-Sourced Chunk** | **Database write-ahead log (WAL)** | Persists each received chunk before business logic or UI rendering so a crash can be reconstructed. |
| **Model-Visible Is Recorded** | **Causal-consistency barrier** | Requires an immutable factual log of data entering or leaving the model. |

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

## 2. Dynamic System-Prompt Assembly and Prompt-Cache Optimization

### 2.1 LLM Inference Bottlenecks and KV Cache Memory Accounting

Before examining system-prompt architecture, consider why prompt ordering matters in terms of GPU memory and computational complexity.

When an LLM autoregressively generates token $t$, attention computes dot products between that token's query vector and the key and value vectors of all preceding tokens ($1$ through $t-1$):

$$\text{Attention}(Q, K, V) = \text{Softmax}\left(\frac{Q K^T}{\sqrt{d_k}}\right) V$$

Recomputing historical $K$ and $V$ matrices for each generation step gives the prefill phase $O(L^2)$ time complexity, where $L$ is context length. To avoid repeated work, modern inference engines such as vLLM, TensorRT-LLM, and DeepSeek inference clusters allocate a **KV Cache** in GPU memory, retaining each historical token's key and value tensors at every layer.

#### Deriving GPU-Memory Use

For a Transformer with $n_{\text{layers}}$ layers, hidden dimension $d_{\text{model}}$, $n_{\text{heads}}$ attention heads, and per-head dimension $d_{\text{head}} = d_{\text{model}} / n_{\text{heads}}$, the standard multi-head attention (MHA) KV Cache at FP16/BF16 precision (2 bytes per value), batch size $b = 1$, and context length $L$ consumes:

$$M_{\text{KV-MHA}} = 2 \times 2 \times n_{\text{layers}} \times n_{\text{heads}} \times d_{\text{head}} \times L \times b = 4 \cdot n_{\text{layers}} \cdot d_{\text{model}} \cdot L \quad \text{(Bytes)}$$

In the **multi-head latent attention (MLA)** architecture used by DeepSeek-V3 / DeepSeek-R1, keys and values are projected into a low-dimensional latent vector $d_c$ (usually $d_c \ll 2 \cdot n_{\text{heads}} \cdot d_{\text{head}}$), alongside decoupled rotary positional encoding of dimension $d_R$:

$$M_{\text{KV-MLA}} = 2 \times n_{\text{layers}} \times (d_c + d_R) \times L \times b \quad \text{(Bytes)}$$

#### Worked Comparison

Suppose we deploy a 64-layer model with hidden dimension $d_{\text{model}} = 8192$ and context length $L = 64\text{k} = 65,536$ tokens:

1. **Standard MHA memory use**: $$M_{\text{KV-MHA}} = 4 \times 64 \times 8192 \times 65,536 \times 1 = 137,438,953,472 \text{ Bytes} \approx 128 \text{ GiB}$$ The KV Cache for one 64K-context Session alone would consume the available memory of two NVIDIA H100 (80 GB) GPUs.

2. **DeepSeek MLA memory use ($d_c = 512, d_R = 64$)**: $$M_{\text{KV-MLA}} = 2 \times 64 \times (512 + 64) \times 65,536 \times 1 = 4,831,838,208 \text{ Bytes} \approx 4.5 \text{ GiB}$$ Memory use is almost 28 times lower, making cross-Session **prefix caching** in GPU memory feasible even with long contexts.

### 2.2 Prefix Caching and Cache Busting

Modern cloud LLM providers, notably DeepSeek, use server-side **prompt caches**. The server's GPU-memory manager hashes prefix tokens in fixed-size blocks, such as 64 tokens:

$$h_i = \text{Hash}(h_{i-1} \parallel \text{Token}_{(i-1)B + 1 \dots iB})$$

If a later request starts with tokens matching existing cached blocks exactly—whether in another Turn of the same agent or the first call of a different agent—the server can reuse the KV Cache and skip prefill computation for those blocks.

$$T_{\text{TTFT}} = \frac{L_{\text{unhit}} \cdot D_{\text{FLOPs}}}{P_{\text{compute}}} + \frac{L_{\text{hit}} \cdot D_{\text{KV-read}}}{B_{\text{mem}}}$$

Here $P_{\text{compute}}$ is GPU floating-point compute capacity and $B_{\text{mem}}$ is GPU-memory bandwidth. Reading cached values is much faster than repeating matrix multiplication, so a cache hit can reduce TTFT from tens of seconds to hundreds of milliseconds. Cloud providers may also discount cached tokens by **75%–90%**; for example, DeepSeek charges one-tenth of its cache-miss price for a hit.

#### A Cache-Busting Example

Suppose an engineer puts this line at the start of the system prompt: `You are an assistant. The current time is 2026-08-25 16:30:15.`

Because the timestamp changes each second, the first prefix hash $h_1$ changes with every request. **The entire system prompt, subsequent tool definitions, and historical messages lose their KV Cache reuse**. Server-side caching is defeated, increasing compute cost and latency substantially.

### 2.3 Assembly Architecture: Stable Prefix and Dynamic Runtime Context

To prevent cache busting by design, DeepSeek Harness uses the `@deepseek-ai/dsh-system-prompt` assembler. It separates model-visible content into two parts:

1. **System prompt (stable prefix)**: Contains the global identity, deployment persona, and tool-use instructions. It stays stable and deterministically ordered through the Session and appears first in the input, maximizing KV Cache hits.
2. **Context snapshot (dynamic suffix / separate message)**: Contains changing runtime state such as time, working directory, Git branch, and claim status. Instead of modifying the system prompt, it is injected into the Session history as the latest Turn's context snapshot.

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

### 2.4 How the `SystemPrompt` Service Works

The main algorithms are in `packages/core/system-prompt/src/index.ts`.

#### (1) Ordering and Scoped Shadowing

Every registered `PromptSection` has an `order`:
* `-100`: Core Harness identity (`harness:identity`).
* `0`: Deployment-level or agent-preset persona (`deployment:persona`).
* `100 ~ 199`: Tool and capability instructions.

```typescript
export interface PromptSection {
  readonly name: string
  readonly order: number
  readonly text: string | ((context: AssembleContext) => string)
  readonly complete?: boolean
}
```

For nested agents or isolated Sessions, `ScopedLayers` provides scoped overrides: a Section registered within an agent scope under the same name, such as `deployment:persona`, shadows the global Section without duplicating prompt text.

#### (2) Strict Variable Interpolation

Prompt variables use `{{variable_name}}` placeholders. The `interpolate()` function validates them strictly so a typo does not fail silently:

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

* **Prototype-chain protection**: It uses `Object.hasOwn(variables, name)` rather than `variables[name] !== undefined` so inherited properties such as `toString` and `constructor` cannot bypass validation.
* **Single-pass scanning**: Inserted values are not scanned again, preventing second-pass interpolation and related prompt-injection or template-recursion attacks.

#### (3) Canonical Ordering of Tool Definitions

If the tool-definition array changes order between requests, perhaps because asynchronous plugins load in a different order, its token sequence changes and invalidates the KV Cache for that region.

`SystemPrompt` implements deterministic `orderTools` ordering: by default, `compareToolNames` sorts names lexicographically by Unicode code point. An explicit `toolOrder` must include the `<unlisted-tools>` placeholder so unlisted tools appear at a defined position. This keeps output byte-for-byte stable across machines and environments.

#### (4) Exclusive Complete Sections and Waterfall Transformations

In specialized cases, such as automated benchmarks or plain-text code completion, a caller may need full control of the system prompt without the built-in `harness:identity` or plugin sections.

`PromptSection` supports `complete: true`. During assembly:
1. Global and scoped variable resolution and waterfall filtering still run so tools and runtime context are calculated normally.
2. At the end, the pipeline discards every other Section and keeps only the authoritative `complete: true` Section.
3. If more than one active Section has `complete: true`, assembly fails immediately instead of silently choosing between conflicting policies.

---

## 3. The LLM Service Definition and Multiple Provider Adapters

In an enterprise agent architecture, the upper-level agent loop must not depend directly on one model vendor's SDK, such as OpenAI's or Anthropic's. Harness defines a provider-neutral `LlmRuntime` Service and abstract `LlmAdapter` base class.

### 3.1 The Two-Phase Prepared Call

Why is a simple `llm.stream(options)` insufficient for enterprise reliability?

In a system with hot reload (HMR), configuration overlays, and retries, settings may change during a call—for example, an administrator may change the default temperature or retry policy in the Web UI. A gap between resolving model metadata and sending HTTP can then produce **configuration and endpoint drift**.

`LlmRuntime` therefore uses an immutable **two-phase prepared call**:

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

1. **Preparation (`prepareCall`)**: Given proposed call settings, the adapter resolves model context length (`contextWindow`), default maximum tokens (`defaultMaxTokens`), and reasoning effort (`reasoningEffort`), then creates a deeply frozen (`deepFreeze`) snapshot.
2. **Execution (`stream`)**: The prepared handle starts streaming. It enforces **single use** by setting `dispatched = true` on dispatch; a modified configuration causes `INVALID_PREPARED_CALL` before execution.

### 3.2 `DeepSeekAdapter`: Direct API Access and Transport Resilience

`packages/llm/llm-deepseek/src/adapter.ts` provides Harness's native DeepSeek API adapter. It uses built-in `fetch` and SSE parsing rather than a large third-party SDK.

#### (1) Idle-Timeout Watchdog

An LLM may take a long time to emit its first token when generating a long answer or using an extended reasoning mode, but tokens usually arrive milliseconds apart once transmission begins. A total-request timeout is difficult to tune: too short truncates long reasoning, while too long delays detection of a stalled TCP connection.

`DeepSeekAdapter` instead uses an **idle watchdog**:

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

Each incoming network chunk resets its timer. If no byte arrives within `streamIdleTimeoutMs` (300 seconds by default), the watchdog signals a timeout and breaks the stalled connection.

#### (2) Asynchronous Large-Image Offloading Through the Files API

When user input contains a high-resolution image, inlining its Base64 encoding in JSON inflates the request by more than 33%, risks an HTTP 413 response from the gateway, and increases memory-copy cost.

`DeepSeekAdapter` includes an image-offload policy:
* **Prefer the Files API**: Upload images asynchronously through the DeepSeek Files API, obtain a `file_id`, and send only the smaller reference in Session messages.
* **Recover from expiry or eviction**: A process-level `DeepSeekFileStore` tracks upload hashes and file lifetimes. If the provider reports an expired or missing file (`providerRejectedFileId`), the adapter catches the error, invalidates the local entry, and retries with inline Base64 in the same call transaction, without exposing the fallback to the agent.

### 3.3 The `pi-ai` Adapter and General Model Gateways

In addition to the native DeepSeek adapter, `packages/llm/llm-pi-ai` connects Harness to other model ecosystems, including OpenAI, Anthropic Claude, Google Gemini, Mistral, Ollama, and Groq.

The `pi-ai` adapter maps Harness `GenerateOptions` (messages, tool schemas, sampling temperature, and stop sequences) to a common multi-model protocol and handles provider-specific capabilities:
* **Reasoning normalization**: Anthropic Claude 3.7 Sonnet `thinking` blocks, OpenAI o-series `reasoning_effort`, and DeepSeek R1 `reasoning_content` map to Harness `reasoning-delta` and `ReasoningBlock`.
* **Tool-call normalization**: It accommodates gateway differences in parallel tool-call IDs and streamed argument-fragment assembly.

### 3.4 The `llm/stream` Waterfall

In `LlmRuntime`, every streaming call passes through a Cordis event-bus waterfall:

```typescript
declare module '@deepseek-ai/cordis' {
  interface Events {
    'llm/stream'(this: LlmRuntime, options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk>
  }
}
```

Middleware plugins can register for `llm/stream` to extend call behavior:
1. **Automatic retry middleware (`@deepseek-ai/dsh-llm-retry`)**: On network failures, HTTP 429 rate limits, or server 503 errors, retry with exponential backoff and jitter without exposing those attempts to the upper layer.
2. **Traffic recording and snapshot replay**: In development and integration tests, capture real external requests and complete streaming-chunk sequences as local JSON snapshots; offline tests replay the streams for deterministic, zero-API-cost end-to-end regression.
3. **Dynamic routing and failover**: After repeated timeouts or quota exhaustion at the primary provider, route calls to a backup model endpoint.

---

## 4. The SSE State Machine and `eventsource-parser` Streaming Parser

### 4.1 Server-Sent Events (SSE) and Transport Boundaries

HTTP SSE streams text over a persistent connection. The server responds with `Content-Type: text/event-stream`. Data is organized into event blocks with colon-separated fields and a double newline `\n\n` between events:

```http
HTTP/1.1 200 OK
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive

data: {"choices":[{"delta":{"reasoning_content":"Let's analyze"}}]}

data: {"choices":[{"delta":{"content":"Hello"}}]}

data: [DONE]

```

TCP buffering and a network MTU (often 1,500 bytes) can split the stream at arbitrary byte positions. A multibyte UTF-8 character, such as a three-byte Chinese character, or a complete JSON string may span two TCP segments:

```
TCP Segment 1: "data: {\"choices\":[{\"delta\":{\"content\":\"\xE4\xBD"
TCP Segment 2: "\xA0\"}}]}\n\n"
```

A naive `split('\n')` or immediate `JSON.parse` can fail at such packet boundaries.

### 4.2 Streaming Pipeline Architecture

DeepSeek Harness processes responses through a pipeline built on the standard Web Streams API:

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

* **Strict sentinel validation**: `[DONE]` marks normal completion in the OpenAI / DeepSeek protocol. If TCP closes before `[DONE]` arrives, for example because a gateway times out, `parseSse` throws `STREAM_CLOSED` instead of treating the truncated output as complete.

### 4.3 State-Machine Translation with `translate()` and Block Assembly

The server returns loosely structured JSON, and DeepSeek R1 may emit reasoning (`reasoning_content`) and body text (`content`) in sequence or interleaved. `translate()` converts raw payloads into Harness's strongly typed `StreamChunk`:

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

#### Disjoint Token Accounting

API reconciliation and token budgets must account for a subtle difference: **providers do not all define `prompt_tokens` in the same way**.
* DeepSeek's `prompt_tokens` is the **total number of input tokens**, including cache hits and misses: $$\text{prompt\_tokens} = \text{prompt\_cache\_hit\_tokens} + \text{prompt\_cache\_miss\_tokens}$$
* Treating `prompt_tokens` as uncached tokens and adding `cacheReadTokens` counts cached input **twice**.

Harness therefore uses **disjoint token accounting**:

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

## 5. Core Invariant: Model-Visible Content Is Recorded

Write-ahead logs (WALs) support durability and recovery in distributed systems and databases. DeepSeek Harness applies that principle as a core system invariant:

> **Core architectural invariant: model-visible content is recorded.** > Anything supplied as model context, and any model output observed by the runtime, must be persisted as an immutable event in the Session log at the time it is produced or consumed.

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

### 5.1 Why Persist Each `assistant/chunk` Immediately?

Many simple agent harnesses save an assistant message only after the full response finishes. That creates serious production risks:

1. **Crash recovery and interrupted-output preservation**: A complex 4,000-token code response may take 30 seconds. If the process runs out of memory, power fails, the host crashes, or the user cancels at second 28, terminal-only persistence loses all output and token use from those 28 seconds. Harness writes each chunk to the Session log as it arrives. On `signal.aborted`, the agent loop can extract `interruptedBlocks()` from `BlockAssembler` and append an `assistant/message` marked `interrupted: true`:
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
2. **Deterministic snapshot replay and audit**: During offline tests, incident review, or Web reconnection, traversing `assistant/chunk` events in sequence order reconstructs the response's causal timing down to microseconds, including when each character appeared and how reasoning unfolded.

### 5.2 Consequences of Violating the Invariant

Violating the model-visible-is-recorded invariant creates three classes of failure:

#### (1) Split-Brain Context Drift

Suppose a dynamic environment value, such as the active claim task ID, is inserted directly into a prompt for performance but no corresponding `runtime/context` event is recorded. After a crash or on the next Turn, `session.deriveMessages()` can reconstruct history only from persisted events. The recovered context differs from what the model actually saw, potentially causing **contradictory output and cascading hallucinations**: it may deny earlier instructions or repeat an external tool with dangerous side effects.

#### (2) Broken Idempotency and Repeated Tool Calls

If generated `tool-call` deltas are not recorded as they arrive, a connection retry after a network failure cannot identify the previous tool ID. The runtime may send duplicate RPC requests to external systems, such as payment gateways, cloud-resource creators, or databases, causing financial or data loss.

#### (3) Privilege Violations and Incomplete Security Audits

Under a restricted sandbox, model inputs and outputs form a nonrepudiable causal audit chain. An unrecorded temporary prompt injection prevents security monitoring from reconstructing the attack path, leaving an opaque gap in production security.

---

## 6. Complete Production-Style TypeScript Example

The following compact, fully typed, production-style example combines prompt assembly and streaming LLM execution. It follows Cordis architectural principles and includes cooperative AbortSignal cancellation, watchdog timeouts, and event-sourced persistence.

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

## 7. Production Failures and Diagnosis

Prompt assembly and streaming transport are common sources of production failures. These five scenarios describe symptoms, causes, and remedies.

### Failure 1: Prompt-Cache Hit Rate Collapses and TTFT Spikes

* **Symptom**: Average TTFT rises abruptly from 350 ms to 4.8 s, while the API bill quadruples despite little change in user traffic.
* **Cause**: A business plugin registers a system-prompt Section containing a generated Session ID, `[Session UUID: eb962368-ae94...]`, at `order` `-50`, before the persona. Each new Session has a different UUID, so the provider's prompt cache misses after token 10; thousands of subsequent persona and tool-schema tokens cannot reuse cached computation.
* **Remedy**:
  1. Add a static-analysis rule prohibiting nondeterministic variables in `SystemPrompt`.
  2. Move Session-specific dynamic identifiers to a `runtime/context` snapshot at the end of the message history.

### Failure 2: Packet Boundaries Cause Intermittent SSE `SyntaxError` Failures

* **Symptom**: Under high concurrency, logs occasionally report `SyntaxError: Unexpected end of JSON input` or `malformed SSE payload`, aborting about 0.3% of requests.
* **Cause**: A simple character-buffer splitter handles TCP segments, but a Chinese or special UTF-8 character spans two `data:` chunks. Because `TextDecoder` does not maintain streaming state, it emits the replacement character `\uFFFD` and later JSON parsing fails.
* **Remedy**: Use `@eventsource-parser` or a standard `TextDecoderStream` pipeline; pass data to JSON parsing only after UTF-8 reassembly and SSE double-newline framing.

### Failure 3: Cancellation Leaves an Orphaned TCP Request and Continues Billing

* **Symptom**: A user rapidly cancels and asks another question. The server catches `AbortError` and stops UI rendering, yet the cloud provider still shows the previous request generating and consuming tokens.
* **Cause**: Although `signal` was passed to `fetch`, leaving a `for await...of` stream with `break` or `throw` did not call `response.body.cancel()` or the underlying iterator's `return()`. The HTTP/2 connection did not send `RST_STREAM`, so remote generation continued.
* **Remedy**: Call `iterator.return?.()` in a generator `finally` block and use `consumer.abort()` to close both sides.

### Failure 4: Overlapping Cache Accounting Produces Negative Input Tokens

* **Symptom**: Billing reconciliation finds `inputTokens < 0`, and financial settlement validation fails.
* **Cause**: An adapter computes `inputTokens = prompt_tokens - prompt_cache_hit_tokens` while interpreting a DeepSeek response. Some third-party gateways have already subtracted cache hits from `prompt_tokens`, so the second subtraction can produce a negative value.
* **Remedy**: Add defensive validation and bounds in `mapUsage`, such as `Math.max(0, rawPromptTokens - cacheHitTokens)`, and interpret semantics using the `prompt_tokens_details` field hierarchy.

### Failure 5: Model-Metadata Drift During HMR

* **Symptom**: After a developer changes configuration during hot reload, a model call fails with `UNSUPPORTED_REASONING_EFFORT: model does not support reasoning effort "high"`.
* **Cause**: Request arguments came from an earlier cached configuration while dispatch switched to a new model endpoint that does not support them.
* **Remedy**: Use Harness's **two-phase `prepareCall` mechanism** to bind model metadata and call configuration into one immutable, generation-bound transaction object so each dispatch uses one configuration generation.

---

## 8. Questions and Hands-On Experiments

Try these three exercises to consolidate the concepts in this chapter:

1. **Prompt-cache hit-rate comparison**: Write a benchmark that sends 10 consecutive requests to the DeepSeek API in two configurations: a dynamic timestamp at the beginning of the prompt, and the timestamp in the runtime-context suffix. Compare `prompt_cache_hit_tokens`, average TTFT, and total charges.
2. **SSE UTF-8 split test**: Build a mock HTTP SSE server that splits the Chinese character U+4E2D (UTF-8 bytes `E4 B8 AD`) across two TCP packets (`E4 B8` and `AD`) with a 100 ms gap. Use `parseSseStream` to verify correct decoding without any `\uFFFD` replacement characters.
3. **Interrupted-run reconciliation**: While `executeAgentStepWithWal` runs, call `abortController.abort()` after the tenth chunk. Inspect the `assistant/chunk` sequence in `MiniSessionLedger` and the final `assistant/message` `content` to confirm `interruptedBlocks` is preserved with correct causal markers.

---

## 9. Chapter Summary and Next Steps

This chapter examined DeepSeek Harness's prompt assembly, model abstraction, and streaming transport:

1. **System-prompt architecture**: Separating a stable prefix from a dynamic context suffix maximizes server-side KV Cache prefix reuse, lowering TTFT and compute cost.
2. **Two-phase calls**: `prepareCall` and immutable snapshots eliminate configuration drift across concurrent calls and hot reloads.
3. **Strict streaming parser**: The `eventsource-parser` state machine, `[DONE]` sentinel, and idle watchdog support robust parsing across packet boundaries and timeout detection.
4. **Core invariant**: Recording model-visible content provides recovery, deterministic snapshot replay, and causal consistency.

The next chapter, **Chapter 10: Tools and Side-Effect Control**, examines tool registries, exclusive barriers and restricted concurrency groups, Zod argument validation, sandbox interception, and spill handling for oversized output.
