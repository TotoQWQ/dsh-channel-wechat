# 2.10.1 更新报告（补发时跳过旧版噪声）

- 版本：`2.10.0` → `2.10.1`
- 日期：2026-11-14

## 问题

2.10.0 之前，投递失败时插件除了把真正的回复放进补发队列，还会再排一条：

```
⚠️ DSH 处理失败：sendmessage ret=-2 prepare failed…
```

恢复后（新 `context_token` 到达）会把这条也补发给用户，造成「先收到答案、再收到一条吓人的失败提示」。

## 修复

- 新增 `isNoisePending(text)`：以 `⚠️ DSH 处理失败` 开头的队列项视为旧版噪声。
- `flushPending` 在补发前过滤掉这些项（记录 `pending noise dropped` 日志），只发送真正的回复。
- 2.10.0 已保证新失败不再产生这类提示，这里只负责清理历史队列。

## 验证

`test-delivery.mjs` 新增「补发时跳过旧版留下的『处理失败』提示」：

- 用失败发送把 `⚠️ DSH 处理失败：…` 排进队列；
- 恢复发送后触发 inbound；
- 断言补发列表里没有该提示、队列清空。

十五套合计 **101 项通过**。

## 变更文件

- `index.js`：`isNoisePending`、`flushPending` 清理、版本号
- `CHANGELOG.md`：2.10.1 条目
- `test-delivery.mjs`：5 项
- `package.json`：`2.10.0` → `2.10.1`
