# Agent Note: LoopX 分布式协作协议

Status: proposed

[English](2026-08-18-loopx-distributed-coordination-protocol.md) | 中文

Provider 无关的 Service Definition 与 LoopX CLI Provider 实现全部八个操作。共享一致性套件会验证完整生命周期、重复投递、过期 fencing、有序取消观察和对账。LoopX Provider 会把 Settlement 身份保留在终态 todo 证据中，并把 Claim、租约续期、进度、取消、Settlement、cursor 和进度去重状态保存到经过验证的 SQLite 投影。重启测试会重建有序后缀；如果进程在投影写回前停止，稳定 LoopX 标签可以恢复最后一项外部变更。有界运行时窗口会报告已压缩前缀而不删除审计事件；`watch` 在明确的次数和延迟上限内重试传输失败。确定性的写入丢失注入覆盖续租与终态结算的崩溃窗口。剩余正式目标包括真实 LoopX 可执行进程的失效证据，以及 cursor 存储不依赖共享文件系统、与传输无关且经过认证的分布式 Provider。

## Problem

只提供 `prepare`、`claim` 和 `settle` 的协作接口无法续租所有权、发布有序进度、观察其他进程、取消 Claim、恢复过期 Worker，也无法在任一方重启后对账 Graph 与 LoopX。分别扩展这些调用会使租约、重试和终态语义变成 Provider 私有行为，Graph 也无法判断远程 Worker 是否仍拥有节点。

## Proposal

`dsh-graph-coordination` 将定义版本化 capability seam，其 Service Definition 不依赖 LoopX CLI 传输。LoopX 实现第一个分布式 Provider；内存 Conformance Provider 在无需外部安装的情况下固定语义。Consumer 仍是 Graph Mode，并且只使用以下操作：

| 操作 | 必要行为 |
| --- | --- |
| `prepare` | 在执行前验证 Goal、Peer 映射、协议版本、策略和 Revision 元数据。 |
| `claim` | 原子获取或恢复一个 `GraphWorkId`；返回 Todo、Claim、租约、过期时间和单调递增 fencing token。 |
| `heartbeat` | 续订精确活动租约并报告进度 Cursor；拒绝已过期或被 fenced 的 Owner。 |
| `observe` / `watch` | 在不获取所有权的情况下读取一致快照或耐久 Cursor 之后的有序变更。 |
| `publishProgress` | 按每项工作的序号追加有界公开安全进度；重复序号幂等，冲突 Payload 失败。 |
| `settle` | 在稳定 Settlement ID 下追加成功、失败、Blocker、跳过、取消、耗尽或不确定终态。 |
| `cancel` | 请求协作式取消活动租约，并保留请求者与原因。 |
| `reconcile` | 比较精确 Graph 操作与 LoopX 引用，返回 confirmed、absent、conflict 或 unknown 证据。 |

所有操作都携带协议版本、`GraphWorkId`、Graph Owner Epoch、调用者身份、稳定 Operation ID 和取消信号。响应包含类型化状态与有界公开安全证据；绝不暴露凭据、隐藏模型推理或不受限文件系统路径。

## Lease and recovery semantics

Claim 是有过期时间的租约，而非永久所有权。所有权转移时 fencing token 必须增加；如果 Provider 把 lease CAS version 作为 fenced 身份，同一 Owner 续租时 token 也可以推进。每次 Heartbeat 都返回当前 lease id 与 token；Consumer 必须持久化该身份，并在下一次进度、取消、对账或结算写入前替换旧身份。对账把同一 Claim 的更高 token 视为向前推进；Claim 被替换、token 降低或相同 token 对应不同 Lease 时属于冲突。只有当前 token 可以写入。迟到 Worker 可以完成本地计算，但 LoopX 拒绝其写入，Graph 把 fenced 结果记录为非权威证据。

