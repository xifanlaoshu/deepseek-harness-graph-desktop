---
description: "在共享、隔离副本或只读的本地工作区中运行 Graph Worker 尝试。本文介绍文件系统策略、制品捕获和清理行为。"
kind: "package-reference"
---

# @deepseek-ai/dsh-graph-worker-local

[English](README.md) | 中文

## 概述

在共享、隔离副本或只读的本地工作区中运行 Graph Worker 尝试。提供方可以捕获有界制品，但由 Graph Mode 负责验证并物化结果。

## 目录

- [配置](#configuration)
- [约定](#contract)
- [开发备注](#dev-note)
- [模型体验](#model-experience)
- [已知限制与待完成工作](#known-limitations-and-deferred-work)

-----

这是 [`dsh-graph-worker`](../graph-worker/README.zh.md) 的本地 Worker Provider。它可以在共享会话工作区、隔离副本或只读快照中运行 Graph Attempt，通过配置的 Subagent Provider 执行模型任务，在隔离分配中检测未声明写入，并发布有界、内容寻址的 Artifact Manifest。

<a id="configuration"></a>
## Configuration

- `providerName` 注册 Graph Worker 路由，默认为 `local`。
- `subagentProvider` 选择现有 Subagent Backend，默认为 `spawn`。
- `isolationRoot` 可选指定分配父目录。
- `exclude` 从复制和变更扫描中排除私有运行状态及生成目录。单路径段配置会匹配任意目录深度的同名目录；因此默认值会排除嵌套的 `node_modules` 和 `.npm-cache` 树，避免依赖安装内容与包管理器缓存成为源码 Artifact。
- `maxArtifactFiles` 和 `maxArtifactBytes` 限制单个 Manifest。
- `artifactProvider` 可以在清理隔离分配前，把变更文件捕获到持久的 `ctx.graphArtifacts` 存储中。Web 组合使用 `fs-artifacts`。

<a id="contract"></a>
## Contract

`isolated-copy` 在启动子级前把源工作区复制到确定性的 Provider 自有分配，并通过 Subagent Activation Request 传递该绝对路径。请求会把进程内子 agent 的沙箱模式上限设为 `workspace-write`，因此即使父级已切换到 `danger-full-access`，也不能授权子 agent 写入分配之外。Assignment 携带 `activeSubagentLimit` 时，请求还会把 Run 作用域的容量 ID `graph-run:<runId>` 及该上限交给子级；后代通过 Subagent Service 继承它。初始快照校验或子级启动失败的分配尚未发布，因此无论后续 Settlement Cleanup Policy 如何都会删除。Settlement 后，每个变化路径都必须属于声明的写入根；变化的符号链接不得逃出分配。每个 Artifact Entry 都包含结果 Hash 及其源 Hash；新文件的源 Hash 为 null，因此 Graph 集成可以在替换前发现源工作区漂移。隔离删除会被拒绝，因为缺少 Blob 不能证明有意删除源文件；该操作必须由显式集成任务负责。删除和未声明写入的结果会标记为不可重试，因为重新分派未变更的节点无法满足其所有权声明。Provider 把 Manifest 归属于精确 Attempt，并执行 Assignment Cleanup Policy。恢复可以通过不透明分配 ID 推导精确路径；Provider 会取消仍附着的 Worker，而且只删除已证明可幂等重放且记录的清理策略允许删除的孤儿分配。

`read-only-snapshot` 使用同样的确定性副本，把进程内子 agent 的沙箱模式上限设为 `read-only`，并且由于写入根列表为空，不接受任何变更路径。该模式用于需要稳定文件系统视图，但不应修改源码的分析、评审和验证节点。

`shared` 保留兼容性，但不能把外部并发变化归属于某个 Worker，因此不会发布变更 Manifest。Graph 规划必须串行化重叠的共享写入根。

<a id="dev-note"></a>
## 开发备注
该 Provider 不发布不变量 companion：每项分配发布前都会与不可变任务分配进行核对。

<details>
<summary>维护者工作背景 — 点击展开</summary>

无。

</details>

<a id="model-experience"></a>
## Model Experience

### Local assignment

#### What the model sees

子级收到角色提示词、节点 Prompt、所选模型、结构化输出 Schema、工具策略和分配后的 `workspaceCwd`。分配路径和文件 Hash 保持为 Host 证据。

#### Token effect

除 Graph 负责的角色、节点、Schema 和工具策略请求外，本 Provider 不增加内容。

#### KV Cache effect

角色和节点 Prompt 由 Graph Mode 负责，本 Provider 不增加模型可见前缀。

## Known Limitations and Deferred Work <a id="known-limitations-and-deferred-work"></a>

- 沙箱模式上限需要进程内 subagent 提供方，以及沙箱策略和实际执行策略的文件系统或进程提供方。本地 Worker 仍依赖运行后变更扫描进行归属，并且会拒绝无法执行所请求上限的提供方。
- 本 Worker 自身不会把隔离结果写入源工作区。Graph Mode 会在发布节点成功前校验并 Materialize 每份已完成 Manifest；显式 Integration 节点仍负责跨节点冲突处理、验证和删除。
