# Chapter 34: Common Interview Questions and Reference Answers

English | [中文](34-frequently-asked-questions.zh.md)

This chapter collects 13 core technical questions frequently asked in interviews for senior AI agent systems architects and full-stack LLM engineers. Each question follows four structured dimensions: **Concise Answer**, **In-Depth Explanation of the Underlying Principles**, **Code or Architecture Evidence**, and **Additional Interview Insight**. The aim is to help engineers demonstrate technical depth and a system-design perspective at the highest industry standard.

---

## 34.1 Fundamentals and Model Principles

### Q1: What is the fundamental difference between an agent and a traditional workflow?
* **Concise answer**: A workflow is a **deterministic, static directed acyclic graph (DAG)** whose branches and paths are predefined in code. An agent is a **closed-loop, dynamic state machine with an LLM as its decision-making core**; the model determines its next action and tool call at runtime from immediate feedback about the environment.
* **Underlying principle**: A workflow's state transition matrix, $S_{t+1} = f(S_t)$, is fixed symbolic logic. An agent's state transition, $S_{t+1} \sim P(\text{Action} \mid S_t, \text{History})$, results from high-dimensional probabilistic sampling.
* **Architecture evidence**: In DeepSeek Harness, deterministic build and packaging run through the `Workflow` plugin in a Worker Thread. Tasks that require exploration, trial and error, or adaptive repairs to a codebase are driven by `AgentLoop`.
* **Additional insight**: Production systems do not have to choose one or the other. A common industry pattern uses a workflow to orchestrate the overall stages and agents for complex local exploration.

### Q2: What is the main engineering value of ReAct (Reasoning + Acting)?
* **Concise answer**: ReAct turns a long sequence of implicit reasoning into an alternating cycle of "Thought $\to$ Action $\to$ Observation." Explicit external feedback can correct hallucinations and accumulated errors inside the model.
* **Underlying principle**: If a model generates hundreds of lines of code in one pass, its one-way autoregressive generation offers no way to backtrack. An early small error can snowball exponentially through subsequent generation. ReAct pauses after each action to read real feedback from a compiler or operating system, turning open-loop generation into closed-loop negative feedback.
* **Architecture evidence**: In the `ReactLoopAgent` state machine, each returned `tool/result` becomes a new observation in the next prompt.
* **Additional insight**: ReAct can make context-token consumption grow as $\mathcal{O}(N^2)$; sliding-window projection and context compaction must accompany it.

### Q3: Why must the host still validate types at runtime, for example with Zod, when the model receives a strict JSON Schema?
* **Concise answer**: JSON Schema is only a suggested format constraint at the prompt level. LLM output is fundamentally an untrusted probabilistic text stream and does not guarantee type safety.
* **Underlying principle**: An LLM generates text tokens. With long output, high concurrency, or adversarial examples, it may misspell a property name, return a string where a number is required, or produce truncated, invalid JSON.
* **Architecture evidence**: Before execution, the Harness tool pipeline must call `safeParse` against a Zod schema. If parsing fails, it returns the structured error to the model as `tool/result` so the model can correct its input, rather than letting an uncaught exception break the Node.js event loop.
* **Additional insight**: Never trust model output; handle it like untrusted external user input.

### Q4: Why does Temperature = 0 still fail to guarantee 100% reproducibility across machines at the hardware level?
* **Concise answer**: Floating-point addition is not associative, and nanosecond-scale scheduling variations in MoE routing disrupt strict determinism during parallel GPU computation.
* **Underlying principle**: $T=0$ specifies the mathematical choice of the maximum Softmax value. But in multi-GPU computation, the accumulation order of a vector reduction depends on concurrent GPU thread-block scheduling. IEEE 754 floating-point arithmetic allows $(a+b)+c \neq a+(b+c)$. Tiny differences in low-order bits can be amplified through dozens of Transformer layers and change the top-ranked next token.
* **Additional insight**: Continuous batching in inference engines such as vLLM and SGLang combines a request with different other requests in GEMM operations, increasing small floating-point differences.

### Q5: Is a context window the same as an LLM's long-term memory?
* **Concise answer**: No. The context window resembles a CPU's L1/L2 cache or a machine's RAM. Actual long-term memory requires external durable storage, such as a WAL event log, a vector knowledge base, or a SQLite ledger.
* **Underlying principle**: The context window is released when the request ends and is stateless; its length is constrained by physical GPU memory. Treating it as memory can exhaust GPU memory and dilute attention, producing the Lost-in-the-Middle effect.
* **Architecture evidence**: Harness uses an append-only `SessionEvent` log as its single source of truth. At runtime, the pure `deriveMessages()` function projects the current working slice into context as needed.

---

## 34.2 Tools, State, and System Reliability

