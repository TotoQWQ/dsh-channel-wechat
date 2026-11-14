# 2.9.0 更新报告（第二轮第 4 项：分段发送）

- 版本：`2.8.0` → `2.9.0`
- 日期：2026-11-14
- 目标：微信不支持流式输出，长回复要按段落分条发送，读起来自然、又不被单条长度上限截断。

## 一、实现

- 新增 `segmentText(text, { maxChars, mode })`：
  - `paragraph`（默认）：先按空行切块 → 能合并的相邻块合并（不超过 `maxChars`）→ 超长块再用 `splitByLength` 按换行/句号/空格/长度兜底切；
  - `length`：保持旧的纯长度切分。
- `sendToChat` 改用分段结果发送：
  - 每条上限 `segmentMaxChars`（默认 0 = 用 `maxReplyChars`，最短 200）；
  - 相邻两条之间 `segmentDelayMs`（默认 500ms）间隔，降低 iLink 限流/乱序概率；
  - `segmentIndex: true` 时多条带「（1/3）」前缀；
  - 失败回落（`-2 prepare failed` 时去掉 context_token 重试）与引用库记录保持原逻辑，按实际发出的每条记录。
- `splitText` 抽成模块级 `splitByLength`（`sendToChat` 与 `segmentText` 共用）。

## 二、验证

`test-segment.mjs` 5 项：

- `segmentText`：空文本、短段落合并、三段超限各成一条（都 ≤200 字）、单段 500 字切成 ≥3 且不丢字；
- `length` 模式与 `splitByLength` 完全一致；
- `sendToChat` 端到端：三条消息、带「（1/3）」序号、总耗时 ≥ 两次间隔；
- `segmentIndex=false` 无序号；
- `segmentMode=length` 时单段按长度切。

十四套合计 **96 项通过**。

## 三、限制

- 分段只影响「一条回复」的发送粒度，不改变模型输出方式；微信仍然没有真正的流式。
- 第 1 条之后会等待 `segmentDelayMs`，长回复的总发送时间会相应变长（默认 0.5s/段）。
- 如果单条内容因为加序号超过上限，会略微超出 `segmentMaxChars`（最多 6 个字符）。

## 四、变更文件

- `index.js`：`splitByLength` / `segmentText`、`sendToChat` 分段与间隔、配置、版本号
- `cordis.patch.yml`：`segmentMode` / `segmentMaxChars` / `segmentDelayMs` / `segmentIndex`
- `README.md`：功能与配置
- `CHANGELOG.md`：2.9.0 条目
- `test-segment.mjs`：新增 5 项
- `package.json`：`2.8.0` → `2.9.0`
