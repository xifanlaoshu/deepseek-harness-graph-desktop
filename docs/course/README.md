# DeepSeek Harness In-Depth Technical Course (Complete Mastery Edition)

English | [中文](README.zh.md)

Welcome to the DeepSeek Harness In-Depth Technical Course. This rigorous, systems-level course is designed for software engineers with **experience in conventional programming (Java / C++ / Go / Rust / Python / TypeScript) but relatively little familiarity with modern AI and agent architectures**.

The course avoids empty buzzwords and circular definitions. Instead, it maps the underlying principles of large language models (LLMs), agents, harnesses, Graph Mode, and the external coordination service LoopX to **mathematical derivations, data structures, computational complexity, GPU memory models, state machines, operating-system calls, and distributed architecture** from conventional software engineering.

The course has five stages and 35 independent, in-depth modules. Every chapter includes detailed explanations of underlying principles, derivations, production-grade code, GPU memory models, and practical guidance on avoiding common pitfalls.

---

## Contents and Learning Path

### Stage One: AI Modeling Fundamentals and Mathematical Intuition (Chapters 01–02)
* [Chapter 01: Learning Goals and How to Use This Course](./01-learning-goals.md) — eight categories of core questions, three levels of observation, five-stage milestones, and weekly self-check metrics
* [Chapter 02: Prerequisites from Zero: From LLMs to Agent Systems](./02-zero-background-llm-to-agent.md) — autoregressive prediction $P(y_t | X, y_{<t})$, BPE tokenizers, RoPE rotation matrices, softmax polarization, MLA/FlashAttention mechanisms, DPO alignment loss, and a detailed KV Cache GPU memory calculation table

