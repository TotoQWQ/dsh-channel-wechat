# 2.21.0 更新报告（学习 meme_manager：内容去重 + 图片校验）

- 版本：`2.20.3` → `2.21.0`
- 日期：2026-11-15
- 依据：学习 [anka-afk/astrbot_plugin_meme_manager](https://github.com/anka-afk/astrbot_plugin_meme_manager)，见 `docs/LEARN-astrbot-meme-manager.md`

## 一、内容 SHA-256 去重

- 索引条目新增 `sha256` 字段；
- `saveEmotionBuffer` 先校验图片、再按内容哈希查重：
  - 命中已有条目 → 返回 `{ ...entry, duplicate: true }`，不写文件、不新增索引；
  - 未命中 → 写文件并记录 `sha256`；
- 上传重复图片的回复改为「ℹ️ 这张已经在「分类」里了，没有重复收录」；
- 旧条目没有哈希时，`/emotion dedupe` 会补算并写回。

## 二、图片内容校验

- `imageExtFromBuffer` 按魔数识别 PNG / JPEG / GIF / WebP，扩展名只作参考；
- 单张上限 20 MiB；
- 非图片抛错，上传流程回复「不是支持的图片」。

## 三、`/emotion dedupe`

- 按内容哈希分组，保留最早收录的一张，删除重复文件与索引；
- 清理「索引里有、磁盘上没了」的条目；
- 回复：`🧹 去重完成：删除 N 张重复，剩余 M 张。`
- 可解决迁移/手工拷贝造成的 `加油_2…_5` 重复副本。

## 四、验证

- `test-emotion.mjs`（11 → 12 项）：
  - 相同内容第二次保存返回 `duplicate` 且不落盘；
  - 不同内容正常生成 `_2`；
  - `/emotion dedupe` 删除同哈希副本并保留最早条目。
- 二十三套合计 **147 项通过**。

## 五、暂未落地

自动收集、语义检索、多包/会话绑定、WebUI 图库、云同步——见学习文档「暂不落地」一节。

## 六、变更文件

- `index.js`：哈希、魔数校验、去重、`/emotion dedupe`、版本号
- `README.md`：表情库说明补充去重/校验
- `CHANGELOG.md`：2.21.0 条目
- `test-emotion.mjs`：12 项
- `docs/LEARN-astrbot-meme-manager.md`、本报告
- `package.json`：`2.20.3` → `2.21.0`
