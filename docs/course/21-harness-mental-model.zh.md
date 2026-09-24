# 第 21 章：Harness 基础篇心智模型

[English](21-harness-mental-model.md) | 中文

作为一名具备 C/C++、Java、Go、Rust、Python 或 TypeScript 等传统系统编程背景的软件工程师，初涉大语言模型（LLM）与智能体（Agent）开发时，最常见的认知障碍在于：将 AI 视为具有某种“神秘心智”的黑盒，或是陷入由各种概念框架包装的抽象流行语中。

本章的核心目标是**彻底击碎 AI 系统的黑盒假象**。在 DeepSeek Harness 架构体系中，没有任何魔法——所有行为都可以严密地映射为传统计算机科学中的**确定性状态机、概率型纯函数、控制反转容器（IoC Container）、事件溯源（Event Sourcing）账本、POSIX 系统调用拦截与分布式排他锁（Fencing Token）**。

通过本章的学习，你将建立起一套贯穿 Harness 五层架构的立体心智模型，并掌握生产环境中定位与排查复杂故障的“五步定位法则”。

---

## 21.1 程序员的 AI 系统直觉重构：从黑盒魔法到确定性状态机

在深入 Harness 源码与架构之前，我们首先需要对 AI 系统的核心概念进行一次彻底的“系统编程语义重构”。

### 21.1.1 核心概念系统编程映射表

下表将现代智能体框架中的核心术语，与传统软件工程及分布式系统中的基础概念进行精准对齐：

| AI / Agent 领域术语 | 传统软件工程 / 系统编程对标概念 | 物理本质与工程直觉 |
|---|---|---|
| **LLM（大语言模型）** | **概率型纯函数（Probabilistic Pure Function）** | 给定只读输入缓冲区（Token 序列），计算下一个离散符号的条件概率分布 $P(y_t \mid X, y_{<t})$，无内部隐式状态。 |
| **Token** | **int32 词法单元（Lexical Unit / Identifier）** | 词表 Vocabulary 中的整数索引，定长数值编码，非连续字符流。 |
| **KV Cache** | **记忆化动态规划缓存（Memoization Table）** | 空间换时间的矩阵缓存，避免自回归计算中对历史 Token 的 Attention Key/Value 矩阵进行重复乘法。 |
| **Prompt / System Prompt** | **初始化函数参数与运行时栈上下文（Call Frame & Stack）** | 注入给纯函数的不可变指令集与初始数据载荷。 |
| **Function Calling / Tool Use** | **结构化 AST 解析与受控 RPC 调度（RPC Dispatch via AST）** | 模型输出符合特定 JSON Schema 的调用声明，宿主运行时解析并派发系统调用。 |
| **Agent** | **死循环状态机驱动器（Event-Driven State Machine Loop）** | `while (hasWork) { read_inbox(); step(); }`，在确定性控制流中驱动异步事件。 |
| **Harness** | **IoC 容器与微内核运行时（IoC Microkernel / Spring / Cordis）** | 负责服务发现、依赖注入、生命周期管理、可逆副作用注册与插件装配的控制反转容器。 |
| **Session Log** | **事件溯源不可变日志（Append-only Event Log / Write-Ahead Log）** | 系统的唯一真实来源（Single Source of Truth），系统状态是该日志在时间轴上的折叠投影。 |
| **Fencing Token** | **单调递增分布式排他租约（Monotonic Distributed Lease Lock）** | 防止分布式多 Host 或旧 Worker 迟到写入破坏一致性的 Epoch 计数器。 |
| **Subagent** | **派生子进程 / 轻量级纤程（Forked Subprocess / Fiber）** | 拥有独立上下文作用域、继承受限权限集、生命周期受父级监控的执行单元。 |

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

### 21.1.2 概率型纯函数与状态机数学形式化定义

从数学与计算理论的角度来看，LLM 本身是一个离散时间步上的概率预测器。设词表为 $\mathcal{V}$，当前输入上下文序列为 $\mathbf{x} = (x_1, x_2, \dots, x_n)$，其中 $x_i \in \mathcal{V}$。模型的前向推理过程定义为计算下一个 Token 的条件概率分布向量 $\mathbf{p}_{n+1} \in \mathbb{R}^{|\mathcal{V}|}$：

$$\mathbf{p}_{n+1} = \text{Softmax}\left( \frac{\mathbf{z}_{n+1}}{\tau} \right) = \mathcal{M}_{\theta}(\mathbf{x})$$

其中 $\mathbf{z}_{n+1} \in \mathbb{R}^{|\mathcal{V}|}$ 为未归一化的 Logits 向量，$\tau > 0$ 为采样温度（Temperature）。采样算子 $\mathcal{S}$ 根据概率分布选出确定的 Token：

$$x_{n+1} \sim \mathcal{S}(\mathbf{p}_{n+1})$$

而智能体系统（Harness）则是一个形式化的五元组状态机 $\mathcal{A} = (Q, \Sigma, \delta, q_0, F)$：

