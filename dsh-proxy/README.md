# dsh-proxy

DSH 本地 HTTP 代理插件 — 定向处理 OpenCode Muse Spark 模型的 `reasoning.encrypted_content` 兼容性问题。

## 架构

```text
DSH pi-ai 适配器 → dsh-proxy (127.0.0.1:PORT) → OpenCode 上游
```

插件在 pi-ai 适配器与 OpenCode 之间插入一层透明代理，仅对匹配的模型执行请求体过滤：

1. 从 `include` 数组中移除 `"reasoning.encrypted_content"`
2. 从 `input` 数组中过滤 `type === "reasoning"` 的历史项

其余请求（其他模型、其他路径）完全透明转发，保留流式 SSE、工具调用、用量与错误信息。

## 安装

```bash
# 在 DSH profile 目录下
pnpm add dsh-proxy
# 或从本地路径
pnpm add ./plugins/dsh-proxy
```

## 配置

将 pi-ai 提供方 `opencode` 的 `baseURL` 指向代理地址：

```jsonc
// DSH settings → llm-pi-ai → providers → opencode
{
  "baseURL": "http://127.0.0.1:8787"
}
```

> **注意**：`baseURL` 只填代理根地址（不含路径后缀）。pi-ai 会自动拼接 `/responses`，
> 代理再将完整路径转发至上游 `https://opencode.ai/zen/v1/responses`。

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `DSH_PROXY_HOST` | `127.0.0.1` | 监听地址 |
| `DSH_PROXY_PORT` | `8787` | 监听端口 |
| `DSH_PROXY_UPSTREAM` | `https://opencode.ai/zen/v1` | 上游基地址 |
| `DSH_PROXY_MODELS` | `muse-spark*` | 需过滤的模型（逗号分隔，支持 `*` 通配和 `/regex/`） |
| `DSH_PROXY_DEBUG` | `0` | 设为 `1` 输出控制台日志 |

示例：过滤所有 Muse Spark 和 GPT-5 系列：

```bash
DSH_PROXY_MODELS="muse-spark*, gpt-5*"
```

## 行为说明

### 过滤逻辑

仅当请求满足以下全部条件时执行过滤：

- 路径以 `/responses` 结尾（OpenAI Responses API 端点）
- 请求体 `model` 字段匹配 `DSH_PROXY_MODELS` 中的模式

过滤内容：

- `include` 数组：移除值为 `"reasoning.encrypted_content"` 的条目
- `input` 数组：移除 `type === "reasoning"` 的条目（历史加密推理项）

其余字段（`reasoning.effort`、`tools`、`stream` 等）完全保留。

### 取消语义

下游客户端断开连接时，代理通过 `AbortController` 同步中止上游 fetch 请求，避免资源泄漏。

### 生命周期

- 插件加载时启动监听；端口冲突时抛出明确错误（`EADDRINUSE`），插件加载失败。
- 插件卸载/重载时：中止所有在途请求 → 关闭 HTTP 服务器 → 释放端口。

### 日志

运行日志写入 `$DSH_HOME/dsh-proxy.log`（JSON Lines 格式），记录每次请求的模型、是否过滤、移除条目数等。

## 已知限制

- **过滤历史推理 ≠ 关闭模型思考**：仍可请求 `xhigh` effort，但模型无法复用被过滤的隐藏推理状态，可能影响连续推理效率。
- 代理限定单一上游地址，不支持按模型路由到不同上游。
- 旧会话能否真正恢复取决于上游 API 对缺失 `reasoning` 项的容忍度，需真实验证。

## 测试

```bash
node tests/smoke.mjs
```

覆盖：过滤正确性、透明转发、SSE 流式、取消中止、端口释放、端口冲突报错。

## 许可

MIT
