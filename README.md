# 微信 ClawBot（iLink）通道 · DeepSeek Harness 插件

把 **DeepSeek Harness 的会话**和**微信（官方 ClawBot「龙虾」插件）**双向接起来：
微信里发消息 → 变成 DSH 会话里的用户消息；DSH 会话里的回复 → 发回微信。
支持多账号、每条微信聊天可绑定到任意一个 DSH 会话、Web GUI 里有一块专门的面板。

> 不依赖 OpenClaw。微信 ClawBot 背后是腾讯的 iLink Bot 协议（HTTP/JSON），本插件直接实现它。

## 功能

- **双向镜像**：微信 ↔ 指定 DSH 会话。微信消息注入会话（GUI 里实时可见），助手的回复自动回微信；GUI 里输入的消息带 `[网页]` 前缀转发到微信。
- **多账号**：多个微信号（bot）同时在线，各自独立长轮询、独立游标、独立错误状态；单个账号可重扫码/断开而不影响其它账号。
- **绑定面板**：左侧栏「微信」→ 账号表（状态/最近错误/重扫码/断开）、扫码登录区（二维码 + 数字配对码）、绑定表（chat → 会话下拉框，可换绑/解绑/直接打开会话）。
- **Agent 工具**：`wechat_login` / `wechat_verify_code` / `wechat_status` / `wechat_bind` / `wechat_unbind` / `wechat_send` / `wechat_logout` / `wechat_simulate` / `wechat_debug`。

## 安装

要求：DSH 桌面版（profile 装插件）+ 微信里启用官方 ClawBot 插件。

```text
# 在 DSH 会话里（或让 agent 代劳）
plugin_manager: install_bundle  target=<本目录的绝对路径>
```

安装后：

1. 重启 DSH 桌面应用（客户端面板清单是启动时扫描的），刷新页面；
2. 左侧栏出现「微信」图标 → 点开 → 右上「新增账号」；
3. 手机微信扫码（可能还需要输入手机上的数字配对码）；
4. 微信里给机器人发一条消息，绑定表里就会多一行；
5. 选一个 DSH 会话点「绑定」——之后两边就是同一个对话了。

## 协议（iLink Bot）

| 用途 | 接口 |
| --- | --- |
| 扫码登录 | `POST /ilink/bot/get_bot_qrcode?bot_type=3` |
| 轮询扫码状态 | `GET /ilink/bot/get_qrcode_status?qrcode=…&verify_code=…` |
| 长轮询收消息 | `POST /ilink/bot/getupdates`（`get_updates_buf` 游标，服务端 hold ~35s） |
| 发消息 | `POST /ilink/bot/sendmessage`（必须回填入站消息的 `context_token`） |
| 打字状态 | `POST /ilink/bot/getconfig` + `POST /ilink/bot/sendtyping`（本插件未用） |

所有请求带 `iLink-App-Id` / `iLink-App-ClientVersion` / `AuthorizationType: ilink_bot_token` / `X-WECHAT-UIN`（随机 uint32 → 十进制 → base64）头，body 带 `base_info`。

协议细节参考腾讯官方包 [`@tencent-weixin/openclaw-weixin`](https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin)（MIT）与社区逆向文档 [`weixin-ClawBot-API`](https://github.com/sintrb/weixin-ClawBot-API)。本仓库不含腾讯代码。

## 配置

在 DSH profile 的 `cordis.patch.yml` 里覆盖 `channel-wechat` 这一行的 `config`：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `allowFrom` | `[]` | 微信用户白名单（`xxxx@im.wechat`），空 = 不限制 |
| `cwd` | `''` | 自动会话的工作目录，空 = DSH 默认目录 |
| `agentPreset` | `''` | 指定 agent preset |
| `replyTimeoutMs` | `180000` | 单轮等待 agent 回复上限 |
| `maxReplyChars` | `1800` | 单条微信文本上限，超出拆条 |
| `messagePrefix` | `''` | 注入会话时给微信消息加的前缀 |
| `webMessagePrefix` | `'[网页] '` | GUI 消息转发到微信时的前缀 |
| `mirrorUserMessages` | `true` | 是否把 GUI 用户消息转发到微信 |
| `mirrorAssistantMessages` | `true` | 是否把助手回复镜像到微信 |
| `mirrorIntervalMs` | `1200` | 镜像扫描间隔 |
| `apiBase` | `https://ilinkai.weixin.qq.com` | iLink 服务地址 |

状态与凭据写在 `~/.dsh/wechat-bridge/state.json`（0600），日志在同目录 `bridge.log`。

## HTTP 接口（面板用，同源）

`/wechat-channel/status`、`/sessions`、`/qr.png`、`/login`、`/logout`、`/verify`、`/bind`、`/unbind`。
只监听本机回环地址。

## 已知限制

- 只处理文本；图片/语音/文件/视频以 `[图片]`、`[语音] …` 等占位交给模型（语音若带腾讯转写会附上文字）；
- 群聊按 `group_id` 单独映射，回复发回发送者，未做 @ 处理；
- 一个微信号的 ClawBot 只能绑定一个网关实例，绑定过其它实例会返回 `binded_redirect`；
- token 失效（errcode `-14`）会停掉该账号轮询，需重扫码；
- 微信二维码约 2 分钟过期，最多自动刷新 3 次；
- 双向镜像意味着绑定会话里的内容都会发到微信，注意隐私。

## License

MIT，见 [LICENSE](./LICENSE)；第三方组件见 [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md)。