1. **状态集合 $Q$**：包含当前会话的所有派生上下文 $S_t$、未决工具调用队列、待处理收件箱 $\text{Inbox}$ 以及生命周期状态 $\text{Status} \in \{\text{idle}, \text{running}\}$。
2. **输入字母表 $\Sigma$**：包含人类用户输入 $M_{\text{user}}$、外部注入上下文 $M_{\text{inject}}$、工具执行结果 $R_{\text{tool}}$ 以及系统中断信号 $\text{Signal}_{\text{abort}}$。
3. **状态转移函数 $\delta: Q \times \Sigma \to Q \times \Gamma$**：将当前状态与输入事件映射为下一状态，并产生外部副作用动作 $\Gamma$（如写磁盘、发起 HTTP 请求、调用子进程）。
4. **初始状态 $q_0$**：由会话种子（Seed）或空会话快照初始化。
5. **终态集合 $F$**：当且仅当收件箱为空、无欠缺工具调用、或触发致命异常/显式取消时进入终态。

$$S_{t+1} = \delta(S_t, e_t) = \text{Fold}(S_t, e_t)$$

状态机在时间步 $t$ 的状态 $S_t$，严格等于初始状态 $S_0$ 与历史事件序列 $(e_1, e_2, \dots, e_t)$ 的折叠结果（Fold）。这一数学性质构成了 Harness **事件溯源与确定性重放**的理论基石。

### 21.1.3 Harness 的核心使命：为随机性装上确定性工程骨架

LLM 的本质是概率驱动的，其输出具有内在的不确定性与幻觉风险；而工程系统的本质要求是确定性、可观测性、幂等性与安全边界。

**Harness 的核心使命，就是在不可预测的概率模型与严格确定性的操作系统之间，构筑一层高韧性、强约束的受控工程骨架。**

这套骨架必须解决以下四大核心工程矛盾：
1. **无限上下文欲望 vs 有限显存与 Token 预算**：通过滑动窗口、Positional Replacement 压缩与 KV Cache 前缀对其进行确定性约束。
2. **黑盒自主执行 vs 最小权限与沙箱隔离**：通过 Service Seam 拦截、POSIX Landlock/Seatbelt 沙箱与路径白名单阻断逃逸。
3. **长周期异步任务 vs 进程崩溃与断电**：通过仅追加事件账本（Append-only Event Log）与崩溃对账算法实现零状态丢失恢复。
4. **多代理并发竞争 vs 数据一致性**：通过不可变任务图 Revision、单调递增 Fencing Token 与租约心跳消除分布式竞态。

---

## 21.2 深度解构：Harness 五层架构心智模型

DeepSeek Harness 采用分层解耦的五层架构设计。每一层各司其职，具有严格的单向依赖与清晰的职责边界：

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

下面我们将自底向上，逐层深度剖析这五层架构的物理本质、数学模型、数据结构与工业级代码实现。

---

### 21.2.1 Layer 1：Cordis 插件树（决定运行时装配了什么）

#### 1. 物理本质与系统映射
在传统企业级 Java 开发中，Spring Framework 凭借 ApplicationContext IoC 容器管理 Bean 的生命周期；在微服务领域，OSGi 提供了模块化插件动态装卸能力。而在 DeepSeek Harness 中，**Cordis 是整个系统的运行骨架与 IoC 容器**。

在 Cordis 中：
- **Context（上下文）**：服务的载体与作用域隔离单元。Context 形成一棵树状层次结构（Root Context $\to$ Preset Context $\to$ Agent Scoped Context）。
- **Service（服务）**：占据 `ctx.<serviceName>` 的单例实现，如 `ctx.sessions`、`ctx.tools`、`ctx.llm`。
- **Inject（依赖声明）**：插件声明自己所依赖的 Service 集合，Cordis 拓扑排序确保依赖满足后才激活插件。
- **Reversible Effect（可逆副作用）**：插件注册的一切监听器、服务、路由，都必须挂载到 `ctx.effect()` 析构模型中。当插件卸载（Unload）或纤程销毁时，所有副作用逆序自动回滚，杜绝内存泄漏与悬挂监听器。

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

#### 2. Cordis 四大事件分发原语
Cordis 废弃了传统 Node.js EventEmitter 简陋的 `on/emit` 模式，提供了四种具备严格控制流语义的事件分发原语：

| 分发原语 | 执行拓扑 | 异步等待 (Await) | 返回值语义 | 经典应用场景 |
|---|---|---|---|---|
| `ctx.emit` | 异步单向广播 | 否（Fire-and-forget） | 无 | `agent/created`、`session/event` 实时推送 |
| `ctx.waterfall` | 洋葱圈 / 环绕中间件 | 否（同步链式传递） | 是（最终累积/重写值） | `agent/pre-step` 决策、`system-prompt/assemble` |
| `ctx.serial` | 顺序执行流水线 | 是（按注册顺序 await） | 是（收集执行结果） | `agent/turn-stopping` 停机检查点、保存持久化 |
| `ctx.parallel` | 扇出并发观察者 | 是（`Promise.all` 扇出） | 否 | 多插件并行刷新缓存、遥测上报 |

