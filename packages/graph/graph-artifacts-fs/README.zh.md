# @deepseek-ai/dsh-graph-artifacts-fs

[English](README.md) | 中文

这是 [`dsh-graph-artifacts`](../graph-artifacts/README.zh.md) 的持久文件系统 Provider。它把 Worker 选中的文件捕获为不可变 SHA-256 Blob，存储带 Attempt 归属的 Manifest，在物化前再次验证每个 Blob，并在对账删除无引用 Manifest 时保留共享 Blob。

## 配置

- `providerName` 是 Worker Adapter 选择的路由。
- `storeRoot` 保存私有 Blob 与 Manifest；默认值是 `.sessions/graph-artifacts`。
- `allowedWorkspaceRoots` 可以把 Capture 源限制到配置的绝对根目录。
- `maxFiles` 与 `maxBytes` 是 Provider 硬上限，只能降低单次请求的限制。

## 安全性

路径必须规范化且相对源目录。本 Provider 会拒绝符号链接和特殊文件，因为它们的目标依赖 Execution World。Materialization 会拒绝带链接的父目录，校验存储大小与 Hash，并要求显式覆盖策略。不可变写入使用私有临时文件和原子发布；并发 Capture 会收敛到同一个内容地址。

## 模型体验

### 文件系统制品

#### 模型会看到什么

模型只看到它在结构化节点输出中给出的 `artifacts` 路径。文件系统存储根目录、Blob Hash、绝对路径和对账证据保持 Host-only。

#### Token 影响

不会直接增加请求内容。

#### KV Cache 影响

没有直接影响。

## 已知限制与后续工作

- 只有当所有 Host 共享同一个经过认证的文件系统挂载与路径映射时，本 Provider 才支持跨进程和跨 Host 执行。
- Blob 垃圾回收被明确推迟；删除一份 Manifest 时不会猜测其他 Manifest 是否仍引用同一共享 Blob。
