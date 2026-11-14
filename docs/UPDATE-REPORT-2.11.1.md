# 2.11.1 更新报告（全量复查修复）

- 版本：`2.11.0` → `2.11.1`
- 日期：2026-11-14
- 关联：`docs/REVIEW-2026-11-14.md`（全量复查报告）

## 修复

1. **流式分段去重（顺序问题）**：`observeSessionEvent` 的 `turn/end` 与 `waitForReply` 存在竞态，`turn/end` 先到时旧代码会清空 `streamBuffers`，导致 `takeStreamRemainder` 拿不到已发前缀，最终回复整条重发。现在微信轮次进行中保留缓冲，`runTurn` 扣减后再清。
2. **流式前缀匹配（空白问题）**：原来用 trim 后的文本比较；改为记录原始字符前缀（含段落结尾换行），最终回复按原始前缀扣减；前缀后带额外空白也能得到正确的剩余文本。
3. **流式段发送简化**：每段直接交给 `sendToChat`（内部完成排版、按 `segmentMaxChars` 切分、加发送间隔），避免重复排版。
4. `test-api.mjs` 解绑检查改为 `try/finally`，失败也会恢复绑定。
5. `README.en.md` 版本更新到 2.11.0，并注明英文页未覆盖最新功能、以中文 README 为准。
6. 删除无调用的 `splitText` 包装。

## 验证

- `test-stream.mjs` 7 项：新增「turn/end 先到不影响剩余计算」「前缀后额外空白仍正确扣减」。
- 十六套合计 **108 项**，连续跑两遍全绿。
- `node --check` 全部通过；版本号统一 `2.11.1`。

## 变更文件

- `index.js`、`CHANGELOG.md`、`package.json`、`test-stream.mjs`、`test-api.mjs`、`README.en.md`
- `docs/REVIEW-2026-11-14.md`、`docs/UPDATE-REPORT-2.11.1.md`
