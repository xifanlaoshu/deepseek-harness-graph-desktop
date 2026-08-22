# Graph

[English](README.md) | 中文

graph 组负责多代理工作的持久化、可编辑 DAG 编排。

| 包 | 角色 | Cordis 键 |
|---|---|---|
| [`dsh-graph`](graph/README.zh.md) | 持久化定义、修订、运行、校验和投影 | 无 |
| [`dsh-graph-mode`](graph-mode/README.zh.md) | `/graph` 主控和有界后台调度器 | `graphMode` |
| [`dsh-graph-coordination`](graph-coordination/README.zh.md) | 与提供方无关的认领、观察和证据接口 | `graphCoordination` |
| [`dsh-graph-coordination-loopx`](graph-coordination-loopx/README.zh.md) | LoopX CLI 协调提供方 | `graphCoordination` |
| [`dsh-graph-worker`](graph-worker/README.zh.md) | 与提供方无关、带围栏的 Worker 分派和生命周期接口 | `graphWorkers` |
| [`dsh-graph-worker-local`](graph-worker-local/README.zh.md) | 共享、隔离副本或只读快照本地 Worker 提供方 | `graphWorkers` |
| [`dsh-graph-worker-remote`](graph-worker-remote/README.zh.md) | 进程外子代理 Worker 适配器 | `graphWorkers` |
| [`dsh-graph-artifacts`](graph-artifacts/README.zh.md) | 内容寻址 Artifact Capture 与 Materialization Seam | `graphArtifacts` |
| [`dsh-graph-artifacts-fs`](graph-artifacts-fs/README.zh.md) | 持久文件系统 Artifact 传输 | `graphArtifacts` |
| [`dsh-graph-resources`](graph-resources/README.zh.md) | 会过期的模型资源观察和带围栏的预留 | `graphResources` |
| [`dsh-graph-resources-local`](graph-resources-local/README.zh.md) | 支持 OOM 与限流退避的本地租约容量 | `graphResources` |
| [`dsh-graph-resources-sqlite`](graph-resources-sqlite/README.zh.md) | 持久的跨进程容量、围栏与退避 | `graphResources` |
| [`dsh-graph-scheduler`](graph-scheduler/README.zh.md) | 与 Provider 无关的整图运行带围栏所有权 | `graphScheduler` |
| [`dsh-graph-scheduler-sqlite`](graph-scheduler-sqlite/README.zh.md) | 跨进程运行租约与持久 fencing 计数 | `graphScheduler` |

调度器必须挂载一个具名 Worker 提供方，但可以不使用外部协调、运行所有权或实时资源遥测。生产组合应挂载运行所有权 Provider，确保只有一个 Host 可以推进恢复后的运行。需要跨代理控制面状态的部署应挂载一个协调提供方；LoopX 提供方在配置的 goal 或 peer 名册不可用时会明确失败。挂载资源提供方后，Graph 静态限制仍是硬上限。
