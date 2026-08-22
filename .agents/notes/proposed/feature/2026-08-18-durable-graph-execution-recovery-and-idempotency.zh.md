# Agent Note: Graph 持久执行恢复与幂等

Status: proposed

[English](2026-08-18-durable-graph-execution-recovery-and-idempotency.md) | 中文

## Problem

Graph 定义和运行快照可以在重启后保留，但调度器所有权、活动 Attempt、LoopX Todo 缓存、准入 Permit 和 Settlement 进度仍是进程内状态。因此崩溃可能留下子进程、外部 Todo、工作区修改或模型请求，而最新运行快照没有反映其结果。若没有稳定操作身份就重新启动同一节点，可能重复昂贵或不可逆副作用；把所有不确定操作都视为完成，则可能遗漏必要工作。

## Proposal

Graph 将区分稳定的逻辑工作身份与物理 Attempt。`GraphWorkId` 是由 `sessionId`、`graphId`、`revision` 和 `nodeId` 组成的品牌化规范元组。`GraphRunGenerationId`、`GraphAttemptId`、`GraphControlOperationId` 和 `GraphSettlementId` 分别标识重复执行、一次 Worker Attempt、一次用户或主控操作以及一次外部终态写入。Wire 和持久记录同时携带元组字段与不透明 ID，使诊断无需解析 ID 也能保持精确。

每次运行拥有追加式操作日志。节点依次经过 `planned`、`admitted`、`claimed`、`started`、零个或多个 `progress` 观察、`output-staged`、`settlement-pending`、对账决定和一个终态。每次转换记录预期前驱、事件 ID、时间、Owner Epoch 及相关外部引用。Projection 拒绝不可能的前驱或第二个冲突终态。整次运行快照仍是便捷 Projection，但不再是唯一恢复证据。

## Recovery and reconciliation

Host 启动时，恢复协调器折叠每份非终态 Graph 账本，获取带单调递增 fencing epoch 的持久 Run Owner 租约，并重建调度资格。旧进程可能完成一个 OS 操作，但其 epoch 不能追加当前转换、续租或 Settlement 外部工作。Heartbeat 丢失会分别中止执行并撤销持久写权限，因此所有权不确定后不会创建已取消终态快照或清理 Settlement。Run 保持非终态，直到更高 Fencing Generation 完成对账。Projection 验证会拒绝较低或跳跃的 Generation、相同 Epoch 接管、过期 Generation ID，以及已接受终态后的同 Generation 替换。协调器会先对账每个已到达 `claimed`、`started`、`output-staged` 或 `settlement-pending` 的操作，然后才准入新工作。

对账通过精确外部引用询问所属 Provider，并记录 `confirmed-running`、`confirmed-terminal`、`absent`、`conflict` 或 `unknown`。确认的输出通过验证后从 Settlement 继续；缺失的幂等工作可在同一 `GraphWorkId` 下以新 Attempt 重启；冲突或未知的非幂等副作用进入 `awaiting_user`。恢复不会因本地进程缺失而假定成功，也不会只因心跳缺失就假定失败。

调度游标、检查点唤醒标记、人工交互请求、准入预留、Worker 租约、模型资源预留、制品清单和外部协作引用都必须持久化，或者可以从操作日志事实重建。唤醒和控制请求具有稳定 Operation ID 及 accepted 标记，避免重启后重复入队。

## Idempotent effects and settlements

Graph 保证至多一个被接受的终态结果，而不承诺任意工具 exactly-once 执行。支持幂等的 Provider 和工具调用接收 `GraphWorkId`，以及从节点声明操作名派生的 Effect Key。以同一 Key 重复调用必须返回原结果或类型化冲突。非幂等副作用必须显式声明，置于审批策略之后，并暴露对账或补偿能力；否则不能在不确定状态后自动 replay。

节点输出在外部 Settlement 前以内容哈希和制品引用暂存。追加式 Settlement 日志记录每次 LoopX 完成、Blocker、取消、资源释放、制品发布和补偿尝试的请求、响应、错误、时间和 Fencing Epoch。每个稳定 `GraphSettlementId` 包含编号的 `pending` 与终态 Attempt 对：`failed` 或 `conflict` 允许开始下一 Attempt，`confirmed` 则封存该 ID。节点只有在必要 Settlement 已确认，或记录终态 `settlement-failed` 后才到达终态。重试 Settlement 绝不重新执行 Worker。

外部引用包含 Provider 类型、端点身份、Goal、Todo、Claim、租约与 fencing token、远程 Worker、工作区分配、模型预留、子会话、制品清单和 Provider 专有不透明数据。敏感凭据和私有观察不得进入这些记录。

## Orphan cleanup

Graph 创建的外部工作携带 `GraphWorkId`、Owner Epoch 和创建事件 ID。对账只能取消或 Settlement 带有这些标签的记录。孤儿扫描器比较带标签的 LoopX Todo、Worker 租约、模型预留和工作区分配与活动或终态 Graph 操作。它释放确认已终止的遗留项，把不确定记录标记为隔离，并追加每个清理决定。它绝不删除无标签 Todo 或工作区，也不把外部缺失转换为 Graph 成功。

保留策略由配置决定。终态 Settlement 记录和制品清单遵循会话保留策略。临时租约和隔离工作区可在终态 Settlement 及配置宽限期后回收。清理失败保持可见且可重试，但不会重新打开节点。

## Alternatives considered

**从最新整次运行快照恢复。** 快照可以表示节点正在运行，却无法识别快照与崩溃之间哪些外部副作用已被接受。转换和 Settlement 记录提供必要恢复点。

**重启所有非终态节点。** 这只对已证明幂等的工作安全，并可能重复部署、消息、文件修改或付费模型调用。

**把所有中断节点标为失败。** 这避免重复执行，却会丢弃已经确认的远程工作，并迫使用户手工判断哪些结果仍可用。

**使用进程 ID 或子会话 ID 作为稳定身份。** 它们只标识一次物理 Attempt，不能跨重启、重试、远程重新分配或仅 Settlement 恢复来表示逻辑节点。

## Acceptance criteria

- 稳定 Work、Run Generation、Attempt、Control Operation 和 Settlement ID 可由 replay 恢复，并被每个本地、远程、LoopX、制品和 UI 操作使用。
- 在每个日志转换处注入崩溃的测试都能恢复，且不会接受两个终态、重复幂等副作用或静默完成未知非幂等副作用。
- 启动对账处理运行中、已终止、缺失、冲突和不可达 Provider，并在新依赖工作开始前记录决定。
- 输出暂存和 Settlement 重试可以在重启后完成而不重新执行 Worker；每次 Settlement 尝试均可检查。
- 资源 Settlement 失败会结束物理 Attempt，不会在已终止的逻辑工作下准入另一次 Worker Attempt；组装式 Loader 覆盖会验证已配置的可选资源 Provider。
- 孤儿清理只处理带 Graph 标签的外部工作，执行保留与隔离策略，并记录失败而不重新打开已完成节点。
- Replay 和 export 无需进程内缓存或当前全局设置即可重建非终态所有权、外部引用、Settlement、不确定结果和恢复决定。

## Risks

操作日志会增加事件量和 Schema 复杂度，Provider 的对账质量限制了自动消除不确定性的能力。Fencing 阻止旧进程接受结果，却不能阻止已经发出的外部副作用。幂等键的强度取决于接收系统，因此 Graph 必须保留 `unknown` 并要求人工裁决，不能夸大 exactly-once 保证。如果宽限期或所有权标签错误，清理策略可能破坏有用的取证状态；隔离和失败关闭的所有权规则不可缺少。