### Stage Two: Harness Core Architecture and Runtime (Chapters 03–20)
* [Chapter 03: What the Project Is](./03-project-overview.md) — a mental model of the plugin architecture, three entry points (CLI/Web/ACP), and the general agent loop boundary
* [Chapter 04: The Actual Technology Stack](./04-tech-stack.md) — the Node.js ESM runtime, TypeScript 6 discriminated unions, the pnpm 11 workspace, and a breakdown of the full stack
* [Chapter 05: Monorepo and Package Boundaries](./05-monorepo-boundaries.md) — the three-role Service Definition / Service Provider / Consumer design pattern and decoupling across packages
* [Chapter 06: Cordis: The Project's Runtime Framework](./06-cordis-runtime.md) — the Context dependency injection container, the `ctx.effect()` disposal model, and waterfall event control
* [Chapter 07: Startup, Profiles, and Configuration Overlays](./07-startup-profiles.md) — profile composition, YAML configuration overlay merging (Overlay Patch), and strict load-time validation with Schemastery
* [Chapter 08: Agents, Turns, Steps, and the Inbox](./08-agent-turn-step-inbox.md) — the agent driver state machine, Inbox message queue, Turn transactions and Step iteration lifecycle, and AbortSignal cancellation ordering
* [Chapter 09: Prompts, Models, and Streaming Responses](./09-system-prompts-streaming.md) — dynamic system prompt composition, stable prefixes versus dynamic suffixes, the SSE streaming protocol, and chunk assembly
* [Chapter 10: Tools and Side-Effect Control](./10-tool-system-side-effects.md) — the tool registry, exclusive barriers and restricted concurrency groups, Zod argument validation, sandbox interception, and the spill strategy for oversized output
* [Chapter 11: The Session Log as the System's Record of Facts](./11-session-log-event-sourcing.md) — event-sourcing design, an append-only event ledger, dynamic projection through `deriveMessages()`, and crash recovery
* [Chapter 12: Web Host, RPC, and Plugin-Based UI](./12-web-host-rpc-ui.md) — separate Host/Client Cordis trees, Typert type graph generation, the RPC protocol gateway, WebSocket downstream delivery, and reactive state with Zustand/Immer
* [Chapter 13: From One Agent to Parallel Work](./13-single-to-parallel-agents.md) — subagent delegation and derivation, monotonically decreasing permissions (`sandboxModeCap`), Jobs background tasks, and a Worker Thread code sandbox
* [Chapter 14: Graph Mode Scheduling](./14-graph-mode-scheduling.md) — a multi-agent DAG task network, immutable Revision versions, Campaign batch decomposition, and the critical-path scheduling algorithm
* [Chapter 15: LoopX Design, Implementation, and Integration](./15-loopx-coordination.md) — an external distributed coordination service, goal/todo/peer mappings, leases, monotonically increasing fencing tokens, and CAS terminal settlement
* [Chapter 16: A Close Look at One End-to-End Request](./16-end-to-end-request-trace.md) — a complete, 15-step source-code call-chain trace from user input through model response, tool execution, sandbox interception, and log persistence
* [Chapter 17: Extending the Project](./17-extending-the-project.md) — a guide to extending Harness, from defining a domain interface to implementing a provider, exposing a consumer, and adding snapshot tests
* [Chapter 18: Builds, Tests, and Quality Gates](./18-build-test-quality-gates.md) — the build system, TypeScript project references, the 100% test coverage gate, keyless replay snapshot tests, and code hygiene checks
* [Chapter 19: Source Code Reading Path and Exercises](./19-source-code-tour.md) — a four-stage source-code reading path, locations of essential files, and four hands-on exercises
* [Chapter 20: Terminology Reference](./20-terminology-reference.md) — more than 30 core AI/agent terms compared in depth with conventional software engineering and distributed architecture concepts

### Stage Three: Advanced Agent Engineering and Production Practice (Chapters 21–30)
* [Chapter 21: Harness Fundamentals and Mental Models](./21-harness-mental-model.md) — a five-layer architectural mental model (plugin tree $\to$ control flow $\to$ fact ledger $\to$ side-effect isolation $\to$ distributed coordination) and a fault-localization flow
* [Chapter 22: Implementing a Minimal Agent Loop from Scratch](./22-minimal-agent-loop-implementation.md) — hand-writing a 150-line production-grade TypeScript agent loop with exception isolation, AbortSignal cancellation, argument parsing, and state transitions
* [Chapter 23: Model Requests, Tokens, and KV Cache](./23-requests-tokens-kvcache.md) — hard token-budget equations, prefix-cache reuse across requests, local large-model selection, and evaluation dataset design
* [Chapter 24: Tool Development from Schema to Side Effects](./24-tool-development.md) — production-grade tool development practices: classifying read-only idempotent, state-idempotent, and non-idempotent writes; bounded-concurrency executors; and error-code design
* [Chapter 25: Event Sourcing, Persistence, and Crash Recovery](./25-event-sourcing-crash-recovery.md) — in-depth event-sourced persistence, Zstandard-compressed frames, SQLite table design, and reconciliation and recovery algorithms for three crash windows
* [Chapter 26: Context Engineering, Memory, and Compaction](./26-context-engineering-memory-compression.md) — context engineering and multilevel memory: hybrid RAG (BM25 + vector cosine similarity + Cross-Encoder Reranker), lossy summary compaction, and prompt-injection defense
* [Chapter 27: Concurrency, Cancellation, Timeouts, and Fencing](./27-concurrency-cancellation-fencing.md) — asynchronous concurrency control, cooperative cancellation (AbortSignal), timeout handling, and monotonically increasing fencing tokens that prevent late writes from old workers
* [Chapter 28: The Agent Security Model](./28-agent-security-model.md) — defense in depth for agents: Linux Landlock and macOS Seatbelt kernel sandboxes, protection against path traversal and SSRF, and least-privilege delegation
* [Chapter 29: Multi-Agent Orchestration and Task Graph Design](./29-multi-agent-orchestration-dag.md) — multi-agent DAG topological orchestration, the critical-path duration formula $T_{\text{total}}$, resource admission control, and Campaign batch progression
* [Chapter 30: Evaluation, Testing, and Observability](./30-eval-testing-observability.md) — an agent evaluation system: deterministic program assertions versus LLM-as-judge, snapshot replay, and OpenTelemetry observability metrics

### Stage Four: Project Practice and Failure Diagnosis (Chapters 31–34)
* [Chapter 31: Hands-On: Build a Model-Visible Context Plugin](./31-hands-on-context-plugin.md) — building a model-visible context plugin with a `ProjectLabelEvent` event, `agent/pre-step` injection, and complete unit and snapshot tests
* [Chapter 32: Diagnosing Three Failure Cases](./32-diagnosing-three-failure-cases.md) — three classic production failures: the UI shows success but a restart re-runs the work; an orphaned process writes files after cancellation; and a Graph node is stuck in awaiting_user, with root-cause analysis and fixes
* [Chapter 33: An Agent System Design Interview Framework](./33-agent-system-design-interview.md) — a five-step agent system design interview framework: clarify constraints $\to$ define the data model $\to$ specify the state machine and control chain $\to$ address failure domains $\to$ estimate capacity
* [Chapter 34: Frequently Asked Interview Questions and Reference Answers](./34-frequently-asked-questions.md) — more than 25 core interview questions and architecture-level reference answers covering principles, state machines, concurrency safety, sandboxes, and project source code

### Stage Five: Comprehensive Graduation Assessment (Chapter 35)
* [Chapter 35: Eight-Week Learning Plan, Graduation Assessment, and Mock Interviews](./35-eight-week-roadmap-graduation.md) — an eight-week intensive study plan, a three-level proficiency matrix (beginner/proficient/expert), a 20-point mock interview rubric, and three capstone portfolio projects
