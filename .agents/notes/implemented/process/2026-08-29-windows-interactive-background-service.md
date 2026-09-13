# Agent Note: Windows interactive background service

Status: implemented

English | [中文](2026-08-29-windows-interactive-background-service.zh.md)

## Problem

Running the Web profile in an ordinary terminal ties DSH availability to that terminal's lifetime. Registering the same command directly with the Windows Service Control Manager would move it into non-interactive Session 0, where the user's WSL distribution and visible Chrome automation are unavailable or unreliable.

## Decision

The source distribution provides `scripts/windows/dsh-service.ps1` as the Windows lifecycle entry point and `scripts/windows/dsh-service-host.ps1` as its supervisor. The manager registers a per-user Task Scheduler task with an interactive logon token, starts it on login, exposes install/start/stop/restart/status/uninstall operations, and preserves service diagnostics on uninstall.

The supervisor launches the source Web entry point from the recorded repository root with the recorded DSH home, Node executable, port, and configurable V8 old-space limit. The manager validates `MaxOldSpaceSizeMB` from 512 through 65,536 and installs 8,192 MB by default; the supervisor passes it as Node's `--max-old-space-size` argument and publishes the effective value in runtime status. It keeps an exclusive per-installation mutex, writes PID identity and start-time evidence atomically, rotates child stdout/stderr logs, and restarts an unexpected child exit after a bounded delay. Stop verifies the recorded executable and start time before terminating that process tree, so a stale PID file cannot kill an unrelated process.

## Alternatives considered

**Register `node.exe` directly with SCM.** A console process does not implement the Windows service protocol, and Session 0 breaks the interactive WSL and Chrome behavior required by this deployment.

**Use WinSW or NSSM under LocalSystem.** A wrapper solves the SCM protocol but retains the Session 0 and service-account state problems. Running the wrapper as the user's account would require password or service-logon provisioning that this repository must not collect or persist.

**Keep a terminal or Codex execution session open.** That process remains owned by a disposable terminal and is terminated when its host session is reclaimed.

## Consequences

DSH survives terminal closure, starts after login, and restarts without storing a Windows password while retaining access to the user's WSL, Chrome, and DSH home. The deployment is user-session scoped rather than machine-boot scoped; a headless SCM deployment requires a separate service-owned configuration that disables interactive dependencies. The memory parameter limits V8 old space, not total process memory or native allocations, so operators must choose a value that leaves physical memory for model runtimes and WSL. Moving the checkout, changing Node.js, or changing the memory limit requires reinstalling the task, and source updates require an explicit service restart.
