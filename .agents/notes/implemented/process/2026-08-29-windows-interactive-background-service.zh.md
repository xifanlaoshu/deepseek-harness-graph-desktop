# Agent Note: Windows 交互式后台服务

Status: implemented

[English](2026-08-29-windows-interactive-background-service.md) | 中文

## Problem

在普通终端中运行 Web profile 会让 DSH 的可用性依赖该终端的生命周期。把同一条命令直接注册到 Windows 服务控制管理器会使其进入非交互式 Session 0，无法可靠使用当前用户的 WSL 发行版和可视化 Chrome 自动化。

## Decision

源码发行版使用 `scripts/windows/dsh-service.ps1` 作为 Windows 生命周期入口，使用 `scripts/windows/dsh-service-host.ps1` 作为监督进程。管理脚本通过交互式登录令牌注册当前用户的任务计划程序任务，在登录时启动，并提供 install/start/stop/restart/status/uninstall 操作；卸载时保留服务诊断数据。

监督进程使用安装时记录的仓库根目录、DSH home、Node 可执行文件、端口和可配置 V8 old-space 上限启动源码 Web 入口。管理脚本校验 512 到 65,536 之间的 `MaxOldSpaceSizeMB`，并默认安装 8,192 MB；监督进程将其作为 Node `--max-old-space-size` 参数传入，并在运行状态中发布生效值。它持有每个安装实例独占的互斥锁，以原子方式写入 PID 身份与启动时间证据，轮转子进程 stdout/stderr 日志，并在子进程意外退出后经过有界延迟重新启动。停止操作会先验证记录的可执行文件和启动时间，再终止该进程树，因此过期 PID 文件不会杀死无关进程。

## Alternatives considered

**直接把 `node.exe` 注册到 SCM。** 控制台进程没有实现 Windows 服务协议，而且 Session 0 会破坏该部署所需的交互式 WSL 和 Chrome 行为。

**在 LocalSystem 下使用 WinSW 或 NSSM。** 包装程序可以解决 SCM 协议问题，但不能解决 Session 0 和服务账户状态问题。让包装程序使用当前用户账户需要配置密码或服务登录权限，本仓库不得收集或持久化这些信息。

**持续打开终端或 Codex 执行会话。** 该进程仍归一次性终端所有，宿主会话被回收时会将其终止。

## Consequences

DSH 可以在终端关闭后继续运行，在登录后启动，并且无需保存 Windows 密码即可继续访问当前用户的 WSL、Chrome 和 DSH home。该部署作用于用户会话而不是机器启动阶段；无界面的 SCM 部署需要使用禁用交互依赖的独立服务配置。内存参数限制 V8 old space，而不是进程总内存或原生分配，因此操作者必须选择一个能为模型运行时和 WSL 留出物理内存的值。移动检出目录、更换 Node.js 或更改内存上限后必须重新安装任务，源码更新后必须显式重启服务。
