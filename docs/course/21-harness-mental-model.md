# Chapter 21: A Mental Model of Harness

English | [中文](21-harness-mental-model.zh.md)

For engineers familiar with C, C++, Java, Go, Rust, Python, or TypeScript, a common obstacle when first working with LLMs and agents is treating AI as a mysterious black box or getting lost in abstract framework terminology.

This chapter replaces that black-box view with systems concepts. In DeepSeek Harness, behavior can be described through **deterministic state machines, probabilistic functions, inversion-of-control containers, event-sourced ledgers, POSIX system-call interception, and distributed fencing tokens**.

You will build a mental model of Harness's five architectural layers and learn a five-step method for diagnosing production failures.

---

## 21.1 Rebuilding Systems Intuition: From Black Box to State Machine

Before examining Harness source code, map basic AI-system concepts into systems-programming terms.

### 21.1.1 Core Concepts Mapped to Systems Programming

The table relates terms from agent frameworks to familiar software-engineering and distributed-systems concepts:

| AI / agent concept | Software-engineering / systems analogue | Runtime interpretation |
|---|---|---|
| **LLM** | **Probabilistic function** | Given a read-only input token sequence, computes the conditional distribution $P(y_t \mid X, y_{<t})$ over the next symbol without hidden mutable state. |
| **Token** | **int32 lexical unit / identifier** | An integer index in a vocabulary; a fixed-size numeric encoding rather than a continuous character stream. |
| **KV Cache** | **Memoization table** | Trades memory for time by caching attention Key/Value matrices for earlier tokens instead of recomputing them during autoregression. |
| **Prompt / System Prompt** | **Call-frame parameters and runtime stack context** | An immutable instruction set and initial data payload supplied to the function. |
| **Function Calling / Tool Use** | **AST parsing and controlled RPC dispatch** | The model emits a call declaration conforming to a JSON Schema; the Host parses it and dispatches a system call. |
| **Agent** | **Event-driven state-machine loop** | `while (hasWork) { read_inbox(); step(); }` drives asynchronous events through deterministic control flow. |
| **Harness** | **IoC container and microkernel runtime** | An inversion-of-control container for service discovery, dependency injection, lifecycle management, reversible effect registration, and plugin composition. |
| **Session Log** | **Append-only event log / write-ahead log** | The source of truth: system state is a projection obtained by folding this log over time. |
| **Fencing Token** | **Monotonic distributed lease** | An epoch counter that prevents late writes by stale workers or other Hosts from violating consistency. |
| **Subagent** | **Forked subprocess / lightweight fiber** | An execution unit with its own context scope, inherited constrained permissions, and a parent-supervised lifecycle. |

```
               +-------------------------------------------------------------+
               |                  DeepSeek Harness 运行时                    |
               +-------------------------------------------------------------+
                                              |
                     +------------------------+------------------------+
                     |                                                 |
                     v                                                 v
   +-----------------------------------+             +-----------------------------------+
   |     确定性宿主世界 (Host World)     |             |      概率型生成世界 (LLM World)     |
   +-----------------------------------+             +-----------------------------------+
   | 1. Cordis IoC 插件树容器           |             | 1. 自回归条件概率分布计算           |
   | 2. FIFO 消息队列与状态机循环        |   RPC 调用   | 2. 离散 Token int32 映射与反采样   |
   | 3. Append-only Event Sourcing 账本 | <---------> | 3. Transformer QKV 矩阵并行乘法   |
   | 4. POSIX 沙箱 / 工具权限拦截       |   JSON AST  | 4. KV Cache 显存记忆化加速        |
   | 5. Fencing Token 分布式一致性      |             | 5. 无副作用、无持久状态、只读计算 |
   +-----------------------------------+             +-----------------------------------+
```

### 21.1.2 Formalizing a Probabilistic Function and State Machine

Mathematically, an LLM predicts a distribution at each discrete time step. Let its vocabulary be $\mathcal{V}$ and current input sequence be $\mathbf{x} = (x_1, x_2, \dots, x_n)$, with $x_i \in \mathcal{V}$. Forward inference computes the next-token distribution vector $\mathbf{p}_{n+1} \in \mathbb{R}^{|\mathcal{V}|}$:

$$\mathbf{p}_{n+1} = \text{Softmax}\left( \frac{\mathbf{z}_{n+1}}{\tau} \right) = \mathcal{M}_{\theta}(\mathbf{x})$$

Here $\mathbf{z}_{n+1} \in \mathbb{R}^{|\mathcal{V}|}$ is the unnormalized logits vector and $\tau > 0$ is sampling temperature. The sampler $\mathcal{S}$ chooses a token from that distribution:

$$x_{n+1} \sim \mathcal{S}(\mathbf{p}_{n+1})$$

The agent system, or Harness, can instead be represented by a five-tuple state machine $\mathcal{A} = (Q, \Sigma, \delta, q_0, F)$:

1. **State set $Q$**: Derived session context $S_t$, pending tool-call queue, Inbox $\text{Inbox}$, and lifecycle state $\text{Status} \in \{\text{idle}, \text{running}\}$.
2. **Input alphabet $\Sigma$**: Human input $M_{\text{user}}$, externally injected context $M_{\text{inject}}$, tool results $R_{\text{tool}}$, and abort signals $\text{Signal}_{\text{abort}}$.
3. **Transition $\delta: Q \times \Sigma \to Q \times \Gamma$**: Maps a state and input event to the next state and external action $\Gamma$, such as a disk write, HTTP request, or subprocess call.
4. **Initial state $q_0$**: Initialized from a session seed or empty session snapshot.
5. **Final states $F$**: Reached only when the Inbox is empty, no tool calls remain outstanding, or a fatal exception or explicit cancellation occurs.

$$S_{t+1} = \delta(S_t, e_t) = \text{Fold}(S_t, e_t)$$

At time $t$, state $S_t$ is the fold of initial state $S_0$ and historical events $(e_1, e_2, \dots, e_t)$. This is the mathematical basis of Harness **event sourcing and deterministic replay**.

### 21.1.3 Harness's Purpose: Deterministic Engineering around Probabilistic Inference

An LLM's outputs are probabilistic and can be wrong; an engineered system needs deterministic control, observability, idempotency, and security constraints.

**Harness places a resilient, constrained execution system between a probabilistic model and the deterministic operating system.**

It addresses four tensions:
1. **Demand for unlimited context versus finite GPU memory and token budgets**: Sliding windows, positional-replacement compaction, and KV Cache prefixes impose deterministic limits.
2. **Autonomous black-box actions versus least privilege and sandboxing**: Service-seam interception, POSIX Landlock/Seatbelt, and path allowlists prevent escape.
3. **Long-running asynchronous work versus process crashes and power loss**: An append-only event ledger and recovery reconciliation preserve state.
4. **Concurrent agents versus data consistency**: Immutable graph revisions, monotonically increasing fencing tokens, and lease heartbeats prevent distributed races.

---

## 21.2 A Five-Layer Mental Model of Harness Architecture

DeepSeek Harness separates responsibilities across five layers with one-way dependencies:

```
+-----------------------------------------------------------------------------------+
|  Layer 5: Graph / LoopX 分布式协调层                                               |
|  - 不可变任务图 (DAG Revision) | 分布式租约 (Scheduler Lease) | Fencing Token 互斥 |
+-----------------------------------------------------------------------------------+
                                         | 调度与派发
+-----------------------------------------------------------------------------------+
|  Layer 4: Capability Provider 副作用层                                            |
|  - Service Seam 三元组 | POSIX 沙箱隔离 | 路径/网络拦截 | 超长输出 Spill 管理器    |
+-----------------------------------------------------------------------------------+
                                         | 受控系统调用
+-----------------------------------------------------------------------------------+
|  Layer 3: Session Log 事实账本                                                    |
|  - Append-only Event Sourcing | deriveMessages() 投影 | Zstd 压缩 | 不可变快照     |
+-----------------------------------------------------------------------------------+
                                         | 唯一事实源
+-----------------------------------------------------------------------------------+
|  Layer 2: Agent Loop 驱动引擎                                                     |
|  - Turn/Step 状态机 | FIFO Inbox 队列 | Waterfall 拦截链 | AbortSignal 协作取消    |
+-----------------------------------------------------------------------------------+
                                         | 运行于 Context 容器
+-----------------------------------------------------------------------------------+
|  Layer 1: Cordis 插件树                                                           |
|  - IoC 依赖注入容器 | ctx.effect() 析构树 | 四大事件分发原语 | Profile 组合叠加   |
+-----------------------------------------------------------------------------------+
```

