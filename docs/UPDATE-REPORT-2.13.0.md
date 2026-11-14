# 2.13.0 更新报告（第一轮第 2 项：风险消息 → 邮件预警）

- 版本：`2.12.0` → `2.13.0`
- 日期：2026-11-14
- 目标：用户发来可能触发微信封号的风险消息时，用邮件通知宿主；**插件不干涉消息处理**。

## 一、行为

1. `riskAlert: true` 且配置了 SMTP + 收件人时：
   - 入站**文本**消息命中 `riskPatterns` → 异步发一封邮件；
   - 消息照常进入会话（不拦截、不改写、不延迟）；
   - 同一聊天 `riskCooldownMs`（默认 5 分钟）冷却，避免邮件轰炸。
2. 未配置 SMTP / 收件人时：只记日志（`risk alert skipped`），完全不影响消息。
3. `/risk` 查看：开关、收件人、规则数、冷却、本次启动已发数量；`/risk test` 发一封测试邮件（会临时绕过冷却）。

## 二、默认规则

```js
[
  { name: '赌博', pattern: '赌博|博彩|下注|押注|赌场|六合彩|时时彩' },
  { name: '诈骗刷单', pattern: '刷单|返利|兼职日结|代开发票|洗钱|跑分|贷款秒批' },
  { name: '色情', pattern: '裸聊|约炮|色情|成人视频' },
  { name: '引流外链', pattern: '加微信|加V|加vx|私聊我|扫码|二维码|点击链接|https?://' },
]
```

可在 `riskPatterns` 里用 `{ name, pattern }` 或字符串自定义（最多 30 条）。命令（`/…`）不参与扫描，避免误报。

## 三、邮件内容

- 主题：`[DSH 微信风险] <规则名> · <chat 末 16 位>`；
- 正文：时间、账号、聊天、命中的规则与匹配片段、原文（最多 2000 字）、插件版本；
- 编码：主题 RFC2047 base64，正文 base64 + UTF-8。

## 四、SMTP 实现

- 零依赖，基于 `node:net` / `node:tls`：
  - 465 隐式 TLS（`riskSmtpSecure: true`）；
  - 587 自动 STARTTLS（`riskSmtpSecure: false` 且服务器通告 STARTTLS）；
  - AUTH LOGIN；MAIL FROM / RCPT TO / DATA；20 秒超时。
- 单收件人（`riskEmailTo` 一次一个地址）。

## 五、配置

| 键 | 默认 | 说明 |
|---|---|---|
| `riskAlert` | `false` | 总开关 |
| `riskPatterns` | 内置 4 条 | 规则表 |
| `riskEmailTo` / `riskEmailFrom` | `''` | 收件人 / 发件人 |
| `riskCooldownMs` | `300000` | 同聊天冷却 |
| `riskSmtpHost` / `riskSmtpPort` | `''` / `465` | SMTP 地址 |
| `riskSmtpSecure` | `true` | 465 TLS；587 设 false |
| `riskSmtpUser` / `riskSmtpPass` | `''` | SMTP 账号 |

## 六、验证

`test-risk.mjs` 6 项（本地 TCP SMTP mock）：

- `detectRisk` 命中/不命中/空文本；
- 风险消息发出 1 封邮件（解码主题/正文校验 chat、账号、原文），同时 `sessionController.prompt` 仍被调用（不干涉）；
- 非风险消息不发；
- 冷却内不重复发；
- 未配置 SMTP 静默跳过且不崩；
- `/risk` 状态与 `/risk test` 测试邮件。

十八套合计 **119 项通过**。

## 七、限制与安全

- 只扫描文本消息；图片/文件里的文字不扫描。
- 邮件正文包含聊天与账号 id、原文片段，注意收件箱隐私。
- SMTP 密码以明文放在插件配置里（与 state 里的 bot token 相同等级），不要提交到仓库。
- 测试覆盖的是明文 SMTP；465 隐式 TLS / 587 STARTTLS 走的是同一套代码分支，但未在真实邮件服务上联调，首次使用建议先 `/risk test`。

## 八、变更文件

- `index.js`：`detectRisk`、极简 SMTP 客户端、`sendRiskAlert`、入站预警、`/risk` 命令、配置、版本号
- `cordis.patch.yml`：`riskAlert` / `riskPatterns` / `riskEmail*` / `riskCooldownMs` / `riskSmtp*`
- `README.md`：功能、命令、配置
- `CHANGELOG.md`：2.13.0 条目
- `test-risk.mjs`：新增 6 项
- `package.json`：`2.12.0` → `2.13.0`
