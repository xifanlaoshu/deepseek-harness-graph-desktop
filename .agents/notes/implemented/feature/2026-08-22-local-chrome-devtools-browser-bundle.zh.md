# Agent Note: 通过固定版本的 DevTools MCP 组合包实现本地 Chrome 自动化

Status: implemented

[English](2026-08-22-local-chrome-devtools-browser-bundle.md) | 中文

## 问题

Harness agent（智能体）需要一条浏览器执行路径：既能操作开发者的本地测试页面、把截图返回给支持图片的模型并暴露调试证据，又不要求 Harness 自己维护第二套浏览器自动化协议。本地调试浏览器还拥有强大的环境权限，因此组合必须将其与用户日常使用的 Chrome profile 分离，且不得静默扩大数据或文件系统访问范围。

## 决策

`@deepseek-ai/dsh-browser-chrome-devtools` 是通用 MCP 客户端之上的可选 profile 组合包。它固定 Google 的 `chrome-devtools-mcp` 包，从组合包自身的依赖树解析已安装的可执行文件，并通过 `process.execPath` 启动，不使用 shell，也不查找包管理器。服务器连接配置指定的 HTTP Chrome DevTools Protocol 端点；默认地址为回环端口 9222。

组合包启用实验性视觉操作与 page-id 路由，因为一个 Harness Host 可以通过同一个 MCP 服务器服务并发 agent。DOM 快照与 UID 操作仍是首选交互路径；截图提供视觉证据，坐标点击作为后备方式。模型提示词会说明该顺序，并要求模型观察页面、控制台或网络证据后才能给出通过结论。

包装层默认关闭上游使用情况统计、更新检查、性能 CrUX 请求、非受限路径与未隐去的敏感网络响应头。WebP 截图与尺寸上限约束常规模型载荷。每项随部署变化的选择都是经过验证的插件配置字段，profile patch 则提供随发行版交付的默认值。

Chrome 在 Harness 生命周期外运行并使用专用用户数据目录。Windows 启动脚本把调试端点绑定到 `127.0.0.1`，绝不复用默认 Chrome profile。MCP 服务器是所属 Cordis 插件的子进程，会随插件 dispose（资源释放）；Chrome 仍由操作者拥有。

截图内容沿用现有 MCP 图片路径：MCP 客户端通过 attachment 服务验证并保存受支持的图片块，且只有确切选中的模型路由声明图片输入时，模型才会收到图片。浏览器包装层不会根据模型名称或端点推断多模态支持。

## 验证

包测试固定配置验证、可执行文件解析、准确的上游参数、提示词注册与组合包 manifest（元数据清单）解析。真实服务器集成测试通过 stdio 启动固定版本的 MCP 可执行文件，并验证其浏览器工具无需 shell 即可注册。现有 MCP 图片测试固定图片结果到持久 attachment 的转换，以及纯文本模型的诊断行为。

## 考虑过的替代方案

**直接使用 Playwright 或 Puppeteer 实现浏览器操作**：拒绝，因为 Harness 将不得不维护导航、选择器、截图、控制台、网络、生命周期与协议兼容代码，而 Chrome DevTools 团队已经维护这些能力。包装层只保留 Harness 专属的组合与策略。

**使用 `microsoft/playwright-mcp`**：它适用于基于无障碍树的自动化，但 Chrome DevTools 服务器直接匹配本地 CDP、控制台、网络与性能调试需求，并为多模态模型暴露坐标工具。通用 MCP 客户端仍允许用户把 Playwright MCP 作为另一套组合接入。

**从 YAML 运行 `npx chrome-devtools-mcp@latest`**：拒绝，因为这要求处理 PATH 与 shell 平台差异，会在每个部署中执行包解析，还会让上游发布在两次启动之间改变工具目录。固定依赖与 `process.execPath` 使启动具有确定性。

**附加到日常 Chrome profile**：拒绝，因为调试进程可以检查已登录的个人页面，而且 Chrome 136 及更高版本会忽略针对默认数据目录的远程调试开关。专用 profile 让权限范围显式且可丢弃。

## 后果

Harness 以较小的自有实现获得维护良好的 Chrome 自动化与多模态截图结果。组合包增加上游服务器的依赖体积，并在启用时暴露较大的工具目录。操作者必须单独启动并保护 Chrome、为本地视觉模型声明图片能力，并协调并发 agent 的标签页所有权；page-id 路由可以避免隐式选择全局页面，但不能替代这种协调。