The following sections examine each layer from the bottom up: its runtime meaning, mathematical model, data structures, and production-style code.

---

### 21.2.1 Layer 1: Cordis Plugin Tree—What the Runtime Loads

#### 1. Runtime Meaning and Systems Analogy
Spring Framework uses an ApplicationContext IoC container to manage bean lifecycles; OSGi provides dynamic module loading. In DeepSeek Harness, **Cordis is the runtime composition system and IoC container**.

Within Cordis:
- **Context**: Carries services and isolates scopes. Contexts form a tree from Root Context to Preset Context to Agent Scoped Context ($\to$).
- **Service**: A singleton implementation on `ctx.<serviceName>`, such as `ctx.sessions`, `ctx.tools`, or `ctx.llm`.
- **Inject**: A plugin declares its required services; Cordis activates it only after dependency order is satisfied.
- **Reversible effect**: Listeners, services, and routes registered by a plugin belong to the `ctx.effect()` disposal model. On unload or fiber disposal, effects are reversed in order to prevent leaks and dangling listeners.

```
                          +------------------------+
                          |   Root Context (Host)  |
                          |   ctx.llm, ctx.sessions|
                          +------------------------+
                                      |
                   +------------------+------------------+
                   |                                     |
                   v                                     v
     +---------------------------+         +---------------------------+
     | Preset Context: "default" |         |  Preset Context: "review" |
     | ctx.tools (标准工具集)    |         |  ctx.tools (只读安全工具) |
     +---------------------------+         +---------------------------+
                   |                                     |
                   v                                     v
     +---------------------------+         +---------------------------+
     | Agent-Scoped Context (A1) |         | Agent-Scoped Context (A2) |
     | 独立的提示词与沙箱环境    |         | 独立的提示词与沙箱环境    |
     +---------------------------+         +---------------------------+
```

#### 2. Four Cordis Event-Dispatch Primitives
Cordis offers four event-dispatch primitives with distinct control-flow semantics beyond the basic Node.js EventEmitter `on/emit` pattern:

| Primitive | Execution topology | Awaits asynchronously? | Return-value semantics | Typical use |
|---|---|---|---|---|
| `ctx.emit` | One-way asynchronous broadcast | No (fire-and-forget) | None | Live `agent/created` and `session/event` pushes |
| `ctx.waterfall` | Onion-style middleware chain | No (synchronous delegation) | Yes (final accumulated or rewritten value) | `agent/pre-step` decisions and `system-prompt/assemble` |
| `ctx.serial` | Sequential pipeline | Yes (awaits in registration order) | Yes (collects results) | `agent/turn-stopping` checkpoints and persistence |
| `ctx.parallel` | Concurrent fan-out observers | Yes (fan-out with `Promise.all`) | None | Concurrent cache refresh and telemetry |

The **`ctx.waterfall`** primitive is central to interception. Each listener receives `(payload, next)`:
- `next(modifiedPayload)` delegates the modified payload to downstream listeners and returns their final result.
- If a listener omits `next()` and instead executes `return customValue`, it **short-circuits** the chain and prevents downstream listeners from running.

```
Request ---> [ Listener 1 (Log) ]
                 | calls next()
                 v
             [ Listener 2 (Rewrite Prompt) ]
                 | calls next()
                 v
             [ Listener 3 (Policy Gate) ] ---> Short-circuit (Reject!)
                 | (next not called)
                 x (Listener 4 never reached)
```

#### 3. Configuration Overlays and Load-Time Validation
Harness composes the Cordis plugin tree from configuration overlays:

1. **Load the base bundle**: `dsh-base` declares core services such as the session log, default model gateway, and basic filesystem tools.
2. **Apply the profile**: The active profile adds a bundle such as `dsh-web-app` or `dsh-headless`.
3. **Apply patch files**: Load profile-level `cordis.patch.yml`, the user Home patch, and CLI `--patch` arguments in order.
4. **Locate and replace entries**: A patch selects a config entry by `id` and replaces its `config` or injects a new entry.
5. **Validate with Schemastery**: Before plugin activation, Schemastery parses configuration fields strictly. Invalid types or unknown keys fail at load time rather than silently degrading.

#### 4. Complete TypeScript Example: Cordis Container

The following production-style Cordis container implements type safety, dependency ordering, reversible disposal, and waterfall middleware semantics:

```typescript
// packages/core/cordis-mini/src/container.ts

export type Disposer = () => void | Promise<void>;

export interface Plugin<C extends Context = Context> {
  name: string;
  inject?: (keyof C)[];
  apply: (ctx: C) => Disposer | void | Promise<Disposer | void>;
}

export type WaterfallNext<R> = (overrideResult?: R) => Promise<R>;
export type WaterfallHandler<T, R, C extends Context> = (
  this: C,
  payload: T,
  next: WaterfallNext<R>
) => Promise<R>;

export class Context {
  private readonly services = new Map<string, any>();
  private readonly listeners = new Map<string, Array<{ handler: Function; ctx: Context }>>();
  private readonly disposers: Disposer[] = [];
  public readonly parent?: Context;

  constructor(parent?: Context) {
    this.parent = parent;
  }

  /**
   * 注册服务单例，支持依赖自动激活
   */
  public provide<K extends string, V>(name: K, service: V): void {
    if (this.services.has(name)) {
      throw new Error(`[Cordis] Service conflict: "${name}" already provided in current context.`);
    }
    this.services.set(name, service);
    (this as any)[name] = service;
  }

  /**
   * 解析服务（沿 Context 作用域链向上回溯）
   */
  public get<K extends string>(name: K): any {
    if (this.services.has(name)) {
      return this.services.get(name);
    }
    if (this.parent) {
      return this.parent.get(name);
    }
    return undefined;
  }

  /**
   * 注册可逆副作用（Effect）
   */
  public effect(action: () => Disposer | void): void {
    try {
      const cleanup = action();
      if (typeof cleanup === 'function') {
        this.disposers.push(cleanup);
      }
    } catch (err) {
      console.error('[Cordis] Failed to execute effect:', err);
      throw err;
    }
  }

  /**
   * 注册 Waterfall 环绕中间件
   */
  public onWaterfall<T, R>(event: string, handler: WaterfallHandler<T, R, this>): Disposer {
    let list = this.listeners.get(event);
    if (!list) {
      list = [];
      this.listeners.set(event, list);
    }
    const entry = { handler: handler as Function, ctx: this };
    list.push(entry);

    const disposer = () => {
      const idx = list!.indexOf(entry);
      if (idx !== -1) list!.splice(idx, 1);
    };
    this.disposers.push(disposer);
    return disposer;
  }

  /**
   * 触发 Waterfall 级联调用链
   */
  public async waterfall<T, R>(event: string, initialPayload: T, fallbackResult: R): Promise<R> {
    const list: Array<{ handler: Function; ctx: Context }> = [];
    let curr: Context | undefined = this;
    while (curr) {
      const registered = curr.listeners.get(event);
      if (registered) list.push(...registered);
      curr = curr.parent;
    }

    let index = 0;
    const dispatch = async (currentIndex: number, currentResult: R): Promise<R> => {
      if (currentIndex >= list.length) {
        return currentResult;
      }
      const { handler, ctx } = list[currentIndex];
      let nextCalled = false;

      const next: WaterfallNext<R> = async (overrideResult?: R) => {
        nextCalled = true;
        const resultToPass = overrideResult !== undefined ? overrideResult : currentResult;
        return dispatch(currentIndex + 1, resultToPass);
      };

      try {
        const res = await handler.call(ctx, initialPayload, next);
        // 如果监听器没有显式调用 next()，则视为短路，直接返回 res
        return res !== undefined ? res : currentResult;
      } catch (error) {
        console.error(`[Cordis] Error in waterfall listener for event "${event}":`, error);
        throw error;
      }
    };

    return dispatch(0, fallbackResult);
  }

  /**
   * 级联卸载所有插件与副作用
   */
  public async dispose(): Promise<void> {
    while (this.disposers.length > 0) {
      const disposer = this.disposers.pop()!;
      try {
        await disposer();
      } catch (err) {
        console.error('[Cordis] Error during dispose teardown:', err);
      }
    }
    this.services.clear();
    this.listeners.clear();
  }
}
```

