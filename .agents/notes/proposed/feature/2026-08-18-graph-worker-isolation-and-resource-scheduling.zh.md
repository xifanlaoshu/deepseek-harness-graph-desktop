# Agent Note: Graph Worker 隔离与资源调度

Status: proposed

[English](2026-08-18-graph-worker-isolation-and-resource-scheduling.md) | 中文

## Problem

Graph Worker 支持共享或隔离副本本地工作区以及远程适配器。静态全局、角色、Provider/Model 和权重上限可以与可选 SQLite 权威组合，后者在本地 Host 进程之间持久保存预留、围栏、OOM 退避和限流到期时间。这一基础不会观察模型队列深度、可用 VRAM、远程 Worker 健康状态或语义文件冲突，SQLite 也不是多 Host 租约存储。如果分布式租约没有经过认证的工作区隔离和制品所有权，两个合法 Worker 可能覆盖同一文件，或把凭据暴露到预期 Host 之外。

## Current foundation

`dsh-graph-artifacts` 现在会校验带 Attempt 归属的内容寻址 Manifest，并把 Capture、Materialization 与恢复分派给具名 Provider。`dsh-graph-artifacts-fs` 存储不可变 SHA-256 Blob 与 Manifest，拒绝不安全路径和符号链接，在显式物化前重新校验字节；当所有 Host 共享同一个经过认证的挂载时，它可以跨进程或跨 Host 使用。本地与远程 Worker Adapter 可以先通过该 Seam 捕获结构化制品路径，再发布终态成功；Web 组合为隔离本地工作启用该能力。`dsh-graph-worker-remote` 现在通过 Credential Reference 提供认证 HTTP Client 与 Server。它在分派前持久化确定性的逻辑作业身份，对丢失响应后的重试去重，通过持久化服务 Epoch 阻止被替代进程继续写入，在重启时隔离不确定的非终态作业，把对账映射到精确底层 Worker 引用，并执行请求、响应、重放与时钟上限。同一认证服务可以公开跨 Host Scheduler、Resource 权威源和有界内容寻址 Artifact 传输；它映射私有 Provider 身份、跨重启保存不透明 Manifest 映射，并在两端校验文件路径、大小、Hash 和本地根目录策略。`dsh-graph-scheduler` 把整图 Host 所有权与节点级 LoopX Claim 分离，其 SQLite Provider 为远程路由提供事务型租约与接管 Fencing。`dsh-graph-resources-sqlite` 可以根据可信模型运行时或 Sidecar 原子发布的队列与设备显存 Snapshot 执行过期校验并拒绝放行。这仍未完成可恢复远程进程、复制式高可用权威源、远程 Worker 健康检查与流式遥测、模型服务器专用原生指标适配器、对象存储规模传输、排他 Integration 租约、语义冲突检测或引用感知 Blob 垃圾回收。

## Proposal

Graph 执行将增加 Worker Provider capability，包含本地进程、本地隔离和远程实现。Worker 注册稳定 ID、协议版本、支持平台、工具、沙箱模式、模型路由、资源遥测能力、工作区能力、最大租约数和制品传输。注册信息仅供参考，Worker 必须证明当前租约并通过 Assignment 验证后才能执行。

Assignment 包含 `GraphWorkId`、Attempt ID、fencing token、不可变节点输入、角色与提示词快照、精确模型选择、工具策略、工作区分配、声明的读写所有权、制品契约、截止时间和公开协作引用。Worker 流式返回有序生命周期与进度记录，暂存结构化输出和制品，并通过所属 Graph 操作 Settlement。它不能修改图定义、角色模板或调度策略。

## Workspace and file ownership

每个可执行节点获得一种工作区模式：只读快照、隔离 Copy-on-Write 目录、Git Worktree、沙箱/容器挂载，或显式共享工作区。并行修改默认采用隔离。分配记录源 Revision、基础内容哈希、可写根、清理策略和 Provider 引用。凭据以作用域引用传入并由 Worker 解析，绝不复制到 Graph 事件或制品清单。

