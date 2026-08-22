# Graph 调度所有权

[English](README.md) | 中文

`@deepseek-ai/dsh-graph-scheduler` 是 Graph 运行排他所有权的服务定义。Provider 以原子方式授予一个可过期租约，只续期完全匹配的租约身份，并拒绝陈旧的 fencing token。它与节点级 LoopX claim 不同：这一层决定哪个 Host 可以推进持久运行。

Provider 必须在租约过期后继续保留 fencing 计数。接管者获得严格递增的 token，Graph Mode 将该 token 用作运行的 `ownerEpoch`。

每个 Provider 都运行共享 Scheduler 一致性测试套件。该套件验证精确幂等准入、竞争 Owner 排他、不可变 Session 身份、Minimum Epoch 准入、精确 Heartbeat 与 Release、替代租约 Fencing，以及陈旧 Owner 拒绝。导出的 `MemoryGraphSchedulerProvider` 为单进程组合提供相同语义，但不声称具备重启持久性。

## 模型体验

### 调度所有权

#### 模型看到的内容

没有直接内容。所有权决定只影响某个 Host 是否可以推进运行；包含 `ownerEpoch` 的持久 `graph/run` 状态仍是模型可见证据。

#### Token 影响

不会增加模型 token。

#### KV Cache 影响

调度所有权不会影响 KV Cache。

## 已知限制与待完成工作

- 本包定义排他的运行所有权，但不提供持久存储、Host 认证或传输。部署需要选择符合自身故障模型和信任模型的 Provider。
- Fencing token 可以阻止陈旧 Host 续期调度状态，但无法撤销该 Host 已启动的任意外部副作用。需要防止脑裂时，Worker 和持久写入也必须执行同一 Epoch。