---

### 21.2.2 Layer 2: Agent Loop—How a Request Advances

#### 1. Turn and Step Semantics in the State-Machine Loop
Conventional web requests tend to follow one request and one response. A single agent request can instead launch several reasoning and tool-use cycles. Harness defines two lifecycle levels: a **Turn** and its **Steps**.

- **Step**: One model request and the execution closure of all tools it calls. One Step comprises one streaming LLM API call and $N$ concurrent or exclusive tool executions.
- **Turn**: A contiguous transaction interval of one or more Steps. It starts with the first pending input (`turn/start`) and ends when the model stops calling tools and the Inbox contains no pending follow-up (`turn/end`).

```
+----------------------------------------------------------------------------------------------------+
| Turn N (轮次事务边界)                                                                              |
|                                                                                                    |
|  [turn/start] -> 领取 Inbox 消息                                                                   |
|       |                                                                                            |
|       v                                                                                            |
|  +----------------------------------------------------------------------------------------------+  |
|  | Step 1 (步骤执行)                                                                            |  |
|  |  [step/start] -> [system-prompt/assemble] -> [llm/stream] -> Assistant 输出 (包含 ToolCalls) |  |
|  |  -> 并发执行 Tool 1 & Tool 2 -> [step/end]                                                   |  |
|  +----------------------------------------------------------------------------------------------+  |
|       | 模型返回了 ToolCall，需要驱动下一步                                                        |
|       v                                                                                            |
|  +----------------------------------------------------------------------------------------------+  |
|  | Step 2 (步骤执行)                                                                            |  |
|  |  [step/start] -> 携带 Step 1 的 ToolResults -> [llm/stream] -> Assistant 纯文本最终回答      |  |
|  |  -> 无工具调用 -> [step/end]                                                                 |  |
|  +----------------------------------------------------------------------------------------------+  |
|       |                                                                                            |
|       v                                                                                            |
|  [agent/turn-stopping] 停机检查点 -> [turn/end] { reason: 'completed' }                           |
+----------------------------------------------------------------------------------------------------+
```

#### 2. One Inbox and Its Scheduling Semantics
All external inputs—human followups, runtime steering, system timers, and child-agent completion notifications—enter a single **`Inbox`** with two ordered partitions:

1. **`next-turn` queue**: Holds regular `followup` messages. Once the previous Turn has fully ended and the agent is `idle`, the driver takes only the first message to start a new Turn.
2. **`next-step` queue**: Holds higher-priority `inject` inputs and mid-Turn `steer` instructions. At a Step boundary, the driver claims every `next-step` item and merges them as `user/message` into the next Step without interrupting the current Turn.

#### 3. Cooperative Cancellation with AbortSignal and Quiescence
Force-killing threads or processes can leave locks and resources behind. Harness instead uses native Web API **cooperative cancellation**:

- Every active Turn and Step receives a strictly inherited `AbortSignal`.
- Immutable `AgentCancelCause` values identify why: `user` (user clicked Stop), `parent` (parent task ended), `hook` (safety-policy interception), or `disposed` (Host unload).
- **Dispose must reach quiescence**: `agent.cancel()` does more than signal abort. It also awaits `whenIdle()` until subprocesses, network sockets, and file handles have closed, preventing orphan work from writing in the background.

#### 4. Complete TypeScript Example: State-Machine Driver

```typescript
// packages/core/agent-loop/src/agent.ts

import { Context } from '../../cordis-mini/src/container.js';

export interface UserMessage {
  id: string;
  role: 'user';
  content: string;
  source: 'human' | 'injected' | 'steering';
}

export interface ToolCall {
  callId: string;
  name: string;
  arguments: string;
}

export interface ToolResult {
  callId: string;
  content: string;
  isError?: boolean;
}

export type AgentCancelCause =
  | { readonly kind: 'user' }
  | { readonly kind: 'parent' }
  | { readonly kind: 'hook'; readonly reason: string }
  | { readonly kind: 'disposed' };

export class AgentDriver {
  private status: 'idle' | 'running' = 'idle';
  private readonly nextTurnInbox: UserMessage[] = [];
  private readonly nextStepInbox: UserMessage[] = [];
  private currentAbortController?: AbortController;
  private idleResolvers: Array<() => void> = [];

  constructor(
    private readonly ctx: Context,
    private readonly sessionId: string
  ) {}

  public followup(msg: UserMessage): void {
    this.nextTurnInbox.push(msg);
    this.wake();
  }

  public steer(msg: UserMessage): void {
    this.nextStepInbox.push(msg);
    this.wake();
  }

  public cancel(cause: AgentCancelCause): void {
    if (this.currentAbortController && !this.currentAbortController.signal.aborted) {
      this.currentAbortController.abort(cause);
    }
  }

  public async whenIdle(): Promise<void> {
    if (this.status === 'idle') return;
    return new Promise<void>((resolve) => {
      this.idleResolvers.push(resolve);
    });
  }

  private wake(): void {
    if (this.status === 'running') return;
    this.runLoop().catch((err) => {
      console.error(`[AgentDriver:${this.sessionId}] Unhandled loop crash:`, err);
    });
  }

  private async runLoop(): Promise<void> {
    this.status = 'running';
    try {
      while (this.nextTurnInbox.length > 0) {
        const turnMessage = this.nextTurnInbox.shift()!;
        await this.executeTurn(turnMessage);
      }
    } finally {
      this.status = 'idle';
      const resolvers = this.idleResolvers;
      this.idleResolvers = [];
      for (const resolve of resolvers) {
        resolve();
      }
    }
  }

  private async executeTurn(initialMessage: UserMessage): Promise<void> {
    this.currentAbortController = new AbortController();
    const signal = this.currentAbortController.signal;

    let stepIndex = 1;
    let pendingInputMessages: UserMessage[] = [initialMessage];
    let owesAnotherStep = true;

    // 触发持久化 turn/start
    console.log(`[Turn] START for session ${this.sessionId}`);

    try {
      while (owesAnotherStep) {
        if (signal.aborted) {
          throw new Error(`Turn aborted: ${(signal.reason as any)?.kind || 'unknown'}`);
        }

        // 1. 认领 next-step 队列中的注入消息
        if (this.nextStepInbox.length > 0) {
          pendingInputMessages.push(...this.nextStepInbox.splice(0, this.nextStepInbox.length));
        }

        // 2. 触发 agent/pre-step Waterfall 拦截器
        const decision = await this.ctx.waterfall<
          { turn: number; step: number; messages: UserMessage[] },
          { action: 'enter' | 'reject'; messages: UserMessage[] }
        >('agent/pre-step', { turn: 1, step: stepIndex, messages: pendingInputMessages }, {
          action: 'enter',
          messages: pendingInputMessages,
        });

        if (decision.action === 'reject') {
          console.warn(`[Step ${stepIndex}] Rejected by policy gate.`);
          break;
        }

        // 3. 执行 Step (LLM 调用 + 工具派发)
        const stepResult = await this.executeStep(stepIndex, decision.messages, signal);
        pendingInputMessages = []; // 清空已消耗的消息

        if (stepResult.toolCalls.length > 0) {
          // 4. 并发执行受控工具
          const toolResults = await this.dispatchTools(stepResult.toolCalls, signal);
          // 将工具执行结果构造成合成消息，准备进入下一步
          owesAnotherStep = true;
          stepIndex++;
        } else {
          // 模型输出了纯文本，无工具调用，步进结束
          owesAnotherStep = false;
        }
      }

      // 触发 agent/turn-stopping 停机检查点
      await this.ctx.waterfall('agent/turn-stopping', { turn: 1 }, { allowStop: true });
    } catch (err: any) {
      console.error(`[Turn] Error during execution:`, err.message);
    } finally {
      console.log(`[Turn] END for session ${this.sessionId}`);
      this.currentAbortController = undefined;
    }
  }

  private async executeStep(
    stepIndex: number,
    messages: UserMessage[],
    signal: AbortSignal
  ): Promise<{ text: string; toolCalls: ToolCall[] }> {
    if (signal.aborted) throw new Error('Aborted before model dispatch');
    // 模拟 LLM 适配器流式调用
    return { text: 'Thought complete.', toolCalls: [] };
  }

  private async dispatchTools(toolCalls: ToolCall[], signal: AbortSignal): Promise<ToolResult[]> {
    return Promise.all(
      toolCalls.map(async (call) => {
        if (signal.aborted) throw new Error('Tool call aborted');
        return { callId: call.callId, content: 'Execution output' };
      })
    );
  }
}
```

