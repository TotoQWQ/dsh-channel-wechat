# 2.7.1 更新报告（修正 token 统计口径）

- 版本：`2.7.0` → `2.7.1`
- 日期：2026-11-14
- 背景：面板上出现「3.0 亿 token」的离谱数字，核查后发现统计口径问题。

## 一、原因

DSH 会话事件里的 `usage` 结构（实测样本）：

```json
{ "inputTokens": 487, "outputTokens": 112, "cacheReadTokens": 724352,
  "cacheWriteTokens": 0, "totalTokens": 724951 }
```

`totalTokens = inputTokens + outputTokens + cacheReadTokens`，其中 **cacheReadTokens 是上下文缓存命中**（长会话每步都会读几万缓存）。2.5.0 用 `totalTokens` 累计，等于把缓存读取全额当成花费，几百步就把数字推到几亿。

## 二、修复

- 计费口径改为 `inputTokens + outputTokens`（未缓存输入 + 输出）。
- `cacheReadTokens` **单列累计**（含按天、上一轮），不混进计费 token。
- `usageOf` 新增返回：`cacheReadTokens`、`todayCacheReadTokens`、`lastTurnCacheReadTokens`。
- 面板「消耗」列：主行「X 输入+输出」，次行「缓存 C · 今日 Y · 上轮 Z」。
- `/status` 的「用量」行：`用量：X token（输入 A / 输出 B / 缓存读取 C；今日 Y，上轮 Z）`。

## 三、验证

`test-usage.mjs` 扩到 6 项，新增「缓存读取单列，不混进计费 token」：追加一条 `input 10 / output 0 / cacheRead 5000` 的事件后，断言计费总量只 +10、缓存累计 5000、今日缓存 5000。

十二套合计 **86 项通过**。

## 四、限制

- 缓存读取本身也有计费（DeepSeek 缓存命中价格更低），这里只单列 token 数，不做金额换算；如果要「估算花费」，可以在后续按 provider 单价配置再算。
- 面板/`/status` 的数字在插件重启后从当前会话事件重新累计（不读历史归档），与之前一致。

## 五、变更文件

- `index.js`：`usageOf` 计费口径与缓存单列、`/status` 文案、版本号
- `client.js`：消耗列展示
- `README.md`：统计口径说明
- `CHANGELOG.md`：2.7.1 条目
- `test-usage.mjs`：6 项
- `package.json`：`2.7.0` → `2.7.1`
