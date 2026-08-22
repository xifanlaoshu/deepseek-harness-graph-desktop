# @deepseek-ai/dsh-graph-resources

[English](README.md) | 中文

`ctx.graphResources` 是 Graph 准入使用的过期模型资源观测、带 fencing 的 Reservation 和运行时容量结果 Service Definition。静态 Graph 配置始终是硬上限，Provider Telemetry 只能降低或延迟准入。

## Contract

- Snapshot 标识一个精确 Provider/Model 路由，可以报告路由状态、活动请求、队列深度、并行和权重上限、上下文/输出容量、Memory Class、可用设备内存、近期 OOM 和限流截止时间。未知字段保持缺失。
- 每个 Snapshot 都会过期；Graph 不得把过期观测当作可用性证据。
- Reservation Request 携带稳定 Graph Work/Operation ID、Owner Epoch、Weight、硬上限和 Deadline。Provider 返回 `granted`、带 Retry Time 的类型化等待，或终态路由拒绝。
- Reservation 拥有独立 Fencing Token 和过期时间。运行时 Outcome 在该精确 Fencing 身份下释放容量，或报告容量、OOM、限流和 Worker 丢失证据。
- 恢复使用精确 Reservation 和 Fencing 身份调用 `reconcile()`。Provider 确认 `released`、`already-released`、`absent` 或 `conflict`，因此即使进程在 Provider 释放成功后、Graph Settlement 写入前崩溃，也不需要盲目再次释放。
- Telemetry 不能授权未配置模型、提高已配置并行或权重限制，也不能证明外部副作用已完成。
- 每个 Provider 都运行共享资源一致性测试套件。该套件验证稳定 Reservation 重放、冲突请求拒绝、替代 Reservation 的单调 Fencing、过期写入拒绝、容量等待、幂等释放与恢复，以及 OOM 退避。

## Model Experience

### Resource evidence

#### What the model sees

规划检查点和 Graph 执行证据可以包含有界 `GraphResourceSnapshot` 摘要。原始设备标识和私有 Provider 诊断保持为 Host-only。

#### Token effect

本包不直接增加请求内容。主控检查点可以在之后的请求中加入一段有界资源摘要。

#### KV Cache effect

没有直接影响；检查点摘要属于可变执行证据。

## Known Limitations and Deferred Work

- Provider 可能在过期前发布陈旧或不完整测量；硬上限和 Worker Fencing 仍然是权威规则。
- 本包不轮询特定模型服务器或 GPU API，相关集成由部署 Provider 负责。
