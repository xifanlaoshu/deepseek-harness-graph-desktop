# SQLite Graph 调度器

[English](README.md) | 中文

`@deepseek-ai/dsh-graph-scheduler-sqlite` 使用 SQLite `BEGIN IMMEDIATE` 事务提供跨进程的 Graph 运行所有权。它在租约过期后继续保留 fencing 计数，在租约存活期间阻止接管，并拒绝陈旧的心跳或释放身份。

默认租约生命周期为 120 秒，SQLite 最多等待 30 秒的事务争用。这些值让临时 Host 停顿期间仍有多次心跳机会，同时保持有界接管；部署可以在 Cordis 配置中覆盖这两个值。

## 模型体验

### SQLite 所有权

#### 模型看到的内容

没有直接内容。数据库路径、租约记录、Host owner id 和事务诊断都只保留在 Host；只有最终的 `graph/run` 证据可能进入后续模型上下文。

#### Token 影响

不会增加模型 token。

#### KV Cache 影响

SQLite 所有权不会影响 KV Cache。

## 已知限制与待完成工作

- SQLite 可以协调能够安全打开同一个数据库文件的进程，但不是任意网络文件系统上的认证多 Host 调度器。
- 租约所有权标识的是配置的 Host 进程，而不是经过远程证明的 Worker。分布式部署仍需要认证 Host 身份、健康状态报告和共享持久 Provider。
