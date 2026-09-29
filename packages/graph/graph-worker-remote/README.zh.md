---
description: "通过经过身份验证的 HTTP 或旧版进程外适配器运行 Graph Worker。本文介绍远程分派、持久化恢复以及可选的资源、调度器和制品路由。"
kind: "package-reference"
---

# @deepseek-ai/dsh-graph-worker-remote

[English](README.md) | 中文

## 概述

通过经过身份验证的 HTTP 或旧版进程外适配器运行 Graph Worker。HTTP 服务会持久化已接受的工作，并对已被取代的进程实施围栏；不确定的活动任务会被隔离，等待协调恢复。

## 目录

- [配置](#configuration)
- [约定](#contract)
- [开发备注](#dev-note)
- [模型体验](#model-experience)
- [已知限制与待完成工作](#known-limitations-and-deferred-work)

-----

这是 [`dsh-graph-worker`](../graph-worker/README.zh.md) 的认证远程 Client、持久化 Worker 服务和面向现有进程外 Subagent Provider 的旧适配器。

<a id="configuration"></a>
## Configuration

`mode` 可选 `client`、`server` 或 `both`，默认值为 `client`。

旧 Client 使用 `providerName`、`subagentProvider`、可选绝对路径 `cwd` 和可选 `artifactProvider`。`maxArtifactFiles` 与 `maxArtifactBytes` 限制通过 `ctx.graphArtifacts` 捕获的制品。

认证 HTTP Client 配置 `http.endpoint`、`principal`、`audience`、`credentialRef`、声明的 `workspaceModes`、轮询与重试限制、请求超时和响应字节上限。`schedulerProviderName` 和 `resourceProviderName` 可注册服务端 Graph Scheduler 与 Resource 路由。`artifactProviderName` 可注册 Graph Artifact 路由；捕获与物化根目录及文件、字节上限共同定义本地文件系统策略。除非显式启用仅限 Loopback 的开发端点，否则必须使用 HTTPS。每次操作前都会重新解析凭据，因此凭据轮换不要求重启插件。

`server` 和 `both` 模式必须配置 `server`：

- `audience`、`basePath` 和 `principals` 把服务身份及每个允许的调用方绑定到 Credential Reference。
- `journalPath` 使用 SQLite 保存已接受作业、逻辑 Worker/工作区身份、底层 Provider 引用、终态结果、服务 Epoch 和不透明 Artifact 映射。
- `workerProvider` 指定执行 Assignment 的同进程 Provider；`parentSessionId` 指定由服务持有的在线委派 Agent。
- `resourceRouteName` 和 `resourceProvider` 可通过认证路由公开一个同进程 Graph Resource 权威源。
- `schedulerRouteName` 和 `schedulerProvider` 可公开一个同进程持久化 Graph Scheduler 所有权权威源。
- `artifactRouteName`、`artifactProvider` 和 `artifactTempRoot` 可通过私有暂存目录公开一个持久化同进程 Graph Artifact Provider；`artifactMaxFiles` 和 `artifactMaxBytes` 限制传输。
- `maxClockSkewMs`、`maxRequestBytes`、`maxResultBytes`、`maxReplayEntries`、`busyTimeoutMs` 和 `operationTimeoutMs` 是部署硬上限。

<a id="contract"></a>
## Contract

HTTP Client 使用 HMAC-SHA256 对 Worker、Resource、Scheduler 和 Artifact 操作签名。签名覆盖规范化方法、精确请求目标、调用方 Principal、服务 Audience、毫秒时间戳、密码学 Nonce 和精确请求体的 SHA-256 摘要。服务端使用常量时间比较验证签名，拒绝过期或重放请求，并在有界 Nonce 缓存已满时拒绝继续接收。Secret 必须包含 32 至 4,096 个 UTF-8 字节。

同一个带 Fencing 的 Assignment 只会启动一次。服务端先持久化确定性的逻辑 Job、Worker 和工作区身份，再调用底层 Provider。启动响应丢失后的重试会得到相同身份，不会拉起第二个 Worker。新服务进程会推进持久化 Epoch、阻止被替代进程继续写入，并把所有不确定的非终态行变为终态隔离结果，而不会静默重新分派。持久化 JSON 在读取时执行 Schema 校验。对账把逻辑远程引用映射回精确的底层 Provider 引用。只有底层 Worker 接受取消后，服务端才确认取消已接受。

可选 Resource 路由会把 `observe`、`reserve`、`report` 和 `reconcile` 转发给一个共享 Provider，并把私有 Provider 身份改写为公共路由身份。多个 Graph Host 因此可以共用一个持久化容量权威源，包括实时模型显存快照和 Reservation 遥测。

可选 Scheduler 路由会把 `acquire`、`heartbeat` 和 `release` 转发给一个持久化 Provider，并改写其私有 Lease Provider 身份。多个 Graph Host 因此可以通过中央事务型租约权威源竞争同一个 Run，同时保留与本地路径相同的 Owner Epoch 和 Fencing 规则。

可选 Artifact 路由只上传允许根目录下、路径规范化的普通文件，并在持久化 Provider 捕获前校验解码大小与 SHA-256，再写入私有暂存目录。Journal 会跨重启保留公共不透明 Manifest 与底层引用的映射。物化时，服务端验证持久化 Manifest，通过有界暂存下载全部文件；Client 再次校验每个摘要，并在允许的目标根目录下原子写入。只有底层 Provider 返回 `deleted` 或 `absent` 后，对账才删除映射。

旧适配器声明共享工作区执行。它把角色与模型选择转发到配置的 Subagent 路由，并可在发布终态成功前捕获制品路径。离线旧适配器引用仍返回 `quarantined`，因为该路径没有持久化远程 Journal。

<a id="dev-note"></a>
## 开发备注
该 Provider 不发布不变量 companion：线协议、日志、传输和 Provider 响应都在相应信任边界校验。

<details>
<summary>维护者工作背景 — 点击展开</summary>

无。

</details>

<a id="model-experience"></a>
## Model Experience

### Remote assignment

#### What the model sees

远程子代理收到角色与节点 Prompt、精确的 `model.provider`、`model.model` 和 `model.reasoningEffort` 选择、结构化输出 Schema、工作区策略，以及选定 Worker Provider 支持的工具限制。认证、重试和 Journal 诊断保持为 Host 证据。

#### Token effect

旧适配器增加一段有界 JSON Schema 指令。HTTP 传输不增加模型可见文本；执行 Provider 负责其正常 Prompt 适配。

#### KV Cache effect

角色和输出 Schema 相同的节点可以复用对应 Prompt 前缀。节点目标和依赖证据仍会变化。

## Known Limitations and Deferred Work <a id="known-limitations-and-deferred-work"></a>

- Worker SQLite Journal 是带 Epoch Fencing 的单活动服务持久化权威源。多 Host Run 所有权要求在 Scheduler 路由后配置持久化 Provider；HTTP 服务本身不是复制式高可用数据库。
- 重启恢复会隔离不确定的非终态作业。它不会恢复仍存活的进程，也不会声称外部副作用不存在；策略重试前必须通过对账处理保留的 Provider 引用。
- HTTP Worker 协议目前轮询终态，尚未流式传输进度。Resource Snapshot 是请求/响应遥测，而不是服务端推送流。
- Artifact 文件在有界认证请求和响应中使用 Base64 编码。大规模部署应增加带预签名、摘要绑定传输的对象存储 Provider，而不是无限提高 HTTP Body 上限。
