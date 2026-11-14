# 2.18.2 更新报告（测试补强，无行为变更）

- 版本：`2.18.1` → `2.18.2`
- 日期：2026-11-14
- 背景：用户休息前的自主加固——补齐 2.18.x 文件转发与面板开关中未覆盖的路径。

## 补充的测试

`test-files.mjs`（4 → 8 项）：

1. 助手消息里的图片/文件附件 + 文本路径转发；
2. 同一附件不重复发送；
3. `.js` 不转发、超过大小上限跳过；
4. 微信轮次（`runTurn`）的文件也会补发；
5. **附件没有 hostPath 时用 `readImage` 回退**（写到 `outbound/` 后发送）；
6. **`mirrorFiles: false` 时只发文本、不发文件**；
7. **文件附件没有 hostPath 时用 `readFileStream` 回退**；
8. **带空格的本地路径（引号内）也能识别**。

`test-features.mjs`（6 → 7 项）：

- 新增 HTTP `GET/POST /wechat-channel/features` 读写开关、未知开关拒绝、`mirrorFiles` 默认值。

## 验证

二十三套合计 **148 项通过**（`node --check` 通过）。

## 变更文件

- `CHANGELOG.md`：2.18.2 条目
- `test-files.mjs`：8 项
- `test-features.mjs`：7 项
- `index.js` / `package.json`：版本号 2.18.1 → 2.18.2