---

### 21.2.3 Layer 3: Session Log—What Can Be Replayed and Recovered

#### 1. The Model-Visible-Is-Recorded Invariant
Many simple AI frameworks keep context history in volatile objects or loosely structured JSON. A process crash or power loss can then leave state inconsistent and unreproducible.

DeepSeek Harness sets a strict invariant:

$$\forall m \in \text{ModelContext}, \quad m = \mathcal{P}(\text{SessionLog})$$

**Everything visible to the model is recorded.** Data that reaches model context—including system prompts, user requests, tool outputs, steering, and file excerpts—must first enter the append-only log as a typed `SessionEvent`, then be derived by the pure projection function $\mathcal{P}$.

```
+---------------------------------------------------------------------------------------------------+
| 会话不可变事实账本 (Append-only Session Log)                                                       |
|                                                                                                   |
|  [seq:0, type:'turn/start']                                                                       |
|  [seq:1, type:'user/message', data: { role:'user', content:'修复 bug' }, surfaceOp:'append']    |
|  [seq:2, type:'step/start', data: { turn:1, step:1 }]                                             |
|  [seq:3, type:'assistant/chunk', data: { chunk: '正在' }]  <-- 原始流式分片 (用于 UI 高保真回放)  |
|  [seq:4, type:'assistant/chunk', data: { chunk: '分析' }]                                         |
|  [seq:5, type:'assistant/message', data: { content:'...', tool_calls:[...] }, surfaceOp:'append'] |
|  [seq:6, type:'tool/call', data: { callId:'c1', name:'fs_read', arguments:'{"path":"a.ts"}' }]   |
|  [seq:7, type:'tool/result', data: { callId:'c1', message:{ ... } }, surfaceOp:'append']          |
|  [seq:8, type:'step/end', data: { turn:1, step:1 }]                                               |
|  [seq:9, type:'turn/end', data: { turn:1, reason:{ kind:'completed' } }]                         |
+---------------------------------------------------------------------------------------------------+
                                         |
                                         | 纯函数投影折叠: deriveMessages(log)
                                         v
+---------------------------------------------------------------------------------------------------+
| 派生出的 LLM 真实历史 (LLM Context Messages Array)                                                |
|                                                                                                   |
|  1. { role: 'user', content: '修复 bug' }                                                         |
|  2. { role: 'assistant', content: '...', tool_calls: [{ name: 'fs_read', ... }] }                 |
|  3. { role: 'tool', tool_call_id: 'c1', content: '...' }                                          |
+---------------------------------------------------------------------------------------------------+
```

#### 2. Surface and Positional-Replacement Compaction
The session log contains messages for model context and structural markers such as `turn/start`, `step/end`, streaming chunks, and heartbeat events. Harness defines a **`Surface`** projection to select messages from that event stream:

- **`SurfaceEventType`**: Only events that produce actual LLM messages enter the surface: `user/message`, `assistant/message`, and `tool/result`.
- **`SurfaceOp` operations**:
  - `'append'`: Appends a regular message at the end of the context.
  - `{ op: 'replace', start: number, end: number }`: **Positional-replacement compaction**. A context-compaction plugin shadows surface events from `start` through `end` and substitutes the current summary at their position in the logical projection without changing the physical history.

```
物理日志序列 (Seq):
0(user) ---> 1(assistant) ---> 2(tool) ---> 3(assistant) ---> 4(compaction/summary: replace 0..3)

逻辑 Surface 投影视图 (模型所见):
[ 4(compaction/summary 综合摘要) ] ---> (后续新追加的 5, 6, 7...)
```

#### 3. Zstandard Frames, Sequence Continuity, and SessionHeader Layout
Harness applies strict rules to durable storage:

1. **`SessionHeader` first**: An immutable JSON metadata header records the format version (`formatVersion: 1`), creation timestamp, associated absolute workspace path (`cwd`), parent-session lineage (`parentSession`), and seed boundary (`seedLength`).
2. **Strictly increasing sequence numbers**: Every event satisfies $\text{seq} = \text{log.length}$, leaving no gaps.
3. **Zstandard (Zstd) frame compression**: `.session.jsonl.zstd` files contain compressed frames with complete JSONL lines, preserving a one-to-one mapping with in-memory events.
4. **`session/end-seed` boundary**: On a fork or restore, a special empty-payload `session/end-seed` event follows the seed events and separates inherited history from writes by the current process.

#### 4. Complete TypeScript Example: Event Sourcing and Projection

