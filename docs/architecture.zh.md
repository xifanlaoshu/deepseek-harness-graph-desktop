# DeepSeek Harness 架构

[English](architecture.md) | 中文

改动 `packages/` 下的任何内容之前，请先阅读本文。本文假定你已了解 Cordis；如果尚未了解，请先阅读[入门](cordis-primer.zh.md)或[教程](cordis-tutorial/index.zh.md)。

建议使用 agent（智能体）探索代码库并理解其架构。

## Cordis

[Cordis](cordis-primer.zh.md) 是 dsh 底层的框架：插件向共享上下文贡献服务、类型化事件和可逆的副作用。产品的每一部分都是插件，包括模型适配器、工具注册表、会话日志，以及 agent loop（智能体循环）本身，因此每一部分都可以从配置替换。

不存在需要打补丁的特权内核：扩展 dsh 的方式是把插件挂载到其他插件旁边，而各项注册都是副作用，会在其插件卸载时撤销。

## Profile 与组合包

运行中的 `dsh` 是一棵插件树，由启动时按序叠加的各层组合而成。

**profile** 是存放在 Harness home 中的具名组装。它列出自己叠放的组合包，存放自己安装的树外插件，并保存用户自己的 `cordis.patch.yml`。`web` 和 `headless` 作为模板随发行版交付。

**组合包**是 Cordis 配置项及其挂载代码的分发格式，因此它插入的内容始终可被其上各层 patch。

两者都在各自的 `package.json` 中通过 `dsh` 字段声明自己：`dsh.profile` 列出一个 profile 的组合包，`dsh.bundle` 指向一个组合包的 patch 文件。

[`dsh-base`](../packages/bundle/base/README.zh.md) 是每个 profile 的第一层：模型适配器、工具、持久化、沙箱与审批策略、设置、凭据、遥测。[`dsh-web-app`](../packages/bundle/web-app/README.zh.md) 增加浏览器应用；[`dsh-headless`](../packages/bundle/headless/README.zh.md) 增加一次性运行器，且完全不带服务器。

各层按此顺序应用在空条目列表之上：先按 profile 列出的顺序应用每个组合包，然后是 profile 的 `cordis.patch.yml`，然后是 home 级的那份，最后是任意 `--patch` overlay。一条 patch 按 id 定位某个条目并替换其整个 config，或插入新条目。

要查看你的机器实际启动的配置树：

```sh
dsh --profile web --dump-config
```

它打印出的任何条目，都可以由你自己的 patch 替换。

