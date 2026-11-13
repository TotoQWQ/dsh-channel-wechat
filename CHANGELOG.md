# 更新日志

本文件记录 `dsh-channel-wechat` 的版本变更。版本号遵循语义化版本：**主版本**改架构或协议行为，**次版本**加功能，**修订**只修 bug。

发布流程（约定）：改代码 → 提升 `package.json` 的 `version`（同时同步 `index.js` 的 `CHANNEL_VERSION`）→ 在本文件补一条 → 提交并推送 → 输出更新报告。

---

## 2.2.0 — 2026-11-13

### 新增

- **wechat_report 任务进度播报**：把「标题 + 勾选清单 + 备注」渲染成一条微信消息（✅ done / 🔄 doing / ⬜ todo / ⛔ blocked / ⚠️ warn），发送失败自动进队列等补发；返回 delivered / queued 与渲染后的文本，便于 agent 知道到底有没有送到。
- 首次实跑已送达：10 项进度的完整报告发到了最近活跃的微信聊天。

### 变更

- 版本 2.1.1 → 2.2.0（CHANNEL_VERSION / ot_agent 同步）。
- 中英 README 的功能与工具清单补上 wechat_report。

---
## 2.1.1 — 2026-11-13

全功能自测跑出来的问题修复。

### 新增

- **`test-api.mjs` 全功能自测脚本**：走插件自己的 HTTP 接口跑 22 项检查（状态/版本一致性、会话列表、客户端模块、引用解析四个用例、镜像干跑、默认会话、新建会话、绑定/解绑、验证码、二维码、未知路由），不发送微信消息。用法：`DSH_WEB_URL=http://127.0.0.1:60260 node test-api.mjs`。

### 修复

- **错误码说人话**：`sendmessage` 的 `ret=-2 / -3 / -14` 现在会翻译成可操作的提示（token 过期该让对方先发一条 / 参数无效该检查目标 id / token 失效该重扫码），不再只甩一个裸错误码。
- **向陌生用户主动发送**：以前会到 `sendmessage` 才报 `ret=-3 invalid arguments`；现在直接说明「没有与该用户的会话记录：微信不接受对陌生人的主动消息，先让对方发一条」。
- **媒体发送的错误信息**同样走这套翻译（`postMessage`）。

### 变更

- `package.json` 增加 `test-api.mjs` 到 `files`。
- 版本号 2.1.0 → 2.1.1（`CHANNEL_VERSION` / `bot_agent` 同步）。

---

## 2.1.0 — 2026-11-13

媒体双向、引用、跨账号转发，以及面板里选择接收会话。

### 新增

- **发文件到微信**：`wechat_send_file` 工具；本地图片 / 视频 / 任意附件 → `getuploadurl` → AES-128-ECB(PKCS7) 加密 → 腾讯 CDN → `sendmessage` 带 `image_item` / `video_item` / `file_item` 引用；单文件上限 50 MB，上传失败重试 3 次。
- **入站媒体**：微信发来的图片 / 文件 / 视频不再只是 `[图片]` 占位符——从 CDN 下载、AES-128-ECB 解密（兼容 `base64(16B)` 与 `base64(32字符hex)` 两种 `aes_key` 编码），落盘到 `~/.dsh/wechat-bridge/inbound/`，路径写进消息文本，模型可用 `read_image` 打开。
- **微信引用**：解析 `item.ref_msg`，把被引用的原文带进上下文；只引用一段时按 `partial_text.startindex/endindex` 截取；新增 `quotes.json` 引用库（最近 800 条收发消息），客户端只给 `svr_id` 时也能还原原文。
- **跨账号转发**：多个微信号绑定同一会话时，A 号收到的消息转发到 B/C 号的微信（`relayAcrossAccounts`，前缀 `relayPrefix`，默认 `[{account}] `）。
- **面板选择接收会话**：顶部「微信消息进哪个会话」——默认接收会话下拉、「设为默认」、「新建会话并设为默认」；绑定表下拉改为**选完立刻生效**。
- **诊断接口**：`/wechat-channel/mirror-probe`、`/send-probe`、`/quote-probe`、`/relay-test`、`/client-modules`。

### 修复

- **发送静默失败**：iLink 用 `HTTP 200 + body.ret` 表示业务失败，旧代码只看 HTTP 状态，导致 `ret=-2 prepare failed` 被当成成功。现在检查 `ret`，失败时退回「不带 `context_token`」重试一次。
- **发送队列**：仍失败的消息入队（每聊天最多 20 条，60 秒退避），并在下一次收到该用户消息（带来新 token）时自动补发；队列条目超过 10 分钟直接丢弃，避免刷屏。
- **默认发送目标选错**：`wechat_send_file` 曾把测试用的 `sim-user` 绑定当成目标（`getuploadurl` 返回 `ret=-1`）；现在只挑真实微信会话（id 含 `@im.`）。
- **面板卡顿**：状态轮询 2s → 3s，页面隐藏时暂停，内容未变不重渲染；`/sessions` 不再每 10 秒全量扫描。

### 变更

- `package.json` 版本从 `1.0.0` 提到 `2.1.0`，`base_info.channel_version` / `bot_agent` 同步。
- README（中英）补排障章节、媒体与引用说明。

---

## 2.0.0 — 2026-11-13

从「每个微信聊天一个会话」重写为「微信 ↔ 任意 DSH 会话」。

### 新增

- **多账号**：`accounts{}` 模型，每个微信号独立长轮询、独立游标、独立错误状态；单账号可重扫码 / 断开而不影响其它账号。
- **双向镜像**：微信消息注入绑定会话（GUI 实时可见），助手回复自动回微信；GUI 输入的消息带 `[网页]` 前缀转发到微信。
- **绑定**：`chat → session` 显式绑定，可换绑 / 解绑 / 打开会话。
- **客户端面板**：左侧栏「微信」图标 + 主区域面板（账号表、扫码登录、绑定表）。
- **HTTP 接口**：`/wechat-channel/status`、`/sessions`、`/qr.png`、`/login`、`/logout`、`/verify`、`/bind`、`/unbind`。
- **工具**：`wechat_login`、`wechat_verify_code`、`wechat_status`、`wechat_bind`、`wechat_unbind`、`wechat_send`、`wechat_logout`、`wechat_simulate`、`wechat_debug`。

### 变更

- 状态从 v1 单账号结构迁移到 v2（`accounts` + `bindings`），迁移时保留原有会话绑定。
- 二维码渲染改为零依赖：`vendor/qrcode.mjs`（qrcode-generator，MIT）+ 自写 PNG 编码器。

---

## 1.0.0 — 2026-11-13

首个可用版本。

### 新增

- 微信 ClawBot / iLink 协议的 Host 插件：扫码登录（`get_bot_qrcode` / `get_qrcode_status`）、长轮询收消息（`getupdates`）、发消息（`sendmessage`，回填 `context_token`）。
- 每条微信聊天映射一个自动 DSH 会话（`wx-<hash>`），收到消息跑一轮 agent 并把回复发回微信。
- 单文件安装器 `install.mjs`（tarball 下载 + `dsh plugin add` + 注册 bundle + 追加 patch 行，幂等）。
- 中英双份 README、MIT LICENSE、第三方声明。
