# Agent Note: Persistent stdio broker for execution-world LoopX

Status: implemented

English | [中文](2026-08-24-loopx-persistent-stdio-broker.zh.md)

## Problem

The LoopX Coordination Provider can reach a CLI installed in another execution environment through a launcher such as `wsl.exe`. Starting that launcher for every claim, heartbeat, observation, progress update, and settlement makes coordination availability depend on repeated environment startup. A long Graph run can create many short-lived launcher connections even though every operation targets the same LoopX installation and Registry. The launcher can reject a new connection before the CLI starts, leaving Graph with no LoopX response and no safe basis for replaying a possibly accepted mutation.

## Decision

The Provider offers `transport: persistent` beside the default per-operation `process` transport. Persistent transport starts one provider-owned launcher running a versioned newline-delimited Python stdio broker. Python is an explicit configurable command inside the execution environment and is already a LoopX runtime prerequisite. The configured `brokerCommand` remains the LoopX CLI authority; the broker does not implement goal, Todo, Claim, Lease, or Settlement semantics.

Each request carries the CLI arguments, converted working directory, timeout, termination grace, and stdout and stderr limits. The broker serializes requests and starts one LoopX CLI child for each operation, so LoopX retains its ordinary file-locking and process-isolation behavior without another host-to-environment launcher connection. Cancellation stops only the selected child. Provider disposal closes the protocol, cancels every owned child, and waits for the launcher tree to exit before closing the coordination journal.

The host registers each request's terminal settlement before writing it to broker stdin. Cancellation can therefore reject the selected request while that write is backpressured without creating an unhandled Promise rejection. All three stdio streams have error owners: stdin failure rejects active requests as a broker failure, while a late stdin error after disposal has begun is contained by the disposing owner.

The protocol returns raw CLI streams as base64 with independent truncation and timeout facts. A launcher that exits before readiness rejects all waiters; Windows UTF-16 diagnostics are decoded and unsigned `0xffffffff` is reported as `-1`. The next operation may start a fresh broker, but the Provider never automatically replays the failed operation because an external mutation can succeed before its response is lost.

## Alternatives considered

**One launcher per CLI operation.** This keeps implementation state minimal but makes every coordination transition pay the execution-environment startup cost and exposes long runs to repeated launcher connection failures.

**A persistent interactive shell.** Shell quoting would become part of the command protocol and would let evidence or paths alter parsing. Structured JSON requests preserve the argument array without shell interpretation.

**A LoopX daemon API.** LoopX does not provide a stable daemon contract for these coordination operations. The stdio broker preserves the released CLI as the authority and can be replaced when an official service exposes equivalent idempotency, cancellation, and readback semantics.

**Native Windows LoopX for every Windows deployment.** Native installation removes WSL from the path but also moves home-relative Registry and Goal state. Persistent transport supports deployments that intentionally retain their existing WSL state.

## Consequences

A WSL deployment holds one launcher connection and its Windows helper process tree for the Provider lifetime instead of creating a new launcher tree for each coordination operation. LoopX commands still run as separate Linux processes and remain independently bounded. The broker is an availability optimization rather than a second control plane: LoopX state and the Provider journal keep their existing ownership, and uncertain mutations still require normal reconciliation. Serial execution can delay a heartbeat behind another CLI operation, so operation deadlines and Graph lease durations remain deployment responsibilities.
