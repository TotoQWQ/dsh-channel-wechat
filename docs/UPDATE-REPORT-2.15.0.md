# 2.15.0 更新报告（第一轮第 4 项：更新热承载 / 热重载）

- 版本：`2.14.0` → `2.15.0`
- 日期：2026-11-14
- 目标：插件更新后不用重启整个 DSH 就能生效。

## 一、调研结论

- 现场：本地文件已经改到 2.14.0，但 `wechat_status` 仍显示 **2.9.0**（`channel started` 只在 14:44 出现过两次）——说明 DSH **不会**自动热加载 profile 里的插件文件。
- DSH Host 有 `hmr` 服务，方法 `reconcileProfile(requiredIds?)` 的说明正好覆盖这个需求：
  > 重新组合 profile，替换已加载文件发生变化的运行中插件；变化的模块会被驱逐、对应 entry 停止，然后按当前文件与配置重新启动 entry。
- 因此热重载的可行路径 = 调用 `ctx.get('hmr').reconcileProfile()`。

## 二、实现

- `hotReloadPlugin(reason)`：调用 `hmr.reconcileProfile()`，返回 `{ok, pending, warnings}`；HMR 不可用 / `hotReload: false` 时返回失败原因。
- 微信命令 `/reload`：先回 `♻️ 正在热重载…`（避免模块被替换后回执丢失），300ms 后触发热重载。
- HTTP：`POST /wechat-channel/reload` 返回热重载结果（面板/脚本可调）。
- 可选自动：`autoHotReload: true` 时每 30 秒比较插件目录 `index.js` 的 mtime，变化且距上次 ≥10 秒就自动热重载；默认关闭，避免编辑到一半触发。
- 旧实例清理：热重载会触发 entry 停止 → `dispose` → `channel.stop()`（清 monitor/进度/健康/热重载定时器），新模块 `start()` 时再由 `CHANNEL_REGISTRY` 兜底停掉任何残留实例。

## 三、验证

`test-hotreload.mjs` 4 项（mock `hmr.reconcileProfile`）：

- 调用成功并计数；
- HMR 不可用时返回失败信息；
- `hotReload: false` 拒绝；
- `/reload` 先回执再触发（300ms 后 reconcile 被调用）。

二十套合计 **129 项通过**（`test-hotreload` 的“hot reload checks passed”不影响断言）。

## 四、限制 / 注意

- 热重载会**停掉再启动**插件 entry：正在进行的微信轮次可能被中断（monitor abort），建议空闲时用。
- `client.js` 是浏览器 bundle，宿主热重载不会更新它；面板改动仍需刷新页面（开发时由 `pnpm run dev:web` 提供 HMR）。
- `autoHotReload` 只盯 `index.js`；只改 `cordis.patch.yml`/`client.js` 不会自动触发。
- 如果 DSH 版本不提供 `hmr.reconcileProfile`，`/reload` 会提示“HMR 服务不可用”，仍需重启。

## 五、变更文件

- `index.js`：`PLUGIN_DIR`、`hotReloadPlugin`、`startHotReloadWatch`、`/reload` 命令、`POST /reload`、配置、版本号
- `cordis.patch.yml`：`hotReload` / `autoHotReload`
- `README.md`：功能、命令、配置
- `CHANGELOG.md`：2.15.0 条目
- `test-hotreload.mjs`：新增 4 项
- `package.json`：`2.14.0` → `2.15.0`