```typescript
// packages/core/session/src/index.ts

export type SessionEventType =
  | 'turn/start'
  | 'turn/end'
  | 'step/start'
  | 'step/end'
  | 'user/message'
  | 'assistant/chunk'
  | 'assistant/message'
  | 'tool/call'
  | 'tool/result'
  | 'session/end-seed';

export type SurfaceOp =
  | 'append'
  | { op: 'replace'; start: number; end: number };

export interface BaseSessionEvent<T extends SessionEventType, D> {
  seq: number;
  time: number;
  type: T;
  data: D;
  surfaceOp?: SurfaceOp;
  sourceEventSeqs?: number[];
}

export type SessionEvent =
  | BaseSessionEvent<'turn/start', { turn: number }>
  | BaseSessionEvent<'turn/end', { turn: number; reason: { kind: string } }>
  | BaseSessionEvent<'step/start', { turn: number; step: number }>
  | BaseSessionEvent<'step/end', { turn: number; step: number }>
  | BaseSessionEvent<'user/message', { role: 'user'; content: string }>
  | BaseSessionEvent<'assistant/chunk', { text: string }>
  | BaseSessionEvent<'assistant/message', { role: 'assistant'; content: string; toolCalls?: any[] }>
  | BaseSessionEvent<'tool/call', { callId: string; name: string; arguments: string }>
  | BaseSessionEvent<'tool/result', { callId: string; content: string }>
  | BaseSessionEvent<'session/end-seed', Record<string, never>>;

export interface ModelMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: any[];
  toolCallId?: string;
}

export class Session {
  private readonly _events: SessionEvent[] = [];
  private surfaceNodes: number[] = []; // 存储 Surface 上的事件 seq
  private cachedDerivedMessages?: ModelMessage[];
  private replaceGeneration = 0;

  constructor(public readonly id: string, seedEvents: SessionEvent[] = []) {
    for (const ev of seedEvents) {
      this.appendInternal(ev, false);
    }
  }

  public get events(): readonly SessionEvent[] {
    return this._events;
  }

  public get seq(): number {
    return this._events.length;
  }

  public append<T extends SessionEventType>(
    type: T,
    data: any,
    surfaceOp?: SurfaceOp,
    sourceEventSeqs?: number[]
  ): SessionEvent {
    const event: SessionEvent = {
      seq: this._events.length,
      time: Date.now(),
      type: type as any,
      data: Object.freeze(JSON.parse(JSON.stringify(data))), // 确保 JSON 可序列化且深度冻结
      surfaceOp,
      sourceEventSeqs,
    } as SessionEvent;

    this.appendInternal(event, true);
    return event;
  }

  private appendInternal(event: SessionEvent, invalidateCache: boolean): void {
    this._events.push(event);

    if (event.surfaceOp) {
      if (event.surfaceOp === 'append') {
        this.surfaceNodes.push(event.seq);
      } else if (event.surfaceOp.op === 'replace') {
        const { start, end } = event.surfaceOp;
        // 过滤掉被遮蔽的序号区间 [start, end]
        this.surfaceNodes = this.surfaceNodes.filter((s) => s < start || s > end);
        this.surfaceNodes.push(event.seq);
        this.replaceGeneration++;
      }
      if (invalidateCache) {
        this.cachedDerivedMessages = undefined;
      }
    }
  }

  /**
   * 纯函数增量投影：根据 Surface 节点序列重建模型可见历史
   */
  public deriveMessages(): ModelMessage[] {
    if (this.cachedDerivedMessages) {
      return this.cachedDerivedMessages;
    }

    const messages: ModelMessage[] = [];
    for (const seq of this.surfaceNodes) {
      const ev = this._events[seq];
      if (!ev) continue;

      if (ev.type === 'user/message') {
        messages.push({ role: 'user', content: ev.data.content });
      } else if (ev.type === 'assistant/message') {
        if (ev.data.content || (ev.data.toolCalls && ev.data.toolCalls.length > 0)) {
          messages.push({
            role: 'assistant',
            content: ev.data.content,
            toolCalls: ev.data.toolCalls,
          });
        }
      } else if (ev.type === 'tool/result') {
        messages.push({
          role: 'tool',
          toolCallId: ev.data.callId,
          content: ev.data.content,
        });
      }
    }

    this.cachedDerivedMessages = Object.freeze(messages) as ModelMessage[];
    return this.cachedDerivedMessages;
  }
}
```

---

### 21.2.4 Layer 4: Capability Providers—Controlled File, Command, and Network Effects

#### 1. The Three Roles of a Service Seam
Hard-coding filesystem writes or shell commands into business logic is dangerous. Harness separates a replaceable capability into three explicit roles through a **Service seam**:

```
+-----------------------------------------------------------------------------------+
| 1. Service Definition (接口定义契约包)                                            |
|    - packages/core/fs-interface: 定义 FileSystem 抽象接口与策略错误码             |
+-----------------------------------------------------------------------------------+
                                         ^
                                         | 实现接口
+-----------------------------------------------------------------------------------+
| 2. Service Provider (具体能力提供方实现包)                                         |
|    - packages/fs/fs-local: 基于 Node.js 本地文件系统实现                    |
|    - packages/fs/fs-sandbox: 基于 Linux Landlock / Docker 远程沙箱实现      |
+-----------------------------------------------------------------------------------+
                                         ^
                                         | 消费注入 (ctx.fs)
+-----------------------------------------------------------------------------------+
| 3. Consumer / Tools (面向大模型的工具消费包)                                      |
|    - packages/fs/tool-fs: 向模型暴露 read_file / write_file 工具 DSL          |
+-----------------------------------------------------------------------------------+
```

#### 2. Side-Effect Categories and Concurrency
Tool calls require scheduling according to their effects, not indiscriminate asynchronous fan-out. Harness groups them into three categories:

| Effect category | Operation | Idempotency | Scheduling barrier | Example tools |
|---|---|---|---|---|
| **Read-only query** | No disk or network write | Naturally idempotent | **Bounded or unbounded rolling pool**; execute concurrently | `read_file`, `grep_search`, `list_dir` |
| **State-idempotent write** | Overwrites a deterministic path | Repeated execution has the same result | **Exclusive write barrier**; drain the pool, then execute alone | `write_to_file`, `replace_file_content` |
| **Non-idempotent external action** | Shell command, database migration, Git commit | May cause irreversible effects | **Strict exclusive barrier and human approval checkpoint** | `run_command`, `deploy_service` |

```
Step 开始
  |
  +---> [read_file(a.ts)]  ---\
  +---> [read_file(b.ts)]  -----> 并发滚动池并行执行 (Bounded Pool: max 4)
  +---> [grep_search(foo)] ---/
  |
  +========================== 排他屏障 (Exclusive Barrier: 等待只读任务全部收敛)
  |
  +---> [write_to_file(c.ts)] --> 串行独占执行 (Single Slot)
  |
  +========================== 排他屏障
  |
  +---> [run_command(npm test)] -> 检查点策略校验 -> 独占执行
```

#### 3. Defense in Depth: Sandbox, Credential Scrubbing, and Spill
Layer 4 applies three defenses when executing model-generated commands and arguments:

1. **Path-traversal defense**: Normalize every input path with `path.resolve` and require it to remain under the `cwd` workspace root, preventing access to `/etc`, `C:\Windows`, or sensitive parent directories.
2. **Credential scrubbing**: Before injecting environment variables into subprocesses, filter keys matching `*KEY*`, `*SECRET*`, `*TOKEN*`, or `*PASSWORD*` so prompt injection cannot exfiltrate API secrets.
3. **Oversized-output spill**: A command such as `cat large_file.log` or a compiler can produce hundreds of megabytes. Instead of putting that output into context and risking OOM, the spill manager writes full output above a threshold such as 32 KB to a private temporary file with `0700` permissions and leaves only a prefix/suffix summary and read-back path in context.

#### 4. Complete TypeScript Example: Controlled Tool Pipeline

```typescript
// packages/core/tools/src/index.ts

import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as crypto from 'node:crypto';

export interface ToolDefinition {
  name: string;
  mode: 'readonly' | 'idempotent-write' | 'non-idempotent-mutating';
  execute: (args: any, signal: AbortSignal) => Promise<string>;
}

export class SpillManager {
  constructor(private readonly spillDir: string) {}

  public async manageOutput(rawOutput: string, maxInlineChars = 32768): Promise<string> {
    if (rawOutput.length <= maxInlineChars) {
      return rawOutput;
    }

    await fs.mkdir(this.spillDir, { recursive: true, mode: 0o700 });
    const filename = `spill-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.txt`;
    const filePath = path.join(this.spillDir, filename);

    await fs.writeFile(filePath, rawOutput, { mode: 0o600, flag: 'wx' });

    const head = rawOutput.slice(0, 2048);
    const tail = rawOutput.slice(-2048);
    return `${head}\n\n... [TRUNCATED: Output exceeded inline limit (${rawOutput.length} chars). Full output spilled to: ${filePath}] ...\n\n${tail}`;
  }
}

export class ToolExecutionPipeline {
  private readonly tools = new Map<string, ToolDefinition>();
  private readonly spillManager = new SpillManager('/tmp/dsh-spill');

  public register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  public async executePipeline(
    calls: Array<{ callId: string; name: string; args: any }>,
    signal: AbortSignal
  ): Promise<Array<{ callId: string; result: string; isError?: boolean }>> {
    const results: Array<{ callId: string; result: string; isError?: boolean }> = [];

    // 1. 根据 executionMode 对工具调用进行分类编排
    const readonlyCalls: typeof calls = [];
    const mutatingCalls: typeof calls = [];

    for (const call of calls) {
      const def = this.tools.get(call.name);
      if (!def) {
        results.push({ callId: call.callId, result: `Tool "${call.name}" not found.`, isError: true });
        continue;
      }
      if (def.mode === 'readonly') {
        readonlyCalls.push(call);
      } else {
        mutatingCalls.push(call);
      }
    }

    // 2. 并发滚动池执行只读工具
    if (readonlyCalls.length > 0) {
      const readonlyResults = await Promise.all(
        readonlyCalls.map(async (call) => {
          return this.runSingleTool(call, signal);
        })
      );
      results.push(...readonlyResults);
    }

    // 3. 排他屏障：串行执行写入与破坏性工具
    for (const call of mutatingCalls) {
      if (signal.aborted) {
        results.push({ callId: call.callId, result: 'Execution aborted by user/signal.', isError: true });
        continue;
      }
      const mutResult = await this.runSingleTool(call, signal);
      results.push(mutResult);
    }

    return results;
  }

  private async runSingleTool(
    call: { callId: string; name: string; args: any },
    signal: AbortSignal
  ): Promise<{ callId: string; result: string; isError?: boolean }> {
    const def = this.tools.get(call.name)!;
    try {
      if (signal.aborted) throw new Error('Aborted');
      const rawRes = await def.execute(call.args, signal);
      const formattedRes = await this.spillManager.manageOutput(rawRes);
      return { callId: call.callId, result: formattedRes };
    } catch (err: any) {
      return { callId: call.callId, result: `Execution error: ${err.message}`, isError: true };
    }
  }
}
```

