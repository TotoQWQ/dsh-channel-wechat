# 2.20.1 更新报告（表情识别诊断）

- 版本：`2.20.0` → `2.20.1`
- 日期：2026-11-15

## 背景

2.20.0 上线后实测上传一张图，文件落到了「其他」，但日志里既没有 `emotion classified` 也没有失败原因——识别走了 null 分支且静默。

## 改动

1. `classifyEmotionBuffer` 补日志：
   - 依赖缺失（无 `llm.stream` / `attachments.saveImage` / 模型选择）→ `emotion classify unavailable`，带 hasLlm/hasAttachments/provider/model；
   - 模型回复了但没有匹配分类 → `emotion classify no-match`，带回复前 200 字。
2. 新增 HTTP 诊断接口：

```
GET /wechat-channel/classify?path=C:\path\to\sticker.png
→ { ok: true, filePath, category }
```

不需要经过微信，方便验证模型是否支持图片、返回什么分类。

## 验证

- `node --check` 通过；二十三套 146 项通过（无行为变更）。
- 上线后调用该接口，根据日志/返回定位模型是否支持图片。

## 变更文件

- `index.js`：日志、`/wechat-channel/classify` 路由、版本号
- `CHANGELOG.md`：2.20.1 条目
- `package.json`：`2.20.0` → `2.20.1`
