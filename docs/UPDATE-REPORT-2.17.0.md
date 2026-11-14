# 2.17.0 更新报告（可选功能收敛 + 面板开关 + 移除语音兜底）

- 版本：`2.16.0` → `2.17.0`
- 日期：2026-11-14
- 背景：用户指出「有些功能其实是选择性用的」——打扰型功能应默认关、按需开；语音有微信自带转写，不需要插件的兜底。

## 一、默认值调整

| 功能 | 旧默认 | 新默认 |
|---|---|---|
| 思考片段摘要 `thinkingSummary` | 开 | **关** |
| 流式分段 `streamSegment` | 开 | **关** |
| 其它（自动表情、进度心跳、定时任务通知） | 开 | 保持开，面板可关 |
| 风险邮件 `riskAlert`、自动热重载 `autoHotReload` | 关 | 保持关（opt-in） |

分段发送本身（`segmentMode` / `segmentMaxChars` / `segmentDelayMs`）仍默认开启：它是“长消息拆条”，不等于“流式边生成边发”。

## 二、移除语音兜底

- 删除 2.16.0 的本地 ASR（`speechToText` 调用）、silk 提示、`/voice` 命令、`voiceAsr`、`voiceFallbackHint` 与 `test-voice.mjs`；
- 语音消息恢复为：腾讯转写 + silk 路径交给会话（原行为），不做额外提示；
- `docs/UPDATE-REPORT-2.16.0.md` 顶部已加“已被 2.17.0 移除”的说明。

## 三、面板「功能开关」

- Web GUI「微信」面板底部新增「功能开关」卡片，7 个开关：
  思考片段摘要、流式分段、自动表情、定时任务完成通知、进度心跳、风险消息邮件、自动热重载；
- 勾选/取消立即生效，写进 `state.json` 的 `settings.features`，重启后保持；
- 新增 HTTP 接口：`GET /wechat-channel/features`（当前值 + 标签）、`POST /wechat-channel/features`（`{ name, value }`）；
- `emotionAuto` 用布尔映射：开 = `subtle`，关 = `off`；
- 命令类功能（`/ping`、`/resend`、`/suggest`、`/tasks`、`/risk`、`/reload`、`/emotion`）不受开关影响。

## 四、顺带修复

- `loadState` 以前只保留 `settings.defaultSessionId`，会丢掉 `emotionAllowOtherSource` 和新的 `features`；现在保留整个 `settings` 对象，只规范化 `defaultSessionId`。
- 清理一处悬空注释。

## 五、验证

`test-features.mjs` 6 项：

- 默认值（思考摘要/流式分段为关，风险邮件/自动热重载为关）；
- `setFeature` 立即生效并写回 snapshot；
- 持久化：新实例从 `state.json` 读取覆盖值；
- `emotionAuto` 布尔映射；
- 未知开关被拒绝；
- 配置文件显式开启优先于默认。

二十一套合计 **135 项通过**（移除语音 6 项、新增开关 6 项）。

## 六、变更文件

- `index.js`：默认值、移除语音代码、`featureValues` / `setFeature` / `applyFeatureOverrides`、`GET/POST /features`、snapshot `features`、`loadState` 保留 settings、版本号
- `client.js`：面板「功能开关」卡片
- `cordis.patch.yml`：`thinkingSummary: false`、`streamSegment: false`、移除 `voiceAsr` / `voiceFallbackHint`
- `README.md`：默认值、面板开关说明、移除语音条目
- `CHANGELOG.md`：2.17.0 条目
- `test-features.mjs`：新增 6 项；删除 `test-voice.mjs`
- `package.json`：`2.16.0` → `2.17.0`