其中，**`ctx.waterfall`（瀑布式中间件）** 是 Harness 拦截体系的核心。每个监听器接收 `(payload, next)` 参数：
- 调用 `next(modifiedPayload)`：将修改后的载荷委托给下游监听器，并接收下游的最终返回值。
- 不调用 `next()` 直接 `return customValue`：**立即短路（Short-circuit）**，阻止下游所有监听器执行。

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

#### 3. 配置文件 Overlay Patch 机制与加载期校验
在运行时，Harness 组装 Cordis 插件树的过程完全遵循配置驱动与叠加修补（Overlay Patching）原则：

1. **基础 Bundle 加载**：加载 `dsh-base` 组合包，声明核心基础服务（会话日志、默认模型网关、基础文件工具）。
2. **Profile 叠加**：应用当前 Profile 指定的组合包（如 `dsh-web-app` 或 `dsh-headless`）。
3. **Patch 文件覆盖**：依次加载 Profile 级 `cordis.patch.yml`、用户 Home 目录级 patch 以及命令行 `--patch` 参数。
4. **条目精确定位与替换**：一条 Patch 规则通过 `id` 定位特定的配置项，以整体替换其 `config` 或动态注入新条目。
5. **Schemastery 强类型校验**：在插件激活前，所有配置字段由 Schemastery 模式进行严格解析，非法类型或未知键在加载期立刻报错中断，防止运行时隐式降级。

#### 4. 工业级 TypeScript Cordis 容器完整实现

下面给出一个满足类型安全、依赖拓扑解析、可逆析构与 Waterfall 中间件语义的生产级 Cordis 容器实现：

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

### 21.2.2 Layer 2：Agent Loop 驱动引擎（决定一次请求如何推进）

#### 1. 状态机死循环：Turn 与 Step 语义解构
在传统的 Web 开发中，请求通常遵循“一问一答”（Request-Response）模式。但在智能体架构中，用户的单次提问可能引发一系列复杂的自主推理与工具调用链。为此，Harness 建立了严格的 **Turn（轮次）** 与 **Step（步骤）** 二级执行生命周期：

- **Step（步骤）**：**单次模型请求及其调用的所有工具执行闭包**。1 个 Step = 1 次 LLM API 流式调用 + $N$ 个并发/排他工具执行。
- **Turn（轮次）**：**由一个或多个 Step 构成的连续事务区间**。Turn 在处理首条待决输入时开启（`turn/start`），并在模型不再产生工具调用、且当前 Inbox 中无待处理后续输入时关闭（`turn/end`）。

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

#### 2. 统一 Inbox 消息队列与调度语义
进入 Agent 的一切外部事件（人类 Followup 提问、运行时 Steering 转向指令、系统定时器、子代理完成通知）均汇入同一抽象队列——**`Inbox`**。Inbox 内部维护两个有序分区：

1. **`next-turn` 队列**：存储普通的用户对话消息（`followup`）。当上一个 Turn 完全结束处于 `idle` 状态时，每次仅取出第一条消息开启一个全新的 Turn。
2. **`next-step` 队列**：存储优先级更高的系统级注入（`inject`）或人工中途干预指令（`steer`）。当驱动器在 Step 边界流转时，会立即认领 `next-step` 中的全部消息，在不中断当前 Turn 的前提下将它们作为 `user/message` 合并注入到下一个 Step 中。

#### 3. 协作式取消体系：AbortSignal 与停稳收敛（Quiescence）
在系统编程中，杀死线程或强制终止进程极易导致死锁与资源悬挂。Harness 采用基于原生 Web API 的 **协作式取消（Cooperative Cancellation）** 架构：

- 每一个活跃的 Turn 和 Step 都绑定一个严格继承的 `AbortSignal`。
- 取消原因由不可变强类型 `AgentCancelCause` 标识：`user`（用户点击停止）、`parent`（父级任务终止）、`hook`（安全策略拦截）、`disposed`（宿主卸载）。
- **停稳守则（Dispose must reach quiescence）**：`agent.cancel()` 不仅发出中止信号，还必须通过 `whenIdle()` 异步等待所有正在运行的子进程、网络 Socket 和文件句柄完全关闭，杜绝孤儿操作在后台继续写入。

#### 4. 工业级 TypeScript 状态机核心驱动器完整实现

