# 2.4.7 更新报告

- 版本：`2.4.6` → `2.4.7`
- 日期：2026-11-14
- 目标：微信里除了切会话，还能换模型、看状态、停任务（`/models`、`/model`、`/status`、`/stop`）。

## 一、新增命令

| 命令 | 作用 |
| --- | --- |
| `/models` | 列可用模型：按厂商分组编号，`1. DeepSeek / DeepSeek Chat（deepseek-chat，推理档 low/high）← 当前 · 默认`，最多 20 个；序号写入绑定的 `modelOptions` 持久化 |
| `/model` | 看当前会话模型 + 平台默认模型 |
| `/model 2` | 切到上次 `/models` 列表第 2 个 |
| `/model 2 high` | 同时指定推理档（只在该模型声明了 efforts 时有效） |
| `/model <provider>/<modelId>` | 直接按 provider/modelId 切 |
| `/status` | 会话状态：标题/id、在线与运行中、当前模型、队列条数与待输入（approval / question）、工作目录、绑定方式 |
| `/stop` | 停止当前这一轮（仅在运行中可停）；排队中的消息不受影响 |

`/help` 文本同步补充了这四条。

## 二、实现

- **模型目录**：`sessionController.modelCatalog()` → `ModelCatalog { default, groups[{ id, name, models[{ id, name, reasoning? }] }] }`，拍平后编号；`catalog.default` 标「默认」。
- **当前模型**：优先实时 Session 的 `requestContext()`（`{ provider, model }`），退化到 `requestHeader().config`；会话没打开时显示「读不到」而不是猜。
- **切换**：`sessionController.selectModel({ sessionId, provider, model, reasoningEffort? })`。切换前先 `ensureSession`，保证自动会话（`wx-…`）已存在；返回值 `selected` 作为回执，日志记 `model switched from wechat`。
- **状态**：`sessionController.state({ sessionId }, signal)` → `{ running, active, queue, pendingInput }`；拿不到就退回本地的轮次跟踪（`isSessionBusy`）。
- **停止**：`sessionController.cancel({ sessionId })`，只在 `isSessionBusy` 为真时调用；否则直接回「没有在跑的轮次」，不产生无意义调用。
- 四个命令都走已有的命令分发：整条消息以 `/` 或 `／` 开头且命中白名单才拦截，命令消息不进会话；未知 `/xxx` 行为不变。

## 三、验证

| 自测 | 覆盖 | 结果 |
|---|---|---|
| `test-models.mjs` | `/models` 列表与「当前/默认」标记、序号落盘；`/model` 看当前；按序号切换；带推理档切换；按 `provider/modelId` 切换；序号越界与错误用法提示；`/status` 各字段；`/stop` 空闲与运行中两种行为 | 8 项通过 |

回归：`test-options`(9)、`test-relay`(6)、`test-progress`(6)、`test-commands`(9)、`test-insert`(5) 全部通过，合计 43 项。

## 四、限制

- `/stop` 只取消当前轮次，不清空已排队的消息；要彻底开新对话用 `/new`。
- 模型切换按会话生效、下一轮才用；切换冷会话需要能 `resolveAgent`（归档/不在本机的会话会提示先在电脑端打开）。
- 推理档只在该模型 `reasoning.efforts` 里声明时才有意义；传了不被支持的档位由 DSH 侧决定（通常回落默认档）。
- `/models` 只列前 20 个；更多用 `/model provider/modelId`。
- 与 2.4.4 起的 `wechat_status` 状态块无关：模型命令不新增配置项。

## 五、升级

保持 `link:` 安装需完全退出 DSH 再启动；或重新执行 `dsh plugin --profile desktop add ./dsh-channel-wechat`。

## 六、变更文件

- `index.js`：命令白名单与帮助文本、`/models` `/model` `/status` `/stop` 四个分支、`modelCatalogOf` / `currentModelOf` / `flattenModelCatalog`、版本号
- `README.md`：命令表与功能说明
- `CHANGELOG.md`：2.4.7 条目
- `test-models.mjs`：新增 8 项自测
- `package.json`：`2.4.6` → `2.4.7`
