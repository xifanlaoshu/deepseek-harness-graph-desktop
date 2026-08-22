# @deepseek-ai/dsh-graph-resources-sqlite

[English](README.md) | 中文

[`dsh-graph-resources`](../graph-resources/README.zh.md) 的 SQLite 提供方。它持久化精确模型路由的预留、围栏令牌、终态结果、OOM 退避与限流到期时间，使使用同一数据库的 Web 会话和 Host 进程共享一个容量权威。

## 配置

- `providerName` 注册资源提供方；默认值为 `sqlite-resources`。
- `path` 选择数据库文件并相对于 Host 工作目录解析；默认值为 `.sessions/graph-resources.sqlite`。
- `routes` 可以提供更低的路由上限和规划事实。路由可设置 `telemetryPath`、`minimumAvailableDeviceBytesPerWeight` 和 `maxQueueDepth`，要求新任务准入前取得可信模型运行时或 Sidecar 写入的新鲜版本化 JSON Snapshot。未列出的路由仍可在 Graph 请求携带的硬上限以下参与调度。
- `observationTtlMs`、`leaseMs`、`retryMs` 与 `oomBackoffMs` 分别约束观察、所有权、等待和 OOM 降级。
- `telemetryMaxBytes` 限制单个遥测文件。`busyTimeoutMs` 约束 SQLite 锁等待。`journalMode` 在数据库身份验证后选择 `wal`、`delete` 或 `truncate`。

## 约定

每次准入都在 SQLite `BEGIN IMMEDIATE` 事务中执行。提供方移除已过期租约、复用相同操作及所有者纪元、派生稳定预留 ID、分配单调递增的围栏令牌，并在提交前计算路由容量。因此，并发进程不能同时占用最后一个容量名额。

有效路由上限取配置路由上限、当前请求冻结的 Graph 上限和活动预留携带上限中的最小值。该规则保留历史会话快照，同时阻止上限较高的会话覆盖仍在活动的更严格会话。路由权重采用相同规则。

配置 `telemetryPath` 后，Provider 会在打开 SQLite 事务前读取并校验完整文件。Snapshot 必须标识精确的 Provider/Model 路由，并携带 `protocolVersion: 1`、`observedAt`、`expiresAt`、`status` 以及可选的请求数、队列、并发和可用设备字节信息。遥测缺失、过期、不可用或格式错误时会拒绝放行。队列和可用显存阈值分别产生类型化的 `queue` 与 `memory` 等待，而持久化配置和 Graph 上限仍是硬限制。生产方必须原子发布该文件。

终态报告在预留 ID 和围栏令牌下保持幂等。OOM 与限流结果持久保存退避状态。恢复会区分已经释放的预留、缺失租约和更新的围栏令牌；旧身份绝不会释放替代租约。

打开同一数据库的所有进程必须使用相同资源配置。只有没有剩余预留时才能接受不同配置；已经打开的提供方随后会拒绝继续操作，直至重新加载。外部 application id、不支持的 schema 版本和包含未归属对象的数据库都会在更改 journal mode 之前被拒绝。

## 模型体验

### 持久容量证据

#### 模型看到什么

Graph 规划检查点和资源等待证据可能包含提供方提供的有界 `GraphResourceSnapshot`。SQLite 路径、锁诊断和预留行只保留在 Host 中。

#### Token 影响

不会直接增加请求内容。后续主控检查点可能加入一份有界容量摘要。

#### KV Cache 影响

没有直接影响；检查点容量摘要会随活动租约和近期结果变化。

## 已知限制与延期工作

- SQLite 协调能够安全打开同一数据库文件的进程。它不是可用于任意网络文件系统的多 Host 租约存储。
- Provider 不理解具体模型服务器的原生指标 API。可信运行时或 Sidecar 必须把 GPU 显存与队列指标转换为版本化遥测文件，并持续更新其过期时间。
- `DatabaseSync` 会在每个短暂预留事务期间阻塞 JavaScript 线程。高吞吐部署应当在事务型服务数据库上实现同一个提供方协议。
