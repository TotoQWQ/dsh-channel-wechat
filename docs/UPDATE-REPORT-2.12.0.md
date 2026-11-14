# 2.12.0 更新报告（第二轮第 5 项：建议入口 → GitHub issue）

- 版本：`2.11.1` → `2.12.0`
- 日期：2026-11-14
- 目标：微信用户可以直接提需求，由插件打开 GitHub issue 提交。

## 一、用法

```
/suggest 增加语音输入支持
希望支持方言和粤语
```

- 标题：取内容首行（最多 80 字），没有内容时用「来自微信的功能建议」；
- 正文：完整内容 + 来源信息（chat / account / 插件版本 / 时间）；
- 成功后微信收到：`✅ 建议已提交：https://github.com/<owner>/<repo>/issues/<n>`；
- 失败：`⚠️ 提交失败：GitHub 返回 403 …`（含 token 未配置、仓库不对、网络错误等）；
- 同一聊天有冷却（`suggestCooldownMs`，默认 60 秒），冷却内回复「刚提交过建议，N 秒后再试」。

## 二、配置

| 键 | 默认 | 说明 |
|---|---|---|
| `suggestRepo` | `TotoQWQ/dsh-channel-wechat` | issue 提交到哪个仓库 |
| `suggestToken` | `''` | GitHub token；留空读环境变量 `GH_TOKEN` / `GITHUB_TOKEN` |
| `suggestLabels` | `['suggestion','from-wechat']` | 新 issue 的标签 |
| `suggestCooldownMs` | `60000` | 同聊天提交冷却（最短 10 秒） |
| `githubApiBase` | `https://api.github.com` | API 地址（测试/企业版可改） |

安全注意：

- token 只从配置或环境变量读取，**不会写入日志/state**；
- issue 正文会带上 chat id 与账号 id（方便宿主定位是哪个微信用户提的）；如果介意，可以自行改 body 模板。

## 三、验证

`test-suggest.mjs` 5 项（本地 mock GitHub API）：

- 成功提交：请求体标题、正文（含 chat id）、标签、`Authorization: Bearer …` 都正确，回复含 issue 链接；
- 冷却时间内不重复提交（不产生新请求）；
- 没配 token 时提示如何配置、不发请求；
- GitHub 返回 403 时回显状态码；
- `/suggest` 无参数时显示用法。

十七套合计 **113 项通过**。

## 四、限制

- 需要宿主提供有 `repo:issues` 写权限的 GitHub token；没有 token 时只会提示。
- 每个聊天 60 秒一条，避免刷屏；同一内容不会去重（GitHub 侧可加 label 过滤）。
- issue 里带的 chat id 属于隐私信息，如果不希望公开，建议把 `suggestRepo` 指到私有仓库。

## 五、变更文件

- `index.js`：`createSuggestion`、`/suggest` 命令、`SUGGEST_HELP_TEXT`、配置、版本号
- `cordis.patch.yml`：`suggestRepo` / `suggestToken` / `suggestLabels` / `suggestCooldownMs` / `githubApiBase`
- `README.md`：功能、命令表、配置
- `CHANGELOG.md`：2.12.0 条目
- `test-suggest.mjs`：新增 5 项
- `package.json`：`2.11.1` → `2.12.0`
