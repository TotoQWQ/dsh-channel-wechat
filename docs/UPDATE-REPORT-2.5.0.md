# 2.5.0 更新报告（第 1 项：面板 token 消耗统计）

- 版本：`2.4.11` → `2.5.0`
- 日期：2026-11-14
- 计划第 1 项：把每个微信会话的 token 消耗显示在面板，便于宿主了解用户的用量。

## 一、实现

- **数据源**：会话日志里 `assistant/message` 事件的 `usage`（`inputTokens` / `outputTokens` / `totalTokens`），这是模型侧的真实用量，不做估算。
- **增量扫描**：插件维护 `sessionId → { throughSeq, totalTokens, inputTokens, outputTokens, days, lastTurnTokens }`，只读取 `throughSeq` 之后的新事件，重复刷新不重复累计；重启后从当前会话事件重新累计一次。
- **snapshot 扩展**：`/wechat-channel/state` 返回的每条 binding 增加 `usage: { totalTokens, inputTokens, outputTokens, todayTokens, lastTurnTokens, throughSeq }`；面板直接消费，不需要额外请求。
- **面板**：绑定表新增「消耗」列，主行显示总量、次行显示「今日 X · 上轮 Y」，数字用 `950 / 3.2k / 1.5 万 / 2.1 亿` 短写。
- **微信侧**：`/status` 增加「用量」一行，例如 `用量：1.5 万 token（今日 3.4k，上轮 560）`。
- 只统计仍然持活的会话；切换绑定的会话各自独立累计（按 sessionId 分桶），不会串账。

## 二、验证

`test-usage.mjs` 5 项：

- `formatTokens` 中文短写（0 / 950 / 3.2k / 1.5 万 / 2.1 亿）；
- `usageOf` 累计两条 assistant 的 usage（200 / input 90 / output 110 / 今日 200 / 上轮 100）；
- 增量扫描：重复调用不重复累计，新事件继续累加；
- `snapshot().bindings[].usage` 正确；
- `/status` 回复包含「用量：250 token（今日 250…）」。

十套合计 **69 项通过**（options 9、relay 8、progress 6、commands 9、insert 5、models 8、extra 8、busy 5、cute 6、usage 5）。

## 三、剩余 4 项的计划（下一轮继续）

| 项 | 可行性结论 | 计划 |
|---|---|---|
| 2. 风险消息预警 → 邮件 | 可行，无需新增依赖：Node 内置 `net`/`tls` 实现最小 SMTP（AUTH LOGIN + MAIL/RCPT/DATA） | 入站文本按可配置正则匹配（默认给涉赌/诈骗/引流/政治敏感示例），命中后异步发邮件给宿主（含时间、chat、片段），消息照常转发、不阻断；带节流与开关 |
| 3. 自动化任务完成反馈 | 可行，取决于 DSH 定时任务投递时是否能识别来源 | 先查 `schedule` 服务与 turn 来源标记；能识别就在轮次结束时往绑定微信发「⏰ 任务『X』完成 + 摘要」，识别不到则用「任务结束时轮次耗时/结果」兜底 |
| 4. 更新热承载 | 需要先实测 DSH HMR 对 profile 内 link 插件是否生效 | 先做实验：改一个字节看 bridge.log 是否出现新的 `channel started`；若 HMR 不覆盖，就做「薄入口 + 带版本号动态 import」的自热重载方案 |
| 5. 微信语音输入 | 入站语音已有腾讯转写文本（`voice_item.text`） | 支持腾讯转写缺失时的兜底：先看能否接 DSH 本地 STT 服务；不能就明确回「语音没转写成功，请打字」并在模型上下文里保留 silk 路径，避免静默丢消息 |

## 四、变更文件

- `index.js`：`formatTokens` / `usageOf` 增量统计、snapshot 扩展、`/status` 用量行、版本号
- `client.js`：绑定表「消耗」列 + 数字短写
- `README.md`：功能与面板说明
- `CHANGELOG.md`：2.5.0 条目
- `test-usage.mjs`：新增 5 项
- `test-progress.mjs`：测试时序改为 250ms 并修复 keep-alive 关闭（稳定性）
- `package.json`：`2.4.11` → `2.5.0`
