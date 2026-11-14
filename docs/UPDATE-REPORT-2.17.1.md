# 2.17.1 更新报告（故障报告修复：progress 重试风暴）

- 版本：`2.17.0` → `2.17.1`
- 日期：2026-11-14
- 输入：用户提供的《微信通道故障报告》（v2.16.0，2026-11-14 15:18–15:19 UTC）

## 一、报告结论与代码对照

报告的核心判断成立：

1. `context_token` 过期后 `sendmessage ret=-2 prepare failed`；
2. `progressHeartbeat` 的进度消息失败会走 `sendToChat`，而 `sendToChat` 的熔断计数不区分消息类型 → 进度失败把账号打进 `send paused`；
3. 熔断后进度仍被反复调用，`sendToChat` 立即抛「发送暂缓」→ `progress send failed` 日志风暴（报告统计 1309 条 / 6 秒）；
4. 真实回复随后也撞上同一熔断 → `turn failed`，消息留在补发队列。

## 二、修复

| 报告建议 | 实现 |
|---|---|
| P0 进度失败不参与重试/冷却 | `sendToChat` 增加 `countFailure` 参数，`sendProgressMessage` 传 `false` |
| P0 熔断只对真实回复生效 | 同上；只有 reply / 流式段 / 补发会计入失败 |
| P1 token 失效停止盲重试 | 熔断期间 `sendProgressMessage` 先查 `sendPauseRemaining`，直接跳过（不请求、不记录）；失败日志每分钟最多一条 |
| P1 progress 去重/合并 | `progressBusy` 防重入；每轮进度最多 20 条；失败后该绑定退避 120 秒 |
| P2 暴露开关 | 2.17.0 面板「功能开关」已含「进度心跳」开关 |

额外：新入站（带新 `context_token`）会清除该账号的发送熔断，补发/回复立即重试，不必等 300 秒冷却。

## 三、验证

`test-faults.mjs` 4 项（本地 mock）：

- 连续 5 次 progress 失败后 `sendPauseRemaining = 0`，真实回复仍能发；
- 熔断期间 progress 返回 false 且**不请求接口**；
- 新入站后熔断清除，回复成功；
- 并发 `progressTick` 不叠加（防重入）。

二十二套合计 **139 项通过**。

## 四、仍存在的边界

- 进度风暴的“1309 条”里包含大量**同一秒内的重复调用**，本次修复保证即使被重复调用也不会请求接口/刷日志/触发熔断；但重复调用本身的来源（多实例/热重载残留）仍由 `CHANNEL_REGISTRY` 单实例 + 面板/命令控制，无法完全证明已消除所有外部触发路径。
- 真正的 `-2` 仍需要对方发消息刷新 `context_token`（或重扫码）；插件现在会在新入站时自动重试，不再盲重试。

## 五、变更文件

- `index.js`：`countFailure`、progress 熔断跳过/日志限流、`progressBusy`、每轮上限、入站清熔断、版本号
- `README.md`：投递恢复说明
- `CHANGELOG.md`：2.17.1 条目
- `test-faults.mjs`：新增 4 项
- `package.json`：`2.17.0` → `2.17.1`
