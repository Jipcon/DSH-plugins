# dsh-plugin-manager

DSH 图形化插件管理插件：在「设置 → 插件」下新增**插件管理**标签页，列出当前
profile 的第三方插件，每个配一个两步确认的**卸载**按钮，点击即可真正卸载。

> 为什么是独立 Tab 而不是塞进每个插件自己的卡片？
> `settings.plugin.item` 卡片由各插件自己拥有并渲染，第三方插件无法改写别人的
> 卡片 DOM。管理 Tab 把全 profile 的第三方插件收拢到一处，效果等价且不受其它
> 插件实现影响。

## 功能

- **插件管理 Tab**（`settings.plugins.tab`，id `plugin-manager`，order 5，
  位于“插件配置”之后、“插件列表”之前）：第三方插件列表 + 内置插件只读区。
- **真正的卸载**（与 `dsh plugin --profile <name> remove <pkg>` 最终状态一致）：
  1. 从 `<profile>/package.json` 的 `dependencies` 删除该包；
  2. 从同一文件 `dsh.profile.bundles` 层列表移除该包（停用其 patch 层）；
  3. best-effort 删除 `<profile>/node_modules/<pkg>`。
- 卸载成功后该行消失，顶部提示**重启 DSH 后生效**（Loader 组合只在启动时决定；
  live patchReload 只覆盖用户 patch 层，不覆盖 bundle 层）。
- 两步确认防误触：第一次点击武装（8 秒有效），第二次点击真正执行；
  卸载要求 `confirm: true`，缺失直接 400。

## 安全边界

- 包名白名单（与桌面端同款正则）：一切路径穿越写法直接 400；
- 只卸载 `dependencies` 里的外部包：内置 bundle（`not-external`）、自身
  （`self`，请用命令行卸载本插件）、桌面端 profile（`unsupported-profile`，
  请走桌面应用自带的插件管理器）一律拒绝；
- 删除目录前做 `resolve` 前缀校验，限定在 `<profile>/node_modules` 内；
- 同源校验 + JSON Content-Type 守卫（与 dsh-message-recall 同款）。

## 安装

```sh
dsh plugin --profile web add D:\dsh-plugins\dsh-plugin-manager
# 重启 DSH Web（必需：bundle 层只在启动时组合）
```

装好后打开「设置 → 插件 → 插件管理」即可看到每个第三方插件的卸载按钮。

重启后如需修剪 lockfile 残留条目：

```sh
dsh plugin --profile web install
```

## 开发

```sh
node build.mjs   # src/ → lib/（无打包器，原样拷贝）
npm test         # 4 组单测：包名校验 / 清单分类与卸载变更 / 宿主路由 / 浏览器注册
```

- `src/index.js` → `lib/index.js`（Node 半边：`webServer` 两条路由）
- `src/client.js` → `lib/client.js`（浏览器半边：模块表工厂，只注入 `slots`）
- `lib/` 是生成物，不要直接编辑。

## 已知限制

- 卸载必须重启 DSH 才彻底生效（架构约束，非本插件能绕过）；
- Windows 下运行中文件可能删不掉，此时响应 `filesRemoved: false`，重启后可再进
  本页确认，残留的 pnpm store 条目下次 `install` 自动修剪；
- 不提供安装/启用/停用按钮：安装涉及任意包执行代码的高危操作，应留在有
  `--profile` 显式上下文的命令行完成。
