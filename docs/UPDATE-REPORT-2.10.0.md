# 2.10.0 更新报告（修复「最终结果有时输出不了」）

- 版本：`2.9.0` → `2.10.0`
- 日期：2026-11-14

## 一、现场证据

- `bridge.log`：14:39:17–14:39:32 共 **387 条** `progress send failed`（同一绑定、同一错误），14:39:38 一条 `turn failed`。
- `state.json`：两个绑定各 `pending: 2`，内容分别是：
  1. 真正的最终答案（PPT 预览、露营车回答）；
  2. `⚠️ DSH 处理失败：sendmessage ret=-2 prepare failed…` 这条「失败提示」。
- 直接探测 `sendmessage`（带 token / 不带 token / 换 `channel_version` / 换 bot_agent / 两个账号）**全部返回 ret=-2 prepare failed**，说明不是插件参数或版本问题，而是 iLink 侧对当前发送方的拒投。

## 二、根因链

1. 插件**热重载/重复实例**：同进程里可能同时存在多个 channel 实例（文件改动触发重载时旧实例的定时器/轮询未停），每个实例都在发进度心跳；
2. 进度心跳失败后**没有退避**，失败一次下一次定时又试，短时间内对 iLink 打了大量 `sendmessage`（387 条日志），触发平台风控/拒投（`ret=-2 prepare failed`）；
3. 此时最终答案发送失败 → 进补发队列；但队列 **TTL 只有 10 分钟**，超时后被当过期丢掉；
4. 同时失败处理又往队列里塞了一条「处理失败」提示 —— 恢复后用户会先看到答案、再看到一条吓人的失败提示；
5. 补发只在 mirror 的 1.2 秒轮询里做，且 `turnActive` 时跳过，导致新消息进来后旧答案迟迟不补发。

三个环节叠加，就表现为「有时候最终结果输出不了」。

## 三、修复

- **队列保留 6 小时**（`pendingTtlMs`，可配），不再 10 分钟丢掉最终答案。
- **入站先补发**：新消息更新 `context_token` 后，先 flush 队列，再处理命令/选项/新消息（命令路径早期 return 也不会绕过补发）。
- **不再堆积失败提示**：`sendmessage` 类投递失败直接跳过「处理失败」提示（回复已入队）；其它错误改为尽力而为发送，不排队。
- **发送熔断**：连续 5 次失败后暂停 5 分钟（`sendBreakerThreshold` / `sendBreakerMs`），不再持续撞接口。
- **进度退避**：进度发送失败后该绑定退避 2 分钟。
- **单实例保护**：`CHANNEL_REGISTRY`（挂在 `globalThis`）保证同一进程同一 `stateDir` 只有一个活跃 channel；新实例 `start()` 时先停旧实例（清定时器、停轮询、停镜像/进度/健康检查）。
- **`/resend`** 手动补发；`/ping` 显示「待补发」数量。

## 四、验证

`test-delivery.mjs` 4 项：

- `isDeliveryError` 只认 `sendmessage` 失败；
- 连续失败触发熔断，熔断后不再请求接口；
- 入站带回新 token 时自动补发旧回复、成功后队列清空；
- 同一 `stateDir` 起第二个实例会停掉第一个。

十五套合计 **100 项通过**。

## 五、说明

- 当前 iLink 侧仍在拒投（`ret=-2`），重启到 2.10.0 后：让对方分别给两个机器人发一条消息，插件会借新 `context_token` 先补发队列里的最终答案。
- 若对方发消息后仍持续 `-2`，说明该 bot 会话被平台标记，需要重新扫码登录该账号（iLink 的 token 失效是 `-14`，这里是 `-2`，属于投递层拒绝，重扫码可重置会话）。
- 这次 387 条失败日志的爆发时间正好与我们改插件文件的时间重合，基本可以确认是「热重载产生多实例」触发；2.10.0 的单实例保护 + 失败退避就是针对它。

## 六、变更文件

- `index.js`：`isDeliveryError`、`CHANNEL_REGISTRY`、`flushPendingOnInbound`、熔断、进度退避、`/resend`、pending TTL、版本号
- `cordis.patch.yml`：`pendingTtlMs` / `sendBreakerThreshold` / `sendBreakerMs`
- `README.md`：投递恢复、`/resend`、配置
- `CHANGELOG.md`：2.10.0 条目
- `test-delivery.mjs`：新增 4 项
- `package.json`：`2.9.0` → `2.10.0`