---

### 21.2.5 Layer 5: Graph / LoopX—Long-Running Task Coordination

#### 1. Multi-Agent DAGs and Immutable Revision Lineage
A single agent can exhaust its context on a multi-hour task involving several modules. Harness provides **Graph Mode** to coordinate a task graph:

- **Directed acyclic graph $\mathcal{G} = (\mathcal{V}, \mathcal{E})$**: Vertices $\mathcal{V}$ are tasks such as analysis, refactoring, tests, and documentation; edges $\mathcal{E}$ are dependencies.
- **Immutable revisions**: Submitting a graph with `graph_submit` freezes it as `Revision 1`. If the controller discovers a changed requirement, it creates `Revision 2` rather than editing the earlier graph in place.
- **Transitive successor invalidation**: When node $N_k$ changes, a topological traversal finds its dependent successor closure $\text{Closure}(N_k)$, invalidates those nodes, and reschedules them. Successful nodes outside that closure reuse their artifacts.

```
Revision 1:
[ 节点 A: 接口设计 (Success) ] ---> [ 节点 B: 模块实现 (Failed) ] ---> [ 节点 C: 集成测试 (Pending) ]

需求调整后产生 Revision 2 (仅使 B 和 C 失效重跑，A 的产物被安全复用):
[ 节点 A (Reused from Rev 1) ] ---> [ 节点 B' (New Ready) ] ---> [ 节点 C' (Pending) ]
```

#### 2. Proof of Monotonic Fencing Tokens
When Graph nodes run across Hosts or worker pools, a severe failure is a **split-brain write**: Host A stalls, its lease expires, Host B takes over, and Host A later resumes and writes stale data.

Harness uses **monotonically increasing fencing tokens** to prevent this sequence.

##### Theorem: Exclusive Ordering with Fencing Tokens
Let a shared resource store be $\mathcal{R}$ with last accepted version $\nu_{\mathcal{R}} \in \mathbb{N}$. Two workers $W_1$ and $W_2$ receive tokens $T_1, T_2 \in \mathbb{N}$ from a coordinator. Tokens increase strictly with grant time: $t_1 < t_2 \implies T_1 < T_2$. The store defines writes as atomic compare-and-swap transitions:

$$\text{Write}(\mathcal{R}, T_{\text{worker}}, \text{Data}) = \begin{cases} \text{Commit}(\text{Data}) \text{ and } \nu_{\mathcal{R}} \leftarrow T_{\text{worker}}, & \text{if } T_{\text{worker}} > \nu_{\mathcal{R}} \\ \text{Reject}(\text{StaleFencingToken}), & \text{if } T_{\text{worker}} \le \nu_{\mathcal{R}} \end{cases}$$

##### Worked Derivation
1. **Time $t_1$**: Host A claims a task node and obtains lease token $T_1 = 100$. The store has $\nu_{\mathcal{R}} = 0$.
2. **Time $t_2$**: Host A starts expensive work but pauses for 30 seconds during stop-the-world GC or a network partition.
3. **Time $t_3$**: The coordinator detects its missed heartbeat, expires the lease, and reassigns the task to Host B with token $T_2 = 101$.
4. **Time $t_4$**: Host B finishes and submits $\text{Write}(\mathcal{R}, T_2=101, \text{ResultB})$. Since $101 > 0$, the write succeeds and the store atomically sets $\nu_{\mathcal{R}} = 101$.
5. **Time $t_5$**: Host A resumes, believes it still holds the lease, and submits stale $\text{Write}(\mathcal{R}, T_1=100, \text{ResultA})$.
6. **Time $t_6$**: The store observes $T_{\text{worker}} (100) \le \nu_{\mathcal{R}} (101)$ and **throws `StaleFencingTokenError`**. Host A's late write cannot change the accepted state.

```
Host A (Worker 1)          Scheduler (Coordination)         Shared Storage (Authority)
      |                               |                                    |
      |-- (1) Claim (Epoch=100) ---->|                                    |
      |                               |-- (2) Grant Token 100 ------------>| (v=100)
      | [ GC Pause / Network Lag... ] |                                    |
      |                               |-- (3) Lease Expired --------------->|
      |                               |                                    |
      |                      Host B (Worker 2)                             |
      |                               |-- (4) Claim (Epoch=101) ---------->|
      |                               |-- (5) Grant Token 101 ------------>| (v=101)
      |                               |-- (6) Commit Result -------------->| [ACCEPTED]
      |                                                                    |
      |-- (7) Stale Commit (Token=100) ----------------------------------->|
                                                                           | [REJECTED! 100 <= 101]
```

#### 3. Harness Execution Plane and LoopX Control Plane
When integrating an external multi-agent coordinator such as LoopX, the two planes have distinct responsibilities:

- **Harness execution plane**: Owns model streams, tools, POSIX sandboxing, child sessions, and the complete raw transcript. Harness session events are authoritative for model-execution facts.
- **LoopX control plane**: Owns global goal planning, shared Todo lists, peer-role claims, and public progress.
- **Communication rule**: The planes exchange only bounded **public-safe summaries** (at most 2,000 characters) with private paths and credentials removed. Raw transcripts must not be exported to the control plane.

#### 4. Complete TypeScript Example: Fenced Storage and Reconciliation

```typescript
// packages/graph/graph-scheduler/src/index.ts

export interface FencedWriteRequest<T> {
  workId: string;
  fencingToken: number; // 单调递增的纪元编号 (Epoch)
  payload: T;
}

export class FencedArtifactStore {
  private readonly versionRegistry = new Map<string, number>();

  /**
   * 带有原子 CAS 约束的受保护写入
   */
  public async commitArtifact<T>(request: FencedWriteRequest<T>): Promise<void> {
    const { workId, fencingToken, payload } = request;
    const currentCommittedEpoch = this.versionRegistry.get(workId) ?? 0;

    // 核心 Fencing 校验：拒绝一切小于等于当前已提交版本的请求
    if (fencingToken <= currentCommittedEpoch) {
      const errMsg = `[FencedArtifactStore] Split-Brain write rejected for work "${workId}". ` +
                     `Incoming token: ${fencingToken}, but active epoch is already: ${currentCommittedEpoch}`;
      console.error(errMsg);
      throw new Error(errMsg);
    }

    // 原子提升纪元版本并持久化
    this.versionRegistry.set(workId, fencingToken);
    await this.persistToDisk(workId, payload);
    console.log(`[FencedArtifactStore] Work "${workId}" committed successfully with token ${fencingToken}.`);
  }

  private async persistToDisk(workId: string, data: any): Promise<void> {
    // 模拟磁盘或 S3 写入
  }
}
```

---

