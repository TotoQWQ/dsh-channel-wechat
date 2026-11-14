# 2.4.4 更新报告

- 版本：`2.4.3` → `2.4.4`
- 日期：2026-11-14
- 目标：解决「DSH 弹出选项/审批时，微信侧看不到、也没法选」的问题，并给长任务补上进度反馈。

## 一、问题

1. **选项 / 审批在微信里不可见**：DSH 的 `ask_user_question` 选项卡片和审批卡只由 Web 客户端接管，微信用户看不到题目，也无法作答；如果人不在电脑前，一轮对话会一直停在那里。
2. **长任务没有反馈**：一轮跑几分钟时，微信侧完全没有动静，用户无法判断是在执行还是卡死。

## 二、改动

### 1. 微信端作答选项 / 审批（Host 侧）

- 监听两个 Cordis 瀑布事件（与 DSH 0.2.2-rc.3 的实际契约对齐）：
  - `user-questions/request`：`(request: AskUserQuestionRequestEvent, next) => AskUserQuestionAnswer`
  - `approval/request`：`(request: ApprovalRequestEvent, next) => ApprovalOutcome`
- 注册时使用 `{ prepend: true, global: true }`：`prepend` 让监听排在 Web 客户端桥接之前，`global` 绕过 scope 过滤，确保所有会话都能收到。
- 只有在「该会话有微信绑定且账号已登录」时才接管；否则原样 `next()`，电脑端行为不变。
- 题目排版成窄屏友好文本：标题（`header`）、问句、`detail`、编号选项（含选项说明），并提示回复方式；审批排版为「工具 + 原因 + 1 允许一次 / 2 拒绝」。
- 回复解析（纯函数，可单测）：
  - 选项题：`1`、`2`… 按序号选；`1,3` / `1，3` / `1、3` 多选；与选项同名也算选中；其余文字作为 `custom` 自定义答案；序号越界、单选题回多个序号会提示重回，不会把错答案交给模型。
  - 审批：`1` / `允许` / `同意` / `OK` → `allowed-once`；`2` / `拒绝` / `No` → `rejected`。
- 入站消费：`handleInbound` 在把消息转发给会话之前，先检查该聊天是否有待作答的选项/审批；有就作为答案消费并回确认，不再进入会话（不会污染对话记录）。
- 超时交还：微信侧默认等 110 秒（短于 `ask_user_question` 默认的 120 秒），超时先给微信发提示，再 `next()` 把请求交还 Web 客户端弹卡；请求信号被取消时按审批语义返回 `cancelled`。

### 2. 长任务进度提示

- 全局监听 `session/event`，用 `turn/start` 记开轮时间、`turn/end` 收轮清理；每 15 秒检查一次是否到点。
- 到点后向该会话所有绑定的微信发：
  - 正常执行：`⏳ 还在处理：已经思考 X 分 Y 秒（第 N 次进度）`
  - 正在等作答：`⌛ 在等你回复：已经等了 X 分`
- 发送为「尽力而为」：失败只记 `bridge.log`，不进入补发队列，避免恢复后刷屏；6 小时以上的残留记录自动清理。

### 3. 可观测性与配置

- `wechat_status` 新增：
  - `options: { relay, waiting, replyTimeoutMs }`
  - `progress: { heartbeat, intervalMs, tracking }`
- 新增配置（包内 `cordis.patch.yml` 已给默认值）：
  - `relayOptions`（默认 `true`）
  - `optionReplyTimeoutMs`（默认 `110000`）
  - `progressHeartbeat`（默认 `true`）
  - `progressIntervalMs`（默认 `120000`，最短 `30000`）

## 三、验证

| 自测 | 覆盖 | 结果 |
|---|---|---|
| `test-options.mjs` | 选项/审批排版与解析、序号越界、多选、自定义答案、时长格式 | 9 项通过 |
| `test-relay.mjs` | 假 iLink 服务下的真实 channel 端到端：发题 → 回 `2` → 得到选项 B；越界提示后重答；审批回 `1` → `allowed-once`；未绑定会话不接管；超时交还 | 6 项通过 |
| `test-progress.mjs` | 到点发进度、同一间隔不重复、等作答时改文案、收轮静默、`progressHeartbeat=false` 全静默 | 6 项通过 |

生产环境实测（Windows / DSH Desktop，真实微信）：选项卡发出后，微信回序号，`bridge.log` 记录

```
[info] option reply {"kind":"question",...}
[info] question relayed to wechat {"sessionId":"...","answers":1}
```

DSH 侧工具调用拿到答案后继续执行，未再卡住。

## 四、兼容性与限制

- 与 DSH `0.2.2-rc.3` 的 `ctx.waterfall` 语义、`AskUserQuestionAnswer` / `ApprovalOutcome` 结构一致；`user-questions/request` 的默认应答者是 Web 客户端桥接，本插件只在「有微信绑定」时抢先接管。
- 问题挂起期间电脑端不会同时显示选项卡（由微信独占），超时后交还 GUI；如果两边都要同时可见，需要改成客户端先接管、微信只做旁路提示。
- `ask_user_question` 若被模型指定了更短的 `timeout`，微信侧可能在它之后才超时；此时工具已返回 `pending`，微信里的回复会被当作普通消息继续发回会话。
- 进度提示只覆盖插件能观察到 `turn/start` 的轮次；插件激活前已在跑的轮次不会被跟踪。

## 五、升级

```powershell
dsh plugin --profile desktop add ./dsh-channel-wechat
```

或保持 `link:` 安装，改完代码后完全退出 DSH 再启动（模块代际需要重启才会替换）。

## 六、变更文件

- `index.js`：选项/审批转发、进度提示、`wechat_status` 状态扩展、版本号
- `cordis.patch.yml`：新增 4 个配置项默认值
- `README.md`：功能说明、配置表、回复规则
- `CHANGELOG.md`：2.4.4 条目
- `test-options.mjs`、`test-relay.mjs`、`test-progress.mjs`：新增自测
- `package.json`：`2.4.3` → `2.4.4`
