# 2.14.0 更新报告（第一轮第 3 项：自动化任务完成 → 微信反馈）

- 版本：`2.13.0` → `2.14.0`
- 日期：2026-11-14
- 目标：DSH 定时任务（`schedule` 服务）跑完后，向绑定的微信反馈完成情况。

## 一、DSH 侧能力（本次调研）

- Host Service `schedule`：
  - `catalog()` 返回所有任务（`title`、`status`、`target`、`scheduledAt`、`lastDelivery`）；
  - `lastDelivery` 含 `deliveredAt`、`targetSessionId`、`messageId`；
  - 投递才会激活/恢复目标会话，任务本身没有「执行完成」事件。
- Event 目录里只有 `schedule/changed`（任务集变化），没有 delivery 完成事件。

因此采用「**投递记录 + turn 时间窗口**」判断：

1. 任一会话 `turn/end` 时，读取 `schedule.catalog()`；
2. 找 `lastDelivery.targetSessionId === 当前会话` 且 `deliveredAt` 落在该轮开始前后 `automationWindowMs`（默认 2 分钟）内的任务；
3. 命中则视为定时任务触发的轮次。

## 二、行为

- 命中后给绑定的微信发：`⏰ 定时任务完成：「标题」· 用时 12 秒`；
- 只发一条短通知，不重复任务结果（结果本身会由镜像/回复通道发出）；
- 微信发起的轮次（`wechatTurns`）跳过，避免和正常回复重复；
- `automationReport: false` 关闭；
- `/tasks`（`/schedule`）列出任务：标题、状态、目标会话/新会话、下次时间，最多 10 条。

## 三、验证

`test-automation.mjs` 6 项：

- 新投递 + turn 结束 → 发出含任务标题与「用时」的通知；
- 10 分钟前的旧投递 → 不发（不误报）；
- `detectAutomationTurn` 直接判断（命中/其它会话不命中）；
- `automationReport: false` → 不发；
- `/tasks` 列出任务；
- `schedule` 服务不可用时 `/tasks` 提示。

十九套合计 **125 项通过**。

## 四、限制

- 判断依赖 `lastDelivery` 的时间窗口：如果用户在定时任务投递后 2 分钟内**手动**在同一会话里发消息，可能被误判为任务轮次，多发一条完成通知（只有提示，不影响内容）。
- 定时任务目标是 `new_once` / `new`（每次新建会话）时，新会话还没有微信绑定，不会收到通知；需要先绑定。
- 只反馈「完成」，不区分成功/失败（DSH 的 schedule 没有执行结果字段）。
- 每个 `turn/end` 会多一次 `schedule.catalog()` 读取（只读、无副作用），频率等于轮次结束次数。

## 五、变更文件

- `index.js`：`scheduleCatalog`、`detectAutomationTurn`、`notifyAutomationDone`、`finalizeAutomationTurn`、`turn/end` 集成、`/tasks` 命令、配置、版本号
- `cordis.patch.yml`：`automationReport` / `automationWindowMs`
- `README.md`：功能、命令、配置
- `CHANGELOG.md`：2.14.0 条目
- `test-automation.mjs`：新增 6 项
- `package.json`：`2.13.0` → `2.14.0`