### Q6: Why must the `tool/call` event be persisted before any real-world side effect executes?
* **Concise answer**: The write-ahead logging (WAL) principle ensures the system can identify unfinished operations and reconcile their outcomes after a power loss or crash during execution.
* **Underlying principle**: Suppose a side effect, such as a transfer or `git push`, happens before the event is persisted. If the process crashes after the operation but before the write, the restarted system has no record of it. It may repeat the operation, causing a catastrophic double spend or data overwrite.
* **Architecture evidence**: The Harness tool pipeline ensures that `tool/call` is written to `SessionWriteBehind` and passes a physical flush barrier before the underlying provider is dispatched.
* **Additional insight**: Explain how crash reconciliation represents such an operation with `TOOL_OUTCOME_UNKNOWN`.

### Q7: Why are cancellation and timeout strictly orthogonal in system design?
* **Concise answer**: Cancellation is a control signal actively sent by an external actor, such as a user or higher-level scheduler. A timeout is a determination that a time threshold has been reached. Process exit code 0 does not mean no timeout occurred.
* **Underlying principle**: A Bash script may receive `SIGTERM` because it timed out, then run a signal handler that calls `exit 0`. Judging only by exit code would misclassify a timed-out interruption as normal completion.
* **Architecture evidence**: Harness uses three independent execution-result fields, `{ exitCode: 0, signal: 'SIGTERM', timedOut: true }`, so the decision logic can distinguish these outcomes.

### Q8: What is a monotonically increasing fencing token, and why is a distributed lease alone insufficient to prevent split brain?
* **Concise answer**: Leases are affected by clock drift and network pauses, including GC pauses. After its lease expires, a worker might resume and write a late result without knowing its lease is stale. A fencing token is a globally monotonically increasing generation number issued by the server; the storage layer checks it with compare-and-swap (CAS) to reject late writes.
* **Underlying principle**: Worker A acquires a lease and enters a 30-second full GC pause. During that pause, its lease expires. The scheduler assigns the task to Worker B and issues token 2. When Worker A resumes and attempts to commit its old result with token 1, the storage layer atomically rejects the write because $1 < 2$.
* **Architecture evidence**: The LoopX coordinator checks the fencing token on every claim assignment and settlement.

---

## 34.3 Context Engineering, Security, and Multi-Agent Orchestration

### Q9: When should you definitely avoid multiple agents?
* **Concise answer**: Avoid multiple agents when a task has strong dependencies, a linear causal sequence, and a total context length within the capacity of one model.
* **Underlying principle**: Multiple agents introduce substantial serialization overhead for communication, coordination costs for task decomposition, and complexity in distributed-state consistency. By Amdahl's law, the serial bottleneck limits the maximum speedup. Using multiple agents without a reason can double token use and make debugging exponentially harder.
* **Architecture evidence**: Prefer a single agent loop to change one module. Start Graph Mode only when a task can be divided into fully independent subsystems, such as scanning ten separate microservices in parallel.

### Q10: How should a defense-in-depth system against prompt injection be built?
* **Concise answer**: Prompt isolation is a supporting measure; an operating-system kernel sandbox is the fundamental safeguard.
* **Underlying principle**: Use XML entity isolation and escaping at the semantic layer; use Linux Landlock or macOS Seatbelt at the system layer to restrict process access to sensitive host directories; use IP pinning at the network layer to block SSRF.
* **Architecture evidence**: The monotonically narrowing permission limit (`sandboxModeCap`) described in Chapter 28 prevents a child agent from escalating its permissions.

---

## 34.4 Project Source and Microkernel Architecture

### Q11: Why does Graph Mode orchestrate multi-agent tasks without modifying the core `agent-loop` source?
* **Concise answer**: Keeping the microkernel minimal and cohesive decouples orchestration through Cordis IoC plugins and event hooks.
* **Underlying principle**: `agent-loop` is responsible only for converging the state machine of one agent's turn. As a higher-level scheduler, Graph Mode can advance the task topology by starting independent child Session instances and listening for their terminal events. This follows the open-closed principle (OCP).

### Q12: Why must a campaign not copy every completed node from one batch into the next batch's task graph?
* **Concise answer**: Doing so would cause historical nodes to accumulate until graph topology and context become unmanageable.
* **Underlying principle**: After dozens of batches, copying every node would leave hundreds of nodes for dependency analysis and prompt injection, exceeding the context limit. Keep the completed prefix immutable and pass evidence across batches through a concise settlement summary instead.

### Q13: Why must a successful worker not be rerun blindly after its LoopX settlement fails?
* **Concise answer**: The worker's real-world operations, such as committing Git code or changing configuration, have already happened and may be irreversible. Blindly rerunning the worker risks duplicate writes and dirty data.
* **Underlying principle**: The failure is in a control-plane distributed network notification, not in the worker's execution. Keep the worker's artifacts intact, and retry only the settlement write with backoff or move to human reconciliation.
