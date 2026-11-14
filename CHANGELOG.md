# 更新日志

本文件记录 `dsh-channel-wechat` 的版本变更。版本号遵循语义化版本：**主版本**改架构或协议行为，**次版本**加功能，**修订**只修 bug。

发布流程（约定）：改代码 → 提升 `package.json` 的 `version`（同时同步 `index.js` 的 `CHANNEL_VERSION`）→ 在本文件补一条 → 提交并推送 → 输出更新报告。

---

## 2.4.11 — 2026-11-14

### 新增

- **`/sticker` 表情包**：从 `stickerDir`（默认 `~/.dsh/wechat-stickers/`，启动时自动建目录并放一份 README）随机发一张 png/jpg/gif/webp；`/sticker 关键词` 按文件名筛选；`/sticker 列表` 列出目录内容；目录为空或无匹配时给放置提示。走已验证的 `getuploadurl → CDN → image_item` 通道（发出来是图片/GIF，不是微信原生表情 item——iLink 协议没有 sticker 类型）。
- **可爱化回复**：`cuteLevel` 控制助手回复句尾是否自动带一个 emoji/颜文字——`off` 不加、`subtle`（默认）约一半、`always` 每条；`cutePool` 可换池子（默认 10 个），已经以池中元素结尾时不重复加。微信发起的回复与镜像发送的助手消息都生效。
- 新自测 `test-cute.mjs`（6 项：decorateReply 三档与去重、表情包扫描/筛选/无匹配、`/sticker` 走 CDN 发图、关键词、列表、空目录提示）。

### 变更

- 命令白名单增加 `sticker`；`/help` 同步。
- 新增配置 `stickerDir`、`cuteLevel`、`cutePool`。
- 版本 2.4.10 → 2.4.11（`CHANNEL_VERSION` / `bot_agent` 同步）。

---

## 2.4.10 — 2026-11-14

### 修复

- **重启后微信不再返回消息**：`turnActive`（「这一轮正在回复」的运行时标记）曾被写进 `state.json`。如果进程在回复中途退出，重启后它会被原样加载、永远不会变回 false，于是插件一直以为会话在跑：
  - 新消息全被当成「插入当前对话」steer 掉，不会再起一轮，也就没有回复；
  - 镜像循环因为 `turnActive` 而整段跳过，助手消息也不发微信；
  - `/new`、`/use` 还会回「这一轮还在回复」。
- 修复方式：
  1. `loadState()` 时把 `turnActive` / `turnActiveSince` 一律复位；
  2. `saveState()` 不再把这些运行时标记写盘；
  3. `isSessionBusy()` 改成异步，并先用 `sessionController.state` 查会话真实 `running`，`turnActive` 只作兜底，且超过 `replyTimeoutMs + 5 分钟` 的标记直接作废；
  4. `runTurn` 写入 `turnActiveSince` 时间戳，便于判断标记年龄。
- 新增 `test-busy.mjs`（5 项）：加载复位、假忙走正常排队、真忙仍 steer、超龄标记作废、turn/start・turn/end 跟踪。

### 变更

- 版本 2.4.9 → 2.4.10（`CHANNEL_VERSION` / `bot_agent` 同步）。

---

## 2.4.9 — 2026-11-14

### 变更

- **选项/审批超时不再卡住会话**：微信里等回复超过 `optionReplyTimeoutMs`（默认 110 秒）时，默认**跳过继续**：
  - 选项卡：把还没答的题都按「未作答」交回（`selected: []`，模型按 `ask_user_question` 的约定继续，不把它当许可）；
  - 审批：按「拒绝」处理（`rejected`，fail-closed），这一轮继续往下走。
  - 微信里会收到「⏱ 微信 110 秒没收到回复，已按「跳过/拒绝」继续」。
- 新增配置 `optionTimeoutMode`：`skip`（默认，如上）或 `handoff`（老行为：先提示再 `next()` 交还 Web 客户端弹卡）。
- 原因：不是所有人都在电脑旁边，老行为会把一轮对话挂在 GUI 的卡片上一直等。

