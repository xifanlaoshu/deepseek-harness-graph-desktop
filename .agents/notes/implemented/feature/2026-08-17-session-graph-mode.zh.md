# Agent Note: 会话 Graph Mode

Status: implemented

[English](2026-08-17-session-graph-mode.md) | 中文

## 问题

一个主控轮次可以委派相互独立的子代理，但会话没有持久化表示来描述持续变化的依赖图。父代理必须自行记住哪些结果供后续任务使用、哪些任务可以并行，以及用户调整早期要求后哪些已完成工作已经过期。这也让模型并行度保持隐式；即使每个子代理都各自有界，一次有效的扇出仍可能压垮本地提供方。

[动态工作流决策](2026-07-05-dynamic-workflows.zh.md)解决由模型编写、在一次调用内执行的脚本编排。它的 JavaScript 正文和前台运行并不适合一种会话模式：后者的任务图必须能跨用户轮次编辑、检查和回放。

## 决策

Graph Mode 是位于 `packages/graph/` 的会话所有插件族。`dsh-graph` 管理版本化配置、不可变任务图修订、完整运行快照、校验、下游失效传播和 `graph` 投影。`dsh-graph-mode` 管理 `/graph`、主控策略、`graph_submit`、精确命令环境检查点和后台调度器。`dsh-graph-worker` 定义面向具名本地或远程 Worker Provider 的带围栏分派，`dsh-graph-resources` 定义位于静态上限之下、可选且会过期的观察与预留。`dsh-client-ui-graph` 渲染投影，并通过命令通道发送经过校验的完整配置替换。

启用的角色中必须恰好有一个主控。Graph Mode 激活时，它的系统策略要求把每次人类输入判定为新任务、修订、检查、控制、澄清或直接回复。主控提交不含 graph 或修订身份的语义任务和依赖。Graph Mode 为新任务推导安全且无冲突的 id，根据会话投影分配修订身份和谱系，丢弃 Host 所有的身份提示，并根据不可变结构推导直接变更节点。新任务从修订一开始；调整会创建当前任务图的下一个修订，并重新执行推导变更的完整传递后继闭包。闭包之外的成功节点只能携带 `reusedFrom` 来源后复用；旧修订和旧运行永不改写。当更早修订中已验收节点的 id 在当前计划中重新成为待处理项时，规划检查点会提供其验收结果、语义定义和入向依赖。主控必须原样保留仍有效的已验收节点，只规划缺失工作与验证；把已验收工作改名为成果保留或基线发现会在没有新证据的情况下使复用失效。

有顺序的长目标会在多个独立 Batch Graph 之上使用 Campaign。第一个 Batch Submission 携带初始有序计划，并且严格绑定到计划列出的第一个 Batch；收到完成 Follow-up 后，后续每次 Submission 都省略该计划，只绑定到指定的下一个 Batch。已登记 Batch 定义构成不可变前缀。[Campaign 计划追加决策](2026-08-24-append-only-campaign-plan-revisions.zh.md)允许在全部已登记 Batch 验收后追加一次可审计后缀，同时不修改现有定义或 execution。每个 Batch 获得自己的 Graph ID，并且只保存本批节点、Revision 与 Run。Campaign Event 保留依赖、状态、执行摘要和已确认 Settlement ID。已通过 Batch 会通过主控 Follow-up 激活下一个就绪 Batch，拒绝或执行失败则只在当前 Batch Graph 中创建 Revision。替换准入会等待前一个 Run 静止，然后重新读取已接受的 Campaign 投影，在追加新 execution 前原样保留每个已结算 execution。已经通过的 Batch Graph 保持不变，后续通过紧凑持久证据消费它们，而不会复制其节点。

任务图边是数据。必需边规定完成顺序；条件边在前置节点发布的 JSON 上计算 `exists`、`truthy`、`equals` 或 `not-equals`。只有所有入向条件边都生效，节点才会运行。修订进入会话日志前会拒绝可执行谓词和环。每个子代理发布受 schema 约束的摘要、JSON 数据和产物路径。它的消息和工具事件保留在执行尝试记录所指向的子会话中。

外部认领和子代理创建之前先执行准入。一个 FIFO 控制器同时执行全局上限中的 worker 份额、角色上限、精确提供方／模型上限和可选的模型加权上限。`controllerReserve` 从 worker 份额中移除许可，避免扇出耗尽为主控配置的容量。角色的提供方、模型、推理强度、提示词和上限都是可由用户编辑的持久设置。Graph Mode 启用时，主控角色会覆盖父级提示词组装和 `agent/request` 路由；工作角色选择会成为子级 `AgentOptions`。初始推理强度是 `AgentOptions` 输入，并由子代理继承；continuable subagent 描述符现在会显式持久化该值，以供冷恢复。

