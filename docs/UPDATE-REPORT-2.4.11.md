# 2.4.11 更新报告：表情包 + 可爱化回复

- 版本：`2.4.10` → `2.4.11`
- 日期：2026-11-14
- 目标：让机器人在微信里能发可爱表情包，回复也带点可爱。

## 一、能力与协议边界

| 想做的 | 现实 |
|---|---|
| 发图片 / GIF 当表情包 | ✅ 走已验证的 `getuploadurl → CDN → image_item` 通道 |
| 发微信「原生表情」item | ❌ iLink 协议 item 类型只有 text / image / voice / file / video，没有 sticker 类型 |
| 文字 emoji / 颜文字 | ✅ 纯文本 |
| 接收你发的表情包 | ✅ 已有：图片/GIF 解密落盘并交给模型 |

## 二、新增功能

### 1. `/sticker` 表情包

- 目录：`stickerDir`，默认 `~/.dsh/wechat-stickers/`；插件启动时自动创建，并放一份 `README.txt` 说明。
- 支持 `png / jpg / jpeg / gif / webp`，按文件名排序。
- `/sticker`：随机发一张。
- `/sticker 关键词`：按文件名包含关系筛选（如 `/sticker 生气` 命中 `生气.gif`）；无匹配时列出全部候选名。
- `/sticker 列表`（或 `/sticker list`）：列出目录里最多 30 个名字与总数。
- 目录为空给出放置提示。
- 发送失败（CDN/账号问题）回一条错误说明，不会静默。
- 走的是现有 `sendMediaToChat`，单文件上限沿用 50 MB，AES-128-ECB 加密后上传。

### 2. 可爱化回复（`cuteLevel`）

- `off`：不加。
- `subtle`（默认）：约一半回复句尾加一个池中 emoji/颜文字。
- `always`：每条都加。
- 去重：回复本身已经以池中某项结尾时不再追加。
- `cutePool` 可自定义（默认 `🌊 🐳 ✨ 😊 🫧 🎵 🌸 🐱 🫶 ☕`，最多 50 项）。
- 生效范围：微信发起的最终回复（`runTurn`）与镜像发送的助手消息（`mirrorTick → sendToBinding`）；命令回复、进度提示、报错提示不加。

## 三、验证

`test-cute.mjs` 6 项：

- `decorateReply` 三档（off / always / subtle，注入随机数）、已有后缀去重、空文本；
- `listStickers` 只认图片扩展名、忽略 txt 与子目录；
- `pickSticker` 关键词命中 `angry.gif`、无匹配返回全量且 `picked: null`、目录不存在返回空；
- `/sticker` 端到端：mock `getuploadurl` + `/upload`（回 `x-encrypted-param`）+ `sendmessage`，断言发出的是 `type: 2` 的 `image_item`，且没有额外文字；
- `/sticker 关键词` 命中指定文件；
- `/sticker 列表` 与无匹配提示、空目录提示。

九套合计 **64 项通过**（options 9、relay 8、progress 6、commands 9、insert 5、models 8、extra 8、busy 5、cute 6）。

## 四、使用

1. 把喜欢的 GIF/PNG 丢进 `~/.dsh/wechat-stickers/`（重启后目录会自动建好）。
2. 微信里发 `/sticker` 或 `/sticker 关键词`。
3. 想调可爱度：`cuteLevel: off|subtle|always`，换池子用 `cutePool`。

## 五、变更文件

- `index.js`：`decorateReply` / `listStickers` / `pickSticker`、`/sticker` 命令、启动建目录、回复装饰、版本号
- `cordis.patch.yml`：新增 `stickerDir` / `cuteLevel` / `cutePool`
- `README.md`：功能、命令表、配置表
- `CHANGELOG.md`：2.4.11 条目
- `test-cute.mjs`：新增 6 项
- `package.json`：`2.4.10` → `2.4.11`
