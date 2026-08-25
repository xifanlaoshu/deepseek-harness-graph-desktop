# `@deepseek-ai/dsh-browser-chrome-devtools`

[English](README.md) | 中文

这是一个可选的 profile 组合包，通过 Google 官方 [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp) 为 dsh agent（智能体）提供本地 Chrome 自动化能力。该包固定上游服务器版本，不经过 shell 启动其子进程，由该服务器启动并回收隔离的 Chrome 进程，再通过 [`@deepseek-ai/dsh-mcp-client`](../../mcp/mcp-client/README.zh.md) 暴露工具。

默认配置支持 DOM 快照与基于 UID 的操作、以图片块返回的截图、供视觉模型使用的坐标点击、控制台与网络检查、性能跟踪，以及供并发 agent 使用的显式 `pageId` 路由。工具名称使用 `mcp__chrome__*` 命名空间。

## 安装与启动

从已发布的包把组合包安装到 Web profile：

```sh
dsh plugin --profile web add @deepseek-ai/dsh-browser-chrome-devtools
```

在本仓库检出目录中，改为安装 workspace 包：

```sh
pnpm dsh plugin --profile web add ./packages/bundle/browser-chrome-devtools
```

安装后启动 Web profile：

```sh
dsh web
```

默认 `managed` 模式不需要单独执行 Chrome 命令。第一次浏览器工具调用会用临时 profile 启动稳定版 Chrome，并显示最大化窗口。释放或重启该组合包时，上游 MCP 生命周期会关闭 Chrome 进程并删除临时 profile。

如果需要连接由操作者管理的调试端点，请在启动 dsh 前设置 `DSH_CHROME_DEBUG_URL`，从而选择 `external` 模式。Chrome 136 及更高版本要求远程调试使用非默认用户数据目录。在 Windows 上，本包为这种可选模式提供启动脚本：

```powershell
powershell -ExecutionPolicy Bypass -File .\packages\bundle\browser-chrome-devtools\scripts\start-chrome-debug.ps1
```

等价的直接启动命令如下：

```powershell
& "$env:PROGRAMFILES\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 --user-data-dir="$env:LOCALAPPDATA\dsh\chrome-debug-profile" --no-first-run --no-default-browser-check
```

组合包停止时，外部 Chrome 进程仍由操作者所有。已安装的 profile 也可以在其 `cordis.patch.yml` 中覆盖 `browser-chrome-devtools` 配置项；patch 替换配置时必须重述完整配置。

## 启用 Qwen 图片输入

只有确切的模型路由声明支持图片输入，浏览器截图才能送达选中的模型。Web 提供方表单没有暴露此字段；请在 `$DSH_HOME/settings.yaml` 现有的 Qwen 模型中添加 `input: [text, image]`：

```yaml
llm-pi-ai:
  providers:
    local-qwen:
      api: openai-completions
      baseURL: http://127.0.0.1:8080/v1
      models:
        - id: qwen
          input: [text, image]
```

保留现有配置项中的提供方 id、模型 id、端点、credential 引用、容量与推理字段。纯文本声明会生成模型能力诊断，而不是静默丢弃截图。llama.cpp 服务器也必须基于已加载的多模态 projector 提供 OpenAI 兼容的视觉请求路径。

## 配置

[`cordis.patch.yml`](cordis.patch.yml) 使用保守的本地默认值挂载本包。每个值都是经过验证的插件字段：

| 字段 | 默认值 | 行为 |
|---|---:|---|
| `serverName` | `chrome` | MCP 工具命名空间 |
| `browserMode` | `managed` | 启动自有 Chrome 进程，或连接 `external` Chrome |
| `browserUrl` | `http://127.0.0.1:9222` | 仅在 `external` 模式使用的 Chrome 调试端点 |
| `chromeChannel` | `stable` | `managed` 模式选择的已安装 Chrome 渠道 |
| `headless` | `false` | 隐藏受管理的 Chrome 窗口 |
| `isolatedProfile` | `true` | 使用受管理 Chrome 关闭后会删除的临时 profile |
| `startMaximized` | `true` | 最大化有界面的受管理 Chrome 初始窗口 |
| `toolCallTimeoutMs` | `120000` | Harness 单次浏览器调用的截止时间 |
| `failOnStartupError` | `true` | 服务器启动或工具发现失败时拒绝激活 |
| `experimentalVision` | `true` | 暴露截图坐标操作 |
| `pageIdRouting` | `true` | 要求页面范围的调用标识所属标签页 |
| `performanceCrux` | `false` | 不把性能跟踪 URL 发送给 Google CrUX 服务 |
| `usageStatistics` | `false` | 禁用上游使用情况上报 |
| `redactNetworkHeaders` | `true` | 隐去敏感响应头 |
| `screenshotFormat` | `webp` | 减少图片字节数与模型上下文成本 |
| `screenshotQuality` | `80` | 默认 JPEG／WebP 质量 |
| `screenshotMaxWidth` | `1600` | 按比例缩放的截图宽度上限 |
| `screenshotMaxHeight` | `1200` | 按比例缩放的截图高度上限 |