### 新增

- `test-relay.mjs` 扩到 8 项：新增「选项卡超时按跳过继续」「审批超时按拒绝继续」「handoff 模式超时交还电脑端」。

### 变更（版本）

- 版本 2.4.8 → 2.4.9（`CHANNEL_VERSION` / `bot_agent` 同步）。

---

## 2.4.8 — 2026-11-14

### 新增

- **`/rename <标题>`（`/title`）**：给当前会话改名（`sessionController.rename`，最多 60 字），自动会话会先 `ensureSession` 再改名。
- **`/history [N]`（`/hist`）**：用 `sessionController.events` 冷读当前会话最近 N 条对话（默认 6、最多 20），按「你：…」「DSH：…」列出，单条截断 140 字；冷会话也能读，不需要先打开。
- **`/search <关键词>`（`/find`）**：`sessionController.search({ query })` 跨会话搜历史，列出命中的会话（标题 · id 后 8 位）与片段，并把命中 id 写进 `sessionOptions`，可直接 `/use 1` 切过去。
- **`/approval [ask|never]`（`/policy`）**：无参数读 `approval.overrideOf(session)` 显示当前策略（未覆盖时显示 ask 默认）；带参数时用 `approval.setPolicy(agent, 'ask'|'never')` 切换，回执「随会话保存，下一轮生效」；会话没打开时明确提示。
- `/help` 文本同步补上四条；命令白名单扩到 `rename / title / history / hist / search / find / approval / policy`。
- 新自测 `test-extra.mjs`（8 项：历史两种角色、改名与缺参、搜索与 `/use` 联动、审批查看/切换/非法参数、帮助覆盖）。

### 变更

- 版本 2.4.7 → 2.4.8（`CHANNEL_VERSION` / `bot_agent` 同步）。

---

## 2.4.7 — 2026-11-14

### 新增

- **`/models` / `/model`**：列可用模型（按厂商分组编号，标出「当前 / 默认」与推理档，最多 20 个），并按序号记住到绑定的 `modelOptions`；`/model` 看当前与默认；`/model 2` 切到第 2 个；`/model 2 high` 同时指定推理档；也支持 `/model <provider>/<modelId>`。切换走 `sessionController.selectModel`（会话级、显式恢复），回执「下一轮生效」。
- **`/status`**：一次看齐标题/id、在线与运行中、当前模型、队列条数与待输入（approval / question）、工作目录、绑定方式。
- **`/stop`**：仅在会话有轮次在跑时调用 `sessionController.cancel`，回执提示排队消息仍在；空闲时明确回「没有在跑的轮次」。
- `/help` 文本同步补充四个新命令。
- 新自测 `test-models.mjs`（8 项：列目录与标记、看当前、按序号/推理档/完整 id 切换、越界与用法提示、`/status` 内容、`/stop` 忙闲两种行为）。

### 变更

- 命令白名单扩到 `models / model / status / stop`；未知 `/xxx` 行为不变（照常转发）。
- 版本 2.4.6 → 2.4.7（`CHANNEL_VERSION` / `bot_agent` 同步）。

---

## 2.4.6 — 2026-11-14

### 新增

- **微信消息插进正在跑的对话**：会话有轮次在跑时（微信发起或电脑端发起都算），新来的微信消息改用 `sessionController.prompt` 的 `mode: 'steer'` 直接注入**当前这一轮**，在下一个 step 边界进入模型上下文，不再排在当前轮结束之后。会话空闲时仍按普通 `queue` 一轮一答处理。
- 插入回执：首次插入回「📥 已插入当前对话（不用等这一轮结束）」，同一聊天 10 秒内多次插入只回一次，避免刷屏。
- 新配置 `insertWhileBusy`（默认 `true`）；置 `false` 可退回 2.4.5 的排队行为。`messagePrefix` 同样会加在插入内容前。
- 新自测 `test-insert.mjs`（5 项：空闲走 queue、忙时 steer、回执节流、前缀保留、关闭开关后回退 queue）。