## 21.3 A Standard Five-Step Diagnosis Method

When an agent appears stuck, a tool does not run, state changes after restart, or output looks wrong, avoid changing code or adding `console.log` calls before tracing the system.

Harness uses a five-step diagnosis path—**Configuration $\to$ Service $\to$ Event $\to$ Log $\to$ Cancellation**—following the causal order of startup and execution:

```
[ Step 1: 配置排查 ] ---> YAML Overlay Patch 是否生效？Profile 是否正确装配？
         |
         v
[ Step 2: 服务排查 ] ---> Cordis IoC 容器中 ctx.<service> 是否就绪？依赖是否死锁？
         |
         v
[ Step 3: 事件排查 ] ---> Waterfall 中间件是否漏调 next()？事件域与分发模式是否匹配？
         |
         v
[ Step 4: 日志排查 ] ---> SessionEvent 的 seq 是否连续？deriveMessages() 是否能正常投影？
         |
         v
[ Step 5: 取消排查 ] ---> AbortSignal 是否正确传递？Dispose 是否达到 Quiescence？
```

### 21.3.1 Step One: Configuration
- **Objective**: Confirm that the loaded plugin tree and parameters match expectations.
- **Main tool**: Run `dsh --profile <profile-name> --dump-config` to print the fully merged Cordis configuration.
- **Checks**:
  1. Overlay order: Base Bundle $\to$ Profile Patch $\to$ User Home Patch $\to$ CLI `--patch`. Verify that a higher-priority patch has not replaced the target entry.
  2. Loader expressions: Check whether missing environment variables made a `!!js` expression evaluate to `disabled: true`.
  3. Schemastery validation: Check whether invalid types or undeclared fields were rejected at startup.

### 21.3.2 Step Two: Services
- **Objective**: Confirm that each Service seam binds a valid Provider.
- **Main tool**: At a debug entry point, inspect `ctx.get('tools')`, `ctx.get('llm')`, and `ctx.get('sessions')`.
- **Checks**:
  1. Circular dependencies: Plugin A declares `inject: ['b']` and plugin B declares `inject: ['a']`, so neither activates.
  2. Scope isolation: Check whether a preset service was placed in an `isolate` realm that the global Host context cannot reach.
  3. Premature disposal: Check whether a parent fiber disposed a Provider before its consumers finished.

### 21.3.3 Step Three: Events
- **Objective**: Confirm that control-flow interception proceeds without unintended short circuits or blocking.
- **Main tool**: Enable Cordis event tracing with `DEBUG=cordis:events*`.
- **Checks**:
  1. **Missing `next()` in a waterfall listener**: A frequent cause of a stuck agent. Inspect each `ctx.onWaterfall` listener and ensure non-rejection branches call `await next()`.
  2. Wrong dispatch mode: An asynchronous persistence operation that should use `serial` but is dispatched with `emit` can let the process exit before data is written.
  3. Wrong event scope: Check that durable session events (`session/event`), live agent events (`agent/*`), and capability-seam events (`tools/*`) are listened for in the proper scope.

### 21.3.4 Step Four: Log and Replay
- **Objective**: Confirm that the physical session ledger is complete and can be projected.
- **Main tool**: Inspect a `.jsonl.zstd` or SQLite session file and replay with `Session.fromRestore()`.
- **Checks**:
  1. **Sequence continuity**: Require $e_{k+1}.\text{seq} = e_k.\text{seq} + 1$ with no gaps or duplicates.
  2. Unserializable data: Check whether a plugin put `BigInt`, `Function`, `Circular Object`, or a class instance in `event.data`.
  3. Projection assertion with `deriveMessages`: Test that messages projected from the log exactly match the payload delivered to the model.

### 21.3.5 Step Five: Cancellation and Teardown
- **Objective**: Confirm that abort and exit paths complete safely.
- **Main tools**: Process monitoring (`ps -ef` or Task Manager) and asynchronous tracing (`async_hooks`).
- **Checks**:
  1. Broken cancellation propagation: Check whether a custom tool or long computation omitted `signal: AbortSignal`, leaving work running after its caller cancels.
  2. **Orphan process on dispose**: Check whether cleanup calls only `childProcess.kill()` without awaiting `await once(childProcess, 'exit')`.
  3. Reject late writes: Before an async completion writes a log event, verify the current lifecycle and fencing token are still valid.

---

## 21.4 Production Failure Reviews

These four cases apply the five-step method to production failures and their remedies.

---

### 21.4.1 Case One: A Missing `next()` Short-Circuits a Waterfall

#### 1. Symptom
A `content-security-plugin` for sensitive-word filtering is rolled out. A normal technical term such as `rm -rf` makes the agent enter `running`, but the UI shows no output or error and spins indefinitely.

#### 2. Five-Step Investigation
- **Step 1 (configuration)**: `dump-config` shows the plugin loaded with valid parameters.
- **Step 2 (service)**: `ctx.agentLoop` and `ctx.systemPrompt` are alive.
- **Step 3 (event)**: Tracing shows dispatch stops after `agent/pre-step`; neither `step/start` nor `agent/request` runs.

#### 3. Root Cause and Source Location
The `content-security-plugin` source reveals the defect:

```typescript
// 错误的有缺陷实现！
ctx.onWaterfall('agent/pre-step', async (payload, next) => {
  const containsIllegalWords = checkSecurity(payload.messages);
  if (containsIllegalWords) {
    // 命中安全规则，返回拒绝
    return { action: 'reject', messages: [] };
  } else {
    // 【致命 BUG】：合法分支中仅打印了日志，忘记调用 return next()！
    console.log('[Security] Pass security check.');
    // 隐式返回 undefined，导致 Waterfall 链在此短路中断，下游的 Agent Loop 监听器永远得不到执行！
  }
});
```

#### 4. Production-Style Remedy
Every non-rejection branch of a waterfall listener must delegate downstream. The corrected code is:

```typescript
// 生产级正确修复实现
ctx.onWaterfall('agent/pre-step', async (payload, next) => {
  try {
    const isViolation = await checkSecurityAsync(payload.messages);
    if (isViolation) {
      console.warn(`[Security] Intercepted unsafe messages in turn ${payload.turn}`);
      // 显式短路拒绝
      return { action: 'reject', messages: [] };
    }
    // 【必须】：非拦截分支必须无条件委托下游，并返回下游的最终处理结果
    return await next();
  } catch (err) {
    console.error('[Security] Error during inspection, failing safe:', err);
    // 防御性策略：安全检查本身异常时，抛出明确错误或拒绝，严禁静默吞掉
    throw err;
  }
});
```

---

### 21.4.2 Case Two: Async Dispose Returns Before Quiescence

#### 1. Symptom
A user asks an agent to run a long Python web-scraping script, stops generation after five seconds, and starts a revised request. Five minutes later, the crawler is still writing `data.csv`, mixing data from the previous Turn into the current file.

#### 2. Five-Step Investigation
- **Steps 1–4**: Configuration, services, events, and the log correctly record `turn/end { reason: 'aborted' }`.
- **Step 5 (cancellation and teardown)**: Despite the frontend cancellation, the Python subprocess still runs as an orphan (PPID=1).

#### 3. Root Cause and Source Location
Inspect `dispose` and `cancel` in the shell capability Provider:

```typescript
// 错误的有缺陷实现！
public cancelCurrentTask(): void {
  if (this.childProcess) {
    // 仅仅发出了 SIGTERM 信号，未等待进程实际退出就直接返回并标记空闲！
    this.childProcess.kill('SIGTERM');
    this.childProcess = undefined;
  }
}
```
After POSIX `SIGTERM`, a child needs time to catch the signal, flush I/O, and exit. If the parent clears its reference and starts a new Turn immediately, the child can still write into the workspace.

#### 4. Production-Style Remedy
Apply the rule **“Dispose must reach quiescence, not just request it”**:

