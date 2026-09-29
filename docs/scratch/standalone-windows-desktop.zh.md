---
description: "自包含 Windows Graph 桌面发行版的迁移与资格验证方案。"
owner: "Desktop fork maintainers"
created: "2026-09-29"
expires: "2026-10-29"
promotion-target: "apps/desktop/README.md and component-owned READMEs"
---

# 独立 Windows Graph 桌面版方案

[English](standalone-windows-desktop.md) | 中文

## 摘要

本拟议发行版让用户无需单独安装开发环境即可使用 Graph 编排和浏览器测试。安装包包含应用运行时、原生 LoopX 控制平面和隔离的自动化浏览器。模型访问仍需要配置服务，或准备兼容的本地硬件及模型权重。本文定义开发和资格验证工作，不表示安装包已经通过验收。

## 目录

- [交付范围](#delivery-scope)
- [迁移职责](#migration-ownership)
- [运行时组成](#runtime-composition)
- [生命周期与安全](#lifecycle-and-security)
- [开发顺序](#development-sequence)
- [验收](#acceptance)
- [开发备注](#dev-note)

<a id="delivery-scope"></a>
## 交付范围

首个资格验证目标是 Windows 11 x64。Windows 10 22H2 x64 需要单独执行兼容性测试，本应用不会恢复该操作系统的安全支持。不承诺 Windows 7/8、32 位 Windows、ARM 模拟、Server、S 模式或任意企业策略下的兼容性。

拟议默认方案不要求用户安装 WSL、Node、Python、pnpm、LoopX 或 Chrome。构建工具属于开发机器，不属于已安装的应用。Git 操作、Docker 工作负载、Maven 项目和本地推理服务仍是不同的能力：在任务依赖这些环境之前，必须捆绑并验证其运行时，或明确声明要求。桌面安装包无法提供每个项目任意的外部环境。

<a id="migration-ownership"></a>
## 迁移职责

集成采用官方[桌面发行版](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.0-rc.2)，并保留完整的本地 fork，包括尚未推送的 Session 格式工作。独立 worktree 将开发与正在运行的 Web 服务分离。未经用户选择，不重命名或覆盖现有仓库 fork。

| 负责模块 | 必须保留的行为 |
|---|---|
| Graph 与 Client | 角色模板、模型与推理设置、全局子代理限制、主控韧性、campaign 批次、修订关系、节点证据和子会话导航 |
| 协作 | 稳定工作标识、activation 隔离、八项协议操作、最新 fencing token、终态结果复用、幂等进度和重启对账 |
| Session | 已发布历史 schema 不可变；当前格式和相邻迁移保持明确的版本归属 |
| Worker 与资源 | 工作区隔离、产物传输、并发限制、模型容量观测、退避和调度所有权 |
| 浏览器与 MCP | 连续操作、多模态截图、证据路径校验、超时策略和所拥有浏览器的清理 |
| 学习资料 | 现有双语课程及文档配对记录 |

已提交改动与剩余工作区差异分别建立清单。凭据、签名材料、机器端点、会话、LoopX 数据库、浏览器 profile、缓存和模型权重不进入源码迁移及可分发默认配置。现有用户数据只能通过明确的备份与迁移操作导入，不能把活动租约复制到新运行时。

<a id="runtime-composition"></a>
## 运行时组成

[桌面运行时](../../apps/desktop/README.zh.md) 已包含 Electron 和主要的 Node/Python/pnpm 载荷。打包将锁定组件加入现有机制，不引入第二套应用启动器。所有应用启动继续通过受支持的 `dsh` profile。

| 组件 | 拟议打包及资格验证 |
|---|---|
| Harness 与 Graph | 生产依赖闭包包含每个 profile 插件；首次激活无需 npm 下载 |
| LoopX | 固定原生 Windows 版本、私有模块资源、内置解释器绝对路径和完整 registry 初始化；不回退 WSL |
| 浏览器 | 固定 Chrome for Testing 或经验证可再分发的 Chromium 构建、显式可执行路径、私有 profile，无首次使用下载 |
| MCP | 从应用依赖闭包提供锁定的服务器依赖和工具，保留现有截图及工作区限制 |
| 可变数据 | 独立 fork home 保存会话、设置、LoopX registry、证据和导入的工作区；不放在安装资源中 |

[LoopX 安装指南](https://github.com/loopx-project/loopx/blob/main/docs/guides/installing-loopx.md) 描述了原生 Windows 安装方式，但这不能证明所选发行版兼容 Harness CLI 协议。捆绑之前必须通过真实原生测试建立兼容性。本机 SQLite 协调器是明确的替代产品模式，不是自动回退，也不替代全部 LoopX 能力。

<a id="lifecycle-and-security"></a>
## 生命周期与安全

每个控制平面进程和自动化浏览器都有应用所有者。取消、关闭和启动失败都要等待所拥有进程树退出；无关的用户浏览器保持运行。浏览器自动化不能通过全局调试端点访问高权限 Electron 应用。证据仍受已批准工作区根目录约束。

fork 使用自己的应用标识、安装目录、协议 scheme、home、缓存、签名发布者、更新源和强制更新策略。官方更新绝不能替换定制 Graph 代码。发行版携带锁定组件版本、哈希、来源引用、SBOM、许可证和必需的 NOTICE 文件。组件自更新保持禁用，应用发行版统一更新通过验证的组件。

LoopX goal 和 peer 标识按用户项目幂等创建。启动健康检查在图运行之前展示组件故障。协调器失败不能静默变成另一种 Provider。崩溃恢复在派发子代理之前对账持久工作，不能根据进程不存在推断成功。

<a id="development-sequence"></a>
## 开发顺序

开发拆成适合低级模型代理的有界模块，由 Astra 评审架构与安全决策。每个模块包含所属文档以及聚焦的有效和无效测试用例。

1. 保全本地 fork 并合并锁定的官方发行版。评审格式谱系，重新生成目录，不改写已提交的历史代次。
2. 增加显式内置浏览器可执行文件设置和 fork 更新源校验，分别验证这两个模块。
3. 用共享协作测试验证固定的原生 LoopX 发行版，再实现载荷准备、初始化及所拥有进程树的清理。
4. 锁定并准备浏览器载荷及再分发声明。将两类载荷加入包清单、签名、完整性检查和离线激活。
5. 接入专用桌面 profile 和独立数据标识。验证模型路由、Graph UI、主控兜底、压缩与历史浏览。
6. 构建用户确认完整版本号的安装包并执行干净机器验收。只有签名、许可证和更新归属确定后才能发布。

<a id="acceptance"></a>
## 验收

资格验证使用没有 WSL、开发者 Node/Python/pnpm 和已安装 Chrome 的全新普通用户 Windows VM。仅构建宿主测试不能证明这个结果。

- 离线安装、启动、组件健康、本地浏览器操作和截图留证不下载依赖即可成功。云模型调用仍需网络和用户凭据。
- Graph 创建并执行真实计划，遵守一个子代理的限制，保留修订及批次关系，重启后正确恢复。
- 原生协作拒绝旧 fencing token、复用已接受终态结果、对账过期租约，并正确处理 broker 崩溃、取消和重复结算。
- 浏览器测试覆盖正常及失败流程、控制台和网络证据、中文及空格路径、端口冲突和进程清理。
- 数据测试覆盖历史会话导入、相邻迁移、子会话浏览及不可变来源历史。现有会话在备份上测试。
- 安装包测试覆盖安装、升级失败、回滚、卸载、低磁盘、完整性拒绝和不含秘密材料。卸载及更新策略明确保留或删除文档指定的数据集合。

<a id="dev-note"></a>
## 开发备注

本方案于 2026-10-29 到期。用户于 2026-09-30 确认仓库为 `xifanlaoshu/deepseek-harness-graph-desktop`，完整安装包版本为 `0.2.0-rc.2-graph.1`。产品标识、签名、浏览器再分发、原生 LoopX 兼容性和干净 VM 结果仍是发布决策或资格验证要求。当前 Web 服务不在此开发 worktree 中，迁移任务不得重启它。