```typescript
// packages/core/agent-loop/src/driver.ts

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

### 21.2.3 Layer 3：Session Log 事实账本（决定什么能够重放与恢复）

#### 1. “模型可见即已记录”不变量（Model-Visible Invariant）
在许多简陋的 AI 框架中，上下文历史存储在易失的内存对象或自由格式的 JSON 中，一旦遇到进程崩溃或断电，状态极易产生裂隙，无法复现。

DeepSeek Harness 确立了一条铁律级的核心不变量：

$$\forall m \in \text{ModelContext}, \quad m = \mathcal{P}(\text{SessionLog})$$

**“模型可见即已记录”（Everything Visible to the Model MUST be Derived from the Durable Log）。** 任何抵达大模型上下文窗口的数据（包括系统提示词、用户提问、工具输出、中途干预、文件切片），都必须先以强类型的 `SessionEvent` 落入仅追加日志（Append-only Log），随后通过纯函数投影器 $\mathcal{P}$ 派生生成。

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

#### 2. Surface 模型与 Positional Replacement 压缩
会话日志中不仅包含用于构造提示词的消息，还包含大量结构化标记（`turn/start`、`step/end`、流式 Chunk、心跳事件）。为了从杂乱的事件流中高效提取消息，Harness 定义了 **`Surface`（投影平面）**：

- **`SurfaceEventType`**：只有产生真实 LLM 消息的事件属于 Surface 事件（`user/message`、`assistant/message`、`tool/result`）。
- **`SurfaceOp` 操作语义**：
  - `'append'`：常规追加，作为最新的一条消息加入上下文尾部。
  - `{ op: 'replace', start: number, end: number }`：**位置替换压缩（Positional Replacement）**。用于上下文压缩插件（Compaction）。它会在不修改历史物理日志的前提下，在逻辑投影平面中将序号从 `start` 到 `end` 的事件整体遮蔽（Shadow），并用当前的摘要事件原位替代。

```
物理日志序列 (Seq):
0(user) ---> 1(assistant) ---> 2(tool) ---> 3(assistant) ---> 4(compaction/summary: replace 0..3)

逻辑 Surface 投影视图 (模型所见):
[ 4(compaction/summary 综合摘要) ] ---> (后续新追加的 5, 6, 7...)
```

#### 3. Zstandard 帧压缩、序列号连续性与 SessionHeader 存储布局
在持久化磁盘存储层面，Harness 遵循极度严苛的工程规范：

1. **`SessionHeader` 元数据前置**：在日志首部存储不可变的 JSON 元数据头，包括格式版本（`formatVersion: 1`）、会话创建时间戳、关联工作区绝对路径（`cwd`）、父子会话派生血缘（`parentSession`）以及种子边界（`seedLength`）。
2. **序列号严格单调递增**：所有事件必须满足 $\text{seq} = \text{log.length}$，保证日志无空洞、无断号。
3. **Zstandard（Zstd）流式帧压缩**：落盘文件采用 `.session.jsonl.zstd` 格式。每个压缩 Frame 包含完整的 JSONL 行，并保持与内存事件的 1:1 双向映射。
4. **`session/end-seed` 边界标记**：从已有会话 Fork 或恢复时，系统在种子事件尾部追加一条特殊的空载荷事件 `session/end-seed`，作为区分“历史继承数据”与“当前进程实时写入数据”的持久化投影边界。

#### 4. 工业级 TypeScript 事件溯源与投影算法完整实现

```typescript
// packages/core/session/src/session.ts

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

### 21.2.4 Layer 4：Capability Provider 副作用层（决定具体文件/命令/网络如何受控执行）

#### 1. Service Seam 三元组架构
在大型单体架构中，将具体的文件系统读写或 Shell 执行代码硬编码在业务逻辑中是极其危险的。Harness 提出了 **Service Seam（能力接缝）** 设计范式，将任何受控能力的引入解耦为三个严格角色：

```
+-----------------------------------------------------------------------------------+
| 1. Service Definition (接口定义契约包)                                            |
|    - packages/core/fs-interface: 定义 FileSystem 抽象接口与策略错误码             |
+-----------------------------------------------------------------------------------+
                                         ^
                                         | 实现接口
+-----------------------------------------------------------------------------------+
| 2. Service Provider (具体能力提供方实现包)                                         |
|    - packages/provider/fs-local: 基于 Node.js 本地文件系统实现                    |
|    - packages/provider/fs-sandbox: 基于 Linux Landlock / Docker 远程沙箱实现      |
+-----------------------------------------------------------------------------------+
                                         ^
                                         | 消费注入 (ctx.fs)
+-----------------------------------------------------------------------------------+
| 3. Consumer / Tools (面向大模型的工具消费包)                                      |
|    - packages/tools/fs-tools: 向模型暴露 read_file / write_file 工具 DSL          |
+-----------------------------------------------------------------------------------+
```

#### 2. 副作用分类学与并发控制模型
工具调用绝非简单的无脑异步并发。根据对系统状态产生的破坏性程度，Harness 将工具划分为三类，并采用不同的并发调度策略：

