/**
 * dsh-channel-wechat — 把 DSH 会话接到微信「ClawBot / 龙虾」插件（腾讯 iLink 协议）。
 *
 * v2：多账号 + 双向镜像
 *   - 每个微信账号（bot）一条独立长轮询；
 *   - 微信 chat ↔ 指定 DSH 会话「绑定」后：
 *       微信消息 → 注入该会话（在 Web GUI 里作为用户消息出现）
 *       微信里发的 / 网页里发的 → 助手回复都会回到微信
 *       网页里输入的用户消息也会转发到微信（[网页] 前缀，可关）
 *
 * 协议实现参考腾讯官方 npm 包 @tencent-weixin/openclaw-weixin（MIT）：
 *   POST /ilink/bot/getupdates     长轮询收消息（get_updates_buf 游标）
 *   POST /ilink/bot/sendmessage    发消息（必须回填 inbound 的 context_token）
 *   POST /ilink/bot/get_bot_qrcode 扫码登录（bot_type=3）
 *   GET  /ilink/bot/get_qrcode_status
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

import qrcode from './vendor/qrcode.mjs'

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const DEFAULT_API_BASE = 'https://ilinkai.weixin.qq.com'
const ILINK_APP_ID = 'bot'
/** 0x000MMNNPP：与官方 2.4.10 对齐 */
const ILINK_APP_CLIENT_VERSION = (2 << 16) | (4 << 8) | 10
const CHANNEL_VERSION = '2.0.0'
const BOT_AGENT = 'DSH-WeChat/2.0'
/** 媒体 CDN（官方 getUploadUrl 没返回 upload_full_url 时用它拼上传地址） */
const CDN_BASE = 'https://novac2c.cdn.weixin.qq.com/c2c'

const LONG_POLL_MS = 35_000
const API_TIMEOUT_MS = 15_000
const LOGIN_TTL_MS = 5 * 60_000
const MAX_QR_REFRESH = 3

const MESSAGE_TYPE_USER = 1
const MESSAGE_TYPE_BOT = 2
const MESSAGE_STATE_FINISH = 2
const ITEM_TEXT = 1
const STALE_TOKEN_ERRCODE = -14

const STATE_VERSION = 2

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

const sleep = (ms, signal) =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const t = setTimeout(done, ms)
    function done() {
      clearTimeout(t)
      signal?.removeEventListener?.('abort', done)
      resolve()
    }
    signal?.addEventListener?.('abort', done, { once: true })
  })

const nowIso = () => new Date().toISOString()
const uid = (prefix) => `${prefix}-${crypto.randomBytes(8).toString('hex')}`
const hashId = (input) => crypto.createHash('sha1').update(String(input)).digest('hex').slice(0, 10)

/** X-WECHAT-UIN：随机 uint32 → 十进制字符串 → base64 */
function randomWechatUin() {
  const n = crypto.randomBytes(4).readUInt32BE(0)
  return Buffer.from(String(n), 'utf8').toString('base64')
}

// ---------------------------------------------------------------------------
// PNG（把二维码渲染成图片，零依赖）
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([length, typeBuf, data, crc])
}

