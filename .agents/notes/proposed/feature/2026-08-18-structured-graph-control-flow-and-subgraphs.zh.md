# Agent Note: 结构化 Graph 控制流与有界子图

Status: proposed

[English](2026-08-18-structured-graph-control-flow-and-subgraphs.md) | 中文

## Problem

Graph 的边目前把依赖顺序与少量针对未版本化 Worker JSON 的谓词组合在一起。所有传入条件边都是合取关系，因此主控不能声明 exactly-one、any、all 或 activated 分支语义。评审拒绝仍是需要主控解释的文本，宽泛任务不能扩展为经过验证的动态节点或嵌套子图，Attempt 重试次数也没有定义项目级收敛或终止策略。

## Proposal

每个可执行节点将声明 `outputSchema`，包含稳定 Schema ID、版本、JSON Schema 子集和字节上限。结构化输出必须先由 Host 验证，才能激活边、满足验收规则、发布进度或成为可复用证据。Schema 不匹配是类型化 Attempt 结果，不得回退为解析摘要文本。Gate 与评审节点使用专用结果类型，包含封闭的 decision 判别字段、问题归属、证据引用和可选返工范围。

边将引用具名分支组。一个分支组声明以下四种确定性激活模式之一：

| 模式 | 激活规则 |
| --- | --- |
| `all` | 每个成员谓词均为 true。 |
| `any` | 至少一个成员谓词为 true。 |
| `exactly-one` | 恰好一个成员谓词为 true；零个或多个均为分支错误。 |
| `activated` | 每个实际运行且产生兼容输出的前驱成员必须为 true；未被激活的前驱成员不否决该组。 |

一个节点可以要求多个分支组，组之间按 `all` 组合。谓词仍是针对已验证输出的声明式 path/operator/value 记录。谓词求值持久化每个成员的值、布尔结果、激活原因和 Schema 版本，确保 replay 不依赖后续代码或模型解释。

## Dynamic expansion and nested subgraphs

主控创建的扩展节点可以返回类型化 `GraphExpansionProposal`，包含候选节点、边、分支组、输出 Schema、所有权声明和预算。调度器绝不把这些记录插入正在运行的 Revision。Host 验证 ID、角色引用、Schema、无环性、深度、节点数、可写所有权、模型兼容性和策略限制，然后要求主控提交新的不可变 Revision。

子图节点引用子 `GraphId`、本次执行选择的精确子 Revision、输入映射和输出映射。父图等待子运行的聚合终态，而不导入全部子事件。子日志仍是内部证据的权威来源。子图深度、扩展节点总数、并发子图数和序列化输出大小均是可验证设置。即使每个 Revision 单独是 DAG，递归图引用和祖先环仍会被拒绝。

动态 fan-out 使用针对 Schema 已验证数组的有界 map 声明。每个元素的确定性子节点 ID 由扩展节点和元素 key 派生；重复或不稳定 key 在工作开始前失败。动态 fan-in 是消费已物化子输出的普通节点，并声明是否接受部分终态。

## Review repair and termination

评审和验证节点发布 `approved`、`rejected` 或 `needs-user` 决定。`rejected` 产生带结构化问题与归属的[规划检查点](2026-08-18-progressive-graph-planning-checkpoints.zh.md)。主控可以提交返工 Revision，修改受影响节点并使其完整后继闭包失效。它不能重新打开已完成运行或增加反向边。

每张图携带经过验证的终止策略，覆盖最大 Graph Revision 数、自动返工 Revision 数、动态扩展次数、子图深度、每节点 Attempt 数、运行限制续写次数、墙钟时间以及可选 token 或成本预算。无进展检测器比较多个返工迭代的问题 ID、输出哈希和变更节点闭包。重复的等价拒绝进入 `exhausted` 或 `awaiting_user`，而不是再次自动创建 Revision。

终态求值是确定性的，记录 `succeeded`、`failed`、`canceled`、`exhausted` 或 `awaiting_user` 之一，以及结束运行的策略规则。Provider 重试、同会话 max-token 续写、返工 Revision 和用户重试使用不同计数器，不能互相消耗预算。

## Alternatives considered

**让主控在提示词中描述分支行为。** 文本无法证明 exactly-one 激活、replay 历史决定，也无法在后继启动前拒绝歧义输出。

**允许可执行谓词。** JavaScript 或模型生成表达式会让持久图数据携带代码，增加沙箱复杂度，并使 replay 依赖运行时实现细节。声明式谓词集可以通过版本化 Operator 扩展。

**允许单个 Revision 内存在环。** 环会模糊每次迭代的证据归属并使后继失效语义不明确。反馈通过新 Revision 和运行代次表达，每个 Revision 仍保持无环。

**让 Worker 直接修改活动图。** 部分接受的扩展可能与调度准入竞争，并留下无法归因的证据。类型化提案、Host 验证和主控提交保留唯一 Revision 权威。

## Acceptance criteria

- 节点输出必须通过所记录 Schema 版本的验证，之后任何分支、复用、Settlement 或验收决定才能消费它。
- `all`、`any`、`exactly-one` 和 `activated` 分支组具有确定性的单元、replay 和组装应用覆盖，包括歧义与未激活输入。
- 动态 map 扩展和嵌套子图执行稳定 ID、跨祖先无环、配置深度与大小限制、所有权验证和不可变 Revision 创建。
- 结构化评审拒绝创建返工检查点和替代 Revision，并重新执行精确的失效后继闭包。
- 独立配置预算限制 Attempt、续写、返工、扩展、子图深度、耗时和资源使用；达到限制后记录 `exhausted` 或 `awaiting_user`，不再自动循环。
- Graph UI 在设计与执行证据中展示 Schema、分支组、选中路径、子图身份、迭代次数和终止策略规则。

## Risks

JSON Schema 和分支组版本会增加持久兼容义务，动态扩展可能让状态量和 UI 成本比静态 DAG 增长更快。保守默认值和失败即报可能在主控适应 Schema 前拒绝有用输出。无进展比较不能证明语义等价，它只是有界安全信号而非正确性判断。嵌套子图也增加跨图取消和资源核算复杂度，因此依赖共享的持久身份与恢复设计。