| 副作用类别 | 操作特征 | 幂等性保证 | 调度屏障策略 (Barrier Strategy) | 典型工具示例 |
|---|---|---|---|---|
| **只读查询（Read-Only）** | 无磁盘/网络写入 | 天然幂等（Idempotent） | **无界/有界并发滚动池（Rolling Pool）**，并发执行 | `read_file`、`grep_search`、`list_dir` |
| **状态幂等写入（State-Idempotent）** | 依赖确定性路径覆写 | 重复执行结果确定 | **排他写屏障（Exclusive Barrier）**，清空并发池后独占执行 | `write_to_file`、`replace_file_content` |
| **非幂等外部动作（Non-Idempotent）** | Shell 命令、数据库迁移、Git Commit | 执行可能产生不可逆副作用 | **严格排他屏障 + 人工审批检查点（Approval Gate）** | `run_command`、`deploy_service` |

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

#### 3. 纵深防御体系：沙箱、凭证脱敏与 Spill Manager
在执行大模型生成的未知命令与参数时，Layer 4 提供了三道关键防线：

1. **路径遍历防御（Path Traversal Defense）**：所有传入的文件路径必须通过 `path.resolve` 规范化，并强制断言在 `cwd`（工作区根目录）子树之内，严禁逃逸到 `/etc`、`C:\Windows` 或父级敏感目录。
2. **环境变量脱敏（Credential Scrubbing）**：在为子进程注入环境变量前，自动执行正则过滤，剔除所有匹配 `*KEY*`、`*SECRET*`、`*TOKEN*`、`*PASSWORD*` 的敏感键值，防止恶意提示词注入窃取 API 密钥。
3. **超长输出 Spill 管理器（Spill Manager）**：大模型执行 `cat large_file.log` 或编译命令可能产生数百兆输出，如果直接塞入上下文会导致 OOM 崩溃。Spill 管理器在输出超过阈值（如 32 KB）时，自动将全量数据写入 `0700` 权限的私有临时文件，并在上下文中仅截取前缀/后缀摘要，附带查看路径提示。

#### 4. 工业级 TypeScript 受控工具执行流水线完整实现

```typescript
// packages/core/tools/src/pipeline.ts

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

### 21.2.5 Layer 5：Graph / LoopX 分布式协调层（决定长期任务如何拆解与并发防冲突）

#### 1. 多 Agent DAG 编排与不可变 Revision 谱系
面对耗时数小时、涉及多个代码模块重构的长周期任务，单 Agent 循环的上下文极易耗尽。Harness 提供了 **Graph Mode（任务图编排）**：

- **任务图形式化为有向无环图 $\mathcal{G} = (\mathcal{V}, \mathcal{E})$**：节点 $\mathcal{V}$ 代表具体的子任务（如需求分析、代码重构、单元测试、文档编写），边 $\mathcal{E}$ 代表依赖关系。
- **不可变 Revision（版本谱系）**：一旦任务图提交（`graph_submit`），当前图定义即被冻结为 `Revision 1`。若主控在执行过程中发现需求变更，**绝不原地修改既有图**，而是创建全新的 `Revision 2`。
- **拓扑失效传播（Transitive Successor Invalidation）**：当修改节点 $N_k$ 时，系统通过拓扑遍历找出所有依赖 $N_k$ 的后继节点闭包 $\text{Closure}(N_k)$，将闭包内的节点标记为失效并重新调度；而闭包之外已成功运行的节点直接复用产物，无需重跑。

```
Revision 1:
[ 节点 A: 接口设计 (Success) ] ---> [ 节点 B: 模块实现 (Failed) ] ---> [ 节点 C: 集成测试 (Pending) ]

