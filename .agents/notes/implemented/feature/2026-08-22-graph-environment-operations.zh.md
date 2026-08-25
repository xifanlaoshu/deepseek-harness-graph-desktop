# Agent Note：Graph 环境操作

状态：已实现

[English](2026-08-22-graph-environment-operations.md) | 中文

## 问题

工程 Worker 通常只拥有工作区范围内的写入权限。安装 Maven、变更 Docker 资源或取得宿主级前置条件可能需要网络访问、写入工作区以外位置，或者需要 Worker Allocation 不应继承的权限。把这种需求当作普通实现任务，要么会在 `workspace-write` 下失败，要么会让模型得到开放式高权限 Shell 轮次。Graph 还需要持久证据，证明人类批准了后续节点所依赖的精确副作用。

## 决策

Graph 新增不可变 `environment` 任务类型和默认的非主控环境操作角色。环境节点会从 `network`、`host-package-install` 与 `docker` 中列出互不重复的所需能力，选择 `workspace-write` 或 `danger-full-access`，并包含一至十六个按顺序执行的操作。每个操作都具有稳定 ID、规范化说明、精确命令和可选的说明性回滚命令。节点始终解析为保留的共享工作区、`manual` 副作用策略和一次尝试。

Graph Mode 通过 `environmentEnabled`、`environmentCapabilities` 与 `environmentDangerFullAccess` 管理部署准入。主控策略会先选择仓库内 Wrapper 和已有工具链。确实仍需要宿主前置条件时，主控会在所有依赖工程节点之前创建一个有界环境节点，写明可测量的验证标准，把 Docker 或包管理器副作用限制在当前项目，并且绝不把环境变更隐藏在工程任务中。

调度器会让已就绪环境节点停在持久 `environment` 检查点。其 Reason 包含对完整能力、沙箱模式、命令和回滚命令的稳定 JSON 渲染。`approve-checkpoint` 控制操作会解决该检查点，并且只授权下一个执行 Generation；重试或更晚的 Generation 不能复用这份权限。拒绝会取消运行。主控 Follow-up 只负责展示计划并等待，不能提交新 Revision、执行命令或声称已经获批。

获批环境节点会通过 `ctx.shell` 直接执行不可变命令，因此任何子模型都不会取得高权限交互工具。每条命令执行前，Graph 会持久化稳定 External Reference 和 Pending Settlement，并在 Shell 调用前 Flush 会话。终态证据会记录退出码、信号、超时、中止、沙箱、截断和输出字节数，但不会把 stdout 或 stderr 复制进父日志。已知非零结果会直接使节点失败而不重试；终态观察缺失或冲突时会停止并要求人工对账。回滚绝不会自动执行，必须放入另一个单独获批的环境节点。

## 考虑过的替代方案

**让环境 Worker 继承父级沙箱。** 不采用，因为委派模型可以选择用户审核计划之外的命令，而且隔离 Worker 不应越出其 Allocation。

**使用子级 Shell 工具发出的通用审批提示。** 不采用，因为可继续子代理是非交互的，审批会落在错误会话中，而且不可变 Graph 无法承载后续工作依赖的前置条件。

**在工程 Attempt 内自动安装缺失工具。** 不采用，因为隐藏的宿主变更在崩溃后既无法重放，也无法安全归因。

**失败后自动执行回滚。** 不采用，因为回滚本身也是外部副作用，其安全性和当前适用性需要重新人工审核。

## 结果

环境前置条件会成为可见 DAG 节点，具有经人工精确批准的副作用和稳定证据。普通分析、工程、评审与验证 Worker 仍受声明的工作区策略限制。Generation 变化后不能复用批准，不确定副作用也不能被静默重试。部署必须挂载 Shell Provider 并显式选择允许的能力；包管理器提权、交互式安装器、Docker Daemon 健康、跨平台命令语法、外部命令内部的 Secret 处理和回滚正确性仍由 Host 或操作员负责。