/** 生成二维码 PNG（8bit RGB，无依赖）。 */
function qrPng(text, { scale = 8, margin = 4 } = {}) {
  const qr = qrcode(0, 'M')
  qr.addData(text)
  qr.make()
  const count = qr.getModuleCount()
  const size = (count + margin * 2) * scale
  const stride = size * 3 + 1
  const raw = Buffer.alloc(size * stride)
  let p = 0
  for (let y = 0; y < size; y += 1) {
    raw[p] = 0
    p += 1
    const my = Math.floor(y / scale) - margin
    for (let x = 0; x < size; x += 1) {
      const mx = Math.floor(x / scale) - margin
      const dark = mx >= 0 && my >= 0 && mx < count && my < count && qr.isDark(my, mx)
      const v = dark ? 0x00 : 0xff
      raw[p] = v
      raw[p + 1] = v
      raw[p + 2] = v
      p += 3
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

function normalizeConfig(raw) {
  const c = raw && typeof raw === 'object' ? raw : {}
  const stateDir =
    typeof c.stateDir === 'string' && c.stateDir.trim()
      ? c.stateDir.trim()
      : path.join(os.homedir(), '.dsh', 'wechat-bridge')
  return {
    enabled: c.enabled !== false,
    allowFrom: Array.isArray(c.allowFrom) ? c.allowFrom.map((v) => String(v).trim()).filter(Boolean) : [],
    cwd: typeof c.cwd === 'string' && c.cwd.trim() ? c.cwd.trim() : '',
    agentPreset: typeof c.agentPreset === 'string' && c.agentPreset.trim() ? c.agentPreset.trim() : '',
    replyTimeoutMs: Number.isFinite(c.replyTimeoutMs) && c.replyTimeoutMs >= 5000 ? c.replyTimeoutMs : 180_000,
    maxReplyChars: Number.isFinite(c.maxReplyChars) && c.maxReplyChars >= 200 ? c.maxReplyChars : 1800,
    apiBase: typeof c.apiBase === 'string' && c.apiBase.trim() ? c.apiBase.trim().replace(/\/+$/, '') : DEFAULT_API_BASE,
    messagePrefix: typeof c.messagePrefix === 'string' ? c.messagePrefix : '',
    webMessagePrefix: typeof c.webMessagePrefix === 'string' ? c.webMessagePrefix : '[网页] ',
    mirrorUserMessages: c.mirrorUserMessages !== false,
    mirrorAssistantMessages: c.mirrorAssistantMessages !== false,
    mirrorIntervalMs: Number.isFinite(c.mirrorIntervalMs) && c.mirrorIntervalMs >= 300 ? c.mirrorIntervalMs : 1200,
    stateDir,
  }
}

// ---------------------------------------------------------------------------
// 通道实现
// ---------------------------------------------------------------------------

function createChannel(ctx, config) {
  const stateFile = path.join(config.stateDir, 'state.json')
  const logFile = path.join(config.stateDir, 'bridge.log')
  const qrFile = path.join(config.stateDir, 'login-qr.png')

  /** @type {{version:number, accounts:Record<string,any>, bindings:Record<string,any>}} */
  let state = {
    version: STATE_VERSION,
    accounts: {},
    bindings: {},
    settings: { defaultSessionId: '' },
  }

  const login = {
    status: 'idle', // idle | waiting | scaned | need_verifycode | confirmed | expired | error | unsupported
    qrcode: '',
    qrUrl: '',
    startedAt: 0,
    pendingCode: '',
    refreshCount: 0,
    error: '',
    replacingAccountId: '',
    abort: null,
  }

  /** @type {Map<string, {abort:AbortController|null, running:boolean}>} */
  const monitors = new Map()
  const chatQueues = new Map()

  let mirrorTimer = null
  let mirrorBusy = false
  let saveTimer = null

  // -- 日志 ----------------------------------------------------------------

  function log(level, message, extra) {
    const line = `${nowIso()} [${level}] ${message}${extra ? ` ${JSON.stringify(extra)}` : ''}`
    try {
      fs.mkdirSync(config.stateDir, { recursive: true })
      fs.appendFileSync(logFile, `${line}\n`, 'utf8')
      if (fs.statSync(logFile).size > 512 * 1024) fs.writeFileSync(logFile, '', 'utf8')
    } catch {
      /* ignore */
    }
    try {
      if (level === 'error') ctx.logger?.error?.(`[wechat] ${message}`)
      else ctx.logger?.info?.(`[wechat] ${message}`)
    } catch {
      /* ignore */
    }
  }

  // -- 状态持久化 ----------------------------------------------------------

  function loadState() {
    let parsed = null
    try {
      parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    } catch {
      return
    }
    if (!parsed || typeof parsed !== 'object') return
    if (parsed.version === STATE_VERSION && parsed.accounts) {
      state = {
        version: STATE_VERSION,
        accounts: parsed.accounts && typeof parsed.accounts === 'object' ? parsed.accounts : {},
        bindings: parsed.bindings && typeof parsed.bindings === 'object' ? parsed.bindings : {},
        settings:
          parsed.settings && typeof parsed.settings === 'object'
            ? { defaultSessionId: String(parsed.settings.defaultSessionId ?? '') }
            : { defaultSessionId: '' },
      }
      return
    }
    // v1 → v2 迁移：单账号 + 每聊天独立会话
    if (parsed.botToken) {
      const id = parsed.botId || `acct-${hashId(parsed.botToken)}`
      const bindings = {}
      for (const [chatId, entry] of Object.entries(parsed.chats ?? {})) {
        if (!chatId) continue
        const key = `${id}::${chatId}`
        bindings[key] = {
          key,
          accountId: id,
          chatId,
          toUserId: entry?.toUserId ?? (chatId.startsWith('user:') ? chatId.slice(5) : ''),
          sessionId: entry?.sessionId || `wx-${hashId(key)}`,
          explicit: true,
          contextToken: entry?.contextToken ?? '',
          lastSeq: 0,
          lastInboundAt: entry?.lastAt ?? null,
          lastOutboundAt: null,
        }
      }
      state = {
        version: STATE_VERSION,
        accounts: {
          [id]: {
            id,
            name: parsed.botId || '默认账号',
            botId: parsed.botId || '',
            botToken: parsed.botToken,
            apiBase: parsed.apiBase || '',
            userId: parsed.userId || '',
            syncBuf: parsed.syncBuf || '',
            createdAt: Date.now(),
            lastPollAt: null,
            lastError: '',
          },
        },
        bindings,
        settings: { defaultSessionId: String(parsed.settings?.defaultSessionId ?? '') },
      }
      log('info', 'migrated v1 state to v2', { accountId: id, bindings: Object.keys(bindings).length })
      saveState(true)
    }
  }

  function saveState(immediate = false) {
    const write = () => {
      saveTimer = null
      try {
        fs.mkdirSync(config.stateDir, { recursive: true })
        fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 })
      } catch (err) {
        log('error', 'saveState failed', { error: String(err) })
      }
    }
    if (immediate) {
      if (saveTimer) clearTimeout(saveTimer)
      write()
      return
    }
    if (saveTimer) return
    saveTimer = setTimeout(write, 400)
  }

  const apiBaseOf = (account) => account?.apiBase || config.apiBase

  // -- iLink HTTP ----------------------------------------------------------

  function baseInfo() {
    return { channel_version: CHANNEL_VERSION, bot_agent: BOT_AGENT }
  }

  function requestHeaders(token) {
    const headers = {
      'Content-Type': 'application/json',
      AuthorizationType: 'ilink_bot_token',
      'X-WECHAT-UIN': randomWechatUin(),
      'iLink-App-Id': ILINK_APP_ID,
      'iLink-App-ClientVersion': String(ILINK_APP_CLIENT_VERSION),
    }
    if (token) headers.Authorization = `Bearer ${token}`
    return headers
  }

  async function apiPost(base, endpoint, body, token, { timeoutMs = API_TIMEOUT_MS, signal } = {}) {
    const url = `${base.replace(/\/+$/, '')}/${endpoint.replace(/^\/+/, '')}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const onAbort = () => controller.abort()
    signal?.addEventListener?.('abort', onAbort, { once: true })
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: requestHeaders(token),
        body: JSON.stringify({ ...body, base_info: baseInfo() }),
        signal: controller.signal,
      })
      const text = await res.text()
      if (!res.ok) throw new Error(`HTTP ${res.status} ${endpoint}: ${text.slice(0, 300)}`)
      return text
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
    }
  }

  async function apiGet(base, endpoint, { timeoutMs = API_TIMEOUT_MS, signal } = {}) {
    const url = `${base.replace(/\/+$/, '')}/${endpoint.replace(/^\/+/, '')}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const onAbort = () => controller.abort()
    signal?.addEventListener?.('abort', onAbort, { once: true })
    try {
      const headers = requestHeaders('')
      delete headers['Content-Type']
      const res = await fetch(url, { method: 'GET', headers, signal: controller.signal })
      const text = await res.text()
      if (!res.ok) throw new Error(`HTTP ${res.status} ${endpoint}: ${text.slice(0, 300)}`)
      return text
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
    }
  }

  // -- 账号 ----------------------------------------------------------------

  function accounts() {
    return Object.values(state.accounts)
  }

  function accountRuntime(accountId) {
    const runtime = monitors.get(accountId)
    return {
      running: Boolean(runtime?.running),
      lastPollAt: state.accounts[accountId]?.lastPollAt ?? null,
      lastError: state.accounts[accountId]?.lastError ?? '',
    }
  }

  function addAccount({ botToken, botId, apiBase, userId, name }) {
    const id = botId ? `acct-${hashId(botId)}` : `acct-${crypto.randomBytes(4).toString('hex')}`
    state.accounts[id] = {
      id,
      name: name || botId || '微信账号',
      botId: botId || '',
      botToken,
      apiBase: apiBase || '',
      userId: userId || '',
      syncBuf: '',
      createdAt: Date.now(),
      lastPollAt: null,
      lastError: '',
    }
    saveState(true)
    startMonitor(id)
    return id
  }

  function removeAccount(accountId) {
    stopMonitor(accountId)
    delete state.accounts[accountId]
    for (const [key, binding] of Object.entries(state.bindings)) {
      if (binding.accountId === accountId) delete state.bindings[key]
    }
    saveState(true)
    log('info', 'account removed', { accountId })
    return { ok: true }
  }

  // -- 登录（一次一个待确认账号） ------------------------------------------

  function writeQrImage(url) {
    try {
      fs.mkdirSync(config.stateDir, { recursive: true })
      fs.writeFileSync(qrFile, qrPng(url))
      return qrFile
    } catch (err) {
      log('error', 'writeQrImage failed', { error: String(err) })
      return ''
    }
  }

  async function fetchQrCode() {
    const text = await apiPost(
      config.apiBase,
      'ilink/bot/get_bot_qrcode?bot_type=3',
      { local_token_list: accounts().map((a) => a.botToken).filter(Boolean) },
      undefined,
      { timeoutMs: API_TIMEOUT_MS },
    )
    const parsed = JSON.parse(text)
    if (!parsed?.qrcode || !parsed?.qrcode_img_content) {
      throw new Error(`get_bot_qrcode 返回异常: ${text.slice(0, 300)}`)
    }
    return { qrcode: String(parsed.qrcode), qrUrl: String(parsed.qrcode_img_content) }
  }

  async function startLogin(force = false, replacingAccountId = '') {
    login.abort?.abort()
    login.abort = new AbortController()
    login.status = 'waiting'
    login.error = ''
    login.pendingCode = ''
    login.refreshCount = 0
    login.startedAt = Date.now()
    login.replacingAccountId = replacingAccountId || ''
    try {
      const { qrcode: code, qrUrl } = await fetchQrCode()
      login.qrcode = code
      login.qrUrl = qrUrl
      writeQrImage(qrUrl)
      log('info', 'login qr ready', { replacingAccountId: login.replacingAccountId })
      void pollLogin(login.abort.signal)
      return { status: 'waiting', qrUrl, qrImagePath: qrFile, message: '用手机微信扫码（约 2 分钟有效）。' }
    } catch (err) {
      login.status = 'error'
      login.error = String(err?.message ?? err)
      log('error', 'startLogin failed', { error: login.error })
      return { status: 'error', message: login.error }
    }
  }

  async function refreshLoginQr(signal) {
    login.refreshCount += 1
    if (login.refreshCount > MAX_QR_REFRESH) {
      login.status = 'expired'
      login.error = '二维码多次失效'
      return false
    }
    try {
      const { qrcode: code, qrUrl } = await fetchQrCode()
      login.qrcode = code
      login.qrUrl = qrUrl
      login.startedAt = Date.now()
      writeQrImage(qrUrl)
      return true
    } catch (err) {
      login.status = 'error'
      login.error = String(err?.message ?? err)
      return false
    }
  }

  async function pollLogin(signal) {
    let host = config.apiBase
    while (!signal.aborted) {
      if (!login.qrcode) return
      if (Date.now() - login.startedAt > LOGIN_TTL_MS && login.status !== 'scaned') {
        if (!(await refreshLoginQr(signal))) return
        continue
      }
      let parsed
      try {
        let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(login.qrcode)}`
        if (login.pendingCode) endpoint += `&verify_code=${encodeURIComponent(login.pendingCode)}`
        parsed = JSON.parse(await apiGet(host, endpoint, { timeoutMs: LONG_POLL_MS, signal }))
      } catch (err) {
        if (signal.aborted) return
        log('warn', 'pollLogin error', { error: String(err?.message ?? err) })
        await sleep(1500, signal)
        continue
      }
      const status = String(parsed?.status ?? 'wait')
      if (status === 'wait') login.status = 'waiting'
      else if (status === 'scaned') {
        login.status = 'scaned'
        login.pendingCode = ''
      } else if (status === 'need_verifycode') login.status = 'need_verifycode'
      else if (status === 'scaned_but_redirect') {
        if (parsed?.redirect_host) host = `https://${parsed.redirect_host}`
      } else if (status === 'binded_redirect') {
        login.status = 'unsupported'
        login.error = '这个微信号已经绑定过其它网关实例。'
        return
      } else if (status === 'expired') {
        if (!(await refreshLoginQr(signal))) return
      } else if (status === 'verify_code_blocked') {
        login.status = 'need_verifycode'
        login.pendingCode = ''
        if (!(await refreshLoginQr(signal))) return
      } else if (status === 'confirmed') {
        const token = String(parsed?.bot_token ?? '')
        const botId = String(parsed?.ilink_bot_id ?? '')
        if (!token || !botId) {
          login.status = 'error'
          login.error = '确认成功但服务器未返回 bot_token / ilink_bot_id'
          return
        }
        const replacing = login.replacingAccountId
        if (replacing && state.accounts[replacing]) {
          const account = state.accounts[replacing]
          account.botToken = token
          account.botId = botId || account.botId
          account.apiBase = String(parsed?.baseurl ?? '') || account.apiBase
          account.userId = String(parsed?.ilink_user_id ?? '') || account.userId
          account.lastError = ''
          saveState(true)
          startMonitor(replacing)
          log('info', 'account re-logged in', { accountId: replacing })
        } else {
          const id = addAccount({
            botToken: token,
            botId,
            apiBase: String(parsed?.baseurl ?? ''),
            userId: String(parsed?.ilink_user_id ?? ''),
            name: String(parsed?.ilink_user_id ?? '').split('@')[0] || botId,
          })
          log('info', 'account added', { accountId: id, botId })
        }
        login.status = 'confirmed'
        login.error = ''
        login.replacingAccountId = ''
        return
      }
      await sleep(1000, signal)
    }
  }

  function submitVerifyCode(code) {
    const value = String(code ?? '').trim()
    if (!value) return { ok: false, message: '验证码为空' }
    login.pendingCode = value
    return { ok: true, message: '已提交，等待确认。' }
  }

  // -- 收消息（每账号一条长轮询） ------------------------------------------

  function startMonitor(accountId) {
    const account = state.accounts[accountId]
    if (!account?.botToken) return
    if (monitors.get(accountId)?.running) return
    const abort = new AbortController()
    monitors.set(accountId, { abort, running: true })
    log('info', 'monitor started', { accountId })
    void monitorLoop(accountId, abort.signal)
  }

  function stopMonitor(accountId) {
    const runtime = monitors.get(accountId)
    if (runtime) {
      runtime.abort?.abort()
      monitors.delete(accountId)
    }
  }

  async function monitorLoop(accountId, signal) {
    let timeoutMs = LONG_POLL_MS
    let failures = 0
    const account = () => state.accounts[accountId]
    while (!signal.aborted) {
      const acc = account()
      if (!acc?.botToken) break
      try {
        const text = await apiPost(
          apiBaseOf(acc),
          'ilink/bot/getupdates',
          { get_updates_buf: acc.syncBuf ?? '' },
          acc.botToken,
          { timeoutMs: timeoutMs + 5_000, signal },
        )
        const resp = JSON.parse(text)
        if (Number(resp?.longpolling_timeout_ms) > 0) timeoutMs = Number(resp.longpolling_timeout_ms)
        const ret = Number(resp?.ret ?? 0)
        const errcode = Number(resp?.errcode ?? 0)
        if (ret !== 0 || errcode !== 0) {
          acc.lastError = `getupdates ret=${ret} errcode=${errcode} ${String(resp?.errmsg ?? '')}`
          if (errcode === STALE_TOKEN_ERRCODE || ret === STALE_TOKEN_ERRCODE) {
            acc.lastError = 'token 失效（-14），请重新扫码'
            stopMonitor(accountId)
            saveState()
            return
          }
          failures += 1
          await sleep(failures >= 3 ? 30_000 : 2_000, signal)
          if (failures >= 3) failures = 0
          continue
        }
        failures = 0
        acc.lastError = ''
        acc.lastPollAt = Date.now()
        if (typeof resp?.get_updates_buf === 'string' && resp.get_updates_buf) {
          acc.syncBuf = resp.get_updates_buf
          saveState()
        }
        for (const msg of resp?.msgs ?? []) {
          if (signal.aborted) return
          void handleInbound(accountId, msg)
        }
      } catch (err) {
        if (signal.aborted) return
        failures += 1
        const acc2 = account()
        if (acc2) acc2.lastError = String(err?.message ?? err)
        log('warn', 'monitor loop error', { accountId, error: String(err?.message ?? err) })
        await sleep(failures >= 3 ? 30_000 : 2_000, signal)
        if (failures >= 3) failures = 0
      }
    }
  }

  // -- 消息解析 ------------------------------------------------------------

  function decryptAesEcb(ciphertext, key) {
    const decipher = crypto.createDecipheriv('aes-128-ecb', key, null)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()])
  }

  /** CDNMedia.aes_key 有两种编码：base64(16 原始字节) 或 base64(32 字符 hex)。 */
  function parseAesKeyBase64(aesKeyBase64) {
    const decoded = Buffer.from(aesKeyBase64, 'base64')
    if (decoded.length === 16) return decoded
    if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString('ascii'))) {
      return Buffer.from(decoded.toString('ascii'), 'hex')
    }
    throw new Error(`aes_key 无法解析（${decoded.length} 字节）`)
  }

  function sniffImageExt(buf) {
    if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50) return 'png'
    if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return 'jpg'
    if (buf.length > 6 && buf.toString('ascii', 0, 3) === 'GIF') return 'gif'
    if (buf.length > 12 && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp'
    return 'bin'
  }

  /** 下载并解密一条入站媒体（图片/文件/视频），落盘返回路径。 */
  async function downloadInboundMedia(item) {
    const type = Number(item?.type ?? 0)
    const payload =
      type === 2 ? item.image_item : type === 4 ? item.file_item : type === 5 ? item.video_item : null
    if (!payload) return null
    const media = payload.media ?? {}
    const eqp = media.encrypt_query_param
    const fullUrl = media.full_url
    if (!eqp && !fullUrl) return null
    const aesKeyBase64 = payload.aeskey
      ? Buffer.from(String(payload.aeskey), 'hex').toString('base64')
      : media.aes_key
    const url = fullUrl || `${CDN_BASE}/download?encrypted_query_param=${encodeURIComponent(eqp)}`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`CDN 下载失败 ${res.status}`)
    const encrypted = Buffer.from(await res.arrayBuffer())
    const plain = aesKeyBase64 ? decryptAesEcb(encrypted, parseAesKeyBase64(aesKeyBase64)) : encrypted
    const dir = path.join(config.stateDir, 'inbound')
    fs.mkdirSync(dir, { recursive: true })
    const ext =
      type === 2
        ? sniffImageExt(plain)
        : path.extname(String(payload.file_name ?? '')).replace(/^\./, '') || 'bin'
    const file = path.join(dir, `wx-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.${ext}`)
    fs.writeFileSync(file, plain)
    return { file, bytes: plain.length, kind: type }
  }

  async function describeInbound(msg) {
    const items = Array.isArray(msg?.item_list) ? msg.item_list : []
    const parts = []
    for (const item of items) {
      const type = Number(item?.type ?? 0)
      if (type === ITEM_TEXT) {
        if (item?.text_item?.text) parts.push(String(item.text_item.text))
      } else if (type === 3) {
        const asr = item?.voice_item?.text
        parts.push(asr ? `[语音] ${String(asr)}` : '[语音消息（无转写）]')
      } else if (type === 2 || type === 4 || type === 5) {
        const label = type === 2 ? '图片' : type === 4 ? `文件 ${item?.file_item?.file_name ?? ''}` : '视频'
        try {
          const saved = await downloadInboundMedia(item)
          if (saved) {
            log('info', 'inbound media saved', { type, file: saved.file, bytes: saved.bytes })
          }
          parts.push(
            saved
              ? `[${label}] 已解密保存到 ${saved.file}（${saved.bytes} 字节）。需要看图就用 read_image 打开这个路径。`
              : `[${label}]（没有可下载的媒体引用）`,
          )
        } catch (err) {
          const message = String(err?.message ?? err)
          const payload = type === 2 ? item.image_item : type === 4 ? item.file_item : item.video_item
          log('warn', 'inbound media failed', {
            type,
            error: message,
            hasAeskey: Boolean(payload?.aeskey),
            hasMediaKey: Boolean(payload?.media?.aes_key),
            hasFullUrl: Boolean(payload?.media?.full_url),
            eqpLen: String(payload?.media?.encrypt_query_param ?? '').length,
          })
          parts.push(`[${label}] 下载/解密失败：${message}`)
        }
      }
    }
    return parts.join('\n').trim()
  }

  function chatIdOf(msg) {
    const groupId = msg?.group_id ? String(msg.group_id) : ''
    if (groupId) return `group:${groupId}`
    return `user:${String(msg?.from_user_id ?? 'unknown')}`
  }

  const bindingKeyOf = (accountId, chatId) => `${accountId}::${chatId}`

  function ensureBinding(accountId, chatId, toUserId, contextToken) {
    const key = bindingKeyOf(accountId, chatId)
    let binding = state.bindings[key]
    if (!binding) {
      const fallback = state.settings?.defaultSessionId || `wx-${hashId(key)}`
      binding = {
        key,
        accountId,
        chatId,
        toUserId: toUserId || '',
        sessionId: fallback,
        // 用了「默认接收会话」就算显式绑定，避免被当成自动会话
        explicit: Boolean(state.settings?.defaultSessionId),
        contextToken: '',
        lastSeq: 0,
        lastInboundAt: null,
        lastOutboundAt: null,
      }
      state.bindings[key] = binding
      log('info', 'binding created', { key, sessionId: binding.sessionId, byDefault: binding.explicit })
    }
    if (toUserId) binding.toUserId = toUserId
    if (contextToken) binding.contextToken = contextToken
    return binding
  }

  function bindSession(key, sessionId) {
    const binding = state.bindings[key]
    if (!binding) return { ok: false, message: '绑定不存在' }
    binding.sessionId = String(sessionId)
    binding.explicit = true
    binding.lastSeq = currentSeq(binding.sessionId)
    saveState(true)
    log('info', 'binding updated', { key, sessionId: binding.sessionId })
    return { ok: true, binding }
  }

  function unbindSession(key) {
    const binding = state.bindings[key]
    if (!binding) return { ok: false, message: '绑定不存在' }
    binding.sessionId = `wx-${hashId(key)}`
    binding.explicit = false
    binding.lastSeq = 0
    saveState(true)
    return { ok: true }
  }

  function enqueue(chatKey, task) {
    const prev = chatQueues.get(chatKey) ?? Promise.resolve()
    const next = prev.then(task, task)
    chatQueues.set(
      chatKey,
      next.catch(() => {}).then(() => {
        if (chatQueues.get(chatKey) === next) chatQueues.delete(chatKey)
      }),
    )
    return next
  }

  // -- DSH 侧 --------------------------------------------------------------

  function requireService(name) {
    const service = ctx.get(name)
    if (!service) throw new Error(`DSH 服务 ${name} 不可用`)
    return service
  }

  async function ensureSession(sessionId) {
    const sessions = ctx.get('sessions')
    if (sessions?.get?.(sessionId)) return 'live'
    const meta = config.cwd
      ? { cwd: config.cwd }
      : ctx.get('workingDirectory')?.defaultDirectory
        ? { cwd: ctx.get('workingDirectory').defaultDirectory }
        : {}
    const controller = ctx.get('sessionController')
    if (controller?.create) {
      try {
        await controller.create({
          sessionId,
          ...meta,
          ...(config.agentPreset ? { agentPreset: config.agentPreset } : {}),
        })
        return 'created'
      } catch (err) {
        const message = String(err?.message ?? err)
        if (!/exist|duplicate|already/i.test(message)) throw err
      }
    }
    const loop = requireService('agentLoop')
    try {
      await loop.create(sessionId, {}, meta)
      return 'created'
    } catch (err) {
      const message = String(err?.message ?? err)
      if (/exist|duplicate|already/i.test(message)) return 'resumed'
      throw err
    }
  }

  function currentSeq(sessionId) {
    const session = ctx.get('sessions')?.get?.(sessionId)
    const seq = session?.seq
    return typeof seq === 'number' ? seq : 0
  }

  async function promptSession(sessionId, text, signal) {
    const controller = requireService('sessionController')
    await controller.prompt(
      { requestId: uid('wx-req'), sessionId, mode: 'queue', content: [{ type: 'text', text }] },
      signal,
    )
  }

  function textOfMessage(message) {
    if (!message || typeof message !== 'object') return ''
    const blocks = Array.isArray(message.blocks)
      ? message.blocks
      : Array.isArray(message.content)
        ? message.content
        : []
    const out = []
    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue
      if (block.type === 'text' && typeof block.text === 'string') out.push(block.text)
    }
    return out.join('').trim()
  }

  function readEvents(sessionId, fromSeq) {
    const session = ctx.get('sessions')?.get?.(sessionId)
    if (!session) return null
    try {
      return session.snapshotEvents(fromSeq, session.seq) ?? []
    } catch {
      return []
    }
  }

  async function waitForReply(sessionId, baseline, signal, timeoutMs) {
    const deadline = Date.now() + (timeoutMs ?? config.replyTimeoutMs)
    let floor = baseline
    let sawPrompt = false
    let lastText = ''
    while (Date.now() < deadline && !signal?.aborted) {
      const events = readEvents(sessionId, baseline)
      if (events) {
        for (const event of events) {
          const seq = Number(event.seq ?? 0)
          if (event.type === 'user/message' && !sawPrompt) {
            const text = textOfMessage(event.data?.message ?? event.data)
            if (text) {
              sawPrompt = true
              floor = seq
            }
          }
          if (event.type === 'assistant/message') {
            const text = textOfMessage(event.data?.message)
            if (text) lastText = text
          }
          if (event.type === 'turn/end' && sawPrompt && seq > floor && lastText) return lastText
        }
      }
      await sleep(400, signal)
    }
    return lastText
  }

  // -- 发送 ----------------------------------------------------------------

  function splitText(text, limit) {
    const value = String(text ?? '')
    if (value.length <= limit) return value ? [value] : []
    const chunks = []
    let rest = value
    while (rest.length > limit) {
      let cut = rest.lastIndexOf('\n', limit)
      if (cut < limit * 0.5) cut = rest.lastIndexOf('。', limit)
      if (cut < limit * 0.5) cut = rest.lastIndexOf(' ', limit)
      if (cut < limit * 0.5) cut = limit
      chunks.push(rest.slice(0, cut).trim())
      rest = rest.slice(cut).trim()
    }
    if (rest) chunks.push(rest)
    return chunks.filter(Boolean)
  }

  function stripMarkdown(text) {
    let out = String(text ?? '')
    out = out.replace(/```[a-zA-Z0-9_-]*\n([\s\S]*?)```/g, (_, code) => code.replace(/\n$/, ''))
    out = out.replace(/`([^`]+)`/g, '$1')
    out = out.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '$1 $2')
    out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    out = out.replace(/^\s{0,3}#{1,6}\s+/gm, '')
    out = out.replace(/\*\*([^*]+)\*\*/g, '$1')
    out = out.replace(/__([^_]+)__/g, '$1')
    out = out.replace(/^\s*[-*+]\s+/gm, '· ')
    return out.trim()
  }

  async function sendToChat({ accountId, toUserId, contextToken, text }) {
    const account = state.accounts[accountId]
    if (!account?.botToken) throw new Error('账号未登录或已移除')
    const chunks = splitText(text, config.maxReplyChars)
    const results = []

    const postOnce = async (chunk, token) => {
      const body = {
        msg: {
          from_user_id: '',
          to_user_id: toUserId,
          client_id: uid('dsh-wechat'),
          message_type: MESSAGE_TYPE_BOT,
          message_state: MESSAGE_STATE_FINISH,
          item_list: [{ type: ITEM_TEXT, text_item: { text: chunk } }],
          ...(token ? { context_token: token } : {}),
        },
      }
      const resp = JSON.parse(await apiPost(apiBaseOf(account), 'ilink/bot/sendmessage', body, account.botToken))
      return { resp, ret: Number(resp?.ret ?? 0) }
    }

    for (const chunk of chunks) {
      // iLink 在 HTTP 200 里用 ret 表示业务失败（-2 prepare failed = context_token 失效等），
      // 不检查就会静默丢消息。带 token 失败时按官方插件的做法退回「不带 context_token」再试一次。
      let attempt = await postOnce(chunk, contextToken)
      let fallback = false
      if (attempt.ret !== 0 && contextToken) {
        fallback = true
        const retry = await postOnce(chunk, '')
        if (retry.ret !== 0) {
          throw new Error(
            `sendmessage 失败 ret=${attempt.ret} ${String(attempt.resp?.errmsg ?? '')}` +
              `；去掉 context_token 重试仍失败 ret=${retry.ret} ${String(retry.resp?.errmsg ?? '')}`,
          )
        }
        attempt = retry
      } else if (attempt.ret !== 0) {
        throw new Error(`sendmessage ret=${attempt.ret} ${String(attempt.resp?.errmsg ?? '')}`)
      }
      results.push({
        messageId: attempt.resp?.message_id ?? null,
        ret: attempt.ret,
        withoutContextToken: fallback,
      })
    }
    return { ok: true, chunks: results.length, results }
  }

  // -- 媒体（图片/文件/视频）：CDN 上传 + AES-128-ECB ----------------------

  function aesEcbPaddedSize(size) {
    return Math.ceil((size + 1) / 16) * 16
  }

  function encryptAesEcb(plaintext, key) {
    const cipher = crypto.createCipheriv('aes-128-ecb', key, null)
    return Buffer.concat([cipher.update(plaintext), cipher.final()])
  }

  function guessMediaKind(fileName) {
    const ext = String(fileName).toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? ''
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(ext)) return 'image'
    if (['mp4', 'mov', 'm4v', 'webm'].includes(ext)) return 'video'
    return 'file'
  }

  async function postMessage(account, msg) {
    const resp = JSON.parse(
      await apiPost(apiBaseOf(account), 'ilink/bot/sendmessage', { msg }, account.botToken),
    )
    const ret = Number(resp?.ret ?? 0)
    if (ret !== 0) throw new Error(`sendmessage ret=${ret} ${String(resp?.errmsg ?? '')}`)
    return resp
  }

  async function uploadToCdn({ account, toUserId, plaintext, mediaType }) {
    const rawsize = plaintext.length
    const rawfilemd5 = crypto.createHash('md5').update(plaintext).digest('hex')
    const filesize = aesEcbPaddedSize(rawsize)
    const filekey = crypto.randomBytes(16).toString('hex')
    const aeskey = crypto.randomBytes(16)
    const text = await apiPost(
      apiBaseOf(account),
      'ilink/bot/getuploadurl',
      {
        filekey,
        media_type: mediaType,
        to_user_id: toUserId,
        rawsize,
        rawfilemd5,
        filesize,
        no_need_thumb: true,
        aeskey: aeskey.toString('hex'),
      },
      account.botToken,
    )
    const resp = JSON.parse(text)
    const fullUrl = String(resp?.upload_full_url ?? '').trim()
    const param = resp?.upload_param
    if (!fullUrl && !param) {
      log('warn', 'getuploadurl failed', {
        resp: text.slice(0, 200),
        accountId: account.id,
        toUserId,
        mediaType,
        rawsize,
        filesize,
        md5Len: rawfilemd5.length,
        aeskeyLen: aeskey.toString('hex').length,
        filekey,
      })
      throw new Error(`getuploadurl 未返回上传地址: ${text.slice(0, 200)}`)
    }
    const url =
      fullUrl ||
      `${CDN_BASE}/upload?encrypted_query_param=${encodeURIComponent(param)}&filekey=${encodeURIComponent(filekey)}`
    const ciphertext = encryptAesEcb(plaintext, aeskey)
    let lastErr
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/octet-stream' },
          body: new Uint8Array(ciphertext),
        })
        if (res.status === 200) {
          const downloadParam = res.headers.get('x-encrypted-param')
          if (!downloadParam) throw new Error('CDN 未返回 x-encrypted-param')
          return {
            filekey,
            downloadEncryptedQueryParam: downloadParam,
            aesKeyBase64: Buffer.from(aeskey.toString('hex'), 'utf8').toString('base64'),
            fileSize: rawsize,
            fileSizeCiphertext: filesize,
            encryptedBytes: ciphertext.length,
          }
        }
        const errText = res.headers.get('x-error-message') ?? (await res.text().catch(() => ''))
        lastErr = new Error(`CDN 上传失败 ${res.status}: ${String(errText).slice(0, 160)}`)
        if (res.status >= 400 && res.status < 500) throw lastErr
      } catch (err) {
        lastErr = err
        if (String(err?.message ?? '').includes('上传失败 4')) throw err
      }
      await sleep(400 * attempt)
    }
    throw lastErr ?? new Error('CDN 上传失败')
  }

  async function sendMediaToChat({ accountId, toUserId, contextToken, filePath, caption }) {
    const account = state.accounts[accountId]
    if (!account?.botToken) throw new Error('账号未登录或已移除')
    if (!fs.existsSync(filePath)) throw new Error(`文件不存在: ${filePath}`)
    const stat = fs.statSync(filePath)
    if (!stat.isFile()) throw new Error(`不是普通文件: ${filePath}`)
    if (stat.size > 50 * 1024 * 1024) {
      throw new Error(`文件太大（${Math.round(stat.size / 1048576)} MB），上限 50 MB`)
    }
    const fileName = path.basename(filePath)
    const kind = guessMediaKind(fileName)
    const mediaType = kind === 'image' ? 1 : kind === 'video' ? 2 : 3
    const plaintext = fs.readFileSync(filePath)
    const uploaded = await uploadToCdn({ account, toUserId, plaintext, mediaType })
    const media = {
      encrypt_query_param: uploaded.downloadEncryptedQueryParam,
      aes_key: uploaded.aesKeyBase64,
      encrypt_type: 1,
    }
    const item =
      kind === 'image'
        ? { type: 2, image_item: { media, mid_size: uploaded.fileSizeCiphertext } }
        : kind === 'video'
          ? { type: 5, video_item: { media, video_size: uploaded.fileSizeCiphertext } }
          : { type: 4, file_item: { media, file_name: fileName, len: String(uploaded.fileSize) } }
    const results = []
    if (caption) {
      results.push(
        await postMessage(account, {
          from_user_id: '',
          to_user_id: toUserId,
          client_id: uid('dsh-wechat'),
          message_type: MESSAGE_TYPE_BOT,
          message_state: MESSAGE_STATE_FINISH,
          item_list: [{ type: ITEM_TEXT, text_item: { text: String(caption) } }],
          ...(contextToken ? { context_token: contextToken } : {}),
        }),
      )
    }
    results.push(
      await postMessage(account, {
        from_user_id: '',
        to_user_id: toUserId,
        client_id: uid('dsh-wechat'),
        message_type: MESSAGE_TYPE_BOT,
        message_state: MESSAGE_STATE_FINISH,
        item_list: [item],
        ...(contextToken ? { context_token: contextToken } : {}),
      }),
    )
    return {
      ok: true,
      kind,
      fileName,
      bytes: uploaded.fileSize,
      encryptedBytes: uploaded.encryptedBytes,
      messageIds: results.map((r) => r?.message_id ?? null),
    }
  }

  async function sendToBinding(binding, text) {
    try {
      const result = await sendToChat({
        accountId: binding.accountId,
        toUserId: binding.toUserId || String(binding.chatId).replace(/^user:/, ''),
        contextToken: binding.contextToken,
        text,
      })
      binding.lastOutboundAt = Date.now()
      binding.lastError = ''
      saveState()
      return result
    } catch (err) {
      // iLink 拒投（常见 ret=-2 prepare failed，多为 context_token 失效）时先入队，
      // 等下一次收到这个人的微信消息（带来新 token）后自动补发，避免静默丢消息。
      binding.pending = [...normalizePending(binding.pending), { text: String(text), at: Date.now() }].slice(-20)
      binding.lastError = String(err?.message ?? err)
      binding.nextRetryAt = Date.now() + 30_000
      saveState()
      throw err
    }
  }

  /** 兼容旧版（纯字符串数组）并统一成 {text, at}。 */
  function normalizePending(list) {
    return (Array.isArray(list) ? list : []).map((item) =>
      typeof item === 'string' ? { text: item, at: 0 } : { text: String(item?.text ?? ''), at: Number(item?.at ?? 0) },
    )
  }

  /** 队列里的旧消息不再补发：超过 PENDING_TTL_MS 的直接丢弃，避免刷屏。 */
  const PENDING_TTL_MS = 10 * 60_000

  async function flushPending(binding) {
    let queue = normalizePending(binding.pending).filter((item) => item.text)
    if (queue.length === 0) {
      binding.pending = []
      return 0
    }
    const fresh = queue.filter((item) => Date.now() - item.at <= PENDING_TTL_MS)
    const dropped = queue.length - fresh.length
    if (dropped > 0) {
      log('warn', 'pending expired, dropped', { key: binding.key, dropped })
      binding.pending = fresh
      saveState()
    }
    queue = fresh
    if (queue.length === 0) return 0
    if (Date.now() < (binding.nextRetryAt ?? 0)) return 0
    let sent = 0
    while (binding.pending.length > 0) {
      const head = normalizePending(binding.pending)[0]
      if (!head?.text) {
        binding.pending = normalizePending(binding.pending).slice(1)
        continue
      }
      try {
        await sendToChat({
          accountId: binding.accountId,
          toUserId: binding.toUserId || String(binding.chatId).replace(/^user:/, ''),
          contextToken: binding.contextToken,
          text: head.text,
        })
        binding.pending = normalizePending(binding.pending).slice(1)
        binding.lastOutboundAt = Date.now()
        binding.lastError = ''
        sent += 1
      } catch (err) {
        binding.lastError = String(err?.message ?? err)
        binding.nextRetryAt = Date.now() + 60_000
        break
      }
    }
    saveState()
    return sent
  }

  // -- 发送参数矩阵探针（定位 "prepare failed"） ---------------------------

  async function sendProbe({ accountId, toUserId, text, contextToken }) {
    const account = state.accounts[accountId]
    if (!account?.botToken) return { error: '没有可用账号' }
    const url = `${apiBaseOf(account).replace(/\/+$/, '')}/ilink/bot/sendmessage`
    const info = (version, agent) => ({ channel_version: version, bot_agent: agent || BOT_AGENT })
    const variants = [
      { name: 'baseline', info: info(CHANNEL_VERSION), clientId: uid('dsh-wechat') },
      { name: 'channel_version=2.4.10', info: info('2.4.10'), clientId: uid('dsh-wechat') },
      { name: 'bot_agent=OpenClaw', info: info('2.4.10', 'OpenClaw'), clientId: uid('dsh-wechat') },
      { name: 'client_id=openclaw-weixin', info: info('2.4.10'), clientId: uid('openclaw-weixin') },
      { name: 'with run_id', info: info('2.4.10'), clientId: uid('openclaw-weixin'), runId: uid('run') },
      { name: 'from_user_id=botId', info: info('2.4.10'), clientId: uid('openclaw-weixin'), from: account.botId },
      { name: 'message_state=NEW', info: info('2.4.10'), clientId: uid('openclaw-weixin'), state: 0 },
      { name: 'no base_info', info: null, clientId: uid('dsh-wechat') },
      { name: 'no context_token', info: info('2.4.10'), clientId: uid('dsh-wechat'), token: '' },
    ]
    const results = []
    for (const variant of variants) {
      const msg = {
        from_user_id: variant.from ?? '',
        to_user_id: toUserId,
        client_id: variant.clientId,
        message_type: MESSAGE_TYPE_BOT,
        message_state: variant.state ?? MESSAGE_STATE_FINISH,
        item_list: [{ type: ITEM_TEXT, text_item: { text } }],
      }
      const token = variant.token === undefined ? contextToken : variant.token
      if (token) msg.context_token = token
      if (variant.runId) msg.run_id = variant.runId
      const body = variant.info === null ? { msg } : { msg, base_info: variant.info }
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: requestHeaders(account.botToken),
          body: JSON.stringify(body),
        })
        const raw = await res.text()
        let parsed
        try {
          parsed = JSON.parse(raw)
        } catch {
          parsed = { raw: raw.slice(0, 200) }
        }
        results.push({
          variant: variant.name,
          http: res.status,
          ret: parsed.ret ?? null,
          errmsg: parsed.errmsg ?? parsed.raw ?? null,
          messageId: parsed.message_id ?? null,
        })
      } catch (err) {
        results.push({ variant: variant.name, error: String(err?.message ?? err) })
      }
      await sleep(300)
    }
    return { url, toUserId, hasContextToken: Boolean(contextToken), results }
  }

  // -- 一轮对话 ------------------------------------------------------------

  async function runTurn(binding, text, signal, timeoutMs) {
    const sessionId = binding.sessionId
    await ensureSession(sessionId)
    const baseline = currentSeq(sessionId)
    const framed = config.messagePrefix ? `${config.messagePrefix}${text}` : text
    binding.turnActive = true
    try {
      await promptSession(sessionId, framed, signal)
      const reply = await waitForReply(sessionId, baseline, signal, timeoutMs)
      binding.lastSeq = currentSeq(sessionId)
      const plain = stripMarkdown(reply) || '（本轮没有产生文本回复）'
      await sendToBinding(binding, plain)
      return { sessionId, reply: plain }
    } finally {
      binding.turnActive = false
      binding.lastInboundAt = Date.now()
      saveState()
    }
  }

  // -- 入站 ----------------------------------------------------------------

  async function handleInbound(accountId, msg, options = {}) {
    const messageType = Number(msg?.message_type ?? 0)
    if (messageType === MESSAGE_TYPE_BOT) return null
    const fromUserId = String(msg?.from_user_id ?? '')
    if (!fromUserId) return null
    const account = state.accounts[accountId]
    if (account?.botId && fromUserId === account.botId) return null
    if (config.allowFrom.length > 0 && !config.allowFrom.includes(fromUserId)) {
      log('warn', 'blocked by allowFrom', { accountId, fromUserId })
      return { blocked: true }
    }
    const text = await describeInbound(msg)
    if (!text) return { empty: true }

    const chatId = chatIdOf(msg)
    const binding = ensureBinding(accountId, chatId, fromUserId, String(msg?.context_token ?? ''))
    const signal = monitors.get(accountId)?.abort?.signal ?? new AbortController().signal

    return enqueue(binding.key, async () => {
      log('info', 'inbound', { accountId, chatId, chars: text.length })
      const started = Date.now()
      try {
        const result = await runTurn(binding, text, signal)
        log('info', 'replied', { accountId, chatId, chars: result.reply.length, ms: Date.now() - started })
        return { ok: true, ...result, ms: Date.now() - started }
      } catch (err) {
        const message = String(err?.message ?? err)
        log('error', 'turn failed', { accountId, chatId, error: message })
        try {
          await sendToBinding(binding, `⚠️ DSH 处理失败：${message}`)
        } catch {
          /* ignore */
        }
        return { ok: false, error: message }
      }
    })
  }

  // -- 出站镜像：会话 → 微信 -----------------------------------------------

  async function scanAndMirror(binding, from, to, options = {}) {
    const send = options.send === true
    const session = ctx.get('sessions')?.get?.(binding.sessionId)
    if (!session) return { ok: false, reason: 'session not live', sessionId: binding.sessionId }
    const start = Number(from ?? binding.lastSeq ?? 0)
    const end = Number(to ?? session.seq ?? 0)
    if (!Number.isFinite(end) || end <= start) return { ok: true, from: start, to: end, events: 0, candidates: [], sent: 0 }
    let events = []
    try {
      events = session.snapshotEvents(start, end) ?? []
    } catch (err) {
      return { ok: false, reason: `snapshot failed: ${String(err?.message ?? err)}` }
    }
    const candidates = []
    let sent = 0
    for (const event of events) {
      if (event?.type === 'assistant/message' && config.mirrorAssistantMessages) {
        const text = stripMarkdown(textOfMessage(event.data?.message))
        if (text) {
          candidates.push({ seq: Number(event.seq), kind: 'assistant', len: text.length, sample: text.slice(0, 80) })
          if (send) {
            try {
              await sendToBinding(binding, text)
              sent += 1
            } catch (err) {
              candidates[candidates.length - 1].error = String(err?.message ?? err)
            }
          }
        }
      } else if (event?.type === 'user/message' && config.mirrorUserMessages) {
        const source = event.data?.source ?? event.data?.message?.source
        const rpcId = String(source?.rpcId ?? '')
        const text = stripMarkdown(textOfMessage(event.data?.message ?? event.data))
        if (text && source?.kind === 'user' && !rpcId.startsWith('wx-req')) {
          candidates.push({ seq: Number(event.seq), kind: 'user', len: text.length, sample: text.slice(0, 80) })
          if (send) {
            try {
              await sendToBinding(binding, `${config.webMessagePrefix}${text}`)
              sent += 1
            } catch (err) {
              candidates[candidates.length - 1].error = String(err?.message ?? err)
            }
          }
        }
      }
    }
    return { ok: true, from: start, to: end, events: events.length, candidates, sent }
  }

  async function mirrorTick() {
    if (mirrorBusy) return
    mirrorBusy = true
    try {
      for (const binding of Object.values(state.bindings)) {
        if (binding.turnActive || !binding.sessionId) continue
        if ((binding.pending?.length ?? 0) > 0) await flushPending(binding)
        const session = ctx.get('sessions')?.get?.(binding.sessionId)
        if (!session) continue
        const from = Number(binding.lastSeq ?? 0)
        const seq = Number(session.seq ?? 0)
        if (!Number.isFinite(seq) || seq <= from) continue
        // 首次扫描（lastSeq 为 0）或积压过多时不回放历史，直接把游标推到当前位置
        if (from <= 0 || seq - from > 500) {
          binding.lastSeq = seq
          saveState()
          continue
        }
        const report = await scanAndMirror(binding, from, seq, { send: true })
        binding.lastSeq = seq
        saveState()
        if ((report?.candidates?.length ?? 0) > 0) {
          log('info', 'mirror tick', {
            key: binding.key,
            from,
            to: seq,
            ok: report?.ok,
            reason: report?.reason,
            events: report?.events,
            sent: report?.sent,
            found: report?.candidates?.length ?? 0,
          })
        }
      }
    } finally {
      mirrorBusy = false
    }
  }

  function startMirror() {
    if (mirrorTimer) return
    mirrorTimer = setInterval(() => {
      void mirrorTick().catch((err) => log('warn', 'mirror tick failed', { error: String(err?.message ?? err) }))
    }, config.mirrorIntervalMs)
  }

  function stopMirror() {
    if (mirrorTimer) clearInterval(mirrorTimer)
    mirrorTimer = null
  }

  // -- 会话列表（给绑定下拉框） --------------------------------------------

  async function listSessions() {
    const controller = ctx.get('sessionController')
    if (controller?.list) {
      try {
        const value = await controller.list({}, new AbortController().signal)
        const items = Array.isArray(value?.items) ? value.items : []
        return items.map((row) => ({
          id: String(row.sessionId),
          title: row.projections?.values?.title ?? row.title ?? null,
          updatedAt: row.updatedAt ?? null,
          running: Boolean(row.running),
          cwd: row.cwd ?? null,
        }))
      } catch (err) {
        log('warn', 'session list failed', { error: String(err?.message ?? err) })
      }
    }
    const sessions = ctx.get('sessions')
    return (sessions?.list?.() ?? []).map((session) => ({
      id: String(session.id),
      title: null,
      updatedAt: null,
      running: true,
      cwd: session.header?.cwd ?? null,
    }))
  }

  // -- 快照 ----------------------------------------------------------------

  function snapshot() {
    const list = accounts().map((account) => {
      const runtime = accountRuntime(account.id)
      const bound = Object.values(state.bindings).filter((b) => b.accountId === account.id).length
      return {
        id: account.id,
        name: account.name,
        botId: account.botId || null,
        userId: account.userId || null,
        apiBase: apiBaseOf(account),
        running: runtime.running,
        lastPollAt: account.lastPollAt ? new Date(account.lastPollAt).toISOString() : null,
        lastError: account.lastError || null,
        bindings: bound,
        createdAt: account.createdAt ? new Date(account.createdAt).toISOString() : null,
      }
    })
    return {
      enabled: config.enabled,
      version: CHANNEL_VERSION,
      loggedIn: list.length > 0,
      login: {
        status: login.status,
        needVerifyCode: login.status === 'need_verifycode',
        qrUrl: login.qrUrl || null,
        qrVersion: login.startedAt || 0,
        replacingAccountId: login.replacingAccountId || null,
        error: login.error || null,
      },
      accounts: list,
      bindings: Object.values(state.bindings).map((binding) => ({
        key: binding.key,
        accountId: binding.accountId,
        accountName: state.accounts[binding.accountId]?.name ?? binding.accountId,
        chatId: binding.chatId,
        sessionId: binding.sessionId,
        explicit: Boolean(binding.explicit),
        live: Boolean(ctx.get('sessions')?.get?.(binding.sessionId)),
        lastSeq: Number(binding.lastSeq ?? 0),
        pending: normalizePending(binding.pending).length,
        lastError: binding.lastError || null,
        needsActivation: /prepare failed/i.test(String(binding.lastError ?? '')),
        lastInboundAt: binding.lastInboundAt ? new Date(binding.lastInboundAt).toISOString() : null,
        lastOutboundAt: binding.lastOutboundAt ? new Date(binding.lastOutboundAt).toISOString() : null,
      })),
      mirror: { running: Boolean(mirrorTimer), intervalMs: config.mirrorIntervalMs },
      settings: { defaultSessionId: state.settings?.defaultSessionId || '' },
      stateDir: config.stateDir,
      logFile,
    }
  }

  // -- HTTP 接口（给客户端面板用） -----------------------------------------

  function json(res, value, status = 200) {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(JSON.stringify(value))
  }

  async function readJsonBody(req) {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const text = Buffer.concat(chunks).toString('utf8').trim()
    if (!text) return {}
    try {
      return JSON.parse(text)
    } catch {
      return {}
    }
  }

  async function handleHttp(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const route = url.pathname.replace(/^\/wechat-channel\/?/, '') || ''
    const method = req.method ?? 'GET'
    try {
      if (method === 'GET' && (route === '' || route === 'status')) return json(res, snapshot())
      if (method === 'GET' && route === 'sessions') return json(res, { items: await listSessions() })
      if (method === 'GET' && route === 'mirror-probe') {
        const fromParam = Number(url.searchParams.get('from') ?? NaN)
        const send = url.searchParams.get('send') === '1'
        const all = url.searchParams.get('all') === '1'
        const targets = all
          ? Object.values(state.bindings)
          : [
              Object.values(state.bindings).find((b) => b.explicit && b.chatId.includes('@im.wechat')) ??
                Object.values(state.bindings)[0],
            ].filter(Boolean)
        const reports = []
        for (const binding of targets) {
          const report = await scanAndMirror(
            binding,
            Number.isFinite(fromParam) ? fromParam : binding.lastSeq,
            undefined,
            { send },
          )
          reports.push({ key: binding.key, chatId: binding.chatId, lastSeq: binding.lastSeq, ...report })
        }
        return json(res, { dryRun: !send, reports })
      }
      if (method === 'GET' && route === 'send-probe') {
        const target =
          Object.values(state.bindings).find((b) => b.explicit && b.chatId.includes('@im.wechat')) ??
          Object.values(state.bindings)[0]
        if (!target) return json(res, { error: '没有绑定' }, 404)
        const text = url.searchParams.get('text') || '【发送参数探针】'
        return json(
          res,
          await sendProbe({
            accountId: target.accountId,
            toUserId: target.toUserId || String(target.chatId).replace(/^user:/, ''),
            text,
            contextToken: target.contextToken,
          }),
        )
      }
      if (method === 'GET' && route === 'client-modules') {
        const modules = ctx.get('clientModules')
        let graph = null
        try {
          graph = modules?.graph?.() ?? null
        } catch (err) {
          graph = { error: String(err?.message ?? err) }
        }
        const ids = Array.isArray(graph?.modules)
          ? graph.modules.map((m) => m.id ?? m.name ?? String(m))
          : graph && typeof graph === 'object'
            ? Object.keys(graph)
            : []
        return json(res, { hasClientHalf: ids.includes('dsh-channel-wechat'), ids, graph })
      }
      if (method === 'GET' && route === 'qr.png') {
        if (!fs.existsSync(qrFile)) return json(res, { error: 'no qr' }, 404)
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' })
        res.end(fs.readFileSync(qrFile))
        return
      }
      if (method === 'POST' && route === 'login') {
        const body = await readJsonBody(req)
        return json(res, await startLogin(Boolean(body?.force), body?.accountId ? String(body.accountId) : ''))
      }
      if (method === 'POST' && route === 'logout') {
        const body = await readJsonBody(req)
        const accountId = String(body?.accountId ?? '')
        return json(res, accountId ? removeAccount(accountId) : { ok: false, message: '缺少 accountId' })
      }
      if (method === 'POST' && route === 'verify') {
        const body = await readJsonBody(req)
        return json(res, submitVerifyCode(body?.code))
      }
      if (method === 'POST' && route === 'bind') {
        const body = await readJsonBody(req)
        return json(res, bindSession(String(body?.key ?? ''), String(body?.sessionId ?? '')))
      }
      if (method === 'POST' && route === 'unbind') {
        const body = await readJsonBody(req)
        return json(res, unbindSession(String(body?.key ?? '')))
      }
      if (method === 'POST' && route === 'default-session') {
        const body = await readJsonBody(req)
        const sessionId = String(body?.sessionId ?? '')
        state.settings = { ...(state.settings ?? {}), defaultSessionId: sessionId }
        saveState(true)
        log('info', 'default session set', { sessionId })
        return json(res, { ok: true, defaultSessionId: sessionId })
      }
      if (method === 'POST' && route === 'new-session') {
        const body = await readJsonBody(req)
        const controller = ctx.get('sessionController')
        if (!controller?.create) return json(res, { ok: false, error: 'sessionController 不可用' }, 500)
        const created = await controller.create({
          ...(config.agentPreset ? { agentPreset: config.agentPreset } : {}),
          ...(config.cwd ? { cwd: config.cwd } : {}),
        })
        const sessionId = String(created?.sessionId ?? '')
        if (body?.bindKey && sessionId) bindSession(String(body.bindKey), sessionId)
        if (body?.asDefault && sessionId) {
          state.settings = { ...(state.settings ?? {}), defaultSessionId: sessionId }
          saveState(true)
        }
        return json(res, { ok: true, sessionId })
      }
      return json(res, { error: `unknown route ${method} ${route}` }, 404)
    } catch (err) {
      const message = String(err?.message ?? err)
      log('error', 'http handler failed', { route, error: message })
      return json(res, { error: message }, 500)
    }
  }

  // -- 生命周期 ------------------------------------------------------------

  function start() {
    loadState()
    for (const account of accounts()) startMonitor(account.id)
    startMirror()
    log('info', 'channel started', { accounts: accounts().length })
  }

  function stop() {
    for (const accountId of [...monitors.keys()]) stopMonitor(accountId)
    stopMirror()
    login.abort?.abort()
    login.abort = null
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    saveState(true)
  }

  return {
    start,
    stop,
    startLogin,
    submitVerifyCode,
    removeAccount,
    snapshot,
    listSessions,
    bindSession,
    unbindSession,
    handleHttp,
    sendToChat,
    sendProbe,
    sendMediaToChat,
    sendToUser: async ({ accountId, toUserId, text }) => {
      const binding = Object.values(state.bindings).find(
        (b) => b.accountId === accountId && (b.toUserId === toUserId || b.chatId === `user:${toUserId}`),
      )
      return sendToChat({
        accountId,
        toUserId,
        contextToken: binding?.contextToken ?? '',
        text,
      })
    },
    sendFileToUser: async ({ accountId, toUserId, filePath, caption }) => {
      const all = Object.values(state.bindings)
      const isRealChat = (b) => String(b.toUserId ?? b.chatId ?? '').includes('@im.')
      const real = all.filter((b) => isRealChat(b) && (!accountId || b.accountId === accountId))
      const target = toUserId
        ? all.find(
            (b) =>
              (!accountId || b.accountId === accountId) &&
              (b.toUserId === toUserId || b.chatId === `user:${toUserId}`),
          )
        : real.sort((a, b) => Number(b.lastInboundAt ?? b.lastOutboundAt ?? 0) - Number(a.lastInboundAt ?? a.lastOutboundAt ?? 0))[0]
      if (!target) {
        throw new Error('没有可用的微信会话：先让对方给机器人发一条消息（或用 to 显式指定微信用户 id）')
      }
      const resolvedTo = toUserId || target.toUserId || String(target.chatId).replace(/^user:/, '')
      if (!String(resolvedTo).includes('@im.') && !String(resolvedTo).includes('@chatroom')) {
        throw new Error(`发送目标看起来不是真实微信 id：${resolvedTo}（请传 to）`)
      }
      return sendMediaToChat({
        accountId: accountId || target.accountId,
        toUserId: resolvedTo,
        contextToken: target.contextToken ?? '',
        filePath,
        caption,
      })
    },
    simulate: async (text, chatId, timeoutMs) => {
      const accountId = accounts()[0]?.id ?? 'sim'
      const binding = ensureBinding(accountId, `user:${chatId || 'sim-user'}`, chatId || 'sim-user', '')
      binding.turnActive = true
      try {
        await ensureSession(binding.sessionId)
        const baseline = currentSeq(binding.sessionId)
        await promptSession(binding.sessionId, text, new AbortController().signal)
        const reply = await waitForReply(binding.sessionId, baseline, new AbortController().signal, timeoutMs)
        binding.lastSeq = currentSeq(binding.sessionId)
        return { ok: true, sessionId: binding.sessionId, reply }
      } catch (err) {
        return { ok: false, sessionId: binding.sessionId, error: String(err?.message ?? err) }
      } finally {
        binding.turnActive = false
        saveState()
      }
    },
    debugSession(sessionId) {
      const sessions = ctx.get('sessions')
      const ids = (sessions?.list?.() ?? []).map((s) => String(s.id))
      const id = sessionId || ids[ids.length - 1]
      const session = id ? sessions?.get?.(id) : undefined
      const events = session ? session.snapshotEvents(0, session.seq) : []
      return {
        build: 'v3',
        liveSessions: ids,
        sessionId: id ?? null,
        seq: session ? Number(session.seq) : null,
        eventCount: events.length,
        tail: events.slice(-14).map((event) => {
          const data = event?.data
          const message = data && typeof data === 'object' ? data.message : undefined
          let detail = ''
          try {
            detail = data === undefined ? '' : JSON.stringify(data).slice(0, 300)
          } catch {
            detail = String(data).slice(0, 300)
          }
          return {
            type: event?.type,
            seq: Number(event?.seq ?? 0),
            detail,
            text: textOfMessage(message).slice(0, 160),
          }
        }),
      }
    },
  }
}

// ---------------------------------------------------------------------------
// 工具注册
// ---------------------------------------------------------------------------

function textOutput(description) {
  return {
    schema: { type: 'object', description, additionalProperties: true },
    render: (_args, value) => [
      { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
    ],
  }
}

function registerTools(ctx, channel) {
  const register = (definition) => {
    try {
      ctx.tools.register(definition)
    } catch (err) {
      try {
        ctx.logger?.error?.(`[wechat] register tool ${definition.name} failed: ${String(err)}`)
      } catch {
        /* ignore */
      }
    }
  }

  register({
    name: 'wechat_login',
    description:
      'Add a WeChat ClawBot (iLink) account by QR login and render the QR code to a PNG. ' +
      'Pass accountId to re-login an existing account instead of adding a new one. ' +
      '新增微信账号（扫码）或对已有账号重新扫码。',
    parameters: {
      type: 'object',
      properties: {
        force: { type: 'boolean', description: 'Regenerate the QR even when one is active.' },
        accountId: { type: 'string', description: 'Re-login this existing account instead of adding one.' },
      },
      required: [],
      additionalProperties: false,
    },
    output: textOutput('Login state, QR payload URL, and the QR PNG path.'),
    async execute(args) {
      return channel.startLogin(Boolean(args?.force), args?.accountId ? String(args.accountId) : '')
    },
  })

  register({
    name: 'wechat_verify_code',
    description:
      'Submit the numeric pairing code that mobile WeChat displays after scanning (only while status is need_verifycode). ' +
      '提交扫码后手机微信显示的数字验证码。',
    parameters: {
      type: 'object',
      properties: { code: { type: 'string', description: 'The numeric code shown on the phone.' } },
      required: ['code'],
      additionalProperties: false,
    },
    output: textOutput('Whether the code was queued for the next status poll.'),
    async execute(args) {
      return channel.submitVerifyCode(args?.code)
    },
  })

  register({
    name: 'wechat_status',
    description:
      'Report the whole WeChat channel: every account (login, poll loop, last error), every chat→session binding, ' +
      'and the mirror loop state. 查看所有微信账号、绑定关系与镜像状态。',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    output: textOutput('Accounts, bindings, login and mirror state.'),
    async execute() {
      return channel.snapshot()
    },
  })

  register({
    name: 'wechat_logout',
    description: 'Remove one WeChat account (and its bindings) by accountId. 断开并移除指定微信账号。',
    parameters: {
      type: 'object',
      properties: { accountId: { type: 'string', description: 'Account id from wechat_status.' } },
      required: ['accountId'],
      additionalProperties: false,
    },
    output: textOutput('Removal result.'),
    async execute(args) {
      if (!args?.accountId) throw new Error('accountId 必填')
      return channel.removeAccount(String(args.accountId))
    },
  })

  register({
    name: 'wechat_bind',
    description:
      'Bind one WeChat chat to an exact DSH session so messages from both sides mirror into each other. ' +
      'Use wechat_status to read binding keys, or pass accountId + chatId. 把微信 chat 绑定到指定 DSH 会话（双向镜像）。',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Binding key from wechat_status.' },
        accountId: { type: 'string', description: 'Account id (with chatId) when key is unknown.' },
        chatId: { type: 'string', description: 'Chat id such as user:xxxx@im.wechat.' },
        sessionId: { type: 'string', description: 'Target DSH session id.' },
      },
      required: ['sessionId'],
      additionalProperties: false,
    },
    output: textOutput('Binding result.'),
    async execute(args) {
      const snapshot = channel.snapshot()
      let key = args?.key ? String(args.key) : ''
      if (!key && args?.accountId && args?.chatId) {
        const found = snapshot.bindings.find(
          (b) => b.accountId === String(args.accountId) && b.chatId === String(args.chatId),
        )
        key = found?.key ?? `${String(args.accountId)}::${String(args.chatId)}`
      }
      if (!key) throw new Error('需要 key，或 accountId + chatId')
      return channel.bindSession(key, String(args.sessionId))
    },
  })

  register({
    name: 'wechat_unbind',
    description: 'Drop a binding back to its private per-chat session. 解除绑定，恢复每聊天独立会话。',
    parameters: {
      type: 'object',
      properties: { key: { type: 'string', description: 'Binding key from wechat_status.' } },
      required: ['key'],
      additionalProperties: false,
    },
    output: textOutput('Unbind result.'),
    async execute(args) {
      if (!args?.key) throw new Error('key 必填')
      return channel.unbindSession(String(args.key))
    },
  })

  register({
    name: 'wechat_send',
    description:
      'Push a text message to a WeChat contact through one account. Requires the WeChat user id ' +
      '(xxxx@im.wechat) and, when several accounts exist, accountId. 主动推送文本到微信。',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'WeChat user id, e.g. o9cq...@im.wechat' },
        text: { type: 'string', description: 'Message body.' },
        accountId: { type: 'string', description: 'Account to send from; defaults to the first.' },
      },
      required: ['to', 'text'],
      additionalProperties: false,
    },
    timeoutMs: 60_000,
    output: textOutput('iLink sendmessage responses.'),
    async execute(args) {
      if (!args?.to || !args?.text) throw new Error('to 与 text 必填')
      const snapshot = channel.snapshot()
      const accountId = args?.accountId ? String(args.accountId) : snapshot.accounts[0]?.id
      if (!accountId) throw new Error('还没有已登录的微信账号')
      return channel.sendToUser({
        accountId,
        toUserId: String(args.to),
        text: String(args.text),
      })
    },
  })

  register({
    name: 'wechat_send_file',
    description:
      'Send a local file to WeChat: the file is AES-128-ECB encrypted, uploaded to the WeChat CDN, then sent as ' +
      'an image / video / attachment message. 把本地文件（图片、视频、任意附件）发到微信。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute local path of the file to send.' },
        to: { type: 'string', description: 'WeChat user id; defaults to the most recent bound chat.' },
        caption: { type: 'string', description: 'Optional text message sent before the file.' },
        accountId: { type: 'string', description: 'Account to send from; defaults to the first.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    timeoutMs: 240_000,
    output: textOutput('Upload and send result: kind, byte sizes, message ids.'),
    async execute(args) {
      if (!args?.path) throw new Error('path 必填')
      const snapshot = channel.snapshot()
      const accountId = args?.accountId ? String(args.accountId) : snapshot.accounts[0]?.id
      if (!accountId) throw new Error('还没有已登录的微信账号')
      return channel.sendFileToUser({
        accountId,
        toUserId: args?.to ? String(args.to) : undefined,
        filePath: String(args.path),
        caption: args?.caption ? String(args.caption) : '',
      })
    },
  })

  register({
    name: 'wechat_simulate',
    description:
      'Run the exact inbound pipeline without iLink: create/resolve the chat session, prompt the agent, collect the reply. ' +
      '模拟一条微信入站消息（不经过 iLink）。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Simulated user message.' },
        chatId: { type: 'string', description: 'Optional fake wechat user id (default sim-user).' },
        timeoutMs: { type: 'number', description: 'Optional wait budget override in milliseconds.' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    timeoutMs: 300_000,
    output: textOutput('Simulated turn result including the session id and collected reply.'),
    async execute(args) {
      if (!args?.text) throw new Error('text 必填')
      return channel.simulate(
        String(args.text),
        args?.chatId ? String(args.chatId) : undefined,
        Number.isFinite(args?.timeoutMs) ? Number(args.timeoutMs) : undefined,
      )
    },
  })

  register({
    name: 'wechat_debug',
    description: 'Diagnostics: list live sessions and dump the tail of one session log. 诊断会话事件尾部。',
    parameters: {
      type: 'object',
      properties: { sessionId: { type: 'string', description: 'Optional exact session id.' } },
      required: [],
      additionalProperties: false,
    },
    output: textOutput('Live session ids plus a compact event tail.'),
    async execute(args) {
      return channel.debugSession(args?.sessionId ? String(args.sessionId) : undefined)
    },
  })
}

// ---------------------------------------------------------------------------
// 插件入口
// ---------------------------------------------------------------------------

export const name = 'channel-wechat'
export const inject = ['tools']

export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  if (!config.enabled) return
  const channel = createChannel(ctx, config)
  const cleanups = []
  let routeTimer = null
  let routeAttempts = 0

  // webServer 可能在插件激活之后才就绪（冷启动顺序不固定），所以轮询等待而不是只试一次。
  const registerRoute = () => {
    routeTimer = null
    const server = ctx.get('webServer')
    if (server?.register) {
      try {
        cleanups.push(
          server.register({
            kind: 'prefix',
            path: '/wechat-channel',
            handler: (req, res) => {
              void channel.handleHttp(req, res)
            },
          }),
        )
        return
      } catch (err) {
        try {
          ctx.logger?.warn?.(`[wechat] route registration failed: ${String(err)}`)
        } catch {
          /* ignore */
        }
      }
    }
    if (routeAttempts < 120) {
      routeAttempts += 1
      routeTimer = setTimeout(registerRoute, 500)
    }
  }
  registerRoute()

  const dispose = () => {
    if (routeTimer) clearTimeout(routeTimer)
    routeTimer = null
    try {
      channel.stop()
    } catch {
      /* ignore */
    }
    for (const off of cleanups) {
      try {
        off()
      } catch {
        /* ignore */
      }
    }
  }

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => {
      channel.start()
      return dispose
    })
  } else {
    channel.start()
    ctx.on?.('dispose', dispose)
  }
  registerTools(ctx, channel)
}
