# 2.20.2 更新报告（识别失败诊断）

- 版本：`2.20.1` → `2.20.2`

## 现象

`/wechat-channel/classify` 返回 `category: null`，日志只记 `emotion classify no-match {"answer":""}`——模型一个文本 delta 都没返回。

## 改动

1. `no-match` 日志增加 `finish`：直接打印 finish chunk，判断是 stop 空回复、还是 unsupported/error。
2. 新增 `GET /wechat-channel/llm-models`：

```json
{ "selection": { "provider": "...", "model": "..." }, "providers": [ { "id": "...", "models": [ { "id": "...", "inputModalities": ["text"] } ] } ] }
```

用于确认默认模型是否支持 `image`。

## 下一步

- 若模型 `inputModalities` 不含 `image`：说明当前 DeepSeek 文本模型不能看图，识别会一直兜底到指定分类/其他；需要换支持视觉的 provider，或改用其它识别方式。
- 若模型支持 image 但 finish 报错：按 finish 错误调整请求（例如附件转换用 `readImageRequest`）。

## 变更文件

- `index.js`：finish 日志、`/llm-models`、版本号
- `CHANGELOG.md`：2.20.2 条目
- `package.json`：`2.20.1` → `2.20.2`
