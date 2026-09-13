# `@deepseek-ai/dsh-graph`

[English](README.md) | 中文

新的 `graph/submission` 记录会携带由 Host 解析的 `GraphRevisionLineage`。其中品牌化逻辑任务 ID、`new_task`、`analysis_refactor` 或 `execution_correction` 分类、触发证据、类型化关系、成功条件和结构节点差异会说明该不可变 Revision 为什么存在。新 Graph 启动独立任务泳道；普通修订通过 `refactors` 或 `corrects` 指向父修订；Campaign 依赖通过 `depends_on` 跨泳道连接。回放接受没有 lineage 的旧记录并明确保留“来源未知”，不会虚构历史意图。

`dsh-graph` 负责 Graph Mode 多代理编排的持久词汇与重放规则。它提供可编辑的软件工程角色默认值、不可变 DAG 修订、初始运行 checkpoint 与增量运行更新、确定性条件边、下游失效计算以及 `graph` 会话投影。

`graph/submission` 是候选 Revision 与 Queued Run 的持久临时记录。Pending Submission 不会改变 `currentGraphId`；Consumer 会先建立外部 Run 所有权，再追加不可变 Revision、Run、Planned Operation 与 Accepted Submission 结果。Failed Submission 可审计，但不会创建 Head Revision。Coordination 会同时使用 Generation 作用域的 `GraphActivationId` 与稳定逻辑 `GraphWorkId`。

`graph/campaign` 把一个有序的长流程目标关联到多个独立 Batch Graph。每个 Batch 只保留自己的不可变 Revision 与 Run；Campaign 记录依赖、验收状态、紧凑执行摘要和已确认的 Settlement ID。已出现在接受 Event 中的 Batch 定义不可变。全部已登记 Batch 验收后，一次计划扩展可以追加非空有序后缀；它会递增 `planRevision`，并记录原因、新增 Batch ID、来源 Batch 与 Run 以及已确认 Settlement ID。扩展不能插入、重排、移除或替换已接受前缀。一个 Batch 通过后会激活下一个就绪 Batch，主控提交会为后者创建另一个 Revision 1 Graph，而不会把历史节点复制到越来越大的 DAG 中。修复仍然是当前 Batch Graph 的 Revision，Campaign 历史则保留各批次之间的关系。

Host 插件在追加 `graph/change` 前用 `validateGraphRevision()` 校验主控输出。每次调整都会创建下一个不可变修订。`downstreamInvalidation()` 按拓扑顺序返回直接变更节点和所有传递后继；调度器据此标记或取消这些节点，并执行新修订，而不改写此前证据。另一个 Revision 或 Generation 复用未受影响的已接受结果时，会记录精确的来源 Run、Generation 和 Node；过期失效元数据会被移除，避免把复用误报成重新执行。节点尝试保留子会话与 LoopX claim 标识，详细消息和工具事件仍由子会话日志持有。

默认团队包含一个主控，以及分析、架构、环境操作、工程、评审、验证、浏览器测试和文档角色。每个角色的提供方、模型、推理强度选择器、提示词和并行度均可编辑。全局、模型、可选加权和活动子代理限制都是硬准入输入；主控预留许可避免工作代理占满资源后饿死意图判定。`maxActiveSubagents` 统计同一次 Run 中每个存活 Graph Worker 及其进程内后代。缺少该字段的历史会话配置会根据自身保存的 Worker 份额推导限制，而不会读取后来修改的全局模板。由于本包不会宣称相应 Provider 无法执行的工作区或浏览器页面隔离，工程与浏览器测试角色的默认并行上限均为一。

`controllerResilience` 保存有序且明确的兜底路由、适用失败码、每轮兜底上限和 Graph 自有的压缩设置。该字段为可选字段，因此历史配置会保留原有路由与压缩行为。新默认值会启用策略但不包含兜底路由；高级模型必须由部署或用户明确选择。

`environment` 节点把有界宿主操作计划与模型工作分开记录。其不可变定义会列出所需的 `network`、`host-package-install` 或 `docker` 能力、请求的沙箱模式，以及一至十六个按顺序执行的操作；每个操作都包含精确命令和可选的说明性回滚命令。环境节点必须使用保留的共享工作区、`manual` 副作用策略、单次尝试和适合人工审批的计划长度。已解决的环境检查点只授权下一个执行 Generation；重放会拒绝缺失、过期或可重复使用的授权。Operation 与 Settlement 记录会保留命令身份和终态事实，但不会把命令输出写入父会话。

条件通过路径和 `exists`、`truthy`、`equals` 或 `not-equals` 之一检查前置节点发布的 JSON。多条入向条件边采用合取语义：只有每个条件都生效，节点才会运行。图定义不能包含可执行 JavaScript、重复边、缺失角色或环。`graph/run` 建立一个 Generation checkpoint，后续 `graph/run-update` 只携带发生变化的节点状态和 Run 级字段。重放会在合并更新前校验身份、围栏、时间与终态单调性，因此即使没有启动子代理尝试，协调和调度失败仍然可见。

执行策略中的毫秒字段不得超过 `MAX_GRAPH_TIMER_MS`（`2_147_483_647`），这是 Node Timer 不发生钳制或拒绝时可接受的最大延迟。Domain 校验会在 Host 构造 Timer 前拒绝更大的持久配置。

人工与主控操作是带版本的持久记录。每条记录把稳定操作 ID 与精确任务图、设计 Revision、运行 Generation、可选节点 Attempt、经认证的操作者、入口来源、有长度上限的原因、`applied` 或 `no-op` 结果、产生的 Generation 或 Revision，以及本次变更失效或复用的节点 ID 绑定。替代节点输出必须通过节点 Schema 校验，并同时保存在控制记录和节点状态中，且保留其控制操作来源。投影回放会拒绝冲突的重复 ID、无效来源，以及指向不可能 Revision 或未来 Generation 的控制记录。

## 模型体验

### 任务图修订规划

#### 模型看到的内容

主控会看到配置后的角色目录和当前任务图标识，然后通过 `graph_submit` schema 发布完整的任务图修订。工作代理内容由 `dsh-graph-mode` 负责渲染。

#### Token 影响

每次启用 Graph Mode 的主控请求都会加入一次角色目录和当前任务图标识；持久领域本身不会向工作代理请求添加文本。

#### KV Cache 影响

设置未变时，稳定的角色目录可以在主控轮次之间复用前缀；创建新任务图或激活新修订时，当前任务图标识会发生变化。

## 已知限制与待完成工作

- 本包提供持久领域与投影，不负责执行。Graph Mode 主控、本地调度器、LoopX 适配器、Host API 和画布 UI 分属独立插件，使部署可以分别替换这些角色。静态并发上限可以降低 OOM 风险，但没有提供方或操作系统资源遥测时无法保证内存安全。