```typescript
// 生产级正确修复实现
export class ManagedProcessExecutor {
  private activeProcess?: ChildProcess;

  public async terminateAndQuiesce(timeoutMs = 5000): Promise<void> {
    if (!this.activeProcess || this.activeProcess.exitCode !== null) {
      this.activeProcess = undefined;
      return;
    }

    const proc = this.activeProcess;
    this.activeProcess = undefined; // 立即移出活跃槽，阻止新操作复用

    return new Promise<void>((resolve) => {
      let settled = false;
      const cleanup = () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve();
        }
      };

      // 1. 设置强制硬杀死超时看门狗
      const timer = setTimeout(() => {
        try {
          console.warn(`[ProcessExecutor] Process ${proc.pid} did not exit gracefully, sending SIGKILL.`);
          proc.kill('SIGKILL');
        } catch (e) {}
        cleanup();
      }, timeoutMs);

      // 2. 监听退出事件
      proc.once('exit', () => {
        console.log(`[ProcessExecutor] Process ${proc.pid} confirmed exited cleanly.`);
        cleanup();
      });

      // 3. 发送优雅终止信号
      try {
        proc.kill('SIGTERM');
      } catch (e) {
        cleanup();
      }
    });
  }
}
```

---

### 21.4.3 Case Three: Missing Fencing Allows Split-Brain Writes Across Hosts

#### 1. Symptom
A distributed Graph Mode run contains ten refactoring tasks. Host 1 edits `src/auth.ts`, but a 20-second network disruption makes the scheduler restart the task on Host 2. The final Git repository unexpectedly contains reverted code in `src/auth.ts`.

#### 2. Five-Step Investigation
- In Step 4 (log) and Step 5 (distributed lease tracing), Host 2 committed the refactor at $t=15\text{s}$. Host 1 recovered at $t=22\text{s}$ and ran `git commit & push`, overwriting Host 2's result with incomplete code.

#### 3. Root Cause
The worker did not attach a scheduler-issued, monotonically increasing `Fencing Token` to its shared-store write, and the store did not enforce compare-and-swap concurrency control.

#### 4. Production-Style Remedy
Use an atomic-write adapter that validates fencing tokens:

```typescript
// packages/graph/graph-scheduler/src/index.ts

export interface FencedWriteRequest<T> {
  workId: string;
  fencingToken: number; // 单调递增的纪元编号 (Epoch)
  payload: T;
}

export class FencedArtifactStore {
  private readonly versionRegistry = new Map<string, number>();

  /**
   * 带有原子 CAS 约束的受保护写入
   */
  public async commitArtifact<T>(request: FencedWriteRequest<T>): Promise<void> {
    const { workId, fencingToken, payload } = request;
    const currentCommittedEpoch = this.versionRegistry.get(workId) ?? 0;

    // 核心 Fencing 校验：拒绝一切小于等于当前已提交版本的请求
    if (fencingToken <= currentCommittedEpoch) {
      const errMsg = `[FencedArtifactStore] Split-Brain write rejected for work "${workId}". ` +
                     `Incoming token: ${fencingToken}, but active epoch is already: ${currentCommittedEpoch}`;
      console.error(errMsg);
      throw new Error(errMsg);
    }

    // 原子提升纪元版本并持久化
    this.versionRegistry.set(workId, fencingToken);
    await this.persistToDisk(workId, payload);
    console.log(`[FencedArtifactStore] Work "${workId}" committed successfully with token ${fencingToken}.`);
  }

  private async persistToDisk(workId: string, data: any): Promise<void> {
    // 模拟磁盘或 S3 写入
  }
}
```

---

### 21.4.4 Case Four: A Session Log Sequence Gap Breaks Recovery

#### 1. Symptom
A production machine restarts after a power failure. Restoring its active session throws `FatalInvariantError: Non-contiguous sequence at position 42 (expected 42, got 44)`, and the service refuses to start.

#### 2. Five-Step Investigation
- **Step 4 (log)**: Decompressed `.session.jsonl.zstd` JSONL jumps from `seq: 41` to `seq: 44`; `seq: 42` and `seq: 43` are missing.

#### 3. Root Cause
Just before power loss, a third-party plugin may have called an unsynchronized low-level write or entered an unlocked in-memory append concurrently. The persistence backend also used asynchronous multithreaded writes, allowing later events to reach disk before earlier events and leaving a sequence gap.

#### 4. Production-Style Remedy
Introduce an atomic queued-write barrier and startup reconciliation for sequence gaps in the session layer:

```typescript
// packages/core/session/src/repair.ts

import { SessionEvent } from './session.js';

export class SessionLogSanitizer {
  /**
   * 启动期对账与修复：校验序列号连续性，对撕裂尾部与断号进行确定性修补
   */
  public static sanitizeAndRecover(rawEvents: SessionEvent[]): SessionEvent[] {
    const validEvents: SessionEvent[] = [];
    let expectedSeq = 0;

    for (let i = 0; i < rawEvents.length; i++) {
      const ev = rawEvents[i];
      if (ev.seq !== expectedSeq) {
        console.warn(`[LogSanitizer] Sequence gap detected at index ${i}: expected ${expectedSeq}, got ${ev.seq}. Truncating uncommitted torn suffix.`);
        // 遭遇断号或撕裂尾部，按照一致性原则，安全截断至最后一个严格连续的事件边界
        break;
      }
      validEvents.push(ev);
      expectedSeq++;
    }

    // 检查尾部是否处于开放轮次中，若处于开放状态，追加合成的 interrupted 事件闭合事务
    const lastEvent = validEvents[validEvents.length - 1];
    if (lastEvent && lastEvent.type === 'step/start') {
      validEvents.push({
        seq: validEvents.length,
        time: Date.now(),
        type: 'turn/end',
        data: { turn: (lastEvent.data as any).turn, reason: { kind: 'interrupted' } },
      } as SessionEvent);
    }

    return validEvents;
  }
}
```

---

## 21.5 Architecture Checks and Core Rules

The chapter closes with ten architectural rules and a recurring development checklist:

### 21.5.1 Ten Architecture Rules
1. **The model is not the source of truth**: It is a stateless probabilistic generator; the Session Log is authoritative.
2. **Model-visible means logged**: Context intended for the model enters the log as an event first.
3. **Registered effects are reversible**: Every Cordis listener or service must provide a matching disposer through `ctx.effect()`.
4. **Waterfalls delegate**: A non-rejection branch explicitly calls `await next()`.
5. **Cleanup reaches quiescence**: Dispose waits until child processes and sockets close.
6. **Status is separate from messages**: `agent.followup()` enqueues asynchronously, so the next `whenIdle()` must not be assumed to represent the outcome of only that message.
7. **Sandbox paths stay contained**: Every path accepted by a tool remains under the `cwd` allowlist.
8. **Credentials are scrubbed**: External processes start without environment variables bearing Key, Secret, or Token values.
9. **Revisions are immutable**: Publishing a graph revision freezes it; changed requirements create a higher revision.
10. **Distributed writes are fenced**: Cross-process and cross-machine writes validate monotonically increasing fencing tokens.

### 21.5.2 Weekly Development Checklist

| Area | Verification question | Pass? |
|---|---|---|
| **Plugin composition** | Did `dsh --dump-config` show a final plugin tree without redundant or conflicting entries? | [ ] |
| **Lifecycle** | Do all `ctx.on` / `ctx.provide` registrations dispose fully when their plugins unload? | [ ] |
| **State-machine flow** | Does a pre-Step interceptor degrade safely on errors rather than emit an unhandled Promise rejection? | [ ] |
| **Log integrity** | Is `deriveMessages()` fully deterministic in Session Log replay tests? | [ ] |
| **Sandbox safety** | Are `../` path traversal and tool outputs over 32 KB intercepted and tested? | [ ] |
| **Concurrency** | Does multi-worker scheduling test rejection of expired fencing tokens? | [ ] |

Combining the five-layer model with the five-step diagnosis method prepares you to reason about agent runtimes as a systems engineer. The next chapters examine implementation and low-level protocol details.