心跳频率和租约时长是带最小值与宽限策略的部署设置。漏掉一次心跳不会立即使工作失败。确认过期后，Graph 在恢复 Claim、让非幂等操作进入 `awaiting_user` 或记录终态失败之前，会先对账 Provider 与 Worker。Worker 被确认停止后，Graph 会重新获取匹配的过期 Claim，把其原始 Activation 结算为已取消，并在新 Generation 中重试幂等节点。由恢复流程创建、且自身没有执行身份的 `awaiting_user` Generation 会自动依据原始 Generation 重新检查；未解决的冲突保持稳定，不会反复生成恢复历史。恢复保留同一 `GraphWorkId` 并使用新的 `GraphAttemptId`。

`watch` 基于 Cursor 且采用 at-least-once 投递。Consumer 按事件 ID 去重，并在压缩后获取新快照。进度序号在一个 Work Identity 内单调递增，且有数量与字节上限；详细转录仍归子会话所有。背压可以合并进度，但不得合并租约、取消或终态转换。

## Ledger reconciliation

Graph 与 LoopX 保留独立权威。Graph 在启动、传输丢失后、恢复过期 Claim 前和人工请求时调用 `reconcile`。Provider 返回它可以证明的精确 Todo、Claim、租约、终态结果和最后进度 Cursor。Graph 将这些记录与自身操作日志比较并追加一条对账结果。

若 LoopX 已终止而 Graph 未终止，Graph 验证引用输出并继续 Settlement，或记录冲突。若 Graph 已终止而 LoopX 仍活动，Graph 使用日志中的结果幂等调用 `cancel` 或 `settle`。若两边终态冲突，任何账本都不会被覆盖；Graph 进入需要策略或人工裁决的可见冲突。没有 Graph 标签的 LoopX Todo 不在对账权限内。

## Remote execution contract

协作协议发布工作，但自身不运行模型或工具。远程 Worker 观察可领取 Claim，证明兼容角色与能力集，获取租约，并调用由 [Worker 隔离与资源设计](2026-08-18-graph-worker-isolation-and-resource-scheduling.zh.md)定义的 Graph Worker 协议。LoopX Peer 仍是管理身份；Graph Role ID 和模型选择仍是会话拥有的执行数据。

## Alternatives considered

**轮询 LoopX Todo 并从状态文本推断所有权。** 轮询缺少有序证据，状态标签也无法提供 fencing、幂等或精确 Graph 身份。

**让 Heartbeat 配额决定 Graph 调度。** LoopX Heartbeat 保护分布式所有权，Graph 准入保护模型、角色、工作区和依赖容量。合并两者会让外部协作服务对本地执行资格拥有权威。

**让最后一次终态写入获胜。** 旧 Worker 可能覆盖恢复后的 Worker 或用户取消。Fencing 与不可变的首个接受终态会阻止该竞争。

**把完整子会话转录写入 LoopX 进度。** 这会复制私有且可能很大的会话证据。进度是有界协作数据；子会话仍是详细来源。

## Acceptance criteria

- Service Definition、LoopX Provider 和 Graph Consumer 实现全部八项操作，并通过共享协议 Conformance Suite。
- Claim 使用过期租约和单调 fencing token；过期 Heartbeat、进度与 Settlement 写入被拒绝并记录，且不改变已接受 Graph 结果。
- Worker 丢失、Host 丢失、LoopX 丢失、租约过期、重复投递、Cursor 压缩和重连都有确定性恢复测试。
- 启动和按需对账覆盖仅 Graph、仅 LoopX、匹配、冲突、不可达和无标签记录，且不静默接管或覆盖。
- 进度有序、有界、公开安全，并可独立于终态 Settlement 和子会话转录检查。
- 取消与终态 Settlement 在稳定 Operation ID 下幂等，并能跨进程重启重试。

## Risks

租约正确性依赖有界时钟偏差或服务端签发的过期时间，传输中断可能让健康 Worker 的工作进入不确定状态。LoopX 协议演进会在独立部署进程之间产生兼容义务。At-least-once 观察增加去重与存储工作。Fencing 控制权威写入，但不能撤销旧 Worker 的凭据，也不能撤销其已经发出的外部副作用。
