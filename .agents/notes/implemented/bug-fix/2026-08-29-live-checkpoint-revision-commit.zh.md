# Agent Note: Revision Commit 读取实时 Checkpoint 状态

Status: implemented

[English](2026-08-29-live-checkpoint-revision-commit.md) | 中文

## Problem

Revision 提交会在取消前序工作、取得 Scheduler 所有权和准备外部协调之前捕获一次投影。操作者可能在这些异步步骤进行期间解析 Pending Checkpoint。如果随后根据已捕获投影解析检查点，同一个 Checkpoint 就会追加第二条终态记录，使只追加的 Graph 日志无法回放。

任务修改检查点还必须通过替代 Revision 完成，因为恢复旧 Generation 会执行操作者要求替换的目标。通用检查点批准路径可能违反该规则，并产生重叠的终态写入。

## Decision

Revision 激活会在同步提交之前立即从实时 Graph 投影读取检查点，并且只解析仍为 Pending 的记录。该读取与终态追加之间没有异步让出，因此人工操作不能插入提交过程。

Graph Control 会拒绝直接批准任务修改检查点。Web 执行视图会隐藏该批准操作，同时保留检查点原因和拒绝控制。只有主控编写的替代 Revision 可以解析任务修改检查点。

Graph Reducer 继续拒绝任何第二条检查点终态记录。恢复不会规范化或隐藏重复终态事件，因为这种事件证明某个生产者违反了只追加生命周期。

## Alternatives considered

- **让 Reducer 接受相同或补充字段后的终态记录** — 拒绝，因为这会隐藏竞争写入者，并把严格对应一次决策的检查点证据弱化成最后写入者获胜的状态。
- **让完整 Revision 准备过程与全部人工控制串行** — 拒绝，因为 Scheduler Acquire 和 Coordination Prepare 可能很慢；在这些外部操作期间占用控制队列会延迟终止及其他人工干预。
- **只使用提交开始时的投影** — 拒绝，因为该投影适合稳定校验草稿，却不能在异步外部工作之后授权终态写入。

## Consequences

- 缓慢的 Scheduler 或 Coordination Prepare 不会再为并发期间已经解析的 Checkpoint 写入另一条终态事件。
- 任务修改始终通过不可变 Revision 历史进行，而不会恢复过时工作。
- 提交点读取实时投影是一项必须保持的并发不变量，并由延迟 Coordination Prepare 的回归测试覆盖。
- 已经包含重复终态事件的日志仍需进行显式且有备份的数据修复；运行时回放继续采用失败关闭策略。
