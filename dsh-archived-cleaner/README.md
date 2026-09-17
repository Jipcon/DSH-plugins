# dsh-archived-cleaner

DSH 已归档会话的彻底删除插件。DSH 官方只有归档（archive）没有删除——会话日志只会越积越多（撤回/编辑类插件每次重发还会再留一个归档副本）。本插件补上“删除”这一块：列出已归档会话，彻底删除其会话文件与注册表引用。

## 功能

- **设置侧栏入口**：设置页侧栏「归档清理」分区（紧贴官方「已归档会话」），整页展示清理列表
- **插件配置卡**：设置 → 插件 → 插件配置里的「已归档会话清理」卡（MessageRecall 同款风格，标题 20px + 副标题 + 右侧箭头）
- **启用勾选**：卡片头部与分区内均有「启用」勾选框（localStorage 持久化，即时生效）；关闭后删除按钮全部隐藏，卡与分区保留以便随时重新打开
- **归档清单**：列出全部已归档会话（标题 / 所属 workspace / 相对时间 / 文件大小），按归档从新到旧
- **逐条删除**：每行两步确认（点一次变“确认删除？”，8 秒内再点执行）
- **多选删除**：勾选多条一次删除
- **一键清空**：清空全部已归档，同样两步确认；live 会话自动跳过并计入结果
- **使用中保护**：仍在内存（live）或正在运行（running）的会话禁用删除并标注，只能先关闭再删
- **注册表清理**：删文件后自动从各 workspace 的 `sessionIds` detach，并从 `archivedSessionIds` 移除（只用官方公开方法）
- **侧栏同步**：删除成功后广播官方 `api-session/removed` 事件并重拉会话列表，已删会话不会以"未分组"在侧栏复活（否则点击即 `session/not-found`）
- **顺手清理（best-effort）**：`session_projcache` 缓存文档、`recall_relations` 版本关系（被删的旧版本会被摘除；目标被删或成员被掏空则整行删除，侧栏回落到独立显示）

仅允许删除**已归档**会话，非归档 id 一律拒绝（`not-archived`）。

## 安装

```sh
dsh plugin --profile web add ./dsh-archived-cleaner
```

也可以先把本仓库克隆下来再按目录安装。安装后重启 `dsh web`，在设置 → 插件 → 插件配置中找到「已归档会话清理」。

卸载：

```sh
dsh plugin --profile web remove dsh-archived-cleaner
```

## 接口（均为 POST + JSON，同源校验）

| 路由 | 入参 | 说明 |
|---|---|---|
| `/archived-cleaner/list` | `{}` | 清单：`{ ok, archived: [{ id, cwd, createdAt, parentSession, sizeBytes, persisted, live, running }] }` |
| `/archived-cleaner/delete` | `{ sessionId }` | 删除单个 |
| `/archived-cleaner/delete-many` | `{ sessionIds: [...] }`（1–200） | 批量删除，逐个返回结果 |
| `/archived-cleaner/clear` | `{ confirm: true }` | 清空全部（快照式，live 自动跳过） |

错误码：`invalid-session-id` / `not-archived`(404) / `live-session`(409) / `confirm-required`(400) / `registry-unavailable`(503) / `file-delete-failed` / `registry-cleanup-failed`。

## 工作原理

删除一个会话固定走三步：

1. **删文件**：`$DSH_HOME/sessions/<projectKey>/<encodeSegment(id)>` 整个目录。路径算法与 `dsh-session-persistence-jsonl/src/format.ts` 逐行同构（见 `tests/path-safety.test.mjs` 锁定的映射关系），另有 `resolve` 前缀校验纵深防御。`stat`  miss 时按目录名精确匹配兜底。
2. **清注册表**：各 workspace `detachSession` + `unarchiveSession`（幂等）。
3. **顺手清理**：projection 缓存与版本关系均为 best-effort，失败不影响主流程。

官方 seam 明确写了“Nothing deletes session files … until removed externally”，本插件就是那个 external remover。

## 安全与已知限制

- 删除是**不可逆的文件删除**（含该会话目录下全部历史版本文件），请确认后再删；如有重要内容请先用会话导出备份。
- live/running 会话拒绝删除——归档只是隐藏，内存里的会话和正在跑的 agent 都还在，删其文件会损坏该会话。
- 附件（`$DSH_HOME/attachments`）与 `:memory:` 的全文索引不在清理范围，属无害残留。
- 调试：`DSH_ARCHIVED_CLEANER_DEBUG=1` 输出控制台，host 日志落盘 `$DSH_HOME/dsh-archived-cleaner.log`。

## 开发

源码即产物：`src/client.js` 与 `src/index.js` 已是可直接加载的模块，构建只做一次拷贝。

```sh
node build.mjs                        # src/ -> lib/
node tests/path-safety.test.mjs       # 路径与校验测试
```

改动一律落在 `src/`，`lib/` 是生成物但**需要提交**（git 安装直接用它）。发布前 `prepack` 会自动重建。

> 注意：本插件经 junction 链接进 profile，文件改动实时可见，但宿主**不会热加载**
> `lib/`（`patchReload: live` 只看 patch 文件）。改完 `src` 后务必 `node build.mjs`
> 再**重启 `dsh web`**，否则跑的还是旧代码（表现为 `/archived-cleaner/list` 一直
> 回 `registry-unavailable`）。

## 许可

MIT
