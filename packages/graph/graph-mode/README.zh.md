# `@deepseek-ai/dsh-graph-mode`

[English](README.md) | 中文

`dsh-graph-mode` 安装 `/graph` 命令、仅供主控使用的系统策略、`graph_submit` 工具和后台 DAG 调度器。`/graph` 为当前会话启用该模式，`/graph off` 退出；`/graph` 后的文本会作为首个主控步骤的 steering 输入。

启用后，每条人类输入都会被分类为 `new`、`revise`、`inspect`、`control`、`clarify` 或 `direct`。新任务和调整提交不含身份字段的语义图草稿。对于新任务，Graph Mode 根据目标和所表示的用户输入推导安全的 graph id；该 id 已存在时会添加后缀，并分配修订一。调整会绑定到当前图，取得下一个修订及父修订，并根据已接受的结构推导直接变更节点。主控可以声明相对工作区所有权；Graph Mode 会推导物理分配，并从冻结的会话与 Provider 配置解析时间戳、普通输出 Schema、节点尝试与权重默认值、空边与分支组列表以及终止限制，然后校验并保存完整的不可变 Revision。调整会使推导出的变更节点的所有传递后继失效。未受影响且已成功的节点会连同明确来源复用其发布输出。更早的图修订和运行证据保持不变。

Revision 准入使用可恢复的 `graph/submission` 记录。Graph Mode 在 Scheduler Acquire 或 Coordination Prepare 前 Flush Pending Candidate，并且只有取得所有权后才发布 Revision／Run 对。启动恢复可以继续 Pending Submission；Busy 或失败的 Acquire 会记录 Failed Submission，而不会移动当前 Head。Resource Reservation、Coordination Claim、Running Attempt、Staged Output、Artifact Integration、Cancellation 与 External Settlement 都会在对应外部变更前经过显式 Session Flush 屏障。每个 Scheduler Lease 只会向后台执行移交一次；移交前失败会释放该 Lease。本地准入后、Worker 分派前失败时，系统会终态结算已取得的 Coordination Claim、把已取得的模型预留报告为已释放，并归还本地许可。即使 Provider 在 Signal 中止后仍不结束，`externalOperationTimeoutMs` 也会从调用方一侧限制清理与 Settlement。

调度器在主控工具调用之外运行，因此会话仍可交互。节点在所有前置节点终止后就绪。每条入向条件边都必须生效；条件输入未全部通过的节点会被跳过。必需前置节点失败会取消依赖任务。发布终态 Run Snapshot 之前，调度器会中止并排空所有活动节点 Attempt，然后关闭该次调度执行的节点更新入口；迟到的 Worker Monitor 回调无法重新打开 Run，替换 Revision 也只会读取已经静止的前序 Run Snapshot。运行完成后会排入一条持久的 `graph-run-complete` follow-up，供主控综合结果。失败 follow-up 会包含持久化的运行错误代码、消息和节点 id，使主控报告已记录的原因，而不是根据不完整的节点摘要猜测原因。

`graph_submit` 接受文档规定的语义草稿，并会用准确路径拒绝未知嵌套字段。准入会一次性汇总相互独立的角色、节点、验收标准、尝试次数、依赖、分支组与工作区错误，并附上可直接修正的最小草稿。工作区草稿可以省略 `readRoots` 和 `cleanup`；前者会解析为 `["."]`，后者会解析为所选模式的默认值；空根、绝对根、反斜杠分隔、未规范化或重复的根会在持久任务图校验前按准确字段路径被拒绝。可并行的 implementation、documentation、integration 或 specialist 节点必须声明明确且互不重叠的相对 `workspace.writeRoots`；重叠根或缺失的并行所有权会在 LoopX 认领前失败。主控永远不提交 graph id、修订号、父修订、时间戳、变更节点列表、终止字段、Worker 分配 ID 或绝对工作区路径，也无需重复部署默认值或 Provider 能力。主控调用夹带的 Host 所有字段和畸形 graph-id 提示无法覆盖当前会话身份或策略。评审与验证草稿会获得控制输出 Schema；在提交任何终态操作前，该 Schema 强制要求 `data.decision`（`approved`、`rejected` 或 `needs-user`）以及结构化的 `data.issues` 列表。其结果返回 Graph run id，而不是 JobRuntime id；主控应等待已记录的完成 follow-up，不能把该 id 传给 `job_output`。子代理创建前发生的协调失败会作为有长度上限的运行级错误持久化，并取消其余非终态节点。