宿主前置条件使用由[环境操作决策](2026-08-22-graph-environment-operations.zh.md)管理的不可变 `environment` 节点。它们把已精确批准的 Shell 命令与普通模型 Worker 权限隔离，并把自身完成作为依赖工程节点的前置条件。

外部协调是可替换 seam，而不是调度器状态。`dsh-graph-coordination` 定义准备、认领、心跳、观察／等待、进度、取消、结算和对账。`dsh-graph-coordination-loopx` 在准备阶段校验已有 LoopX goal 和角色到 peer 的映射。节点进入 ready 并通过准入后，claim 才按需创建或重新发现带 Graph 标签的 todo，使用角色已注册的 peer 认领，并返回带围栏租约和紧凑 observation。主控可以声明相对工作区所有权，但不得声明物理分配 ID 或绝对路径。草稿准入会解析省略的读取根和清理策略，并在持久修订校验前按准确字段路径拒绝畸形根。可并行的变更型主控节点必须在准入前声明互不重叠的写入根。LoopX 会扩展每个精确根以覆盖其后代，只在所有权未指定或覆盖整个工作区时使用部署 `writeScopes`，并为只读 Activation 分配互不重叠的私有 Scope。成功时 todo 会以禁止 follow-up 的方式完成，最终失败则转为 blocker。Harness 仍是执行与会话轨迹的权威来源。默认 Web bundle 以禁用状态交付该提供方行，因为 goal id 和 peer 身份属于部署；启用后，LoopX 或绑定不可用会明确失败。

LoopX CLI 响应收集量可通过 `stdoutMaxBytes` 和 `stderrMaxBytes` 按部署配置。stdout 默认值可容纳包含数百条 Todo 的 Goal Registry；Provider 会区分输出收集被截断和 JSON 格式错误，避免 Registry 增长把合法的 `todo list` 误报为解析失败。

Graph 持久化稳定逻辑 Work、Generation 作用域的 Activation、Operation、Submission、Settlement、Checkpoint 与 Control ID。系统会在 Scheduler Acquire 或 Coordination Prepare 前 Flush `graph/submission`，并且只有带所有权的 Queued Run 才能让 Revision 成为当前 Head。Resource Reservation、Coordination Claim、Running Attempt、Worker Dispatch、Staged Output、Artifact Integration、Cancellation 与 Settlement 都位于已持久化意图或已接受引用之后。Scheduler Lease 只会显式移交给后台执行一次；移交前失败会释放 Lease，本地准入后、Worker 分派前失败则会终态结算已取得的 Coordination Claim、释放已取得的模型预留并归还本地许可。LoopX 在硬租约获取失败时会清除 Todo 的软认领并把它标记为 Blocked。分派前，Graph 会解析精确模型能力与实时资源画像，限制节点预算并保存在 Attempt 中。恢复会提高 Owner Epoch，对账 Worker 与 Resource 引用，使用稳定 ID 重复 Staged Settlement，并为每个新 Generation 分配独立 Coordination Activation，同时保留逻辑 Work ID 表达谱系。每个存活 Agent 都会扫描没有本地执行器的持久非终态工作并尝试带 Fencing 的重新认领；Busy Lease 会让运行保持不变，等待后续扫描。没有 Worker 引用的 `reconcile` 节点可以重新分派，因为模型控制的副作用尚未开始；已存在 Worker 引用时仍要求对账证据。组合提供 Projection Registry 时，主控和调度器会读取持续增量维护的 Graph Projection，避免在 Heartbeat 敏感路径中反复重放完整日志。手动、冲突、未知或清理失败的结果保持在 `awaiting_user`。

本地隔离副本 Worker 会执行声明的写入根并发布有界内容寻址变更清单。每份 Assignment 都会让模型看到已解析的模式和相对读写根。进程内隔离子 agent 会收到 `workspace-write` 沙箱上限，只读快照子 agent 会收到 `read-only` 上限，因此父级权限变更不能授权它们越出分配。每个变更普通文件都包含复制工作区中的源 Hash，依赖目录与包管理器缓存目录名会在复制与捕获期间从任意目录深度排除。尚未发布的分配若在校验或子级启动期间失败，则一定会被删除。删除和未声明写入结果是不可重试的：Graph 会保留精确错误，在第一次 Attempt 后打开规划检查点，并要求主控在分派替换工作前修正任务或工作区所有权。Web Profile 默认使用隔离副本。Graph Mode 会通过对应 Provider 和稳定 Artifact Settlement 校验并 Materialize 每份已完成 Manifest，然后才发布节点成功。分配任何后继节点前，它还会对账传递上游 Manifest，从而恢复采用渐进发布机制之前的运行所接受的文件。已经存在的相同内容不会重复写入；同路径分歧和源工作区漂移会在写入前失败。独立 Integration 节点负责跨节点冲突处理、验证和删除；隔离删除和符号链接集成会显式失败，而不会被推断或覆盖。