节点声明规范化读根、写根、生成制品和可选合并策略。提交验证拒绝并发可执行节点之间重叠的可写根，除非具名 Integration 节点对它们串行化。运行时观察把实际文件修改与声明比较；未声明写入按策略使节点失败或进入审批。文件所有权是路径协作规则，不代表语义合并必然无冲突。

成功的隔离工作生成内容寻址制品清单，包含哈希、Mode、相对路径、来源和大小。专用 Integration 节点在排他租约下把 Patch 或合并应用到目标工作区，并将冲突记录为结构化输出。取消 Worker 只停止后续执行，不会声称已发布的文件系统或外部修改已经回滚。

## Live model-resource scheduling

模型 Provider 与 Worker 可以发布有过期时间的资源快照：路由可用性、活动请求、队列深度、并发上限、预留权重、已知上下文窗口、最大输出 token、内存类别、可用设备内存以及近期 OOM 或限流信号。未知字段保持未知。静态 Graph 设置仍是硬上限和回退值；遥测可以减少或推迟准入，但不得提高配置上限。

准入变为针对依赖就绪、角色上限、精确模型上限、Worker 租约、工作区锁和模型资源容量的持久预留。调度器在优先级内采用 FIFO 公平策略，保留配置的主控容量，并记录节点等待原因。预留会过期且使用 fencing，避免断线 Worker 永久占用容量。

OOM、容量拒绝或重复 max-token 结果是类型化资源结果。策略可以对路由退避、为同一角色选择预先批准的其他模型、在输出预算内续写同一子会话，或返回[规划检查点](2026-08-18-progressive-graph-planning-checkpoints.zh.md)以拆分节点。调度器绝不静默切换到未经批准的 Provider、Model、Role 或 Reasoning Selector。

## Security and trust

远程 Worker 以配置的部署身份认证，并获得最小权限工具、凭据、网络和文件系统策略。制品内容在 Integration 前验证路径穿越、大小、类型和哈希。Host 与 Worker 协议消息使用有界 Schema，并在 Claim 前拒绝版本或能力不匹配。Worker 遥测影响其自身资格，但不能作为外部副作用已经完成的证明。

## Alternatives considered

**让每个 Worker 都在父 Checkout 中运行。** 这很简单，但会使并行文件所有权无法执行，也使取消无法隔离部分写入。

**只使用静态模型上限。** 静态上限是必要策略，但无法适应其他进程占用 VRAM、远程队列或近期 OOM 证据。遥测是在硬上限之下减少准入的信号。

**让 Worker 在过载时自行选择模型。** 这会绕过会话拥有的角色快照、成本策略和证据归因。备用路由必须预先批准，并在执行前记录实际选择。

**成功后自动合并 Worker 目录。** 文件可以在文本上合并，却违反架构或测试。普通 Integration 节点让合并、评审与验证保持图中可见。

## Acceptance criteria

- 本地与远程 Worker Provider 通过同一套 Assignment、租约、fencing、取消、进度、制品和失败 Conformance Suite。
- 并行可变节点默认使用隔离分配；可写根冲突在执行前失败，未声明写入可检测，Integration 在排他且有记录的操作下发生。
- 制品清单内容寻址、有界、路径安全、可归因到精确 Attempt，并且无需 Worker 在线即可恢复。
- 准入把静态硬上限与过期实时遥测组合，并记录等待原因、预留、释放、过期、OOM 退避和任何已批准路由切换。
- Worker 丢失、旧 fencing、工作区清理失败、制品损坏和模型不可用进入持久可恢复结果，而不是泄露容量或静默重跑副作用。
- Web 执行视图展示实际 Worker、工作区模式、模型路由、资源等待、预留、制品与冲突证据。

## Risks

工作区隔离和制品传输增加磁盘、网络与清理成本，一些工具依赖难以在远程复现的 Host 全局状态。遥测可能过期或不可信，因此不能替代硬限制。路径所有权无法发现生成索引、数据库或外部服务中的语义冲突。支持多种隔离模式会增加平台差异；交付 Profile 必须声明其实际保证，不能把所有模式呈现为等价。