所有确定性的人工操作都进入同一个串行控制服务。请求必须精确指定任务图、不可变修订、运行 Generation 和可选的最新 Attempt，Host 则提供经过认证的操作者与入口来源。用不同输入复用操作 ID 或从过期页面操作都会在变更状态前失败。已接受的记录保留请求、操作者、来源、结果以及产生的 Generation 或 Revision。操作可暂停准入并建立持久人工检查点、持久化节点级任务修改并要求主控生成下一个不可变 Revision、批准或拒绝检查点、终止整图或节点、重试、从指定节点恢复、跳过声明为可跳过的节点、应用仅属于新 Generation 的分派覆盖、提供带明确来源且通过 Schema 校验的替代输出、把历史修订克隆为新 Head，以及请求恢复对账。修改不会改变历史工作；只有主控提交替换 Revision 后，其检查点才会解析为已完成。修改活动节点时，系统会先请求协调取消并停止其 Worker，再让运行进入 `awaiting_user`，从而阻止过时节点开始下一次内部尝试。该路径只发送专用的修改 Follow-up，并抑制调度器针对同一检查点生成的通用规划 Follow-up。普通暂停则先让活动 Attempt 排空，再进入 `awaiting_user`；批准只启动一个新 Generation，并仅保留已经接受的前置证据。启动恢复不会改变处于 `paused` 的规划或评审检查点，人工对账也只检查它精确寻址的 `awaiting_user` 运行。

每个已认领节点都会发布有界的准入进度和 Schema 验证后的输出进度，续期带 Fencing 的租约，并从最新 Cursor 开始观察有序的外部进度或取消。公开安全的观察会保留为 `progress` Operation Transition；原始协调状态不会在认领后进入 Worker 提示词。停止心跳循环会等待已经开始的续租完成；Graph 会在进度、取消或结算写入前观察 Claim，并在 Claim 相同且租约身份未倒退时，用观察值替换已记录值。随后，每个已认领节点都会在其 Generation 作用域的 Activation 下写入一个终态协调结果。取消和 Revision 替换会先请求 LoopX 取消，再停止子代理工作，而且不会取消补偿写回。启动恢复会先对账旧 Worker，再把仍在运行的 Coordination Claim 转换为终态 Canceled Settlement，然后才允许幂等节点在新的 Fenced Generation 与 Activation 下重新运行。仅有 Confirmed Cancellation Request 不能证明协调租约已经释放。External Settlement 使用稳定身份并追加编号 Attempt；`failed` 和 `conflict` Attempt 可以在恢复后重试，`confirmed` 则不可变。有效输出已暂存后的终态写回失败会使运行进入 `awaiting_user` 对账检查点；恢复会先重试该 Settlement，再应用 Attempt 上限，绝不会仅为重复写回而重新运行 Worker。清理 Signal 有明确上限；无法完成的 Operation 会保留 Pending 证据供后续恢复，而不会无限阻塞卸载。

准入采用 FIFO，并同时执行全局上限中的工作代理份额、角色上限、精确提供方／模型上限和可选模型权重预算。至少一个全局许可为主控保留。Graph Mode 启用时，主控角色的提示词、提供方、模型和推理强度选择会路由父请求；工作角色的选择会传给相应子代理。工作代理上限能降低 OOM 概率，而每个父会话本来就会串行执行主控请求。若部署需要在不同会话的主控之间共享上限或实施硬内存隔离，还必须在模型提供方或进程运行时执行该限制。

每个已接受节点都保存完整执行预算：`maxOutputTokens`、`maxReasoningOnlyTokens`、`firstDurableActionMs`、`maxNoDurableProgressMs`、`checkpointIntervalMs`、`maxWallTimeMs` 和 `maxContinuations`。四个毫秒字段不得超过 `2_147_483_647`，因此配置不会被 Node Timer 钳制为立即触发，也不会被 `AbortSignal.timeout` 拒绝。准入前，Graph Mode 会通过 `ctx.llm` 解析精确的提供方／模型，拒绝模型未声明支持的显式推理强度，用适配器与实时资源上限共同限制节点输出预算，并在 Attempt 中记录上下文窗口、支持的推理档位、实际输出上限、并行上限、权重上限和可用设备内存。本地 Worker 会把实际输出上限传给子请求。Graph Mode 会从子会话事件分开跟踪 Provider 报告的输入、输出与推理用量、流式推理估算、模型活动和持久进度。成功的文件修改和成功的聚焦验证命令会生成结构化检查点，记录稳定 Work/Attempt ID、Activation、内容哈希、验证退出码、剩余验收条件和下一步动作；验证摘要会去除首尾空白并保留最后 2,000 个字符。失败的验证既不会生成检查点，也不会重置进度看门狗。通过校验的结构化结果会用已完成验收条件关闭检查点。只有隐藏推理不会推进持久进度。产生产物的任务必须尽早执行持久动作。在 Windows 上，任务遇到已记录的沙箱 `spawn EPERM` 进程 I/O 限制时，会被要求通过窄范围沙箱提权原样重试一次，而不是修改依赖、缓存或构建工具。

达到 token 上限或被看门狗终止的 Activation 只有在已有持久检查点时才能续跑同一逻辑 Attempt，续跑收到的是该检查点，而非隐藏推理或无上限轨迹。停止时没有检查点、续跑次数耗尽或节点墙钟时间耗尽时，Graph 会阻止同粒度重试并打开规划检查点。主控 Follow-up 除已完成证据、Worker、工作区、执行预算、健康度和最新检查点外，还会解析每个待处理节点的实际模型画像与实时容量。如果待处理节点在更早修订中已有验收结果，Follow-up 还会提供原修订、语义节点定义、入向依赖、输出和产物。主控必须原样保留仍有效的已验收节点，使 Graph Mode 可以复用它们，而不能安排保留成果或重新发现基线的工作。主控策略要求在架构阶段之后，把实现任务拆成约 10–30 分钟、具有两到四项可测验收条件的节点；并行节点必须拥有互不重叠的文件或模块、产生可独立验证的产物，并进入单独的集成节点，而不能批准未变更的停滞工作。

