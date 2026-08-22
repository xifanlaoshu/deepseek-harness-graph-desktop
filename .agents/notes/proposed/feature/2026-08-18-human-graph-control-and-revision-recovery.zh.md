# Agent Note: Graph 人工控制与 Revision 恢复

Status: proposed

[English](2026-08-18-human-graph-control-and-revision-recovery.md) | 中文

当前 Host 控制服务会按会话串行执行操作，拒绝过期的任务图／Revision／Generation／Attempt 地址和冲突的操作 ID 复用，并记录操作者、来源、原因、`applied`／`no-op` 结果以及产生的 Revision 或 Generation。它已支持排空式暂停、持久化节点级修改请求并交回主控生成新的不可变 Revision、检查点批准／拒绝、终止、重试、恢复、跳过、分派覆盖、带来源且通过 Schema 校验的替代输出、单调回滚与恢复对账请求。本提案剩余工作是更完整的拒绝分支交互、Host 已认证入口之外的授权策略，以及在每个控制 Settlement 阶段进行崩溃注入。

## Problem

Graph Mode 可以接收新需求和主控生成的 Revision，取消提案也会增加停止操作。它还没有持久 `awaiting_user` 状态、审批记录、精确节点恢复、手动跳过或重试、强制角色或模型覆盖以及回滚语义。若每次动作都向主控发送自由文本，结果会依赖模型，旧浏览器页面也可能误操作更新的工作。

## Proposal

Graph Mode 将暴露一个 Host 所有的控制服务，由 Graph 面板、子会话 Header、命令路径、主控工具和交互 UI 共同使用。每个操作携带稳定 Control ID、预期 Projection Revision、Actor、Source、父会话、Graph、设计 Revision、运行代次和精确目标。节点级操作还寻址 `GraphWorkId` 以及观察到的 Attempt 或终态。过期、重复、未授权和已终止请求返回类型化结果，不影响更新的工作。

该服务支持以下动作：

| 动作 | 持久结果 |
| --- | --- |
| `pause` | 停止新准入，并由策略决定活动 Attempt 排空或取消；运行进入 `awaiting_user`。 |
| `approve` | 满足精确待审批项并恢复符合条件的工作。 |
| `reject` | 记录结构化原因，并终止、激活声明的拒绝分支或创建返工检查点。 |
| `modify-task` | 产生主控可见的变更请求，并要求先创建新不可变 Graph Revision 再执行。 |
| `resume-from-node` | 启动新运行代次，复用不受影响证据，并使目标及其完整后继闭包失效。 |
| `retry-node` | 通过策略检查后为同一设计启动新运行代次；绝不重写旧 Attempt。 |
| `skip-node` | 记录显式 skipped 结果并应用声明的依赖规则；绝不伪造成功输出。 |
| `override-assignment` | 验证后为新运行代次保存精确 Role、Provider、Model、Reasoning、Worker 或资源覆盖。 |
| `rollback-revision` | 把选定历史设计克隆成新 Head Revision，同时链接当前 Head 与回滚来源。 |
| `cancel-node` / `cancel-run` | 使用[用户取消](2026-08-18-user-operated-graph-cancellation.zh.md)定义的语义。 |
| `reconcile` | 执行精确 Graph/LoopX/Worker 对账并记录证据，不直接修改设计。 |

## Awaiting-user and approval semantics

节点、分支、策略限制、不确定副作用、资源冲突或主控可以通过现有 Interaction capability 发出类型化交互请求。Graph 记录包含 Prompt、Decision Schema、选项、安全证据引用、缺省行为、可选 Deadline 和精确 Continuation Token。运行进入 `awaiting_user`；只有请求明确允许时，独立工作才可继续。

审批和拒绝是结构化决定，不从自由文本的正负语气提取。Host 在追加响应前验证 Response Schema 和预期 Control Revision。Deadline 可以失败、取消、选择预声明默认值或保持暂停，但绝不可以虚构用户批准。非幂等外部副作用需要审批，除非部署策略明确预授权声明的 Effect Class。

