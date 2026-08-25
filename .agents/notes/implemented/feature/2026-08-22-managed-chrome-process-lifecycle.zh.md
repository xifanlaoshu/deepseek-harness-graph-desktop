# Agent Note: Harness 管理的 Chrome 进程生命周期

Status: implemented

[English](2026-08-22-managed-chrome-process-lifecycle.md) | 中文

## 问题

Harness agent（智能体）需要一条浏览器执行路径：既能操作开发者的本地测试页面、把截图返回给支持图片的模型并暴露调试证据，又不要求 Harness 维护另一套浏览器自动化协议。要求操作者单独启动调试浏览器，会让启动、故障恢复与关闭游离在插件生命周期之外。浏览器自动化进程还拥有强大的环境权限，因此它不能复用用户日常使用的 Chrome profile，也不能成为 Graph 编排实现的一部分。

## 决策

`@deepseek-ai/dsh-browser-chrome-devtools` 是通用 MCP 客户端之上的可选 profile 组合包。它固定 Google 的 `chrome-devtools-mcp` 包，从组合包自身的依赖树解析已安装的可执行文件，并通过 `process.execPath` 启动，不使用 shell，也不查找包管理器。默认 `managed` 模式让该 MCP 子进程在第一次浏览器操作时延迟启动稳定版 Chrome。有界面的 Chrome 以最大化窗口启动，并使用由上游拥有的临时用户数据目录；Harness 释放 MCP 子进程时，上游会关闭浏览器并删除该目录。

可选的 `external` 模式让 MCP 服务器连接到配置指定的 HTTP Chrome DevTools Protocol 端点。随发行版提供的 bundle patch 会在设置 `DSH_CHROME_DEBUG_URL` 后选择该模式。Harness 停止时，所连接的 Chrome 进程仍由操作者所有；该模式服务于持久测试 profile 与独立管理的环境，而不是默认生命周期。

组合包启用实验性视觉操作与 page-id 路由，因为一个 Harness Host 可以通过同一个 MCP 服务器服务并发 agent。DOM 快照与 UID 操作仍是首选交互路径；截图提供视觉证据，坐标点击作为后备方式。委派或并行测试使用唯一的上游 `isolatedContext` 创建页面，之后只操作该上下文的 Page ID。模型提示词会说明这些要求，并要求模型观察页面、控制台或网络证据后才能给出通过结论。

浏览器组合包不导入任何 Graph 包，也不持有 Graph run 状态。Graph Worker 通过 Harness 的普通注册表使用其工具。因此浏览器生命周期、传输与配置可以被独立替换，而 Graph 只负责判断何时需要浏览器验证任务。

包装层默认关闭上游使用情况统计、更新检查、性能 CrUX 请求、非受限路径与未隐去的敏感网络响应头。WebP 截图与尺寸上限约束常规模型载荷。每项随部署变化的选择都是经过验证的插件配置字段，profile patch 则提供随发行版交付的默认值。

截图内容沿用现有 MCP 图片路径：MCP 客户端通过 attachment 服务验证并保存受支持的图片块，且只有确切选中的模型路由声明图片输入时，模型才会收到图片。浏览器包装层不会根据模型名称或端点推断多模态支持。

## 验证

包测试固定两种进程模式、配置验证、可执行文件解析、准确的上游参数、提示词注册与组合包 manifest（元数据清单）解析。真实服务器集成测试通过 stdio 启动固定版本的 MCP 可执行文件，并验证其浏览器工具无需 shell 即可注册。组装后的无密钥快照固定模型可见的隔离指令与真实工具目录。本地生命周期冒烟测试会针对已安装的 Chrome 调用受管理服务器，并验证释放 Harness 后其拥有的浏览器进程终止。

## 考虑过的替代方案

**直接使用 Playwright 或 Puppeteer 实现浏览器操作与进程管理**：拒绝，因为 Harness 将不得不维护导航、选择器、截图、控制台与网络检查、Chrome 发现、profile 清理和协议兼容代码，而 Chrome DevTools 团队已经维护这些能力。包装层只保留 Harness 专属的组合与策略。

**使用 `microsoft/playwright-mcp`**：它适用于基于无障碍树的自动化，但 Chrome DevTools 服务器直接匹配本地 CDP、控制台、网络与性能调试需求，并为多模态模型暴露坐标工具。通用 MCP 客户端仍允许用户把 Playwright MCP 作为另一套组合接入。

**从 YAML 运行 `npx chrome-devtools-mcp@latest`**：拒绝，因为这要求处理 PATH 与 shell 平台差异，会在每个部署中执行包解析，还会让上游发布在两次启动之间改变工具目录。固定依赖与 `process.execPath` 使启动具有确定性。

**让 Chrome 永久由操作者管理**：拒绝将其作为默认方式，因为日常 agent 能力将依赖未显式描述的进程、端口、profile 与清理步骤。需要外部管理的环境仍可显式选择连接模式。

**连接日常 Chrome profile**：拒绝，因为自动化进程可以检查已登录的个人页面，而且 Chrome 136 及更高版本会忽略针对默认数据目录的远程调试开关。受管理模式使用可丢弃 profile；外部模式文档要求使用专用测试 profile。

**把 Chrome 生命周期代码放入 Graph Mode**：拒绝，因为普通 Harness agent 也需要相同的浏览器能力，且进程所有权与任务编排相互独立。浏览器组合包可以在不改变 Graph 的情况下安装、替换、重启或省略。

## 后果

Harness 以较小的自有实现获得维护良好的 Chrome 自动化、多模态截图结果与完全停稳的浏览器清理。用户通常只需启动 dsh；第一次浏览器调用会打开 Chrome，启动失败在这次延迟操作而非 MCP 工具发现阶段暴露。组合包增加上游服务器的依赖体积，并在启用时暴露较大的工具目录。一个正在运行的组合包仍共享一个 Chrome 进程，因此并发 agent 必须选择不同的隔离上下文名称与显式 Page ID。外部模式有意放弃自动 Chrome 清理。
