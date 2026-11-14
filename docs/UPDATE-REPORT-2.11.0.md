# 2.11.0 更新报告（流式分段：整段输出完再发）

- 版本：`2.10.1` → `2.11.0`
- 日期：2026-11-14
- 目标：分段输出不要等整条回复结束才一次性发；但每一段必须「整段输出好」再发，不能把半段发出去。

## 一、问题

2.9.0 的分段发送是在 `runTurn` 拿到**最终完整回复**之后才切段发送，所以用户感觉是「整条答案好了一会儿才一起出来」；中途没有任何输出。

## 二、实现

- 监听 `agent/assistant-stream` 的 `text-delta`（正文增量），只对**微信发起的那一轮**（`wechatTurns` 集合）生效，GUI 轮次不流式，避免和 mirror 重复。
- 每来一段增量就追加到该会话的流缓冲区；**只有遇到空行（段落结束）且该段 ≥ `streamMinChars`（默认 200 字）** 才把这一整段发出去：
  - 没有空行边界 → 继续等，绝不发半段；
  - 段落太短 → 继续攒；
  - 两次发送至少间隔 `streamMinIntervalMs`（默认 1.5s）。
- 发送前复用 `formatWechatText` + `segmentText`（单段过长仍按 `segmentMaxChars` 切），失败进补发队列。
- **最终回复去重**：`takeStreamRemainder()` 把已经流式发出的前缀从最终文本里扣掉，`runTurn` 只补发剩余部分；前缀不匹配（模型重写）时退回整条发送，避免丢内容。
- `turn/end` 清空缓冲；`streamSegment: false` 可关闭，回到 2.9/2.10 的「整条完成后分段发」。

## 三、验证

`test-stream.mjs` 5 项：

- 没有空行边界时**不发**（等整段输出完）；
- 完整段落（空行结束）**立即发送**，且两段分别正确；
- `takeStreamRemainder` 从最终回复扣掉已发前缀，只返回剩余「丙…」；
- 非微信发起的轮次不流式发送；
- `streamSegment: false` 时完全不流式。

十六套合计 **106 项通过**。

## 四、效果

- 长回答会随着生成进度，每隔一段（空行分隔、≥200 字、≥1.5 秒）就到微信一条，不再等到最后一次性刷出。
- 每一段都是完整段落，不会出现「半句话」消息。
- 短回答或没有空行的回答仍然只在该轮结束时发；不会因为流式而重复。

## 五、变更文件

- `index.js`：`streamBuffers` / `wechatTurns`、`feedStreamText`、`takeStreamRemainder`、`sendStreamSegments`、`observeAssistantStream` 的 `text-delta` 分支、`runTurn` 去重、配置、版本号
- `cordis.patch.yml`：`streamSegment` / `streamMinChars` / `streamMinIntervalMs`
- `README.md`：功能与配置
- `CHANGELOG.md`：2.11.0 条目
- `test-stream.mjs`：新增 5 项
- `package.json`：`2.10.1` → `2.11.0`
