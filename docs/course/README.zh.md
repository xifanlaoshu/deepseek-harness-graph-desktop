# DeepSeek Harness 深度技术教程（完全精通版）

[English](README.md) | 中文

欢迎阅读《DeepSeek Harness 深度技术教程》。这是一套专为**具备传统编程经验（Java / C++ / Go / Rust / Python / TypeScript），但对现代 AI 与 Agent 架构相对陌生**的软件工程师量身打造的硬核系统级教材。

本套教材抛弃空洞的流行词与概念套娃，将大语言模型（LLM）、智能体（Agent）、框架（Harness）、任务图（Graph Mode）以及外部协调服务（LoopX）的底层原理，全面映射为传统软件工程中的**数学推导、数据结构、计算复杂度、显存模型、状态机、操作系统系统调用与分布式架构**。

全书分为五大阶段、共 35 个独立深度模块，每个章节都包含详尽的原理拆解、公式推导、生产级代码、显存模型与实战避坑指南。

---

## 目录索引与学习路线

### 第一阶段：零基础 AI 建模与数学直觉 (Chapters 01–02)
* [第 01 章：学习目标与阅读方法](./01-learning-goals.zh.md) — 8 类核心问题拆解、3 种观察尺度、5 阶段里程碑与每周自检指标
* [第 02 章：零基础预备：从 LLM 到 Agent 系统](./02-zero-background-llm-to-agent.zh.md) — 自回归预测 $P(y_t | X, y_{<t})$、BPE Tokenizer、RoPE 旋转矩阵、Softmax 极化、MLA/FlashAttention 机制、DPO 对齐损失、KV Cache 显存精算表

### 第二阶段：Harness 核心架构与运行时 (Chapters 03–20)
* [第 03 章：项目是什么](./03-project-overview.zh.md) — 插件化架构心智模型、三大入口（CLI/Web/ACP）与通用 Agent 循环边界
* [第 04 章：实际技术栈](./04-tech-stack.zh.md) — Node.js ESM 运行时、TypeScript 6 判别联合、pnpm 11 workspace 与全栈技术解构
* [第 05 章：Monorepo 与包边界](./05-monorepo-boundaries.zh.md) — Service Definition / Provider / Consumer 三元角色设计模式与跨包解耦
* [第 06 章：Cordis：项目的运行骨架](./06-cordis-runtime.zh.md) — Context 依赖注入容器、`ctx.effect()` 析构模型与事件 Waterfall 瀑布流控制
* [第 07 章：启动、Profile 与配置叠加](./07-startup-profiles.zh.md) — Profile 装配、YAML 配置叠加合并（Overlay Patch）与 Schemastery 加载期强校验
* [第 08 章：agent、轮次、步骤与 Inbox](./08-agent-turn-step-inbox.zh.md) — Agent 驱动状态机、Inbox 消息队列、Turn 事务与 Step 迭代生命周期、AbortSignal 取消时序
* [第 09 章：提示词、模型与流式响应](./09-system-prompts-streaming.zh.md) — 系统提示词动态装配、稳定前缀 vs 动态后缀、SSE 流式协议与 Chunk 拼接
* [第 10 章：工具体系与副作用控制](./10-tool-system-side-effects.zh.md) — 工具注册表、exclusive 屏障与受限并发组、参数 Zod 校验、沙箱拦截与超长输出 Spill 策略
* [第 11 章：会话日志：系统的事实记录](./11-session-log-event-sourcing.zh.md) — 事件溯源（Event Sourcing）设计、仅追加事件账本、`deriveMessages()` 动态投影与崩溃恢复
* [第 12 章：Web Host、RPC 与插件化 UI](./12-web-host-rpc-ui.zh.md) — Host/Client 双 Cordis 树、Typert 类型图生成、RPC 协议网关、WebSocket 下行与 Zustand/Immer 响应式状态
* [第 13 章：从单代理到并行工作](./13-single-to-parallel-agents.zh.md) — Subagent 委派派生、权限单调递减（`sandboxModeCap`）、Jobs 后台任务与 Worker Thread 代码沙箱
* [第 14 章：Graph Mode 的调度机制](./14-graph-mode-scheduling.zh.md) — 多 Agent DAG 任务网、不可变 Revision 版本、Campaign 批次拆解、关键路径调度算法
* [第 15 章：LoopX 的设计、实现与耦合](./15-loopx-coordination.zh.md) — 外部分布式协同服务、goal/todo/peer 映射、租约 Lease、单调递增 Fencing Token 与 CAS 终态结算
* [第 16 章：一次请求的端到端近景](./16-end-to-end-request-trace.zh.md) — 从用户输入到模型响应、工具执行、沙箱拦截与日志落盘的 15 步端到端完整源码调用链追踪
* [第 17 章：如何扩展项目](./17-extending-the-project.zh.md) — 扩展 Harness 指南：从领域接口定义到 Provider 实现、Consumer 暴露与 Snapshot 测试落地
* [第 18 章：构建、测试与质量门禁](./18-build-test-quality-gates.zh.md) — 构建体系、TypeScript 项目引用、100% 测试覆盖率门禁、无密钥回放 Snapshot 测试与代码卫生检查
* [第 19 章：源码阅读路线与练习](./19-source-code-tour.zh.md) — 四阶段源码阅读路线图、核心关键文件定位与四个动手练习
* [第 20 章：术语速查](./20-terminology-reference.zh.md) — 30+ 核心 AI/Agent 术语与传统软件工程/分布式架构深度对照表