需求调整后产生 Revision 2 (仅使 B 和 C 失效重跑，A 的产物被安全复用):
[ 节点 A (Reused from Rev 1) ] ---> [ 节点 B' (New Ready) ] ---> [ 节点 C' (Pending) ]
```

#### 2. 分布式租约与单调递增 Fencing Token 数学证明
在跨多个 Host 节点或进程池并发调度 Graph 节点时，最严重的生产事故是 **“脑裂并发写入”（Split-Brain Write Conflict）**：当 Host A 执行节点因网络抖动卡顿导致租约过期，Host B 被选举接管该节点；随后 Host A 从卡顿中恢复，继续向磁盘或外部写入，造成数据污染。

Harness 通过 **单调递增 Fencing Token 算法** 严格证明并消除了这一风险。

##### 【数学定理：Fencing Token 偏序排他性定理】
设外部共享资源存储为 $\mathcal{R}$，其内部记录最后一次成功提交的版本号为 $\nu_{\mathcal{R}} \in \mathbb{N}$。 对于任意两个并发执行者 $W_1$ 与 $W_2$，其从分布式协调服务领取的 Fencing Token 分别为 $T_1, T_2 \in \mathbb{N}$。 若协调服务满足严格单调递增性，即分配时间 $t_1 < t_2 \implies T_1 < T_2$。 资源存储 $\mathcal{R}$ 的写入操作定义为带有 CAS（Compare-And-Swap）约束的原子转移：

$$\text{Write}(\mathcal{R}, T_{\text{worker}}, \text{Data}) = \begin{cases} \text{Commit}(\text{Data}) \text{ and } \nu_{\mathcal{R}} \leftarrow T_{\text{worker}}, & \text{if } T_{\text{worker}} > \nu_{\mathcal{R}} \\ \text{Reject}(\text{StaleFencingToken}), & \text{if } T_{\text{worker}} \le \nu_{\mathcal{R}} \end{cases}$$

##### 【手算推导演示】
1. **时刻 $t_1$**：Host A 认领任务节点，获得租约 $T_1 = 100$。存储端此时 $\nu_{\mathcal{R}} = 0$。
2. **时刻 $t_2$**：Host A 开始执行耗时计算，但遭遇操作系统深垃圾回收（GC Pause）或网络分区，挂起 30 秒。
3. **时刻 $t_3$**：协调器检测到 Host A 心跳超时，宣布租约过期，并将任务重新分派给 Host B。Host B 获得递增的 Fencing Token $T_2 = 101$。
4. **时刻 $t_4$**：Host B 快速完成工作，发起结算请求 $\text{Write}(\mathcal{R}, T_2=101, \text{ResultB})$。由于 $101 > 0$，写入成功，存储端版本原子跃迁为 $\nu_{\mathcal{R}} = 101$。
5. **时刻 $t_5$**：Host A 从 GC 卡顿中恢复，自以为仍持有锁，向存储端发出迟到的写入请求 $\text{Write}(\mathcal{R}, T_1=100, \text{ResultA})$。
6. **时刻 $t_6$**：存储端校验发现 $T_{\text{worker}} (100) \le \nu_{\mathcal{R}} (101)$，**直接拒绝并抛出 `StaleFencingTokenError`**。Host A 的迟到写入被安全阻断，系统一致性得以完整保全。

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

#### 3. 执行平面（Harness）与控制平面（LoopX）的双向交互边界
在结合外部多代理协同框架（如 LoopX）时，必须明确 **执行平面与控制平面的职责划分**：

- **Harness 管理执行平面（Execution Plane）**：包含模型流式调用、工具执行、POSIX 沙箱隔离、子会话（Child Sessions）管理以及全量原始 Transcript。Harness 会话事件是模型执行事实的唯一权威源。
- **LoopX 管理控制平面（Control Plane）**：包含全局 Goal 规划、共享 Todo 列表、Peer 角色名册认领以及公开进度追踪。
- **通信边界原则**：双方仅交换有长度上限（最长 2000 字符）、剥离了私有路径与凭证的 **公开安全摘要（Public-Safe Summary）**，严禁将未过滤的底层 Transcript 倾倒至外部控制平面。

#### 4. 工业级 TypeScript 分布式 Fencing 存储与对账实现

```typescript
// packages/graph/graph-scheduler/src/fenced-storage.ts

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

## 21.3 标准“五步故障定位法则”

在高度复杂的智能体系统中，当出现“Agent 假死”、“工具未按预期执行”、“重启后状态错乱”或“输出结果异常”时，切忌盲目打印 `console.log` 或修改代码。

Harness 总结出了一套标准化的 **“五步故障定位法则”（Configuration $\to$ Service $\to$ Event $\to$ Log $\to$ Cancellation）**，按照系统加载与执行的因果链自底向上排查：

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

### 21.3.1 第一步：配置排查（Configuration Phase）
- **排查目标**：确认运行时实际装配的插件树与参数是否与预期一致。
- **核心工具**：运行 `dsh --profile <profile-name> --dump-config` 打印最终合并后的 Cordis 配置树。
- **排查清单**：
  1. YAML 补丁覆盖顺序：默认 Bundle $\to$ Profile Patch $\to$ User Home Patch $\to$ CLI `--patch` 参数。确认目标条目未被高优先级 Patch 覆盖。
  2. Loader 表达式解析：检查 `!!js` 动态表达式是否因环境变量缺失而计算为 `disabled: true`。
  3. Schemastery 强校验报错：检查配置项类型是否匹配 Schema，未声明的非法字段是否在启动期被拦截。

### 21.3.2 第二步：服务排查（Service Phase）
- **排查目标**：确认各个 Service Seam 是否成功绑定了合法的 Provider。
- **核心工具**：在调试入口打印 `ctx.get('tools')`、`ctx.get('llm')`、`ctx.get('sessions')`。
- **排查清单**：
  1. 循环依赖检测：插件 A 声明 `inject: ['b']`，插件 B 声明 `inject: ['a']`，导致双方均无法激活。
  2. 隔离作用域穿透：检查 Presets 中的服务是否被错误地放置在 `isolate` realm 中，导致 Host 全局上下文无法寻址。
  3. 析构提前触发：检查提供方是否被父级纤程的提前 dispose 连带卸载。