### 变更

- `promptSession` 增加 `mode` 参数（默认 `'queue'`），插入路径传 `'steer'`。
- 插入不会改动镜像游标：微信侧用户消息仍按 `wx-req` 前缀被镜像跳过，不会回显成「[网页]」。
- 版本 2.4.5 → 2.4.6（`CHANNEL_VERSION` / `bot_agent` 同步）。

---

## 2.4.5 — 2026-11-14

### 新增

- **微信里切换会话**：新增五个会话命令，整条消息以 `/`（或全角 `／`）开头且命中才生效，其他 `/xxx` 照常发给会话。
  - `/sessions`（`/ls`、`/list`）：列出最近 12 个会话（标题 · id 后 8 位，标出运行中/当前），并把这次的序号记到绑定的 `sessionOptions`，供 `/use` 使用。
  - `/use 2`（`/switch 2`）：切到上次列表第 2 个；也支持 `/use <完整会话 id>`。目标会话没打开时先用 `sessionController.resolveAgent` 尝试恢复，恢复失败给出提示，不硬切。
  - `/new`：换到全新会话（下一条消息开新对话，原会话保留在电脑端）。
  - `/current`（`/now`）：显示当前绑定会话、在线状态、手动绑定还是自动会话。
  - `/help`（`/?`）：命令帮助。
- 正在回复的轮次未结束时，`/use`、`/new` 提示先等结束，避免把回复发到一半切走；切换成功会回「✅ 已切换到 …」，并写入绑定表持久化。

### 变更

- 版本 2.4.4 → 2.4.5（`CHANNEL_VERSION` / `bot_agent` 同步）。

---

## 2.4.4 — 2026-11-14

### 新增

- **微信端作答选项 / 审批**：DSH 弹出 `ask_user_question` 选项卡或审批卡时，插件把题目与编号选项同步发到绑定的微信。微信回 `1` / `2` / `1,3`（中英文逗号、顿号都认）或直接回文字即可作答；审批回 `1` 允许一次、`2` 拒绝。实现上监听 `user-questions/request` 与 `approval/request` 两个瀑布事件，用 `{ prepend: true, global: true }` 抢在 Web 客户端桥接之前，入站文本在 `handleInbound` 处被消费，不再转发给会话。
- **长任务进度提示**：跟踪 `turn/start` / `turn/end`，一轮跑得久时每 `progressIntervalMs`（默认 2 分钟）发一条「⏳ 还在处理：已经思考 X 分 Y 秒（第 N 次进度）」；若这时正在等微信作答，文案改为「⌛ 在等你回复：已经等了 X 分」。收轮即停，发送失败只记日志、不进补发队列。
- **新配置**：`relayOptions`（默认 `true`）、`optionReplyTimeoutMs`（默认 `110000`）、`progressHeartbeat`（默认 `true`）、`progressIntervalMs`（默认 `120000`，最短 `30000`）。
- **新自测**：`test-options.mjs`（9 项，排版/解析）、`test-relay.mjs`（6 项，假 iLink 服务端到端）、`test-progress.mjs`（6 项，进度节流/文案/静默）。

### 变更

- 选项题在微信里超时（默认 110 秒，短于 `ask_user_question` 的 120 秒）后，先给微信发一条「已转到电脑端」，再 `next()` 把请求交还 Web 客户端弹卡；未绑定微信的会话完全不受影响。
- `wechat_status` 增加 `options` / `progress` 两段状态，便于确认转发是否生效。
- 版本 2.4.3 → 2.4.4（`CHANNEL_VERSION` / `bot_agent` 同步）。

---

## 2.4.3 — 2026-11-13

### 新增

