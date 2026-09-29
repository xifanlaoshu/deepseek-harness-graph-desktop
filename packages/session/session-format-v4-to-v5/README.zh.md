---
description: "Session V4 到 V5 的迁移与原生 V5 接纳规则。"
kind: "package-library"
---

# @deepseek-ai/dsh-session-format-v4-to-v5

[English](README.md) | 中文

## 概述

本库将已存储的 V4 Session 升级为 V5 写入格式，不改变事件正文，也不覆盖 V4 文件。V5 的当前 Session 校验接纳 Graph 拥有的消息来源。V4 物理编解码器及校验仍供历史读取使用。

本包不发布运行时不变式配套模块，因为编解码器与迁移过程会在恢复时校验每份独立产物；本包没有可供比较的独立可变观测值。

## 目录

- [转换](#conversion)
- [原生接纳](#native-admission)
- [Dev Note](#dev-note)
- [模型体验](#model-experience)
- [已知限制与待办工作](#known-limitations-and-deferred-work)

<a id="conversion"></a>
## 转换

`sessionFormatV4ToV5` 校验 V4 逻辑头，仅将 `version` 从 4 改为 5。会话标识、父会话、创建时间及所有可选头字段均保持不变。事件、紧凑事件段、序号、时间戳、来源、载荷及继承事件坐标原样传递。有种子的 Session 以最后一个继承结束标记确定截点；无种子的 Session 使用零。源 V4 编解码器负责物理解码，之前的迁移阶段各自负责其转换。缺失继承标记或与已知源截点不符时拒绝恢复。

<a id="native-admission"></a>
## 原生接纳

`releasedV5SessionFormatCodec` 保留 V4 物理行编码。V5 头保留 V4 字段，版本为 5。当前行接纳保留 V4 结构检查；已安装的 Session 校验接纳 Graph 消息来源和当前事件词汇。完整恢复检查 V4 关系，并依据事件序号及 Session 所有者校验 V5 交付标记。历史 V4 交付标记保留其 V4 含义，不会重标版本。

<a id="dev-note"></a>
## 开发备注

None.

<a id="model-experience"></a>
## 模型体验

### 历史恢复

#### 模型看到什么

迁移不提供模型可见的工具或提示词。它在恢复的代理请求之前还原已记录消息；哪些 `user/message` 等记录内容进入模型，由已安装的 Session 读取器决定。

#### Token 影响

V4 到 V5 的迁移保留消息内容，不增加承载 token 的文本。

#### KV Cache 影响

迁移边保留记录的请求前缀。提供方缓存的可用性和淘汰策略不属于本库职责。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与待办工作

- 本迁移不修复无效 V4 数据、不改写已提交的代际文件，也不合成 Graph 状态。目录和 JSONL 持久化服务负责迁移调度及后继文件发布。
- 若历史 V4 正文需要 V3 子会话事实，仍须通过目录绑定子会话证据。