### 21.3.3 第三步：事件排查（Event Phase）
- **排查目标**：确认控制流拦截链是否畅通，是否存在短路或阻塞。
- **核心工具**：开启 Cordis 事件追踪日志（`DEBUG=cordis:events*`）。
- **排查清单**：
  1. **Waterfall 中间件 `next()` 漏调**：这是导致 Agent 假死的最常见原因！检查所有 `ctx.onWaterfall` 监听器，确认在非拒绝分支中必须无条件 `await next()`。
  2. 分发模式错误：将本应 `serial` 的异步持久化事件误用 `emit` 分发，导致数据尚未写入进程就已退出。
  3. 事件域混淆：会话持久事件（`session/event`）、实时代理事件（`agent/*`）与能力接缝事件（`tools/*`）监听位置颠倒。

### 21.3.4 第四步：日志排查（Log & Replay Phase）
- **排查目标**：确认会话事实账本的物理完整性与可投影性。
- **核心工具**：读取持久化存储的 `.jsonl.zstd` 或 SQLite 会话文件，调用 `Session.fromRestore()` 手动回放。
- **排查清单**：
  1. **序号连续性断言**：断言事件流中满足严格的 $e_{k+1}.\text{seq} = e_k.\text{seq} + 1$，无断号、无重复。
  2. 非法不可序列化数据：检查是否有插件将 `BigInt`、`Function`、`Circular Object` 或类实例存入 `event.data`，导致底层序列化抛错。
  3. 投影断言（`deriveMessages`）：运行独立测试，断言从日志投影出的消息列表与大模型实际接收到的 Payload 完全一致。

### 21.3.5 第五步：取消与清理排查（Cancellation & Teardown Phase）
- **排查目标**：确认在中止与退出路径中，系统能够优雅且完整地收敛。
- **核心工具**：进程监控命令（`ps -ef` / 任务管理器）结合异步追踪（`async_hooks`）。
- **排查清单**：
  1. 取消信号断链：检查自定义工具或长耗时计算是否遗漏了传递 `signal: AbortSignal`，导致外层取消后底层仍死锁运行。
  2. **Dispose 孤儿进程**：检查进程退出清理函数是否仅仅触发了 `childProcess.kill()`，而没有 `await once(childProcess, 'exit')` 等待停稳。
  3. 迟到写入阻断：检查异步任务完成后，是否先校验了当前生命周期与 Fencing Token 是否有效，再决定是否写入日志。

---

## 21.4 生产级故障深度复盘实战

为了将上述理论模型与五步定位法则融会贯通，下面精选四个在真实生产环境中引发严重灾难的典型故障案例进行深度复盘与重构。

---

### 21.4.1 故障案例一：Waterfall 拦截器遗漏 `next()` 导致驱动引擎死锁假死

#### 1. 故障现象
生产环境部署了一个敏感词安全过滤插件（`content-security-plugin`）。在灰度上线后，用户反馈：只要在提问中包含普通的技术词汇（如 `rm -rf` 讨论），Agent 状态立即变为 `running`，但随后界面没有任何输出，也不报错，永久卡死在转圈状态。

#### 2. 五步法排查过程
- **Step 1（配置）**：`dump-config` 显示插件正常加载，参数无误。
- **Step 2（服务）**：`ctx.agentLoop` 与 `ctx.systemPrompt` 正常存活。
- **Step 3（事件）**：开启事件追踪，发现驱动器在触发 `agent/pre-step` Waterfall 事件后，执行链在此中断，后续的 `step/start` 与 `agent/request` 从未被触发！

#### 3. 根因分析与代码定位
查看 `content-security-plugin` 的源码，发现了致命缺陷：

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

#### 4. 工业级修复方案
在 Waterfall 监听器中，必须严格保障全分支的控制流委托。修复代码如下：

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

### 21.4.2 故障案例二：异步 Dispose 未达到 Quiescence 导致孤儿进程跨轮次写穿

#### 1. 故障现象
用户在 Web 端让 Agent 执行一个长时间的 Python 爬虫脚本。执行 5 秒后，用户点击了“停止生成（Cancel）”，随后修改了提问并重新发起对话。然而，5 分钟后，用户发现工作区中的 `data.csv` 依然被爬虫数据不断写入，且文件内容与前一轮的任务混杂，导致数据严重损坏。

#### 2. 五步法排查过程
- **Step 1~4**：配置、服务、事件、日志均正常记录了 `turn/end { reason: 'aborted' }`。
- **Step 5（取消与清理）**：检查系统调用层，发现虽然前端点击了取消，但后台的 Python 子进程依然以孤儿进程（PPID=1）形式在操作系统中高速运行！

#### 3. 根因分析与代码定位
排查 Shell Capability Provider 的 `dispose` 与 `cancel` 实现：

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
在 POSIX 系统中，发出 `SIGTERM` 后，子进程需要一定时间进行信号捕获、刷新 IO 缓冲区并退出。如果父进程直接置空引用并开启下一轮，操作系统中的子进程依然存活并拥有工作区的写权限，造成跨轮次写穿！

#### 4. 工业级修复方案
严格贯彻 **“Dispose must reach quiescence, not just request it”** 原则：

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

### 21.4.3 故障案例三：跨 Host 调度无 Fencing Token 保护导致分布式脑裂写入

