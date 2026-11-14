# 2.16.0 更新报告（第一轮第 5 项：微信语音输入兜底）

- 版本：`2.15.0` → `2.16.0`
- 日期：2026-11-14
- 目标：微信语音消息在腾讯转写缺失/失败时，也要有可用的兜底，不静默丢消息。

## 一、现状

- iLink 语音消息（`type: 3`）的 `voice_item.text` 是腾讯转写，大多数情况可用；
- 转写为空时，旧版只给会话一句「（无转写）」+ silk 文件路径，模型无法得知内容，用户也收不到任何反馈；
- iLink 语音是 **silk** 编码，本地没有解码器；DSH 的 `speechToText` 服务只接收 WAV 等常规音频。

## 二、实现

1. **腾讯转写优先**：`voice_item.text` 非空直接用。
2. **DSH 本地 ASR 兜底**：转写为空且保存的文件是 `.wav/.mp3/.ogg/.m4a/.webm/.flac` 时，调用 `ctx.get('speechToText')`：
   - `resolve({ audio })` → `transcribe(spec, signal)` → 使用返回文本；
   - 没有 provider / 失败时静默跳过并记日志。
3. **silk 明确标注**：silk 无法本地解码，会话里标记「（未识别出文字）…silk 编码，需要转码才能播放」，不假装成功。
4. **给对方可操作的提示**：仍然没有文字时，额外回一条「🎙️ 这条语音没识别出文字，麻烦打字或重发一下（可能太短/方言）」；`voiceFallbackHint: false` 可关。
5. **`/voice` 状态**：显示腾讯转写、DSH 本地 ASR provider、兜底提示开关。
6. 配置：`voiceAsr`（默认 true）、`voiceFallbackHint`（默认 true）。

## 三、验证

`test-voice.mjs` 6 项：

- wav 文件走 `speechToText` 并返回文本；
- silk 文件跳过 ASR；
- `/voice` 显示「本地 Whisper」和「未识别时的提示：开」；
- 空转写语音 → 收到 🎙️ 打字提示；
- 有腾讯转写 → 不提示；
- `voiceFallbackHint: false` → 不提示。

二十一套合计 **135 项通过**。

## 四、限制

- iLink 语音基本是 silk，本地 ASR 分支实际主要覆盖「用户发的是普通音频文件」；silk 目前只能提示对方重发/打字，彻底解决需要 silk 解码器（无依赖实现不现实）。
- 腾讯转写对短语音/方言可能本来就不准；兜底提示能避免静默丢消息，但不能恢复内容。
- DSH `speechToText` 需要安装了对应的语音插件（provider）才会生效。

## 五、变更文件

- `index.js`：`transcribeVoiceFile`、语音分支兜底、入站提示、`/voice` 命令、配置、版本号
- `cordis.patch.yml`：`voiceAsr` / `voiceFallbackHint`
- `README.md`：功能、命令、配置
- `CHANGELOG.md`：2.16.0 条目
- `test-voice.mjs`：新增 6 项
- `package.json`：`2.15.0` → `2.16.0`
