# Agent Note: SQLite 默认会话历史与增量 Graph Run

Status: implemented

[English](2026-08-27-sqlite-default-and-incremental-graph-history.md) | 中文

## 问题

随产品交付的 Web 配置曾把每个会话存入压缩 JSONL 产物。会话记录分页只有在 `inspect()` 解码并实体化完整逻辑日志后才选择小页面。Graph Mode 还会在每次节点转换后追加完整 `graph/run`。因此，长流程会积累同一个不断增长 Run 的大量副本；打开冷历史时所需内存可能远大于压缩产物大小所暗示的数值。

## 决策

随产品交付的配置使用 `$DSH_HOME/sessions.sqlite` 中的 `dsh-session-persistence-sqlite` 作为权威会话事件存储。该提供方接受可选的旧 JSONL 根目录。启动时，它会逐物理 Zstandard frame 导入 SQLite 中尚不存在的会话身份，并为每个会话使用一个事务。导入失败会一起回滚元数据和事件；来源产物保持不变，后续启动会再次尝试。

`SessionPersistence` 提供读取有界序号区间的 `readRange`、按类型及追加 surface 从新到旧查找位置的 `findEventSequences`，以及在事件数和 UTF-8 JSON 字节预算下过滤事件域的 `readEventPage`。SQLite 把这些操作实现为物理查询，并在逻辑过滤前解析打包分片行。压缩 JSONL 会遍历 frame 而不保留完整的已解码日志；其他后端继承通过完整检查保证正确性的回退实现。

`session.history` 会先定位追加来源的消息边界，只读取一个有界页面。会话记录页面排除 `graph/*`；Graph 状态通过独立投影基线提供。`session.list` 基线会省略 Graph 投影，避免列出所有会话时在一个响应中聚合全部历史 Graph 值。已附加会话和子代理历史采用相同的页面预算。系统会单独取得最后一次 preset 选择事件以完成冷 presenter 组合；旧持久化实现仍保留原有完整检查回退。

冷投影恢复采用选择性读取。历史尾页的轻量投影在计算恢复起点时排除 Graph 单元，并读取一个在解码前排除 `graph/*` 的持久化页面；Graph 基线直接从身份匹配的持久检查点 view。选择性折叠绝不会把不完整的行写回为完整检查点。这避免打开会话记录时对大型缓存 Graph 状态做深度恢复、事件重放和序列化，从而同时产生多份副本。

每个 Graph 执行 Generation 以一条完整 `graph/run` checkpoint 开始。后续调度器发布会追加 `graph/run-update`，只包含变化的节点值和 Run 级字段。只有更新所指向的既有 Run 具有相同 Graph、Revision、Generation、Generation 身份和 Owner Epoch 时，重放才会接受；时间戳不能倒退，终态结果不能被替换。折叠结果仍是恢复流程和 UI 使用的同一 `GraphRun` 值。Graph 投影 checkpoint 版本保持不变，因为其持久状态表示没有变化。

## 考虑过的替代方案

- **保留 JSONL 权威存储并增加 SQLite 历史索引。** 两份持久存储需要崩溃对账，并规定部分写入后以哪一份为准。让 SQLite 成为权威存储只保留一份事件账本和一条恢复路径。
- **继续使用完整 `graph/run` 快照并依赖压缩。** 压缩能减少磁盘字节，却不能避免重放时实体化重复逻辑 payload。增量事件会在编码前消除重复。
- **导入后改写或删除旧 JSONL 文件。** 导入缺陷会因此删除唯一恢复副本。保持来源不可变可让迁移重试并接受独立审计。
- **使 Graph 投影 checkpoint 失效。** 投影状态表示没有变化，递增版本反而会强制执行本次变更正要避免的完整旧日志重放。

## 影响

新的 Graph 日志按实际节点状态变化增长，不再按此前每份 Run 大小的总和增长。SQLite 会话记录读取只为有界页面中的非 Graph 事件分配内存，不再为整个冷会话分配内存。单个事件可以超过字节预算，以确保向后分页总能前进；事件数预算保持硬限制。投影缓存身份基于不可变会话 header 字段，因此更换后端后已有 checkpoint 仍然有效；系统不必仅为提供尾页而重放巨大的旧日志。Graph checkpoint 缺失时，可选基线保持缺席，而不会在会话记录加载期间强制重放旧 Graph。恢复 Graph 工作本身仍可能需要领域恢复，因此增量 Graph 事件、payload 上限与投影 checkpoint 频率仍是运行保障。

SQLite 数据库 schema 继续采用预发布阶段的递增并拒绝旧版本策略。启动导入器负责把原 JSONL 后端格式迁入全新或当前 SQLite 数据库，并不是 SQLite schema 升级器。明确需要每会话独立产物的组合与示例仍可使用原始 JSONL 编码。

## 验证

共享持久化约定会为 JSONL 与 SQLite 覆盖有界区间、追加 surface 位置、排除事件域、事件数限制和字节限制。SQLite 测试证明旧存储事务导入及后续启动幂等。Host 测试证明冷历史页面与最后一次 preset 解析不会触发完整检查、不会传输密集 Graph 事件，并从会话列表基线省略 Graph。Graph 测试证明增量合并校验和完整折叠等价；Graph Mode 测试证明每次执行只有一条初始 Run checkpoint，后续更新只包含发生变化的节点。
