# Agent Note: 面向执行环境内 LoopX 的常驻 stdio Broker

Status: implemented

[English](2026-08-24-loopx-persistent-stdio-broker.md) | 中文

## 问题

LoopX Coordination Provider 可以通过 `wsl.exe` 等 Launcher 访问安装在另一执行环境中的 CLI。每次 Claim、Heartbeat、Observation、进度更新和 Settlement 都重新启动 Launcher，会让协调可用性依赖反复启动执行环境。一次长时间 Graph Run 即使始终访问同一个 LoopX 安装和 Registry，也可能创建大量短生命周期 Launcher 连接。Launcher 可能在 CLI 启动前拒绝新连接，使 Graph 既得不到 LoopX 响应，也没有安全依据重放一个可能已经被接受的修改。

## 决定

Provider 在默认的逐操作 `process` Transport 之外提供 `transport: persistent`。Persistent Transport 启动一个由 Provider 持有的 Launcher，在其中运行采用带版本号换行分隔协议的 Python stdio Broker。Python 是执行环境内显式可配置的命令，也是 LoopX 的现有运行前提。配置的 `brokerCommand` 仍是具有权威性的 LoopX CLI；Broker 不实现 Goal、Todo、Claim、Lease 或 Settlement 语义。

每个请求携带 CLI 参数、转换后的工作目录、超时、终止宽限期以及 stdout 和 stderr 限制。Broker 串行处理请求，并为每次操作启动一个 LoopX CLI 子进程，因此 LoopX 保留原有文件锁和进程隔离行为，同时不再建立新的宿主到执行环境 Launcher 连接。取消只停止指定子进程。Provider 销毁时关闭协议、取消全部自有子进程，等待 Launcher 进程树退出，然后关闭协调 Journal。

宿主会在写入 Broker stdin 前注册每个请求的终态结算。因此，即使该写入因背压尚未完成，取消也可以拒绝指定请求，而不会产生未处理的 Promise 拒绝。三条 stdio 流都有明确的错误所有者：stdin 故障会以 Broker 故障拒绝活动请求；销毁开始后的延迟 stdin 错误则由正在销毁的所有者收敛。

协议使用 Base64 返回 CLI 原始流，并分别报告截断和超时事实。Launcher 在 Ready 前退出会拒绝全部等待者；Windows UTF-16 诊断会被正确解码，无符号 `0xffffffff` 会显示为 `-1`。后续操作可以启动新 Broker，但 Provider 绝不会自动重放失败操作，因为外部修改可能已成功而响应丢失。

## 曾考虑的替代方案

**每次 CLI 操作启动一个 Launcher。**这种方式的实现状态最少，但每次协调转换都承担执行环境启动成本，并使长流程反复暴露于 Launcher 连接故障。

**常驻交互式 Shell。**Shell 引号会成为命令协议的一部分，证据或路径可能改变解析。结构化 JSON 请求能保留参数数组而不经过 Shell 解释。

**LoopX Daemon API。**LoopX 尚未为这些协调操作提供稳定的 Daemon Contract。stdio Broker 保留已发布 CLI 的权威性；官方服务提供等价的幂等、取消和读回语义后可以替换它。

**所有 Windows 部署都使用原生 Windows LoopX。**原生安装可以移除 WSL，但也会移动相对于 Home 的 Registry 和 Goal 状态。Persistent Transport 支持有意保留既有 WSL 状态的部署。

## 影响

WSL 部署在 Provider 生命周期内保留一条 Launcher 连接及其 Windows 辅助进程树，不再为每次协调操作创建新的 Launcher 进程树。LoopX 命令仍作为独立 Linux 进程运行，并分别受限。Broker 是可用性优化，不是第二个控制面：LoopX 状态与 Provider Journal 维持原有所有权，结果不确定的修改仍需常规 Reconciliation。串行执行可能让 Heartbeat 等待另一项 CLI 操作，因此 Operation Deadline 与 Graph Lease 时长仍由部署负责。