终态 Coordination Settlement 的生命周期独立于 Worker Cancellation Signal。停止协调心跳时会等待已经提交的续租完成；每次进度、取消或终态写入都会先观察当前 Claim，并且只接受同一 Claim 上未倒退的租约身份。Confirmed Cancellation Request 不是终态结果，也不授权替换工作。每条活动取消路径都会持久化 Settlement 意图、请求协作式取消、停止 Worker，并为对账保留终态证据。活动任务的修改控制会先走这条取消路径再进入 `awaiting_user`，防止已失效节点开始下一次内部尝试；普通运行暂停则会排空当前 Attempt。任务修改只发送专用的主控 Follow-up，并抑制调度器针对同一检查点生成的通用规划 Follow-up。Run 只有在所有活动节点 Attempt 完成取消和有界 External Cleanup 后才发布终态 Snapshot，并会关闭该次调度执行的节点更新入口，使迟到的 Worker Monitor 回调无法重新打开 Run。因此，替换 Revision 只会得到一个已经静止的前序 Run Snapshot。同一 Revision 的 Retry 保留逻辑 Work ID，但获得另一个 Activation，因此不可变的终态 Todo 不会阻塞后续 Generation。控制节点结果校验先于输出暂存、产物物化、资源完成和终态协调结算；通过 Schema 但语义无效的结果会让 Claim 保持非终态，以便在当前 Activation 内执行有界重试。输出暂存后的写回失败会创建 `awaiting_user` 对账检查点；恢复会在 Attempt 耗尽判定前重试稳定 Settlement，且不重新运行 Worker。External Cleanup 使用配置的 Deadline 和调用方 Abort Race；忽略 Signal 的 Provider 无法无限阻塞卸载，未完成的清理会保留可恢复 Pending 证据。

Web bundle 挂载任务图领域、Worker 与资源 Service Definition、本地 Worker Provider、主控和 `ui-graph`。只有投影处于激活状态时，会话标题栏按钮才存在。横向面板把不可变设计与实际执行记录分开，展示修订选择、条件边、节点阶段／输出／产物／执行尝试、实际 Worker／模型／推理路由与容量、精确 Token 计数、最近模型活动、最近持久进度、工作区、等待、LoopX claim id、检查点、Settlement，以及权威子会话入口。操作者可以停止活动工作、把节点交回主控、从检查点恢复，并使用不同的角色、模型、推理强度、Worker、输出上限或纯推理上限重启节点及其后继。设置页打开期间会保留可丢弃的编辑草稿，防止无关的运行投影替换用户输入。保存操作位于可滚动角色列表之外，会报告命令级拒绝，并通过 `/graph config <JSON>` 替换会话配置，由 Host 校验后追加事件。模型下拉框读取由设置功能维护的共享模型目录。已选模型只能使用其公布的推理强度；编辑器会阻止保存不受支持的角色值，并允许用户清空或替换已有的无效值。未公布推理元数据的模型会禁用已经为空的推理字段。编辑器关闭后，只有已记录的投影是权威状态。

调度执行排空后，暂停、取消、重试、恢复或替换 Revision 的控制操作会终态结算更早失败 Attempt 遗留的 Claim，替换工作才能认领重叠作用域。已确认的终态 Coordination Settlement 仍是权威结果，不会再次取消。

Pending Submission 的原始激活与启动恢复共享一个 Single-flight 身份。提交激活仍在运行时，恢复不能重复 Scheduler Acquire 或 Coordination Prepare；执行清理也只能删除仍由当前 Promise 拥有的 Run 条目。

Activation 已接受的终态在 Claim 阶段同样幂等。Memory 与 LoopX Provider 会返回其结果和证据，而不会再次认领；LoopX 在调用 CLI Claim 前检查持久 Journal 与 Todo 当前状态。Graph 不会从该 Terminal Disposition 分派 Worker；本地持久证据仍需对账时，会保留稳定的 Run 级 Coordination Error。

Web UI 在所选 Graph 上方放置有序 Campaign Batch 轨道。每张卡片会打开一个独立的当前或历史 Batch Graph，因此界面可以保留跨 Batch 历史，而不会把已完成节点合并到活动 DAG，也不会改变持久 Current Graph 状态。

## 验证

