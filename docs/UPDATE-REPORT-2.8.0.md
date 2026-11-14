# 2.8.0 更新报告（第二轮第 3 项：断联检测）

- 版本：`2.7.1` → `2.8.0`
- 日期：2026-11-14
- 目标：能确认微信通道是否断联，并在轮询卡住时自动恢复。

## 一、检测什么

每个账号的健康度由三项决定：

- 长轮询 monitor 是否在跑（`monitors` 运行时）；
- 最近一次成功轮询距今多久（`account.lastPollAt`）；
- 最近错误（`account.lastError`，比如 iLink 的 `ret/errcode` 或 token 失效）。

判定：**在跑 + 未超时 + 无错误** 才算健康；`lastPollAt` 缺失（从未成功）按异常处理。

## 二、能力

### 1. 微信内 `/ping`（`/health`）

```
✅ 微信连接正常
acct-a0be51 · 轮询中 · 最近轮询 3 秒前
镜像：运行中 · 绑定会话：1
```

异常时：

```
⚠️ 微信连接异常
acct-a0be51 · 轮询中 · 最近轮询 180 秒前 · 疑似断联
　错误：getupdates ret=-1 errcode=0
镜像：运行中 · 绑定会话：1
（长期卡住会自动重启该账号的轮询，仍不行就重扫码）
```

### 2. 后台自动恢复

- 每 30 秒跑一次 `healthTick`；
- 长轮询超过 `healthStaleMs`（默认 120 秒，最短 30 秒）没有成功 → 重启该账号的 monitor（`stopMonitor → startMonitor`）；
- 同一账号至少间隔一个 `healthStaleMs` 才再次重启（`lastStaleRestartAt`），避免抖动；
- 记录 `staleRestarts` 到 `state.json`；`healthCheck: false` 可整体关闭自动重启（只保留 /ping 与面板显示）。

### 3. 面板

snapshot 增加：

```json
"health": {
  "ok": true,
  "staleAfterMs": 120000,
  "accounts": [{ "id": "acct-…", "running": true, "lastPollAt": 1794…, "lastPollAgoMs": 3000,
                 "stale": false, "lastError": "" }]
}
```

面板标题栏在镜像状态旁显示「连接正常（3 秒前轮询）/ 连接异常」。

## 三、验证

`test-health.mjs` 5 项：

- `evaluateAccountHealth` 纯函数：新鲜、超时、未运行、从未轮询；
- 未启动时 `/ping` 回「⚠️ 微信连接异常」；
- 启动后轮询成功，`/ping` 回「✅ 微信连接正常」并含「轮询中 / 镜像：运行中」；
- 模拟轮询卡住：`healthTick(now+10s)` 重启 monitor、`staleRestarts=1`，同一窗口内再次调用不重复重启；
- `healthCheck=false` 时不做自动重启。

十三套合计 **91 项通过**。

## 四、限制

- `/ping` 走的是本地状态，不额外发 iLink 请求（避免消耗游标/触发限流）；真正的网络可达性体现在 `lastPollAt` 的推进。
- 如果账号 token 失效（`-14`），monitor 本身会停掉并提示重扫码，`/ping` 会显示「未运行 + token 失效」。
- 自动重启只恢复进程内轮询；微信侧被顶下线（`binded_redirect`）仍需要重扫码。

## 五、变更文件

- `index.js`：`evaluateAccountHealth`、`accountHealth` / `healthSummary` / `staleAccountIds` / `healthTick` / 定时器、`/ping` 命令、snapshot `health`、版本号
- `client.js`：标题栏连接状态
- `cordis.patch.yml`：`healthStaleMs` / `healthCheck`
- `README.md`：功能、命令表、配置
- `CHANGELOG.md`：2.8.0 条目
- `test-health.mjs`：新增 5 项
- `package.json`：`2.7.1` → `2.8.0`