## Resume, retry, skip, and rollback

执行历史不可变。恢复与重试创建新的 `GraphRunGenerationId`，并记录来源 Run 与持久复用映射。`resume-from-node` 使目标节点及其传递后继失效；前驱与独立成功节点只有通过正常输入和 Schema 兼容检查后才能复用。若节点输出已被缺少对账或补偿能力的终态外部副作用消费，`retry-node` 会被拒绝。

只有节点策略声明 `skippable` 并定义每个后继如何处理缺失输出时才允许跳过。必要后继变为 canceled 或 blocked；条件后继按未激活求值；独立分支继续。用户只能通过独立的 `supply-output` 审批动作提供 Schema 有效替代输出，其来源始终可见。

回滚不会把当前指针后移，也不会删除后续证据。Host 创建从选定历史 Revision 派生的新 Revision，记录回滚来源与当前 Head Parent，使用会话快照中的当前 Role 和 Schema 验证，并只在确认后启动新 Run。这样既保持线性 Head 历史，也保留被放弃分支供检查。

Assignment Override 是执行数据，不修改全局模板。UI 预览模型能力、并发、工作区、成本和失效影响。覆盖不得超过硬调度策略，也不得选择不可用 Role、Model、Worker 或 Reasoning Value。历史运行始终展示实际使用的有效 Assignment。

## Product control plane

Graph 面板将包含活动运行控制条、待交互队列、确认与影响预览和操作时间线。节点证据 Drawer 只暴露对所选状态有效的动作。子会话页面可以取消、暂停或打开精确父操作，但不能修改不相关 Run。键盘和屏幕阅读器行为遵循相同 Enabled State 与确认规则。

每个完成的控制都展示 Actor、Time、Source、Target、预期与接受 Revision、结果 Phase、失效闭包、复用决定、Assignment 变化、外部 Settlement 和错误。UI 等待权威 Projection 状态，不展示乐观成功。

## Alternatives considered

**把所有控制都作为普通会话文本发送。** 主控仍适合解释需求变更，但精确执行操作需要过期状态检查、授权和确定性结果，提示词无法保证这些要求。

**原地修改选中的历史 Run。** 这会抹去用户当时看到的证据，并使 replay 无法区分原始执行与人工干预。

**把 Skip 当作成功。** 下游节点可能消费缺失或伪造数据。Skip 是具有显式后继策略的独立结果。

**回滚时把 Head Pointer 移回旧位置。** 后续 Revision 与 Run 将脱离当前历史。克隆为新 Revision 同时保留来源和单调 Head。

## Acceptance criteria

- 所有动作使用同一个精确寻址、Revision 校验、幂等的 Host 控制服务，并在 replay 与 export 中保留 Actor、Source、Target、Reason、Impact 和 Result。
- `awaiting_user` 可跨重启保留，除非有明确策略绝不默认批准，并在有效响应后恰好恢复一次。
- 审批、拒绝、修改、恢复、重试、跳过、提供输出、Assignment 覆盖、回滚、取消和对账具有确定性 Domain 与组装浏览器覆盖。
- 恢复和重试创建新运行代次，应用精确失效闭包并带来源复用证据；历史 Run 保持不变。
- 回滚创建验证后的新 Head Revision，绝不删除或重写选定来源及后续历史。
- Override 保持会话与 Run 所有，遵守硬限制，并在执行证据中显示有效 Role、Model、Reasoning、Worker 和资源决定。
- 冲突浏览器标签、过期子页面、重复点击、控制 Settlement 期间重启和完成/控制竞争都保留唯一接受结果。

## Risks

如果前置条件不严，强大操作者动作可能绕过自动评审或产生无效项目状态。大型图的影响预览可能成本很高，跨外部系统变化的回滚也不能撤销副作用。持久审批可能包含敏感说明，因此需要有界公开安全字段和 Actor 授权。较大的动作集合还会增加 UI 复杂度；状态相关可用性和唯一 Host 服务可防止展示代码自行发明语义。
