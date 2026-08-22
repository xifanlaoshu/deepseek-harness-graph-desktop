# `@deepseek-ai/dsh-browser-chrome-devtools`

English | [中文](README.zh.md)

An optional profile bundle that gives dsh agents local Chrome automation through Google's official [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp). The package pins the upstream server, starts it as a child process without a shell, connects to a separately launched Chrome DevTools Protocol endpoint, and exposes its tools through [`@deepseek-ai/dsh-mcp-client`](../../mcp/mcp-client/README.md).

The default configuration supports DOM snapshots and UID-based actions, screenshots returned as image blocks, coordinate clicks for vision models, console and network inspection, performance traces, and explicit `pageId` routing for concurrent agents. Tool names use the `mcp__chrome__*` namespace.

## Install and start

Install the bundle into the Web profile from a published package:

```sh
dsh plugin --profile web add @deepseek-ai/dsh-browser-chrome-devtools
```

From this repository checkout, install the workspace package instead:

```sh
pnpm dsh plugin --profile web add ./packages/bundle/browser-chrome-devtools
```

Chrome 136 and later require remote debugging to use a non-default user data directory. On Windows, the package includes a launcher that finds Chrome, creates a dedicated profile, binds the debugging endpoint to loopback, and waits until it is ready:

```powershell
powershell -ExecutionPolicy Bypass -File .\packages\bundle\browser-chrome-devtools\scripts\start-chrome-debug.ps1
```

The equivalent direct launch is:

```powershell
& "$env:PROGRAMFILES\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 --user-data-dir="$env:LOCALAPPDATA\dsh\chrome-debug-profile" --no-first-run --no-default-browser-check
```

Then start the Web profile:

```sh
dsh web
```

Set `DSH_CHROME_DEBUG_URL` before starting dsh when Chrome uses another port. An installed profile may also override the `browser-chrome-devtools` row in its `cordis.patch.yml`; patch replacement requires restating the complete config.

## Enable Qwen image input

Browser screenshots reach the selected model only when that exact model route declares image input. The Web provider form does not expose this field; add `input: [text, image]` to the existing Qwen model in `$DSH_HOME/settings.yaml`:

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

Keep the provider id, model id, endpoint, credential reference, capacity, and reasoning fields from the existing entry. A text-only declaration produces a model-capability diagnostic instead of silently discarding the screenshot. The llama.cpp server must also expose an OpenAI-compatible vision request path backed by the loaded multimodal projector.

## Config

[`cordis.patch.yml`](cordis.patch.yml) mounts this package with conservative local defaults. Every value is a validated plugin field:

| Field | Default | Behavior |
|---|---:|---|
| `serverName` | `chrome` | MCP tool namespace |
| `browserUrl` | `http://127.0.0.1:9222` | Running Chrome debugging endpoint |
| `toolCallTimeoutMs` | `120000` | Harness-side deadline for one browser call |
| `failOnStartupError` | `true` | Refuse activation when server startup or tool discovery fails |
| `experimentalVision` | `true` | Expose screenshot-coordinate actions |
| `pageIdRouting` | `true` | Require page-scoped calls to identify their tab |
| `performanceCrux` | `false` | Keep trace URLs away from the Google CrUX service |
| `usageStatistics` | `false` | Disable upstream usage reporting |
| `redactNetworkHeaders` | `true` | Redact sensitive response headers |
| `screenshotFormat` | `webp` | Reduce image bytes and model context cost |
| `screenshotQuality` | `80` | Default JPEG/WebP quality |
| `screenshotMaxWidth` | `1600` | Proportional screenshot width cap |
| `screenshotMaxHeight` | `1200` | Proportional screenshot height cap |

The wrapper also disables the upstream update check. Upgrades are explicit dependency changes, so the tool schema cannot change between local starts without a reviewed package update.

## Security

Use the dedicated debug profile only for test accounts and test data. Any local process that can reach the debugging port can control that Chrome instance, and browser tool results can contain page text, console output, request data, and screenshots. The launcher binds to `127.0.0.1`; the plugin does not add authentication to a non-loopback endpoint.

The upstream server's unrestricted-path option remains disabled. Without negotiated MCP roots, file-writing browser tools stay restricted to the operating-system temporary directory.

## Model Experience

### Browser automation context

#### What the model sees

The model receives the discovered `mcp__chrome__*` tool schemas, a short system-prompt section, and browser tool results retained in conversation history. The prompt directs it to prefer accessibility snapshots and stable element UIDs, use screenshots for visual assertions, preserve explicit page identity, inspect relevant console or network failures, and claim success only from observed evidence. The generic MCP client stores supported screenshot blocks as durable Harness image attachments before the next model request.

#### Token effect

The full discovered tool catalog and the short guidance section are present on every request while the bundle is active. Snapshot text, tool arguments, text results, and durable image references remain in history until compaction; WebP and screenshot dimension caps reduce dynamic image payloads.

#### KV Cache effect

The system-prompt section is stable for one `serverName`, and the tool catalog stays prefix-stable while the pinned server advertises unchanged schemas. Newly appended browser results follow the reusable prefix; changing the server namespace or upgrading the pinned server may invalidate reuse from the first changed prompt or schema token.

## Known Limitations and Deferred Work

- **The browser is an external process** — dsh starts and supervises the MCP server, not Chrome. Start the debug profile first and keep it running for the test.
- **Concurrent agents still coordinate tab ownership** — `pageIdRouting` prevents accidental reliance on one global selected page, but it does not assign tabs or serialize conflicting actions.
- **Visual accuracy belongs to the selected model** — screenshots provide pixels, while coordinate selection and visual assertions depend on the local Qwen projector, quantization, prompt, and image budget.
- **Chrome DevTools MCP officially supports Google Chrome and Chrome for Testing** — other Chromium browsers may work but are outside the upstream support promise.
