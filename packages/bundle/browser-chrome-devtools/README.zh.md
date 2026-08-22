# `@deepseek-ai/dsh-browser-chrome-devtools`

[English](README.md) | 中文

这是一个可选的 profile 组合包，通过 Google 官方 [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp) 为 dsh agent（智能体）提供本地 Chrome 自动化能力。该包固定上游服务器版本，不经过 shell 启动其子进程，连接单独启动的 Chrome DevTools Protocol 端点，并通过 [`@deepseek-ai/dsh-mcp-client`](../../mcp/mcp-client/README.zh.md) 暴露工具。

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

Chrome 136 及更高版本要求远程调试使用非默认用户数据目录。在 Windows 上，本包提供的启动脚本会查找 Chrome、创建专用 profile、把调试端点绑定到回环地址，并等待端点就绪：

```powershell
powershell -ExecutionPolicy Bypass -File .\packages\bundle\browser-chrome-devtools\scripts\start-chrome-debug.ps1
```

等价的直接启动命令如下：

```powershell
& "$env:PROGRAMFILES\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 --user-data-dir="$env:LOCALAPPDATA\dsh\chrome-debug-profile" --no-first-run --no-default-browser-check
```

然后启动 Web profile：

```sh
dsh web
```

当 Chrome 使用其他端口时，在启动 dsh 前设置 `DSH_CHROME_DEBUG_URL`。已安装的 profile 也可以在其 `cordis.patch.yml` 中覆盖 `browser-chrome-devtools` 配置项；patch 替换配置时必须重述完整配置。

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
| `browserUrl` | `http://127.0.0.1:9222` | 正在运行的 Chrome 调试端点 |
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

包装层还会禁用上游更新检查。升级必须显式修改依赖，因此未经评审的包更新不会让工具 schema 在两次本地启动之间发生变化。

## 安全

专用调试 profile 只能使用测试账号与测试数据。任何能够访问调试端口的本地进程都可以控制该 Chrome 实例，浏览器工具结果可能包含页面文本、控制台输出、请求数据与截图。启动脚本绑定 `127.0.0.1`；插件不会为非回环端点添加身份验证。

上游服务器的非受限路径选项保持关闭。没有协商 MCP roots 时，可写文件的浏览器工具仍然只能使用操作系统临时目录。

## 模型体验

### 浏览器自动化上下文

#### 模型看到的内容

模型会收到发现的 `mcp__chrome__*` 工具 schema、一个简短的系统提示词区段，以及会话历史中保留的浏览器工具结果。提示词要求模型优先使用无障碍快照与稳定的元素 UID、使用截图完成视觉断言、保留显式页面身份、检查相关控制台或网络失败，并且只根据实际观察到的证据判定成功。通用 MCP client 会先把受支持的截图块保存为持久的 Harness 图片 attachment，再构造下一次模型请求。

#### Token 影响

组合包启用期间，每次请求都包含完整的已发现工具目录和简短指引区段。快照文本、工具参数、文本结果与持久图片引用会保留在历史中直至压缩；WebP 与截图尺寸上限会减少动态图片载荷。

#### KV Cache 影响

对同一个 `serverName`，系统提示词区段保持稳定；只要固定版本的服务器发布的 schema 不变，工具目录也保持前缀稳定。新追加的浏览器结果位于可复用前缀之后；修改服务器命名空间或升级固定版本的服务器，可能从首个变化的提示词或 schema token 起使复用失效。

## 已知限制与暂缓事项

- **浏览器属于外部进程**：dsh 启动并监管 MCP 服务器，而不启动 Chrome。请先启动调试 profile，并在测试期间保持运行。
- **并发 agent 仍需协调标签页所有权**：`pageIdRouting` 可以防止意外依赖单一全局选中页面，但不会分配标签页，也不会串行化互相冲突的操作。
- **视觉准确性取决于选中的模型**：截图提供像素，坐标选择与视觉断言则取决于本地 Qwen projector、量化、提示词与图片预算。
- **Chrome DevTools MCP 官方支持 Google Chrome 与 Chrome for Testing**：其他 Chromium 浏览器可能可用，但不属于上游支持承诺。