领域测试覆盖配置、DAG 拒绝、主控计划身份解析、并行工作区准入、临时 Submission 回放、Run Replacement、失效传播、输出复用、Timer 上限、Checkpoint 与 Artifact。工具边界用例证明缺失或畸形的 graph-id 提示会得到安全的 Host id，过时的谱系、时间戳和终止字段无法覆盖当前投影，并证明无需主控提示即可推导变更节点。工作区草稿用例证明省略读取根与清理策略时采用默认值，并验证畸形根的准确诊断。Scheduler 测试除准入、Worker、Resource、Artifact、Cancellation 与恢复外，还覆盖失败持久化屏障、Scheduler 拒绝且 Head 不漂移、Pending Submission 恢复、孤儿 Run 自动重新认领、存在存活执行器时对账返回 No-op、通过 `MemoryGraphCoordination` 执行同一 Revision Retry、不可重试工作区失败在一次 Attempt 后返回主控、Worker 停止时仍在完成的续租、两个活动 Worker 以不同速度完成取消时进行 Revision Replacement、节点 Attempt 上限后的仅结算恢复，以及控制 Generation 在重新认领前结算前一 Attempt 遗留的 Claim。Projection 覆盖证明组合 Registry 时 Graph Mode 会读取实时增量状态。本地 Worker 测试覆盖沙箱上限、相对源根的多路径段排除，以及包根以下的嵌套依赖或缓存目录名。LoopX 测试覆盖按 Activation 建立 Key 的一致性、从工作区推导租约 Scope、重建 Provider 后使用持久 Claim Settlement、CLI Timeout、有限响应收集、Journal 丢失修复，以及不同 Activation 的 Settlement 并发。Client 测试覆盖 Graph 可见性、布局、控制、模型与推理选择、Timer 校验、设置序列化、恢复控制和卸载。无密钥 Headless Snapshot 挂载发布的 Graph 插件，按准确路径拒绝空工作区根，接受修正后的重试，并固定终态 DAG Event 与最终综合。

启用 LoopX 的真实 Web profile 运行验证了完整组合路径。一个四节点任务图先运行 source 节点，两个独立的 review 与 verification 节点相隔一毫秒启动，并且 result 节点只在两个条件前置都完成后启动。运行最终为 `succeeded`，结果数据包含两个条件，四个子会话和 claim 均被保留，四条 LoopX todo 均以 `--no-follow-up` 到达 `done`，生成的 source 与 result 文件包含精确预期标记。另一个单节点浏览器运行也已完成，且没有运行级或尝试级错误。

一次浏览器修订运行通过真实 LoopX CLI 覆盖了取消补偿。修订一认领了一个子代理正在执行 `sleep 30` 的节点，修订二在其活动期间进行替换。第一个运行和子会话以明确的父级取消结束，其已认领 todo 转为不可执行的 blocker；替换运行创建了不同的 claim，并以 `--no-follow-up` 到达 `done`。父会话与两个完整子会话日志合计包含 362 条可解析记录和 194 个完整 Zstandard 帧，没有残缺帧、工具失败、步骤失败或意外错误事件。替换运行的产物包含精确预期的 3 个字节，而取消运行的产物不存在。

## 曾考虑的替代方案

**扩展动态工作流。** 工作流脚本在一次工具调用内不可变，并且有意允许通用 JavaScript。加入跨轮次变更、会话修订语义和常驻主控会混合两个各自有用的产品，并让持久化任务图数据继承可执行条件风险。

**让 agent loop 分发任务图。** 否决，因为命令、提示词、工具、投影、subagent 和 UI 扩展点已能提供该行为。让默认驱动器理解任务图会把可选组合变成特权 loop 策略。

**原地修改一个任务图记录。** 否决，因为检查时将无法区分原始证据和修订工作，部分写入还可能让下游结果看起来仍然有效。不可变修订和显式复用让每个答案都有来源。

**自动创建并注册 LoopX goal。** 否决，因为 LoopX registry 和 peer 身份属于外部管理权限。Harness 可以向选定 goal 添加 todo，但不得静默编造部署身份或把工作改送到新的控制面。

## 后果

Graph Mode 在不修改 Loop 的情况下让依赖感知的多代理工作可见、可修订、可恢复并可独立路由，并使并行度成为可执行的准入决策，而不是主控建议。代价是增加 Submission、会话、子会话、Operation 与 Settlement 记录及部署配置。静态上限会降低 OOM 风险；只有 Resource Provider 才能观察实际模型服务器或设备状态。恢复可以通过新 Activation 重试终态逻辑 Work，也可以通过持久 Claim Todo ID 结算已暂存 LoopX 输出，但没有 Provider Reconciliation API 时仍无法证明任意外部效果。按需创建 Todo 可避免为已取消、已跳过或永远不能进入 Ready 的节点产生推测性外部工作。只有部署提供已有 Goal 和完整角色到 Peer 的映射后，LoopX 协调才可用。
