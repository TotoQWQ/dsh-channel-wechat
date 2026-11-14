# 2.4.9 更新报告

- 版本：`2.4.8` → `2.4.9`
- 日期：2026-11-14
- 目标：微信里的选项卡 / 审批卡超时后**直接跳过继续**，不把整轮对话挂在电脑端的弹卡上。

## 一、问题

2.4.8 及之前：微信里等待回答超过 `optionReplyTimeoutMs`（默认 110 秒）后，插件先给微信发提示，再 `next()` 把请求交还 Web 客户端。如果人不在电脑旁，GUI 的卡片会一直等回答——这一轮对话就停在那里。而 `ask_user_question` 的阻塞式用法本就没有超时，审批更没有默认超时。

## 二、改动

超时行为改为可配置的 `optionTimeoutMode`：

| 值 | 行为 |
|---|---|
| `skip`（默认） | 直接跳过继续：选项卡把还没答的题都按「未作答」交回（`selected: []`），审批按「拒绝」（`rejected`，fail-closed），这一轮照常往下走 |
| `handoff` | 老行为：先给微信发提示，再 `next()` 交还 Web 客户端弹卡 |

细节：

- 多选题逐题提问时，已答的题保留答案，超时那一题及之后都补成 `selected: []`，答案批次仍然覆盖本次请求的全部题目。
- 微信里会收到「⏱ 微信 110 秒没收到回复，已按「跳过」继续（这题标记为未作答）」或「…已按「拒绝」继续这一轮」，说明发生了什么。
- 审批超时选择拒绝而不是取消：拒绝只让这次工具调用失败、回合继续；`cancelled` 会走取消语义。
- 日志新增 `question timeout skipped` / `approval timeout rejected` 两条事件，方便回查。
- 请求信号被取消（工具自己的超时）时行为不变：仍按 `cancelled` / 交还处理。

## 三、验证

`test-relay.mjs` 扩到 8 项，新增：

- 「微信超时 → 选项卡按「跳过」继续」：返回 `{ answers: [{ id, selected: [] }] }`；
- 「微信超时 → 审批按「拒绝」继续」：返回 `rejected`，微信收到跳过提示；
- 「handoff 模式超时 → 交还电脑端」：保持 `undefined` 老行为。

七套回归合计 **53 项通过**：options 9、relay 8、progress 6、commands 9、insert 5、models 8、extra 8。

## 四、限制

- `skip` 只是「不再等」，不代表同意：选项卡是未作答，审批是拒绝，模型会按此继续；需要真正授权时仍要在微信里回 `1`。
- 超时时间仍由 `optionReplyTimeoutMs` 控制；如果模型给 `ask_user_question` 设了更短的 `timeout`，工具自身会先超时并返回 pending（那也意味着继续）。
- 只有绑定了微信的会话才会走这套逻辑；没绑定的会话仍由 Web 客户端处理。

## 五、升级

保持 `link:` 安装需完全退出 DSH 再启动；或重新执行 `dsh plugin --profile desktop add ./dsh-channel-wechat`。

装了 `dsh-autoupdate` 的话，下次启动会自动拉到这一版。

## 六、变更文件

- `index.js`：`optionTimeoutMode` 配置、选项/审批超时分支、版本号
- `cordis.patch.yml`：新增 `optionTimeoutMode: skip`
- `README.md`：配置表与回复规则
- `CHANGELOG.md`：2.4.9 条目
- `test-relay.mjs`：8 项（新增 3 项超时行为）
- `package.json`：`2.4.8` → `2.4.9`
