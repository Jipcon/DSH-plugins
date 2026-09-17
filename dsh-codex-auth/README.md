# dsh-codex-auth

用 ChatGPT Plus / Pro 订阅登录 OpenAI Codex 路由的桥接插件，无需 API Key。

官方现状：`dsh-llm-pi-ai` 底层早已为 `openai-codex` 注册了 OAuth 登录流
（`ctx.authorization` 上 key 为 `llm-pi-ai/openai-codex` 的 flow），但 Web
「设置 → 模型」页明确不支持 OAuth 提供方（"Providers that sign in with OAuth,
such as Codex, are not supported here yet."）。本插件不改官方页，只给这个
已存在的 flow 配一个浏览器可达的 surface。

实测修正：生产组合（dsh-base 系）里 `ctx.authorization` 服务根本不存在——
`dsh-authorization` 全仓库只有测试在挂载，正式代码全是 `import type`。
后果有二：`dsh-llm-pi-ai` 的 Codex 流在生产环境从未注册；声明
`inject: […'authorization'…]` 的插件会静默 pending（本插件第一版即如此：
有卡片、无路由、无日志，调接口 405）。因此本插件自带
`lib/authorization.js`（官方 seam 的同语义 plain-JS 移植，零导入），
启动后缺缝则就地 `provide`，`dsh-llm-pi-ai` 会自动把 Codex 流挂上来；
未来官方组合自带该服务时则直接沿用，不重复提供。

## 功能

- 两处 UI（共用同一套登录面板，各有一份独立轮询/输入状态）：
  - 设置 → 插件 → 插件配置里的常驻卡；
  - 设置侧栏「Codex 登录」独立分区（紧贴归档清理），整页展示。
- 浏览器登录：在浏览器完成 OpenAI 登录后，把回调地址粘回卡片提交
  （host 的 `/start` 接口仍保留 `device_code` 能力，UI 上暂不暴露）。
- 登录状态查询、取消本次登录、退出登录（仅删除本机授权记录，不通知发行方撤销）。
- `openai-codex` 路由一键启用（经 `remote.settings.mutate` 写 `llm-pi-ai`），
  失败时给出 `settings.yaml` 手动片段。

## 安装

```bash
dsh plugin --profile web install <path-to-dsh-codex-auth>
# 或按你管理其它 dsh-* 插件的方式装，然后重启 DSH
node build.mjs
```

重启后进「设置 → 插件 → 插件配置」找本卡，或直接点设置侧栏的「Codex 登录」分区。

## 使用

1. 点「Device 码登录」，按卡片指引去 ChatGPT 页面输用户码。
2. 卡片显示「已登录」后，点「检查路由」/「一键启用路由」启用
   `llm-pi-ai.providers['openai-codex']`（等价手写 `openai-codex: {}`）。
3. 开新会话，在模型选择器里选 `openai-codex` 的模型即可。
4. 手动备用（`$DSH_HOME/settings.yaml`）：

```yaml
llm-pi-ai:
  providers:
    openai-codex: {}
```

## 限制（官方语义，原样继承）

- 登录尝试只活在发起它的进程里：中途刷新/重载页面即作废，需重来。
- Device 码 15 分钟有效。
- 需要含 Codex 的 ChatGPT 订阅；免费号登上也可能无可用模型。
- 退出登录只是 `deleteRecord`，服务端订阅关系不受影响。

## 开发

```bash
node build.mjs        # src/client.js -> lib/client.js
node tests/smoke.mjs  # 骨架自检
```

host 路由见 `lib/index.js` 头部注释：`/codex-auth/status|start|poll|answer|cancel|signout`。
