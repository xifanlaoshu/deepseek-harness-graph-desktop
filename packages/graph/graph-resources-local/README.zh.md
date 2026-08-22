# @deepseek-ai/dsh-graph-resources-local

[English](README.md) | 中文

[`dsh-graph-resources`](../graph-resources/README.zh.md) 的本地 Provider。它把配置的精确模型路由转为带租约的并行度与权重预留，并根据运行时 OOM 和限流结果，在有限时间内降低路由的可用性。

## 配置

- `providerName` 注册资源 Provider，默认为 `local-resources`。
- `routes` 声明精确的 provider/model 标识、并行度、可选权重上限，以及可选的上下文、输出和内存等级规划信息。
- `observationTtlMs`、`leaseMs`、`retryMs` 和 `oomBackoffMs` 分别限制观测、所有权、等待和 OOM 降级的持续时间。

## 约定

Graph 角色和模型的静态限制始终是硬上限。Provider 可以降低有效并行度或权重、拒绝不可能执行的请求、在租约占用、近期 OOM 或限流期间延迟执行，并返回会过期的资源快照。Reservation 使用稳定操作标识和单调 Fencing；活动操作重放必须匹配其冻结的路由、工作、权重与硬上限，释放或过期后的替代 Reservation 保留稳定 ID，但获得更新的 Fencing Token。重复提交相同运行结果具有幂等性；缺失、过期或冲突的结果会失败。

此 Provider 不调用设备 API，也不暴露设备标识。能够观测 GPU 显存或模型服务队列的部署应实现另一个遵循相同预留协议的 `dsh-graph-resources` Provider。

## 模型体验

### 本地容量证据

#### 模型可见内容

Graph 规划检查点和资源等待证据可以包含有界 `GraphResourceSnapshot` 状态。路由容量不会加入普通 Worker 提示词。

#### Token 影响

本包不直接增加请求内容。之后的主控检查点可以包含一段有界状态摘要。

#### KV Cache 影响

没有直接影响；状态摘要会随当前容量变化。

## 已知限制与延期工作

- 活跃容量只存在于当前进程。Provider 重启会丢失未完成租约，因此恢复会把精确的旧 Reservation 确认为 `absent`；必须跨进程保留容量所有权的部署需要持久化 Provider。
- 近期 OOM 与限流退避来自 Worker 结果，而不是直接的模型服务遥测。
