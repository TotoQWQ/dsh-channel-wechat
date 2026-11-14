# 2.18.0 更新报告（AI 输出文件自动转发到微信）

- 版本：`2.17.1` → `2.18.0`
- 日期：2026-11-14
- 问题：镜像只同步文本，AI 产出的图片/文件（消息附件或回复里提到的本地文件）不会到微信。

## 一、实现

### 1. 消息附件
扫描会话事件里的 `image` / `file` 内容块（兼容助手消息和工具结果里的嵌套结构）：

- 用 DSH `attachments` 服务解析：优先 `imageHostPath` / `fileHostPath`；后端不落盘时用 `readImage` / `readFileStream` 读出字节，写到 `~/.dsh/wechat-bridge/outbound/`；
- 通过 `sendMediaToChat` 发送：图片走 `image_item`、视频走 `video_item`、其它走 `file_item`，复用 CDN 上传 + AES-128-ECB 链路。

### 2. 文本里的本地文件
助手回复里出现的本地路径也会被识别：

- Windows 绝对路径（`C:\…\x.pdf`）与引号/相对路径；
- 解析为绝对路径（相对路径基于会话工作目录），确认文件存在才发；
- 只转发图片/视频/PDF/Office/压缩包/txt/md 等“输出文件”扩展名，`.js/.ts/.json` 等源码不自动发，避免刷屏。

### 3. 去重与限制
- 同一文件（附件 + 文本路径重复提到）只发一次，记录在 `binding.mirrorFileSent`（24 小时清理，最多 200 条）；
- 超过 `mirrorFileMaxBytes`（默认 50 MB）跳过并记日志；
- 解析失败/发送失败只记日志，不影响文本转发；
- `mirrorFiles: false` 或面板「输出文件转发」开关可关闭。

## 二、验证

`test-files.mjs` 3 项（本地 mock CDN）：

- 助手消息里的图片 + 文件附件、文本里提到的 PDF 都发到微信（text/image/file 三种 item 都出现）；
- 同一附件重扫不会重复发送；
- `.js` 不转发、超过大小上限的文件跳过并出现在诊断 candidates 里。

二十三套合计 **142 项通过**。

## 三、限制

- 只扫描**助手消息**；用户在 GUI 里上传的文件、工具在 workspace 里生成但未在回复里提到的文件不会自动发（需要 AI 在回复里给出路径或作为附件）。
- 文本路径识别是启发式：路径含空格且未加引号时可能识别不到。
- 微信文件上限 50 MB；视频/图片格式取决于 `guessMediaKind`（按扩展名）。
- 附件解析依赖 DSH `attachments` 服务；服务不可用时只发文本。

## 四、变更文件

- `index.js`：`collectAttachmentRefs`、`collectTextFilePaths`、`resolveAttachmentPath`、`mirrorEventFiles`、去重、`mirrorFiles`/`mirrorFileMaxBytes` 配置、面板开关、版本号
- `client.js`：功能开关新增「输出文件转发」
- `cordis.patch.yml`：`mirrorFiles` / `mirrorFileMaxBytes`
- `README.md`：功能、配置
- `CHANGELOG.md`：2.18.0 条目
- `test-files.mjs`：新增 3 项
- `package.json`：`2.17.1` → `2.18.0`