### 第三阶段：Agent 工程深化与生产实战 (Chapters 21–30)
* [第 21 章：Harness 基础篇心智模型](./21-harness-mental-model.zh.md) — 五层架构心智模型（插件树 $\to$ 控制流 $\to$ 事实账本 $\to$ 副作用隔离 $\to$ 分布式协同）与故障定位流
* [第 22 章：从零实现最小 agent loop](./22-minimal-agent-loop-implementation.zh.md) — 从零手写 150 行生产级 TypeScript Agent Loop（含异常隔离、AbortSignal 取消、参数解析与状态转移）
* [第 23 章：模型请求、token 与 KV Cache](./23-requests-tokens-kvcache.zh.md) — Token 预算硬约束方程、前缀缓存跨请求复用、本地大模型选型与 Eval 评测集设计
* [第 24 章：工具开发：从 schema 到副作用](./24-tool-development.zh.md) — 生产级工具开发规范：只读幂等/状态幂等/非幂等写入分类、有界并发执行器与错误码设计
* [第 25 章：事件溯源、持久化与崩溃恢复](./25-event-sourcing-crash-recovery.zh.md) — 事件溯源持久化深入：Zstandard 压缩帧、SQLite 表结构设计与 3 种崩溃窗口对账恢复算法
* [第 26 章：上下文工程、记忆与压缩](./26-context-engineering-memory-compression.zh.md) — 上下文工程与多级记忆：多路混合 RAG（BM25 + 向量余弦 + Cross-Encoder Reranker）、有损摘要压缩与 Prompt 注入防御
* [第 27 章：并发、取消、超时与 fencing](./27-concurrency-cancellation-fencing.zh.md) — 异步并发控制：协作式取消（AbortSignal）、超时处理、单调递增 Fencing Token 解决旧 Worker 迟到写入
* [第 28 章：Agent 安全模型](./28-agent-security-model.zh.md) — Agent 纵深防御模型：Linux Landlock / macOS Seatbelt 内核沙箱、路径遍历与 SSRF 防护、最小权限委派
* [第 29 章：多 agent 编排与任务图设计](./29-multi-agent-orchestration-dag.zh.md) — 多 Agent DAG 拓扑编排、关键路径耗时公式 $T_{\text{total}}$、资源准入控制与 Campaign 批次流转
* [第 30 章：评测、测试与可观测性](./30-eval-testing-observability.zh.md) — Agent 评测体系：确定性程序断言 vs LLM-as-judge、Snapshot Replay 回放与 OpenTelemetry 观测指标

### 第四阶段：项目实战与故障诊断 (Chapters 31–34)
* [第 31 章：实战：开发一个模型可见上下文插件](./31-hands-on-context-plugin.zh.md) — 实战开发模型可见上下文插件：`ProjectLabelEvent` 事件、`agent/pre-step` 注入与完整单元/快照测试
* [第 32 章：三个故障案例的诊断方法](./32-diagnosing-three-failure-cases.zh.md) — 三大生产级经典故障复盘：UI 显示成功但重启重跑、取消后孤立进程写文件、Graph 节点卡在 awaiting_user 的根因定位与修复
* [第 33 章：Agent 系统设计面试框架](./33-agent-system-design-interview.zh.md) — Agent 系统设计面试五步框架：约束澄清 $\to$ 数据模型 $\to$ 状态机与控制链 $\to$ 故障域应对 $\to$ 容量估算
* [第 34 章：高频面试问题与参考答案](./34-frequently-asked-questions.zh.md) — 25+ 核心高频面试题与架构级标准参考答案（涵盖原理、状态机、并发安全、沙箱与项目源码）

### 第五阶段：综合毕业验证 (Chapter 35)
* [第 35 章：八周学习、毕业验证与模拟面试](./35-eight-week-roadmap-graduation.zh.md) — 八周高强度学习路线、三阶熟练度矩阵（入门/熟练/精通）、模拟面试 20 分评分细则与三大毕业设计作品集
