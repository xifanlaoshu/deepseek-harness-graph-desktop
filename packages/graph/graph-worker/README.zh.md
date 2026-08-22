# @deepseek-ai/dsh-graph-worker

[English](README.md) | 中文

`ctx.graphWorkers` 是把一个带 fencing 的 Graph 节点 Attempt 分配给命名本地或远程 Worker Provider 的 Service Definition。它验证协议和能力要求，Provider 负责工作区分配、子级执行、取消、制品暂存和终态资源分类。

## Contract

- Assignment 在 Provider 接受前冻结 Graph Work、Operation、Attempt、Run Generation、Owner Epoch、Fencing Token、角色、节点、提示词、输出 Schema、工作区策略、Deadline 和工具策略。
- Provider 声明支持的工作区模式，以及是否支持远程执行、结构化输出、工具过滤、Artifact Manifest、进度和取消。不支持的要求在分发前失败。
- 已发布 Run 拥有一个工作区分配、协作式取消和一个终态结果。Outcome 区分模型完成、取消、基础设施失败、Token 耗尽、容量拒绝、OOM 和路由不可用。
- 恢复通过 `reconcile()` 精确寻址先前 Worker 和工作区。Provider 返回 `canceled`、`deleted`、`retained`、`absent` 或 `quarantined`；只有调度器明确证明重放具备幂等性且清理策略允许时，Provider 才能删除分配。
- Artifact Manifest 是内容寻址的 Provider 引用；Provider 在发布前必须验证相对路径、Hash、Mode、大小和 Attempt 归属。
- Service Definition 不选择 Provider、不分配资源、不解释模型输出，也不集成制品。这些职责分别属于 Graph Mode、资源 Consumer 和 Integration 节点。
- 每个 Provider 都运行共享 Worker 一致性测试套件。该套件验证能力声明、终态前发布的 Worker 与工作区引用、唯一的完成或取消终态结果、协作式取消，以及拒绝不匹配工作区的精确活动 Worker 对账。

## Model Experience

### Worker evidence

#### What the model sees

Graph Mode 可以选择有界公开 `GraphWorkerResult` 证据。除非主控或节点 Schema 显式选择字段，否则 Worker ID、工作区路径和制品传输保持为 Host-only。

#### Token effect

本能力不增加请求内容；Graph Mode 负责 Worker 提示词和所有被选择的证据。

#### KV Cache effect

没有直接影响。

## Known Limitations and Deferred Work

- 本包与 Provider 无关，不会把共享工作区变成隔离工作区；具体 Provider 只能声明自己真正执行的模式。
- 本能力无法让任意外部副作用变成 exactly-once；被隔离或无法访问的 Worker 保持不确定状态，必须由 Graph 策略或人工裁决。