- **MP4 宣传片**：`docs/promo.mp4`（H.264 / yuv420p / 1280×720 / 10fps / 14.4 秒 / 400 KB / faststart），由同一套帧用 ffmpeg 编码。
- GIF 改为从干净帧重新用 palettegen 生成（2.0 MB，画质比首版好），README 顶部改为「封面 → 点击播 MP4」。

---
## 2.4.2 — 2026-11-13

### 新增

- **宣传视频**：`docs/promo.gif`（14 秒，6 幕：定位 → 双向镜像 → 多账号转发 → 媒体与引用 → 一条命令安装 → 仓库地址），`docs/promo-poster.png` 为首帧封面；中英 README 顶部已嵌入。

---
## 2.4.1 — 2026-11-13

代码审查后修复。

### 修复

- **`wechat_simulate` 污染状态**：之前会把 `user:sim-user` 之类的假绑定写进 `state.json` 并显示在面板上；现在自测用临时会话 id，不落盘、不写绑定。
- **诊断接口缺确认门**：`/relay-test`、`/send-probe`、`/mirror-probe?send=1` 都会真的给微信发消息，现在必须带 `&confirm=1` 才会执行，误触发也不会刷屏。
- **引用库泄漏本地路径**：入站媒体落盘路径会被记进 `quotes.json` 并可能回填给模型；现在改存干净摘要（`relaySummary`，不含路径）。

### 变更

- 版本 2.4.0 → 2.4.1（`CHANNEL_VERSION` / `bot_agent` 同步）。

---
## 2.4.0 — 2026-11-13

入站媒体补齐：语音、文件、视频都能正常接收。

### 新增

- **入站语音**：不再只取腾讯转写文本，同时从 CDN 下载、AES-128-ECB 解密并落盘为 `.silk`，消息里带上时长、转写和文件路径（silk→wav 转码仍未做）。
- **入站文件名保留**：文件类消息用原文件名作前缀（非法字符替换、截断 60 字），扩展名取自原文件名，不再一律 `.bin`。
- **视频**固定存成 `.mp4`；图片按魔数判扩展名（png/jpg/gif/webp）。
- **入站媒体大小上限 100 MB**，超限直接给出可读提示而不是把进程撑爆。

### 变更

- 入站提示语统一成「[类型 时长] 说明 + 绝对路径 + 体积」，模型一眼知道文件在哪、多大、要不要 read_image。
- 版本 2.3.0 → 2.4.0（`CHANNEL_VERSION` / `bot_agent` 同步）。

---
## 2.3.0 — 2026-11-13

微信文字排版优化，外加测试中挖出的两个发送 bug。

### 新增

- **`formatWechatText` 排版管线**（发到微信前统一走一遍，导出可单测）：
  - Markdown 表格 → `· 键：值`（两列）或 `· a｜b｜c`（多列），表头行自动丢弃；
  - 标题 `## x` → `【x】`；引用块压平；`---` → `──────────`；
  - `**粗**` / `*斜*` / ` 代码 ` / `~~删除线~~` 去掉标记保留文字；
  - `- [x]` → ✅、`- [ ]` → ⬜；链接 → `文字（url）`；代码块去围栏保留内容；
  - **长段落按句读断行**（。！？；，、），列表项续行缩进两格、有序列表缩进三格；
  - 连续空行收敛为一行。
- **`formatMaxLine` 配置**（默认 60 字符）：控制断行宽度。

### 修复

- **`wechat_send` 找不到目标**：之前固定用 `accounts[0]` 去匹配绑定，聊天在别的号上时会误报「没有与该用户的会话记录」；现在按 `chatId` 反查绑定，并跨账号回退。
- **`wechat_send` 失败即报错**：token 过期时直接抛错；现在改走 `sendTextToUser`，失败自动进发送队列并返回 `queued`，不再丢消息。
- 两列表格的表头行不再渲染成 `· 项目：状态`。

### 变更

- 版本 2.2.0 → 2.3.0（`CHANNEL_VERSION` / `bot_agent` 同步）。

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
