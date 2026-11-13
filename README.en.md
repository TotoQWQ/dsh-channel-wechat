# WeChat ClawBot (iLink) Channel · DeepSeek Harness Plugin

Connects a **DeepSeek Harness session** with **WeChat** (via Tencent's official ClawBot / "lobster" plugin) in **both directions**:
a message in WeChat becomes a user message in a DSH session, and the assistant's reply goes back to WeChat.
Multi-account, per-chat binding to any DSH session, and a dedicated panel in the Web GUI.

> No OpenClaw required. WeChat ClawBot speaks Tencent's **iLink Bot** protocol (HTTP/JSON), and this plugin implements it directly.

**English** | [中文](./README.md)

## Features

- **Bidirectional mirroring** — WeChat ↔ one DSH session. Incoming WeChat messages are injected into the session (visible live in the GUI); assistant replies are sent back to WeChat; messages you type in the GUI are forwarded to WeChat with a `[网页]` prefix.
- **Multi-account** — several WeChat bots online at once, each with its own long-poll loop, cursor and error state. Re-scan or disconnect one account without touching the others.
- **Binding panel** — sidebar item「微信」: accounts (status / last error / re-scan / disconnect), QR login area (QR image + numeric pairing code), and a binding table (chat → session dropdown that binds immediately, unbind, open the session). A「默认接收会话」picker at the top chooses which session future WeChat chats land in, with a one-click "new session and use as default".
- **File sending** — a local image / video / any attachment is AES-128-ECB encrypted, uploaded to the WeChat CDN, then sent as `image_item` / `video_item` / `file_item` (50 MB limit).
- **Quoted messages** — when you long-press and quote one of the bot's messages in WeChat (including quoting only a selected fragment), the quoted text enters the model context as `【引用】…`. A local quote store keeps the last 800 sent/received messages (`quotes.json`), so a bare `svr_id` can still be resolved and sliced by `startindex/endindex`.
- **Agent tools** — `wechat_login`, `wechat_verify_code`, `wechat_status`, `wechat_bind`, `wechat_unbind`, `wechat_send`, `wechat_send_file`, `wechat_logout`, `wechat_simulate`, `wechat_debug`.

## Install

Requirements: DSH desktop (plugins live in a profile) + the official WeChat ClawBot plugin enabled on your phone.

### Option 1 — single-file installer (recommended)

`install.mjs` contains everything: it downloads the plugin files from this repository into `<DSH_HOME>/plugins/dsh-channel-wechat`, links the package into your profile with `dsh plugin add`, registers the bundle, and appends the plugin row to the profile's `cordis.patch.yml`. Idempotent, keeps `.bak` backups.

```bash
# from the repository root
node install.mjs

# pick a profile / target, or preview without touching anything
node install.mjs --profile web
node install.mjs --dry-run
```

You can also hand `install.mjs` to any DSH session's agent and ask it to install the plugin — the file is self-describing.

### Option 2 — DSH plugin manager

```text
plugin_manager: install_bundle  target=<absolute path to this directory>
```

After installing:

1. Restart the DSH desktop app (the client-module manifest is scanned at startup), then reload the page.
2. A「微信」(WeChat) icon appears in the sidebar — open it and click「新增账号」(add account).
3. Scan the QR code with mobile WeChat (you may also need to enter the numeric pairing code shown on the phone).
4. Send one message to the bot from WeChat; a row appears in the binding table.
5. Pick a DSH session and click「绑定」(bind) — from then on both sides are the same conversation.

## Protocol (iLink Bot)

| Purpose | Endpoint |
| --- | --- |
| QR login | `POST /ilink/bot/get_bot_qrcode?bot_type=3` |
| Poll login status | `GET /ilink/bot/get_qrcode_status?qrcode=…&verify_code=…` |
| Long-poll messages | `POST /ilink/bot/getupdates` (`get_updates_buf` cursor, server holds ~35 s) |
| Send message | `POST /ilink/bot/sendmessage` (must echo the inbound `context_token`) |
| Typing indicator | `POST /ilink/bot/getconfig` + `POST /ilink/bot/sendtyping` (unused here) |

Every request carries `iLink-App-Id`, `iLink-App-ClientVersion`, `AuthorizationType: ilink_bot_token` and `X-WECHAT-UIN` (random uint32 → decimal string → base64); every body carries `base_info`.

Protocol details were cross-checked against Tencent's official package [`@tencent-weixin/openclaw-weixin`](https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin) (MIT) and the community write-up [`weixin-ClawBot-API`](https://github.com/sintrb/weixin-ClawBot-API). This repository contains no Tencent code.

## Configuration

Override the `config` of the `channel-wechat` row in your DSH profile's `cordis.patch.yml`:

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch |
| `allowFrom` | `[]` | Allow-list of WeChat user ids (`xxxx@im.wechat`); empty = everyone |
| `cwd` | `''` | Working directory for auto-created sessions; empty = DSH default |
| `agentPreset` | `''` | Agent preset for those sessions |
| `replyTimeoutMs` | `180000` | Max wait for one agent turn |
| `maxReplyChars` | `1800` | Max characters per WeChat message; longer replies are split |
| `messagePrefix` | `''` | Prefix added to inbound WeChat text when injected |
| `webMessagePrefix` | `'[网页] '` | Prefix for GUI messages forwarded to WeChat |
| `mirrorUserMessages` | `true` | Forward GUI user messages to WeChat |
| `mirrorAssistantMessages` | `true` | Mirror assistant replies to WeChat |
| `mirrorIntervalMs` | `1200` | Mirror scan interval |
| `apiBase` | `https://ilinkai.weixin.qq.com` | iLink base URL |

State and credentials live in `~/.dsh/wechat-bridge/state.json` (mode 0600); the log is `bridge.log` in the same directory.

## HTTP endpoints (same-origin, used by the panel)

`/wechat-channel/status`, `/sessions`, `/qr.png`, `/login`, `/logout`, `/verify`, `/bind`, `/unbind`.
Loopback only.

## Known limits

- Inbound: text is passed through; images / files / video are downloaded from the CDN, AES-128-ECB decrypted and saved under `~/.dsh/wechat-bridge/inbound/`, with the path included in the message text (the model can `read_image` it). Voice only contributes Tencent's speech-to-text transcript (no silk transcoding).
- Group chats map per `group_id`; replies go to the sender and `@` mentions are not handled.
- A WeChat account's ClawBot can be bound to a single gateway instance; binding it elsewhere returns `binded_redirect`.
- A stale token (errcode `-14`) stops that account's poll loop and requires a new QR scan.
- WeChat QR codes expire in about 2 minutes and are auto-refreshed at most 3 times.
- Bidirectional mirroring means everything in a bound session is sent to WeChat — mind your privacy.

## Troubleshooting

### WeChat receives nothing (log shows `ret=-2 prepare failed`)

iLink's `sendmessage` reports business failures as **HTTP 200 with a non-zero `ret`**; `-2 prepare failed` usually means the send context (`context_token`) for that bot session expired or was invalidated (for example by a gateway restart).

What this plugin does:

- Any non-zero `ret` is raised as an error instead of being treated as success;
- On failure it retries once without `context_token`, which the official plugin also does;
- If that also fails, the text goes into a per-chat **outbox** (max 20 entries) with a 60 s backoff, and is flushed automatically on the **next inbound message from that user** (which carries a fresh token);
- The outbox length and the chat's `lastError` are visible in `bindings[]` from `/wechat-channel/status`.

So when WeChat suddenly goes quiet: have the user send one message to the bot; that refreshes the token and flushes the queue. If it still fails, the WeChat-side ClawBot binding is gone and the QR code must be scanned again.

### Panel feels laggy

The panel only polls `/wechat-channel/status` (every 3 s, paused while the tab is hidden, and it skips re-rendering when the payload is unchanged). `/sessions` is read on mount and on the refresh button only, so the session store is not scanned on a timer.

## License

MIT — see [LICENSE](./LICENSE); third-party components in [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md).
