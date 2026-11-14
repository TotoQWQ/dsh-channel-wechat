# 2.19.1 更新报告（修复热重载 runExclusive）

- 版本：`2.19.0` → `2.19.1`
- 日期：2026-11-15

## 问题

`POST /wechat-channel/reload` 返回：

```
{"ok":false,"message":"HMR profile reconciliation must run inside runExclusive"}
```

DSH 的 `hmr.reconcileProfile()` 现在要求调用方先进入 `hmr.runExclusive()` 的串行区；`hotReloadPlugin` 之前直接调用。

## 修复

```js
const result = hmr.runExclusive
  ? await hmr.runExclusive(() => hmr.reconcileProfile())
  : await hmr.reconcileProfile()
```

- 有 `runExclusive` 时严格串行执行；
- 旧版本 DSH 没有 `runExclusive` 时保持直接调用（向后兼容）。

## 验证

- `test-hotreload.mjs` 增加断言：`runExclusive` 与 `reconcileProfile` 各调用一次；
- 二十三套合计 **144 项通过**。

## 注意

当前线上还是 2.18.2（`/reload` 因同一原因会失败），需要**重启一次** DSH 加载 2.19.1；之后 `/reload` 才会正常。

## 变更文件

- `index.js`：`hotReloadPlugin` 的 runExclusive 包装、版本号
- `CHANGELOG.md`：2.19.1 条目
- `test-hotreload.mjs`：runExclusive 断言
- `package.json`：`2.19.0` → `2.19.1`
