# Agent Note：Campaign 计划追加修订

状态：已实现

[English](2026-08-24-append-only-campaign-plan-revisions.md) | 中文

## 问题

Campaign 最初要求在第一个 Batch 启动时提交完整有序 Batch 注册表。分析驱动型工作无法始终诚实地提前知道该注册表：引导或盘点 Batch 可能只有执行完成后才能发现真实模块、依赖和验收范围。拒绝后续新增会迫使主控提前虚构推测性 Batch，或者把新发现工作作为无关 Graph 运行，从而丢失 Campaign 进度、前序证据和单任务展示。

## 决策

Campaign 计划使用不可变已接受前缀和可审计后缀追加。首次 Submission 记录 `planRevision: 1` 和空扩展列表。全部已登记 Batch 都进入 `approved` 或 `approved_with_findings` 且没有活动 Batch 后，一次 `intent=new` Submission 可以在启动扩展首个 Batch 时携带 `campaign.planExtension`。扩展包含非空有序 Batch 后缀；`campaign.batchId` 等于其首个 ID。

新 Batch ID 在完整 Campaign 内唯一。每项依赖必须指向已有 Batch 或同一扩展中更早的 Batch。扩展不能插入、重排、移除、重命名或替换任何已接受 Batch 定义或 execution。已有就绪 Batch 继续只通过 `campaign.batchId` 启动；活动 Batch 的 Revision 省略 Campaign 字段。

Graph Mode 自行推导审计记录，不信任模型编写的运行证据。顶层 Submission 原因成为扩展原因；最后一个已接受 Batch 及其最新成功 execution 提供来源 Batch、Run 和已确认 Settlement ID。Host 递增 `planRevision`，追加一条 `GraphCampaignPlanExtension` 和 Batch 定义，并在同一临时 Submission 生命周期中准入第一个新 Graph 与 Run。

回放会把缺少计划元数据的历史 Campaign Event 视为修订一且没有扩展。后续每条 Campaign Event 要么完整保留计划元数据，要么恰好推进一次扩展，并且其 `addedBatchIds` 必须匹配新增连续后缀。普通状态和最新 execution 字段仍按既有校验规则推进，同时已接受前缀和扩展历史保持逐字稳定。

Campaign 轨道展示当前计划修订和引入每个 Batch 的计划修订。追加 Batch 的提示框展示扩展原因、来源 Batch、Run 和 Settlement 数量，不复制子会话完整记录。

## 验证

领域覆盖验证可以在历史修订一 Campaign 上追加后缀，会拒绝非尾部历史和既有 execution 变更，并校验来源证据。主控覆盖验证启动一个初始完整 Campaign、在一次计划修订中追加两个新发现 Batch、启动第二个追加 Batch 时不重复提交计划、已登记工作尚未完成时拒绝扩展，并固定 `graph_submit` 计划扩展字段。客户端覆盖验证计划修订、每个 Batch 的引入修订和审计提示框。组装后的 Graph 快照通过真实 Headless 组合固定主控策略。

## 考虑过的替代方案

**永久冻结完整注册表。** 这能保护回放，却要求主控在定义工作的分析完成前猜测任务，或者让新发现工作放弃 Campaign 跟踪。

**允许任意修改计划。** 编辑或插入早期 Batch 会改变依赖含义并使已接受执行证据失效；仅追加可以保留既有身份和顺序。

**创建续接 Campaign 或独立 Graph。** 执行可以继续，但一个用户任务会被拆成多个进度根，并失去原生跨 Batch 导航和 Settlement 谱系。

**预先登记占位 Batch。** 占位目标和依赖属于推测性证据，而且后续仍需要语义修改，与已接受定义不可变规则冲突。

## 影响

分析驱动型 Campaign 可以在已验证范围增长时仍保持为一个持久任务。回放依然拒绝任何已接受历史变更，扩展 Event 则为 UI 和恢复提供稳定因果记录。增长只能发生在注册表全部完成的边界，因此主控不能绕过 Pending 或失败工作修改计划；它必须先完成、修复或取得用户决定。真正无关的新目标仍会启动新 Campaign，不会扩展当前 Campaign。