包装层还会禁用上游更新检查。受管理 Chrome 会在第一次浏览器操作时延迟启动；仅发现 MCP 工具不会打开窗口。升级必须显式修改依赖，因此未经评审的包更新不会让工具 schema 在两次本地启动之间发生变化。

## Graph 与并发 agent

浏览器组合包不依赖任何 Graph 包，也不持有 Graph run 状态。Graph Worker 通过 Harness 的普通工具注册表获得同一组浏览器工具，因此浏览器进程的启动、关闭与配置可以独立于 Graph Mode 被替换。

一个正在运行的组合包通过一个受管理 Chrome 进程服务多个 agent。委派或并行测试必须使用唯一的 `isolatedContext` 调用 `new_page`，之后只操作该上下文返回的 Page ID。不同隔离上下文不会共享 Cookie 或 Web Storage；显式 `pageId` 路由可以避开服务器的全局已选页面状态。

保存文件证据的浏览器工具接受相对于调用 agent 会话工作区的路径，例如 `test-evidence/run-01/login.png`。位于隔离副本中的 Graph Worker 会写入该目录，再通过既有 artifact 集成发布图片；不得使用绝对路径直接指向源工作区。

## 安全

受管理 Chrome 只能使用测试账号与测试数据。临时 profile 与日常 Chrome profile 相互隔离，但浏览器工具结果仍可能包含页面文本、控制台输出、请求数据与截图。在 `external` 模式中，任何能够访问调试端口的本地进程都可以控制该 Chrome 实例；启动脚本绑定 `127.0.0.1`，插件不会为非回环端点添加身份验证。

由于一个连接由多个 agent 共享，无法安全声明单一静态 MCP Root，因此上游 MCP 进程会启用其非受限路径选项。Harness MCP 桥接层会把每个浏览器文件系统路径参数限制到确切调用 agent 的规范会话工作区，并发送通过检查的同一目标，因此相对路径会使用 agent 工作区，且不能通过检查后切换的符号链接重新解析。缺失调用上下文、工作区外路径与符号链接逃逸会在调用前被拒绝。真实服务器测试会对比固定版本已发现工具 Schema 与受保护参数列表，因此新暴露的路径参数会使验证失败；被拒绝的路径不会发送给上游进程。

## 模型体验

### 浏览器自动化上下文

#### 模型看到的内容

模型会收到发现的 `mcp__chrome__*` 工具 schema、一个简短的系统提示词区段，以及会话历史中保留的浏览器工具结果。提示词要求委派或并行任务创建唯一隔离上下文、优先使用无障碍快照与稳定的元素 UID、使用截图完成视觉断言、通过工作区相对路径保存文件证据、保留显式页面身份、检查相关控制台或网络失败，并且只根据实际观察到的证据判定成功。通用 MCP client 会先把受支持的截图块保存为持久的 Harness 图片 attachment，再构造下一次模型请求。

#### Token 影响

组合包启用期间，每次请求都包含完整的已发现工具目录和简短指引区段。快照文本、工具参数、文本结果与持久图片引用会保留在历史中直至压缩；WebP 与截图尺寸上限会减少动态图片载荷。

#### KV Cache 影响

对同一个 `serverName`，系统提示词区段保持稳定；只要固定版本的服务器发布的 schema 不变，工具目录也保持前缀稳定。新追加的浏览器结果位于可复用前缀之后；修改服务器命名空间或升级固定版本的服务器，可能从首个变化的提示词或 schema token 起使复用失效。

## 已知限制与暂缓事项

- **受管理 Chrome 延迟启动**：dsh 激活时可以证明固定版本的 MCP 服务器与工具目录可用；Chrome 安装或启动失败会在第一次浏览器操作时暴露。
- **并发 agent 仍需选择上下文名称**：隔离上下文与 `pageIdRouting` 提供机制，但上游服务器不会替 Harness agent 分配名称或串行化冲突操作。
- **视觉准确性取决于选中的模型**：截图提供像素，坐标选择与视觉断言则取决于本地 Qwen projector、量化、提示词与图片预算。
- **Chrome DevTools MCP 官方支持 Google Chrome 与 Chrome for Testing**：其他 Chromium 浏览器可能可用，但不属于上游支持承诺。