Web 组合会在 `isolated-copy` 工作区中派发 Graph 节点。每个成功的隔离 Attempt 都会保存完整的内容寻址 Artifact Manifest，并记录每个变更文件在源工作区中的原始哈希；随后在节点成功前把该 Manifest 物化到会话工作区。每个后继节点还会在分配 Worker 前对账所有传递上游 Manifest，因此从旧运行恢复时不会基于空白或过期的源码工作区继续分派。Graph Mode 会拒绝缺失基线证据、同一路径的不同修改、不受支持的符号链接，以及分配后发生变化的源文件；已经存在的相同内容不会重复写入。每次实际 Materialize 都使用稳定的 `artifact` Settlement。Integration 节点仍显式负责跨节点冲突处理、验证和删除；隔离工作区删除文件会被拒绝，系统不会根据文件缺失进行猜测。

执行视图会显示实际模型与资源画像、实际预算、Provider 用量、推理估算、最近模型活动、最近持久进度、变更文件数、检查点、子会话、输出和 Settlement 证据。操作者可以终止活动工作、把节点交回主控生成新图、从检查点恢复、重试或跳过允许的工作、切换角色／模型／Worker／推理强度，并为新的执行 Generation 调整节点输出预算或纯推理预算。未公布推理能力元数据的精确模型会禁用推理强度输入。

配置 `schedulerProvider` 后，Graph Mode 会在发布每个初始、恢复或控制操作新建的 Generation 前取得一个整图租约，在 DAG 推进期间发送心跳，并在运行停止后释放。租约 Fencing Token 会成为 `ownerEpoch`；低于请求 Epoch 的 Provider 响应会被拒绝，存在存活所有者时，第二个 Host 不能推进同一运行。Heartbeat 失败会中止 Worker 活动并立即撤销 Graph 写权限：旧 Host 不能追加已取消 Run、Node Transition、Checkpoint、Settlement 或完成 Follow-up。最后的持久状态保持非终态，供更高 Fencing Generation 对账。Run Projection 还会拒绝过期 Generation、相同 Epoch 接管、Generation 跳跃或替换已接受的终态快照。`schedulerHeartbeatMs` 限制续期间隔。Web Profile 为共享会话目录的进程使用 SQLite 调度 Provider。

调度执行排空后，暂停、取消、重试、恢复或替换 Revision 的每条控制路径都会终态结算更早失败 Attempt 遗留的 Claim，替换工作才可认领重叠作用域。已经确认的终态 Coordination Settlement 保持不变。

## 模型体验

### 主控策略

#### 模型看到的内容

主控会收到配置后的角色提示词、当前任务图标识、已启用角色目录，以及要求先对每条人类输入分类再通过 `graph_submit` 创建、调整、检查或直接回答任务的指令。工具 Schema 只要求语义图内容；Host 会推导 graph 身份、修订谱系、结构变更和部署字段。主控必须保留用户明确要求、锁定基线和验收标准；无法按原文满足时应询问用户。`control` 分类只记录意图，不能声称已经执行 Graph 控制操作。配置后的提供方、模型和推理强度会路由当前父请求。

#### Token 影响

每次启用 Graph Mode 的主控请求都会加入一个有长度上限的策略块和配置后的角色目录。

#### KV Cache 影响

策略和未变的角色目录会形成可复用前缀；任务图标识和最新用户输入会随轮次变化。

### 节点分派

#### 模型看到的内容

每个子代理会看到配置后的角色提示词、一个节点目标、验收标准、已发布的前置输出和紧凑协调观察，并返回结构化摘要、数据对象、产物列表和可选的公开安全协调摘要。

#### Token 影响

每次尝试会创建一个子代理请求，其可变长度由节点说明、选中的前置输出和提供方限制长度的协调观察组成。

#### KV Cache 影响

相同角色和模型的子代理可以复用角色提示词前缀，但节点目标、依赖输出和协调观察会随尝试变化。

## 已知限制与待完成工作

- 恢复流程可以重放已暂存的 Settlement、重试失败的 Settlement Attempt、对账 Worker/工作区与模型 Reservation 引用、取消仍处于 Claim 状态的 LoopX 工作，并重新执行确认缺失且幂等的工作，但无法证明任意外部副作用。手动、隔离、冲突或未知结果会停在 `awaiting_user`，直到精确寻址的控制操作解决它们。
- Web 组合中的 SQLite 调度与资源 Provider 会协调共享同一会话目录的本地 Host 进程，其 Artifact Provider 会在该文件系统中持久化 Manifest。Artifact 集成目前支持带源哈希的普通文件；符号链接物化和隔离删除仍需显式集成实现。独立 Host 仍需要经过认证的分布式调度 Provider、持久 Worker 身份与健康状态、远程遥测、经过认证的产物传输和引用感知孤儿清理。