组装机制见 [app-boot](../packages/boot/app-boot/README.zh.md#profiles)；配置字段见生成的[配置目录](config-catalog.zh.md)。

## 核心包

以下是向 Cordis 树贡献内容的部分核心包。

| 包 | 职责 | `ctx` 键 |
|---|---|---|
| [`core/session`](subsystems/session.zh.md) | 仅追加的 `SessionEvent` 日志和内存存储 | `ctx.sessions` |
| [`core/system-prompt`](subsystems/system-prompt.zh.md) | 提示词片段与工具 schema 的组装 | `ctx.systemPrompt` |
| [`core/tools`](subsystems/tools.zh.md) | 作用域化的工具注册表和带把关的执行流水线 | `ctx.tools` |
| [`core/agent`](subsystems/core.zh.md) | `Agent` 接口、活跃 agent 注册表和 `agent/*` 事件 | `ctx.agents` |
| [`core/agent-loop`](subsystems/core.zh.md) | 实现该接口的默认驱动器 | `ctx.agentLoop` |
| [`core/scope`](subsystems/scope.zh.md) | 按 agent 划分作用域的注册原语 | 库，无 ctx 键 |
| [`llm/llm`](subsystems/llm-streaming.zh.md) | 消息与流式词汇表，以及适配器 seam | `ctx.llm` |

<a id="events"></a>

## 事件

事件就是扩展点，而选对事件域是大多数改动的第一个决定。

- **会话事件**是追加到日志并通过 `session/event` 广播的持久事实。当某个事实必须在重新加载后仍然存在时，使用它。
- **Agent 事件**（`agent/*`）携带活跃 `Agent`：inbox、步骤、状态、请求、验证、续跑。要观察或拦截进行中的工作时，使用它。
- **能力事件**无需导入循环即可向某个 seam（`fs/*`、`tools/*`、`telemetry/*`）附加策略和适配器。

[事件映射](event-producer-consumer.zh.md)列出每个事件的生产方与消费方。

<a id="turn-flow"></a>

## 轮次流程

一个**步骤**是一次模型请求加上它调用的工具。一个**轮次**包含零个或多个步骤：它在领取首条输入之前打开，并在不再欠下任何工作时关闭。

```text
turn/start
  claim next-step input plus one queued message
  assemble prompt sections + tool schemas
  -> agent/pre-step                   reject | enter(messages)
     reject, or a first enter rewritten empty -> close the turn with no step
     step/start
     append entered messages as user/message
     derive model history from the log
     agent/request -> llm/stream -> assistant/chunk* -> assistant/message
     tool/call* -> tools/pre-execute -> tools/execute -> tools/post-execute -> tool/result*
     step/end
     tools owe another request, or next-step input arrived -> claim -> next step
  -> agent/turn-stopping
turn/end
```

`turn/*`、`step/*`、`user/message`、`assistant/*` 和 `tool/*` 是持久会话事件；其余是分属三个事件域的实时扩展点。`agent/pre-step`、`agent/request`、`llm/stream` 和三个 `tools/*` 事件是 waterfall（瀑布式事件），其监听器必须调用 `next()` 才能委托下去；`agent/turn-stopping` 是 serial 事件，没有 `next()`。

输入通过同一个 inbox 到达驱动器。有些消息会立即唤醒它；注入的上下文会留在 inbox 中，直到另一条消息将其唤醒。

`agent/pre-step` 决定模型看到什么。监听器可以改写已领取的消息，也可以直接拒绝它们；首次领取被拒绝或被改写为空时，仍会关闭一个不含步骤的持久轮次，因此日志会记录这次尝试。每个步骤读取插件注册的提示词片段和工具 schema。

详情见[时序图](agent-lifecycle.zh.md)、[工具流水线](tool-execution-pipeline.zh.md)和[取消与错误恢复](subsystems/core.zh.md#the-agent-handle)。

## 会话日志

会话日志是模型所见上下文的来源。`deriveMessages()` 从中投影出模型历史，原始 `assistant/chunk` 事件则保证回放和 UI 保真。fork、恢复、transcript（文本记录）、遥测和持久化都派生自该事件流。

**模型可见即已记录。** 抵达模型请求的一切都必须能从日志重建，并由一项运行时不变量断言这一点。因此，新增一项模型可见输入就需要新增一个会话事件：扩展 `SessionEventMap` 并从日志渲染。

## Graph Mode

[`dsh-graph`](../packages/graph/graph/README.zh.md) 在不修改 agent loop 的前提下增加会话所有的多代理编排领域。`/graph` 激活主控策略和 `graph_submit` 工具。主控会判断之后的每次人类输入：新任务创建新的不可变 DAG；调整则为当前任务图创建下一个修订。任务图定义和完整运行快照都是会话事件，因此重新加载、检查和 Web 投影会重建相同的修订与证据。

有顺序的长目标会在 Revision 层之上使用 Campaign。每个 Batch 拥有独立 Graph 且只包含当前工作；Campaign Event 保留 Batch 依赖、状态、紧凑结果与 Settlement 引用。已登记 Batch 定义构成不可变前缀；全部已登记 Batch 验收后，主控可以把新发现的有序后缀作为可审计计划修订追加，并持久保留原因、前序 Run 与 Settlement 证据。成功 Batch 通过主控 Follow-up 激活下一个就绪 Batch，修正则只调整失败 Batch Graph。这样会把跨任务历史与任务内修订谱系分开，避免已完成节点不断堆积到后续 DAG。

[`dsh-graph-mode`](../packages/graph/graph-mode/README.zh.md) 通过 [`dsh-graph-worker`](../packages/graph/graph-worker/README.zh.md) 接口调度已就绪节点。必需边要求前置节点完成；结构化条件边只检查已发布 JSON，不包含可执行代码。修订先找出直接变更节点，再按拓扑顺序让所有传递后继失效。不在该闭包内的成功节点保留已发布输出，并记录明确来源。子代理启动前，准入器同时执行全局、角色、精确提供方／模型及可选加权限额；主控预留会阻止 worker 饱和占用全部配置许可。可选的 [`dsh-graph-resources`](../packages/graph/graph-resources/README.zh.md) 提供方可以根据会过期的路由遥测进一步延迟或拒绝工作，但不能提高这些静态上限。

宿主变更使用显式环境节点，而不是扩大 Worker 权限。主控会在依赖它的工程工作之前放置有界的精确命令计划，并列出所需的网络、包安装或 Docker 能力。部署策略校验计划后，Graph 会停在人工检查点。批准仅对下一个执行 Generation 生效；Graph Mode 通过 Shell 能力执行不可变命令并记录稳定 Settlement，绝不会给模型子 agent 开放式高权限轮次。失败、不确定或回滚副作用都需要新的人工决定。

每个不可变节点都携带已解析的执行预算，覆盖模型输出、无持久进度的推理、首次动作、进度静默、检查点、墙钟时间和续跑次数。准入前，Graph Mode 会解析精确 LLM 路由、校验推理强度、用实时资源信息共同限制输出与并行度，并把实际模型画像保存在 Attempt 中。子会话事件会把模型活动与可恢复工程进度分开；只有成功的文件修改、聚焦验证命令和已接受的结构化结果会推进检查点。达到 token 上限或被看门狗终止的 Activation 只能从持久检查点续跑。停止时没有检查点则会把精确路由、容量、预算、计数器和最新证据交回主控；主控必须把不安全工作修订成 10–30 分钟且可独立验证的节点，而不能重新分派同一粗粒度任务。

整图运行所有权与节点执行相互独立。[`dsh-graph-scheduler`](../packages/graph/graph-scheduler/README.zh.md) 向获准推进运行的 Host 授予一个可过期且带围栏的租约；Graph Mode 在调度期间持续发送心跳，并将其 token 用作 `ownerEpoch`。恢复扫描会重新取得没有本地执行器的 `queued` 或 `running` 持久工作，而仍然存活的租约会阻止重复执行。Graph 状态读取会优先使用持续增量维护的 Session Projection，避免大日志阻塞租约 Heartbeat。SQLite Provider 在本地 Host 进程之间串行化所有权，并在租约过期和重启后保留 fencing 计数。多 Host 部署应替换为经过认证的分布式 Provider；LoopX 节点 claim 不能替代这一租约。

外部进度协调是独立的 capability seam。[`dsh-graph-coordination`](../packages/graph/graph-coordination/README.zh.md) 管理准备、带围栏的认领、心跳、观察与等待、有限进度、取消、结算和对账；[LoopX 提供方](../packages/graph/graph-coordination-loopx/README.zh.md) 将这些操作映射到已有 goal 和已注册 peer。认领已经终态的 Activation 时会返回其已接受的 Terminal Disposition，绝不会再次分派 Worker。Graph 在接受终态前持久化操作、Worker、工作区、模型预留、产物、结算、检查点和人工控制证据。Harness 仍是执行和会话轨迹的权威来源。协调记录只接收有长度上限且可公开的摘要，子代理消息和工具事件保留在对应子会话中。

产物传输也是可替换的 Seam。[`dsh-graph-artifacts`](../packages/graph/graph-artifacts/README.zh.md) 把每份 Manifest 绑定到一个带 Fencing 的 Attempt，并校验路径、结果 Hash、源 Hash、总字节数和 Provider 所有权。隔离实现 Attempt 会把完整 Manifest 持久化到 Graph 运行证据。集成节点收集所有传递上游 Manifest，在任何 Materialize 之前拒绝同路径分歧和源工作区漂移，以稳定 Settlement 导入每份 Manifest，并让自身已接受的 Manifest 通过相同检查。文件系统 Provider 为共享同一文件系统的 Host 存储不可变 Blob；经过认证的对象存储或 RPC Provider 可以替换它，而无需修改 Graph Mode 或 Worker Assignment。

远程执行使用 [`dsh-graph-worker-remote`](../packages/graph/graph-worker-remote/README.zh.md)。其 HTTP Client 与 Server 通过 Credential Reference 认证 Worker、Scheduler、Resource 和 Artifact 操作，在分派前持久化确定性的逻辑作业身份，对丢失响应后的重试去重，使用持久化服务 Epoch 阻止被替代进程继续写入，在重启后隔离不确定的非终态作业，并把对账映射到精确底层 Provider 引用。可选路由会公开跨 Host Scheduler、Resource 权威源和带持久化不透明映射、端到端摘要校验的有界内容寻址 Artifact 传输。SQLite Resource Provider 可以根据可信模型运行时或 Sidecar 发布的带过期时间队列与设备显存 Snapshot 拒绝放行。Worker Journal 只是单个活动服务的持久化权威；它不提供可恢复远程进程、复制式高可用、原生模型服务器指标适配器或对象存储。

## 能力 seam

一个 **seam** 是一项可替换能力，包含三种角色：声明接口的 **Service Definition**、实现它的 **Service Provider**，以及使用它的 **Consumer**（通常是面向模型的工具）。一个包可以合并承担多个角色，但单一角色本身不是 seam；添加一项能力意味着把三者一并设计（[能力图](capability-seams.zh.md)）。

seam 正是替换一个提供方就能改变整个产品的原因。文件系统与进程提供方共享同一个执行世界，因此把它们指向远程沙箱，也就把 Bash、PTY 和 LSP 一并搬了过去，无需提供方专用 fork。[subagent 提供方](subsystems/subagent.zh.md)在同一个接口之后同样千差万别，从新建一个子 agent，到把一个轮次委派给另一个产品。

[实验性 Agent Teams](subsystems/agent-team.zh.md) 是 `ctx.agentTeams` 上的私有显式启用协作 seam，在可继续 subagent 之上提供持久 roster、任务板和 mailbox。

## 新行为的归属位置

新行为附加到已有文档记录的扩展点。改动循环本身时，本映射随之更新。

| 目标 | 机制 |
|---|---|
| 添加模型提供方 | 在 `ctx.llm` 上注册其适配器 |
| 添加面向模型的能力 | 在 `ctx.tools` 上注册；其 schema 加入提示词组装 |
| 让某个会话拥有不同的能力集合 | 组装一个 agent preset；其中的服务行需要 `isolate` realm |
| 添加 shell 执行 | 注册 `ctx.shell` 后端；本地后端通过 `ctx.subprocess` spawn 进程 |
| 添加持久化终端执行 | 注册 `ctx.terminals` 后端和 `dsh-tool-terminal` |
| 添加用户命令 | 在 `ctx.commands` 上注册；它无需模型轮次即可分派 |
| 添加后台工作 | 在 `ctx.jobs` 上注册；`job_*` 工具负责收集或停止 |
| 编排有依赖的多代理工作 | 使用 `dsh-graph-mode`；通过 `ctx.graphCoordination` 替换外部协调提供方 |
| 添加文件系统访问或策略 | 注册 `ctx.fs` 提供方，或监听 `fs/*` 事件 |
| 限制所启动的进程 | 使用 `ctx.sandbox` 后端；消费方在启动进程前包装 argv |
| 拦截请求、工具或轮次 | 使用相应的 `agent/*` 或 `tools/*` 事件；`agent/turn-stopping` 会停止轮次 |
| 添加模型可见上下文 | 调用 `agent.inject()`；它会落到下一次获准的请求中 |
| 添加 UI 或编辑器集成 | 驱动 `ctx.agents` 并从 `session/event` 渲染 |
| 添加 Web Client Chat 节点 | 注册 `ConversationNodeDefinition` + keyed renderer |
| 添加持久会话状态 | 扩展 `SessionEventMap`；从日志渲染和回放 |
| 生成会话标题 | 注册唯一的 `ctx.sessionTitle` 提供方 |
| 管理同会话目标 | 使用 `ctx.goals`；通过 `agent/*` 续跑 |
| fork 活跃会话 | `ctx.sessions.fork(source, boundary?, childSessionId?)` |
| 将注册项限定到单个 agent | 使用该 agent 的 `agent.ctx` |

[扩展实操手册](cookbook/extension-cookbook.zh.md)将功能映射到能力，并索引[包](cookbook/adding-a-package.zh.md)、[工具](cookbook/adding-a-tool.zh.md)、[LLM（大语言模型）适配器](cookbook/adding-an-llm-adapter.zh.md)、[Chat 节点](cookbook/adding-a-conversation-node.zh.md)和[设置卡片](cookbook/adding-a-settings-card.zh.md)的分步指南。
