# dsh-message-recall

DSH Web 的消息撤回与重编辑插件：撤回已发送的消息、原地改写后重发，并且**编辑前后在侧栏仍是同一条对话**。

## 功能

- **撤回**：用户消息上的撤回键（或配置的快捷键）把对话回退到该消息之前的最后一个完整回合，原消息文本回填输入框。
- **气泡编辑**：点击用户气泡直接改写内容，确定后按同样的边界重新发送。
- **稳定侧栏条目**：编辑重发产生的新版本不单独成行。侧栏那一行的标题、选中高亮、手动拖拽位置在版本切换前后保持连续，切换的是这一行「显示哪个会话」，不是换一行。
- **版本翻页**：在最后一条回答下方用 `‹ ›` 或键盘 `←`/`→` 在历史版本之间切换；每个版本的模型与思考挡位随行。
- **图片保留**：编辑重发时原消息的图片附件经官方草稿附件通道带到新会话；编辑框中支持拖入图片。
- **底部草稿隔离**：编辑重发过程中，底部输入框里未发送的草稿与图片会被暂存，发送完成后回填，不会与重发内容混在一起。
- **失败可恢复**：fork、历史加载或切换失败时保留原会话与编辑草稿，不归档原会话；待发送记录保留到投递被明确接受为止，可重试。

## 安装

插件以 DSH **bundle** 形式分发，装进某个 profile：

```sh
dsh plugin --profile web add dsh-message-recall
```

也可以从仓库源码安装。包位于本仓库的 `dsh-message-recall/` 子目录，先克隆再按目录安装：

```sh
git clone https://github.com/Jipcon/DSH-plugins.git
dsh plugin --profile web add ./DSH-plugins/dsh-message-recall
```

本仓库已提交构建产物 `lib/`，所以这条路径不依赖安装时的 `prepare` 脚本 —— pnpm ≥10 默认拒绝执行 git 依赖的构建脚本，除非用户在 profile 的 `pnpm-workspace.yaml` 里显式授权。

安装后用 `dsh --profile web --dump-config` 可以看到 `dsh-message-recall` 这一层，重启 `dsh web` 生效。

卸载：

```sh
dsh plugin --profile web remove dsh-message-recall
```

## 设置

设置 → 插件 → 插件配置 → MessageRecall：

| 项 | 说明 |
|---|---|
| 启用 MessageRecall | 总开关。关闭后气泡编辑、撤回键与版本翻页器都不注册；设置卡自身始终可用 |
| 每日检查更新 | 每天检查一次新版本，发现时在卡片内提示 |

## 版本要求

最低 dsh `0.1.2-rc.1`。当前 dsh 高于插件已适配的版本时，卡片会给出提示而不是静默失败。

## 工作原理

撤回与编辑重发都通过**在上一个完整回合处 fork 出一个新会话来替换**实现，原会话归档 —— 这是 DSH 上唯一能真正丢弃内容的手段，因此会话日志本身是只追加的，插件从不改写历史。

为了让「替换」在界面上不可见，插件做了两件事：

1. **发布前登记归属**：先自行铸造子会话 id，用它登记「版本关系」，再带着同一个 id 去 fork。宿主 fork 出的子会话一旦创建就同步进入客户端列表，等 `fork()` 返回再登记必然留下一段新行可见的空窗；提前登记后，子会话在列表里一出现就已被折叠进原条目。
2. **受控切换**：预加载目标会话历史（`sessions.prepare`，不改变选中）→ 打开 → 订阅 `sessions.list` 确认选中已落到目标 → 归档旧版本。归档只在切换成功后发生，切换失败则原会话与草稿原样保留。

版本关系由宿主经 `storageDomain` 持久化在 `recall_relations` 域，客户端经 `/bubble/relations` 同步，再经 `ctx.uiWorkspace.registerRecallRows` 交给侧栏投影。**普通 fork 从不登记**，因此用户主动 fork 的会话始终独立显示 —— 版本家族只认明确登记的编辑关系，不靠 `parentId` 推断。

## 配置与日志

设置项存在 localStorage（`dsh-message-recall:*`）。调试模式：

```js
localStorage.setItem('dsh-message-recall:debug', '1')
```

开启后浏览器控制台打印全链路日志，同时经 `/bubble/log` 上报到宿主落盘于 `$DSH_HOME/dsh-message-recall.log`。另有实时调试入口 `window.__dshMessageRecall.bar`。

## 开发

源码即产物：`src/client.js` 与 `src/index.js` 已是可直接加载的模块，构建只做一次拷贝。

```sh
node build.mjs                                  # src/ -> lib/
node tests/guard-pending-inbox.test.mjs         # 守卫测试
```

改动一律落在 `src/`，`lib/` 是生成物但**需要提交**（git 安装直接用它）。发布前 `prepack` 会自动重建。

## 许可

MIT
