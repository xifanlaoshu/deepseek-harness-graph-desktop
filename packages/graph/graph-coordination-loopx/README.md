# `@deepseek-ai/dsh-graph-coordination-loopx`

English | [中文](README.zh.md)

LoopX CLI Service Provider for [`dsh-graph-coordination`](../graph-coordination/README.md). It verifies one configured existing goal during graph preparation, lazily creates a LoopX todo only when the scheduler makes a node ready, claims it with the role's registered peer id, and supplies a bounded public-safe claim observation. A hard-lease acquisition failure before Worker dispatch clears the Provider's soft claim and leaves the todo as a non-executable blocker, so a write-scope conflict cannot strand claimed work. Each hard-lease renewal advances the LoopX lease version; the Provider returns and persists that fenced identity so terminal writeback uses the current CAS version. Reconciliation accepts a higher lease token for the same Claim as forward renewal, while a replaced Claim, lower token, or same-token Lease mismatch remains a conflict. Progress, cancellation, claims, lease renewals, and settlements enter a schema-version-2 SQLite projection keyed by physical Activation, with stable cursors and idempotent sequences. Restart settlement reads the Todo id from the durable Claim rather than a process-local map. Terminal writes serialize per Activation, so an unrelated Activation can settle while another is waiting. Every CLI operation also has an intrinsic deadline. Success completes the todo with public-safe evidence and `no_followup`; terminal failure turns it into a blocker. Graph admission remains the authority for model concurrency, so this Provider does not apply LoopX heartbeat quota, vision, scheduler, or worktree policy to session-local node execution.

Before invoking `loopx todo claim`, the Provider checks both its durable terminal journal and the Todo's current status. A completed or blocked Todo with tagged terminal evidence returns the matching terminal disposition and repairs the local journal if necessary; it is never claimed or executed again.

```yaml
- id: graph-coordination-loopx
  name: '@deepseek-ai/dsh-graph-coordination-loopx'
  config:
    goalId: my-project-goal
    roleAgents:
      analyst: analyst-peer
      architect: architect-peer
      engineer: engineer-peer
      reviewer: reviewer-peer
      verifier: verifier-peer
      writer: writer-peer
    journalPath: .sessions/graph-coordination-loopx.sqlite
```

`goalId` and every role used by a graph must already exist in the selected LoopX registry. `executable`, `executableArgs`, `transport`, `pathStyle`, `registry`, `graceMs`, `leaseTtlSeconds`, and `operationTimeoutMs` configure external coordination. `transport: process` starts the configured CLI command for each operation. `transport: persistent` starts one provider-owned stdio broker through the configured launcher; `brokerPythonExecutable` and the required `brokerCommand` name Python and LoopX inside that execution environment. The broker serializes CLI operations, preserves per-operation timeout, cancellation, and output bounds, stops every owned command during disposal, and starts afresh after an unexpected exit. Caller cancellation rejects only that operation even while a broker stdin write is pending; stdin failures reject active operations instead of escaping as process-level stream errors. It never retries an uncertain LoopX mutation. `stdoutMaxBytes` and `stderrMaxBytes` bound collected CLI output; the stdout default is 8 MiB so a large but valid `todo list` response remains parseable, and an exceeded limit produces an explicit size diagnostic instead of a misleading JSON error. A node with precise relative `workspace.writeRoots` protects those roots and their descendants in its LoopX lease; `writeScopes` is the fallback for nodes without precise ownership or with whole-workspace ownership. Read-only nodes receive an Activation-specific non-overlapping coordination scope. `journalPath`, `journalBusyTimeoutMs`, `journalMode`, and `journalEventWindow` configure the local durable event projection; `:memory:` is accepted only for explicitly ephemeral deployments and tests. `watchReconnectAttempts` and `watchReconnectDelayMs` bound transport retries within the caller's cancellation and operation deadlines. The Provider rejects an unrelated schema version, malformed claim/event/terminal JSON, a non-contiguous cursor, and progress whose sequence, evidence, or cursor does not match its event. It fails graph submission if the CLI, goal, or peer binding is unavailable and never silently drops coordination.

For a Windows host with LoopX installed in WSL, persistent transport keeps one WSL launcher connection and its helper process tree for the Provider lifetime. Put only the distribution and execution selector in `executableArgs`; `brokerCommand` names the LoopX executable inside WSL. `pathStyle: wsl` converts the registry and per-operation working directories.

```yaml
    executable: wsl.exe
    executableArgs: [-d, Ubuntu, --exec]
    transport: persistent
    brokerPythonExecutable: python3
    brokerCommand: /root/.local/bin/loopx
    pathStyle: wsl
```

## Model Experience

### LoopX worker observation

#### What the model sees

The claimed worker receives one `dsh-loopx-observation-v1` object containing the public-safe goal id, todo id, peer id, claim status, task class, and action kind returned by `loopx todo claim`.

#### Token effect

One observation of at most 8,000 characters is appended to each coordinated node attempt.

#### KV Cache effect

The observation reflects attempt-specific todo and claim state and therefore behaves as a variable suffix rather than a reusable prefix.

## Known Limitations and Deferred Work

- LoopX remains the external coordination fact source; the SQLite journal is a restart-safe local projection, not a distributed transaction participant. Stable progress, cancellation, and settlement tags repair the latest successful LoopX mutation when a process stops before writing the projection, while reconciliation reports conflicts instead of replacing either ledger.
- Hosts that share neither the journal file nor one authenticated distributed store do not share cursors or progress deduplication. The authenticated multi-Host Provider in the [durable project control-plane design](../../../.agents/notes/proposed/feature/2026-08-18-graph-loopx-durable-project-control-plane.md) remains required for distributed authority.
