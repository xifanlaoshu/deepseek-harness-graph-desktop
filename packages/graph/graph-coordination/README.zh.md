# `@deepseek-ai/dsh-graph-coordination`

[English](README.md) | 中文

这是 Harness 会话日志之外的任务图 worker 协调 Service Definition。提供方为不可变任务图修订准备工作项，用最新的紧凑观察信息准入并认领每个节点，然后记录终态证据和进度。调度器仍负责子代理执行、DAG 依赖、重试和持久化运行快照。

Protocol Version 3 同时携带稳定逻辑 `workId` 与 Generation 作用域的 `activationId`。Provider 按 Activation 为可变 Claim、Lease、Progress、Cancellation、Observation 和终态建立 Key；逻辑 Work 仍是 Graph 失效传播与人工控制使用的谱系 Key。终态 Activation 不可变，但不会阻止后续 Generation 以另一个 Activation 认领同一逻辑 Work。

该接口只传递可公开的摘要。原始提示词、会话轨迹、凭据和私有路径保留在 Harness 会话中，不得复制到协调提供方。

即使工作代理已被取消，Consumer 也必须为终态结算提供可用信号，并在释放提供方之前等待结算完成。这样可以确保取消、修订替换和卸载不会让已认领的外部工作项继续保持可执行状态。

心跳会返回当前的 lease id 和 fencing token。Provider 可以在续租时推进该身份；Consumer 必须持久记录新身份，并且后续心跳、取消、对账和终态结算只能使用最新返回的身份。

每个 Provider 都会运行共享的八操作一致性套件。该套件联合验证 prepare、claim、heartbeat、observe/watch、进度、取消、结算与对账，并覆盖重复投递、冲突载荷、过期 fenced 写入、有序取消观察以及匹配或冲突的终态证据。

## 模型体验

### 协调观察

#### 模型看到的内容

工作代理可以收到 `GraphCoordinationService.claim()` 提供方针对其已认领节点生成的最新公开安全观察。消费方决定将该文本放在何处，并且不得暴露原始协调传输细节。

#### Token 影响

提供方为每次节点尝试至多贡献一条观察，其实现负责限制观察长度。

#### KV Cache 影响

观察是尝试特有的后缀，因此不会在不同节点之间提供稳定的缓存内容。

## 已知限制与待完成工作

- Service Definition 不持久化或恢复提供方状态。每个提供方自行负责外部身份、可用性、观察长度限制和恢复策略。
