# `@deepseek-ai/dsh-graph-coordination-loopx`

[English](README.md) | 中文

这是 [`dsh-graph-coordination`](../graph-coordination/README.zh.md) 的 LoopX CLI Service Provider。任务图准备阶段会确认一个配置好的已有 goal 可读；只有调度器使节点进入 ready 后，Provider 才懒创建对应的 LoopX todo，使用该角色已注册的 peer id 认领，并向 worker 提供有长度上限的公开安全 claim observation。Worker 分派前若硬租约获取失败，Provider 会清除软认领并把 todo 留为不可执行 blocker，因此写入 Scope 冲突不会遗留已认领工作。每次硬租约续租都会推进 LoopX lease version；Provider 会返回并持久化新的 fenced 身份，使终态写回使用当前 CAS version。进度、取消、认领、租约续期和结算会进入按物理 Activation 建立 Key 的 Schema Version 2 SQLite 投影，并使用稳定 Cursor 与幂等序号。重启 Settlement 从持久 Claim 读取 Todo ID，不依赖进程内 Map。终态写入按 Activation 串行，因此一个 Activation 等待时不会阻塞无关 Activation。每个 CLI Operation 还有独立 Deadline。成功时，Provider 用公开安全证据和 `no_followup` 完成 todo；最终失败时把 todo 更新为 blocker。模型并行度仍由 Graph 准入机制管理，因此该 Provider 不会把 LoopX 的 heartbeat quota、vision、scheduler 或 worktree 策略套用到会话内节点执行。

调用 `loopx todo claim` 前，Provider 会同时检查持久终态 Journal 与 Todo 当前状态。已经完成或阻塞且带有终态标签证据的 Todo 会返回匹配的 Terminal Disposition，并在必要时修复本地 Journal；它绝不会再次被认领或执行。

```yaml
- id: graph-coordination-loopx
  name: '@deepseek-ai/dsh-graph-coordination-loopx'
  config:
    goalId: my-project-goal
    roleAgents:
      analyst: analyst-peer
      architect: architect-peer
      engineer: engineer-peer
      reviewer: reviewer-peer
      verifier: verifier-peer
      writer: writer-peer
    journalPath: .sessions/graph-coordination-loopx.sqlite
```

`goalId` 和任务图会使用的每个角色都必须已存在于选定的 LoopX registry。`executable`、`executableArgs`、`transport`、`pathStyle`、`registry`、`graceMs`、`leaseTtlSeconds` 和 `operationTimeoutMs` 配置外部协调。`transport: process` 为每次操作启动配置的 CLI 命令。`transport: persistent` 通过配置的 Launcher 启动一个由 Provider 持有的 stdio Broker；`brokerPythonExecutable` 和必填的 `brokerCommand` 分别指定该执行环境内的 Python 与 LoopX。Broker 串行执行 CLI 操作，保留每次操作各自的超时、取消和输出限制，在 Provider 销毁时停止它拥有的全部命令，并在异常退出后的下一次调用中重新启动。即使 Broker stdin 写入尚未完成，调用方取消也只会拒绝对应操作；stdin 故障会拒绝活动操作，不会逃逸为进程级流错误。Broker 绝不会重试结果不确定的 LoopX 修改。`stdoutMaxBytes` 和 `stderrMaxBytes` 限制 CLI 输出收集量；stdout 默认值为 8 MiB，使大型但合法的 `todo list` 响应仍可完整解析，超过上限时会给出明确的大小诊断，而不是误报 JSON 错误。节点声明精确的相对 `workspace.writeRoots` 时，其 LoopX 租约会保护这些根及其后代；没有精确所有权或拥有整个工作区的节点使用 `writeScopes` 作为回退。只读节点会得到按 Activation 隔离且互不冲突的协调 Scope。`journalPath`、`journalBusyTimeoutMs`、`journalMode` 和 `journalEventWindow` 配置本地持久事件投影；只有明确的临时部署和测试可使用 `:memory:`。`watchReconnectAttempts` 和 `watchReconnectDelayMs` 在调用方取消与 Operation Deadline 内限制传输重试。Provider 会拒绝无关 schema version、格式错误的 claim/event/terminal JSON、非连续 cursor，以及序号、证据或 cursor 与事件不匹配的进度记录。如果 CLI、goal 或 peer 绑定不可用，Provider 会让任务图提交明确失败，不会静默丢弃协调。

Windows 宿主使用 WSL 内安装的 LoopX 时，Persistent Transport 会在 Provider 生命周期内保留一条 WSL Launcher 连接及其辅助进程树。`executableArgs` 只放发行版和执行选择参数，`brokerCommand` 指定 WSL 内的 LoopX 可执行文件。`pathStyle: wsl` 会转换 Registry 与每次操作的工作目录。

```yaml
    executable: wsl.exe
    executableArgs: [-d, Ubuntu, --exec]
    transport: persistent
    brokerPythonExecutable: python3
    brokerCommand: /root/.local/bin/loopx
    pathStyle: wsl
```

## 模型体验

### LoopX 工作代理观察

#### 模型看到的内容

已认领任务的 worker 会收到一个 `dsh-loopx-observation-v1` 对象，其中包含 `loopx todo claim` 返回的公开安全 goal id、todo id、peer id、claim 状态、task class 和 action kind。

#### Token 影响

每次受协调的节点尝试都会追加一条最多 8,000 个字符的 observation。

#### KV Cache 影响

Observation 反映当前尝试特有的 todo 和 claim 状态，因此它是可变后缀，而不是可复用前缀。

## 已知限制与待完成工作

- LoopX 仍是外部协调事实源；SQLite 日志是可在重启后恢复的本地投影，不是分布式事务参与者。稳定的进度、取消和结算标签可以补回进程在 LoopX 变更成功后、投影写入前停止时的最后一项变更；对账发现冲突时不会覆盖任一账本。
- 如果多个 Host 既不共享日志文件，也不共享一个经过认证的分布式存储，它们就不能共享 cursor 或进度去重状态。分布式权威仍然需要[持久项目控制面设计](../../../.agents/notes/proposed/feature/2026-08-18-graph-loopx-durable-project-control-plane.zh.md)定义的认证多 Host Provider。
