---
description: "从 Graph Worker 尝试捕获内容寻址文件，并将准确的清单物化到显式指定的工作区。本文介绍提供方职责和制品证据。"
kind: "package-reference"
---

# @deepseek-ai/dsh-graph-artifacts

[English](README.md) | 中文

## 概述

为带围栏的 Graph Worker 尝试捕获和物化内容寻址制品。提供方负责存储、传输、身份验证和保留，而 Graph 会验证尝试归属。

## 目录

- [开发备注](#dev-note)
- [契约](#contract)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

-----

`ctx.graphArtifacts` 是把带围栏的 Graph Worker Attempt 所产生的内容寻址文件传入持久存储，并在之后把同一份 Manifest 显式物化到指定工作区的服务定义。

<a id="contract"></a>
## 契约

- Capture 携带完整的 Graph Work、Operation、Attempt、Run、Generation、Owner Epoch 与 Fencing 身份；返回的 Manifest 必须精确匹配这些归属字段。
- 在 Graph 持久化 Manifest 前，Runtime 会校验规范化相对路径、词法唯一性、结果 SHA-256、可选源 SHA-256、Mode、总字节数、限制、Deadline 与 Provider 引用。源 Hash 为 null 表示变更文件在复制源工作区时不存在。
- Materialization 必须显式选择 `forbid` 或 `replace`；Worker 不会自行把输出合并回源工作区。
- 恢复操作指定一份 Manifest 和 Provider 引用，并且只有在没有已提交 Graph 输出引用它时才授权删除。
- 身份认证、远程传输、加密、保留策略和存储凭据属于 Provider，而不属于 Graph Mode。
- 每个 Provider 都运行共享 Artifact 一致性测试套件。该套件验证带 Attempt 归属的幂等 Capture、词法排序的内容寻址 Manifest、完整 Materialization、保留被引用证据、隔离不匹配引用、授权删除与缺失状态重放。

<a id="dev-note"></a>
## 开发备注
该服务不发布不变量 companion：每项制品操作都会同步校验 Manifest。

<details>
<summary>维护者工作背景 — 点击展开</summary>

无。

</details>

<a id="model-experience"></a>
## 模型体验

### 制品证据

#### 模型会看到什么

节点输出可以声明相对源目录的制品路径。完整的 `GraphArtifactManifest`、Provider 位置、凭据、工作区根目录、Blob Key 与恢复证据保持 Host-only，除非后续主控 Schema 显式选取有界的公开字段。

#### Token 影响

不会直接增加请求内容。后继节点只接收已经进入前置节点输出的制品路径字符串。

#### KV Cache 影响

没有直接影响；Artifact Manifest 是持久执行证据，不是提示词内容。

## 已知限制与后续工作 <a id="known-limitations-and-deferred-work"></a>

- 本包定义传输与校验，但不选择存储后端。Graph Mode 拥有集成策略，并在自动 Materialize 前要求源 Hash。
- 多 Host 部署需要由共享且经过认证的存储支持 Provider；本地文件系统 Provider 只覆盖共享同一挂载文件系统的 Host。