#### 1. 故障现象
在 Graph Mode 多节点分布式部署中，包含 10 个代码重构子任务。Host 1 负责重构 `src/auth.ts`。由于 Host 1 所在的物理机发生 20 秒的网络抖动，Scheduler 认为 Host 1 已死，在 Host 2 上重新拉起该任务。最终，Git 仓库中的 `src/auth.ts` 出现了不可理解的代码回退。

#### 2. 五步法排查过程
- 通过 Step 4（日志）与 Step 5（分布式租约追踪），发现 Host 2 在 $t=15\text{s}$ 提交了重构后的代码，而 Host 1 在 $t=22\text{s}$ 恢复后，直接执行了 `git commit & push`，将自己未完成的半成品代码强行覆盖了 Host 2 的最终成果。

#### 3. 根因分析
分布式 Worker 在写回共享存储时，未携带由调度器颁发的单调递增 `Fencing Token`，存储端未做 CAS 乐观并发控制校验。

#### 4. 工业级修复方案
引入带有 Fencing Token 强校验的原子写入适配器：

```typescript
// packages/graph/graph-scheduler/src/fenced-storage.ts

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

### 21.4.4 故障案例四：Session Log 序列号断裂导致崩溃恢复时事件投影失败

#### 1. 故障现象
某生产节点由于物理机突发断电重启。系统重启后，尝试加载断电前的活跃会话，控制台抛出 `FatalInvariantError: Non-contiguous sequence at position 42 (expected 42, got 44)`，会话无法恢复，整个服务拒绝启动。

#### 2. 五步法排查过程
- **Step 4（日志排查）**：直接检查 `.session.jsonl.zstd` 解压后的 JSONL 行，发现 `seq: 41` 之后直接跳到了 `seq: 44`，中间的 `seq: 42` 与 `seq: 43` 丢失。

#### 3. 根因分析
在断电前的一瞬间，某个第三方插件直接调用了底层的未同步写入函数，或者在追加事件时并发进入了未加锁的内存数组；同时持久化后端采用了异步多线程写入，导致前序事件未 Flush 成功时后序事件先落盘，形成了序列号空洞（Sequence Gap）。

#### 4. 工业级修复方案
在会话层引入原子排队写屏障与启动期自动空洞修补对账算法：

```typescript
// packages/core/session/src/persistence-repair.ts

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

## 21.5 架构自检清单与核心法则总结

为了在日常开发中持续保证系统质量，本章最后提炼出 **“十条架构黄金定律”** 与 **“自检清单”**：

### 21.5.1 十条架构黄金定律
1. **模型非真源**：大模型只是无状态的概率生成器，Session 日志才是唯一的真源。
2. **可见即已记录**：任何将要传给大模型的上下文，必须先作为 Event 进入 Log。
3. **副作用必可逆**：在 Cordis 中注册的任何监听与服务，必须在 `ctx.effect()` 中提供对等的 Disposer。
4. **瀑布链必委托**：编写 Waterfall 中间件时，非拒绝分支必须显式 `await next()`。
5. **清理必须停稳**：资源释放（Dispose）必须等待底层子进程和 Socket 完全关闭（Quiescence）。
6. **状态与消息解耦**：`agent.followup()` 是异步入队，绝不能假定下一次 `whenIdle()` 仅仅代表该消息的执行结果。
7. **沙箱阻断逃逸**：所有工具接收的路径参数必须强制限定在 `cwd` 白名单之内。
8. **凭证彻底脱敏**：启动外部进程前必须剥离所有携带 Key/Secret/Token 的环境变量。
9. **修订不可篡改**：任务图 Revision 一旦发布即不可变，需求变更只能生成更高的新 Revision。
10. **分布式必带 Fencing**：跨进程/跨机器执行任务时，写回操作必须校验单调递增的 Fencing Token。

### 21.5.2 每周开发自检清单

| 自检维度 | 验证指标与检查项 | 是否达标 |
|---|---|---|
| **插件装配** | 是否运行 `dsh --dump-config` 验证最终插件树无冗余与冲突？ | [ ] |
| **生命周期** | 是否所有 `ctx.on` / `ctx.provide` 均能响应插件卸载并完全释放？ | [ ] |
| **状态机流转** | Pre-step 拦截器在异常分支下是否安全降级而非抛出未捕获 Promise 拒绝？ | [ ] |
| **日志完整性** | Session 日志重放测试中，`deriveMessages()` 的结果是否 100% 确定？ | [ ] |
| **沙箱安全** | 是否对 `../` 路径遍历与超长（>32KB）工具输出做了完整拦截与测试？ | [ ] |
| **并发防护** | 多 Worker 调度场景下是否包含针对过期 Fencing Token 写入的单元测试？ | [ ] |

通过将上述五层架构心智模型与五步故障定位法铭记于心，你已经完成了从传统软件工程师到顶级 Agent 系统架构师的关键认知跃迁。在接下来的章节中，我们将深入更具体的代码实现与底层协议细节。
