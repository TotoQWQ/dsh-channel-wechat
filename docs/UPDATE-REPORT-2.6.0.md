# 2.6.0 更新报告（第二轮第 1 项：表情包库 /emotion）

- 版本：`2.5.0` → `2.6.0`
- 日期：2026-11-14
- 目标：插件专属表情包库：分类存放、可重命名、私有上传、外来来源默认禁用、按语境判断最多发两张、不耗 token。

## 一、目录与索引

- 根目录 `emotionDir`，默认 `~/.dsh/wechat-emotions/`。
- 9 个分类子目录：`开心 / 难过 / 生气 / 惊讶 / 爱你 / 无语 / 摸鱼 / 加油 / 其他`。
- `index.json` 记录每张的 `file / category / name / source / addedAt / bytes`。
- 启动时自动建目录，并把**手工放进分类目录**的图片补进索引（视为用户自己的收藏，`source: user`）。
- 重名自动加 `_2`、`_3` 后缀，不会覆盖。

## 二、命令

| 命令 | 作用 |
|---|---|
| `/emotion add [分类]` | 开始收录：之后发来的图片/GIF 直接归档到该分类，不转发给会话 |
| `/emotion end` / `/emotion cancel` | 结束并报数 / 取消（已收录的保留） |
| `/emotion list [分类]` | 不填分类看各分类数量，填分类列出名字（最多 30 个） |
| `/emotion send [分类\|名字]` | 手动发 1–2 张；不填随机挑一个非空分类 |
| `/emotion rename 旧名 新名` | 文件与索引一起改名 |
| `/emotion delete 名字` | 删除文件和索引 |
| `/emotion other source true\|false` | 是否允许「外来」来源表情包，**默认 false** |

- 外来来源（插件内置等，`source: builtin`）默认**不参与**列表与自动发送；`/emotion other source true` 后才会出现，设置写入 `state.json` 持久化。
- 收录过程只接受图片（`type: 2`，包含 GIF），其它消息照常走会话。

## 三、按语境发送（不耗 token）

- 本地关键词表把文本映射到 8 个情绪分类（`EMOTION_HINTS`）。
- 打分：用户消息命中 **2 分**，助手回复命中 **1 分**（避免助手自说自话触发）。
- `emotionAuto`：
  - `off`：完全不发；
  - `subtle`（默认）：分数 ≥ `emotionThreshold`（默认 2）才发；
  - `always`：命中即发（阈值 1）。
- 每次最多 **2 张**（池子 ≥2 时随机 1–2 张）；同一聊天 `emotionCooldownMs`（默认 5 分钟）冷却；只统计用户自己收录的来源（除非显式允许外来）。
- 发送复用已验证的 `getuploadurl → CDN → image_item` 通道。
- 自动发送只在**微信发起的那一轮**结束时触发，GUI 里的对话不会突然被塞表情。

## 四、验证

`test-emotion.mjs` 9 项：

- 语境分类与打分（用户 2 分 / 助手 1 分，未命中返回 null）；
- `saveEmotionBuffer` 分类落盘、重名加序号、`source: builtin` 区分；
- `/emotion add` → `end` 流程与计数；
- `/emotion list` 汇总与按分类列出；
- `rename` / `delete` 同步文件与索引；
- `/emotion other source true` 后才列出内置来源；
- `/emotion send 开心` 发出 `image_item`；
- `maybeSendEmotions` 命中语境发 1–2 张、冷却内不再发；
- `emotionAuto: off` 时不发。

十一套合计 **78 项通过**。

## 五、限制与后续

- 现有分类是「目录/命令指定 + 关键词」的本地识别，不调用视觉模型（因此不耗 token）；若要「按图自动分类」，可以作为可选项用视觉模型在上传时判定（会产生 token），后续再加。
- 旧 `/sticker`（`~/.dsh/wechat-stickers/`）保留，未自动迁移到 `/emotion` 库；需要的话可以加一次性导入。
- 第二轮其余 4 项与第一轮剩余 4 项在计划里继续：思考摘要、断联检测、分段发送、建议入口 → GitHub issue；风险邮件、自动化反馈、热承载、语音兜底。

## 六、变更文件

- `index.js`：情绪分类/打分、表情库索引与目录、`/emotion` 命令、图片收录、自动发送、snapshot `emotions`、版本号
- `cordis.patch.yml`：`emotionDir` / `emotionAuto` / `emotionThreshold` / `emotionCooldownMs` / `emotionAllowOtherSource`
- `README.md`：功能、命令表、配置表
- `CHANGELOG.md`：2.6.0 条目
- `test-emotion.mjs`：新增 9 项
- `package.json`：`2.5.0` → `2.6.0`
