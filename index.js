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
/** 插件版本：与 package.json 保持一致，出现在 base_info.channel_version 里 */
const CHANNEL_VERSION = '2.4.9'
const BOT_AGENT = 'DSH-WeChat/2.4.9'
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
// 微信文本排版：把 Markdown 压成适合微信窄屏阅读的纯文本
// ---------------------------------------------------------------------------

/** 两列表格 → 「· 键：值」；多列 → 「· a｜b｜c」。表头行若有分隔线会丢弃。 */
function tableToLines(table) {
  const raw = table
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('|'))
  const hasHeader = raw.some((line) =>
    line
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .every((cell) => /^:?-{2,}:?$/.test(cell.trim())),
  )
  const rows = raw.map((line) =>
    line
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((cell) => cell.trim()),
  )
  const body = rows.filter((cells) => !cells.every((cell) => /^:?-{2,}:?$/.test(cell)))
  if (body.length === 0) return ''
  const data = hasHeader ? body.slice(1) : body
  if (data.length === 0) return ''
  const width = Math.max(...data.map((cells) => cells.length))
  if (width <= 2) {
    return data.map((cells) => `· ${cells[0] ?? ''}：${cells[1] ?? ''}`.replace(/：\s*$/, '')).join('\n')
  }
  return data.map((cells) => `· ${cells.join('｜')}`).join('\n')
}

/** 按句读把一行切成不超过 max 的若干段。 */
function wrapPlain(text, max) {
  const parts = []
  let rest = text
  while (rest.length > max) {
    let cut = -1
    for (const ch of ['。', '！', '？', '；', '，', '、']) {
      const at = rest.lastIndexOf(ch, max)
      if (at > cut) cut = at
    }
    if (cut < max * 0.5) cut = rest.lastIndexOf(' ', max)
    if (cut < max * 0.5) cut = max - 1
    parts.push(rest.slice(0, cut + 1).trim())
    rest = rest.slice(cut + 1).trim()
  }
  if (rest) parts.push(rest)
  return parts.join('\n')
}

/** 长段落按句读断行，微信里不用横向扫视；列表项续行缩进两格。 */
function wrapLongLines(text, max) {
  return text
    .split('\n')
    .map((line) => {
      if (line.length <= max) return line
      if (/^[【「]/.test(line)) return line
      const bullet = /^[ \t]*[·🔹•▪][ \t]+/.exec(line)
      if (bullet) {
        const prefix = bullet[0]
        const wrapped = wrapPlain(line.slice(prefix.length), max)
        return prefix + wrapped.split('\n').join('\n  ')
      }
      const numbered = /^[ \t]*\d+[.、)][ \t]+/.exec(line)
      if (numbered) {
        const prefix = numbered[0]
        return prefix + wrapPlain(line.slice(prefix.length), max).split('\n').join('\n   ')
      }
      return wrapPlain(line, max)
    })
    .join('\n')
}

/**
 * 把模型常输出的 Markdown 渲染成微信友好的纯文本：
 * 表格转键值行、标题转【】、去掉引用/分隔线/强调符、勾选框转 emoji、长段落断行。
 */
export function formatWechatText(input, { maxLine = 140 } = {}) {
  let out = String(input ?? '').replace(/\r\n?/g, '\n')

  // 代码块：去掉围栏，保留内容（行宽交给微信自己折）
  out = out.replace(/```[a-zA-Z0-9_+-]*[ \t]*\n?([\s\S]*?)```/g, (_, code) => code.replace(/\n$/, ''))

  // 表格
  out = out.replace(/(?:^|\n)((?:[ \t]*\|[^\n]*\|[ \t]*\n?)+)/g, (_, table) => `\n${tableToLines(table)}\n`)

  // 分隔线
  out = out.replace(/^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm, '──────────')

  // 标题
  out = out.replace(/^[ \t]{0,3}#{1,6}[ \t]+(.+?)[ \t]*#*$/gm, '【$1】')

  // 引用
  out = out.replace(/^[ \t]{0,3}>[ \t]?/gm, '')

  // 图片 / 链接
  out = out.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, url) => alt || url)
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1（$2）')

  // 强调
  out = out.replace(/(\*\*|__)(.+?)\1/g, '$2')
  out = out.replace(/~~(.+?)~~/g, '$1')
  out = out.replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)(?!\s)\*(?!\*)/g, '$1$2')
  out = out.replace(/`([^`\n]+)`/g, '$1')

  // 列表 / 勾选框
  out = out.replace(/^[ \t]{0,3}[-*+][ \t]+/gm, '· ')
  out = out.replace(/\[[ ]\]/g, '⬜')
  out = out.replace(/\[[xX]\]/g, '✅')

  // 长段落断行 + 空行收敛
  out = wrapLongLines(out, maxLine)
  out = out.replace(/[ \t]+$/gm, '')
  out = out.replace(/\n{3,}/g, '\n\n')
  return out.trim()
}

// ---------------------------------------------------------------------------
// 选项 / 审批转发（纯函数：排版与解析，单测直接调用）
// ---------------------------------------------------------------------------

/** 微信里选项提示的最大字数，超了会分条发送。 */
const OPTION_PROMPT_MAX = 1800

/** 审批允许的同义词（小写比较）。 */
const APPROVE_WORDS = ['1', '允许', '同意', '可以', '行', 'ok', 'yes', 'y', 'allow']
/** 审批拒绝的同义词（小写比较）。 */
const REJECT_WORDS = ['2', '拒绝', '不允许', '不同意', '不行', 'no', 'n', 'deny', 'reject']

/**
 * 把一道 ask_user_question 排成微信文本：问句 + 编号选项 + 回复说明。
 * @param {object} question 服务层的 AskUserQuestionItem
 * @param {number} index 当前题号（从 0 开始）
 * @param {number} total 本轮总题数
 * @param {{ timeoutSec?: number }} [options] 超时提示秒数
 * @returns {string} 微信文本
 */
function formatQuestionPrompt(question, index, total, { timeoutSec = 0 } = {}) {
  const options = Array.isArray(question?.options) ? question.options : []
  const lines = []
  const step = total > 1 ? `（第 ${index + 1}/${total} 题）` : ''
  lines.push(`🧩 DSH 需要你选择${step}`)
  if (question?.header) lines.push(`【${String(question.header).trim()}】`)
  lines.push(String(question?.question ?? '').trim())
  if (question?.detail) lines.push(String(question.detail).trim())
  if (options.length > 0) {
    lines.push('')
    options.forEach((option, i) => {
      const description = option?.description ? ` —— ${option.description}` : ''
      lines.push(`${i + 1}. ${String(option?.label ?? '')}${description}`)
    })
    lines.push('')
    lines.push(
      question?.multiSelect === true
        ? '回复序号选择，多选用逗号（如 1,3）；也可以直接回复你自己的答案。'
        : '回复序号选择；也可以直接回复你自己的答案。',
    )
  } else {
    lines.push('')
    lines.push('直接回复你的答案即可。')
  }
  if (timeoutSec > 0) lines.push(`（${timeoutSec} 秒内回复有效，超时转到电脑端）`)
  return lines.join('\n').slice(0, OPTION_PROMPT_MAX)
}

/**
 * 解析「1」「1,3」「1，3」这类序号回复。
 * @param {string} text 微信原文
 * @returns {number[] | null} 序号数组；不是纯序号时返回 null
 */
function parseNumberList(text) {
  const value = String(text ?? '').trim()
  if (!/^\d+(\s*[,，、]\s*\d+)*$/.test(value)) return null
  return value
    .split(/[,，、]/)
    .map((part) => Number(part.trim()))
    .filter((number) => Number.isFinite(number))
}

/**
 * 把一条微信回复解析成 AskUserQuestionAnswerItem。
 * 纯数字按选项序号；与某个选项完全同名也算选中；其余文字作为自定义答案。
 * @param {string} text 微信原文
 * @param {object} question 服务层的 AskUserQuestionItem
 * @returns {{ answer?: object, error?: string }}
 */
function parseQuestionReply(text, question) {
  const raw = String(text ?? '').trim()
  if (!raw) return { error: '回复不能为空' }
  const options = Array.isArray(question?.options) ? question.options : []
  const id = String(question?.id ?? '')
  if (options.length > 0) {
    const numbers = parseNumberList(raw)
    if (numbers && numbers.length > 0) {
      const outOfRange = numbers.find((number) => number < 1 || number > options.length)
      if (outOfRange !== undefined) return { error: `序号 ${outOfRange} 超出范围（1-${options.length}）` }
      if (question?.multiSelect !== true && numbers.length > 1) return { error: '这题只能选一个，请只回一个序号' }
      const selected = []
      for (const number of numbers) {
        const label = String(options[number - 1]?.label ?? '')
        if (label && !selected.includes(label)) selected.push(label)
      }
      return { answer: { id, selected } }
    }
    const exact = options.find((option) => String(option?.label ?? '') === raw)
    if (exact) return { answer: { id, selected: [String(exact.label)] } }
    return { answer: { id, selected: [], custom: raw } }
  }
  return { answer: { id, selected: [], custom: raw } }
}

/**
 * 取审批请求的可读原因：优先 displayReason（中文），退回 reason。
 * @param {object} request approval/request 的载荷
 * @returns {string} 原因文本，可能为空
 */
function describeApprovalReason(request) {
  const display = request?.displayReason && typeof request.displayReason === 'object' ? request.displayReason : null
  if (display) {
    const preferred = display.zh ?? display['zh-CN'] ?? display.en
    if (typeof preferred === 'string' && preferred.trim()) return preferred.trim()
    const first = Object.values(display).find((value) => typeof value === 'string' && value.trim())
    if (first) return first.trim()
  }
  return String(request?.reason ?? '').trim()
}

/**
 * 把一条审批请求排成微信文本。
 * @param {object} request approval/request 的载荷
 * @param {{ timeoutSec?: number }} [options] 超时提示秒数
 * @returns {string} 微信文本
 */
function formatApprovalPrompt(request, { timeoutSec = 0 } = {}) {
  const lines = ['🔐 DSH 需要你审批']
  const toolName = String(request?.toolName ?? '').trim()
  if (toolName) lines.push(`工具：${toolName}`)
  const reason = describeApprovalReason(request)
  if (reason) lines.push(reason)
  lines.push('')
  lines.push('1. 允许一次')
  lines.push('2. 拒绝')
  lines.push(`回复 1 或 2${timeoutSec > 0 ? `；${timeoutSec} 秒内有效，超时转到电脑端` : ''}`)
  return lines.join('\n').slice(0, OPTION_PROMPT_MAX)
}

/**
 * 解析审批回复。
 * @param {string} text 微信原文
 * @returns {{ outcome?: string, error?: string }} allowed-once / rejected，或错误提示
 */
function parseApprovalReply(text) {
  const value = String(text ?? '').trim().toLowerCase()
  if (!value) return { error: '请回复 1（允许一次）或 2（拒绝）' }
  if (APPROVE_WORDS.includes(value)) return { outcome: 'allowed-once' }
  if (REJECT_WORDS.includes(value)) return { outcome: 'rejected' }
  return { error: '请回复 1（允许一次）或 2（拒绝）' }
}

/**
 * 把毫秒时长排成「3 分 12 秒」这样的中文短句。
 * @param {number} ms 时长
 * @returns {string} 时长文本
 */
function formatDuration(ms) {
  const total = Math.max(0, Math.floor(Number(ms) || 0) / 1000)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = Math.floor(total % 60)
  if (hours > 0) return `${hours} 小时 ${minutes} 分`
  if (minutes > 0) return `${minutes} 分 ${seconds} 秒`
  return `${seconds} 秒`
}

/** 微信里认的会话命令；不在这张表里的 `/xxx` 不拦截，照常发给会话。 */
const WECHAT_COMMANDS = new Set([
  'sessions',
  'ls',
  'list',
  'use',
  'switch',
  'new',
  'current',
  'now',
  'models',
  'model',
  'status',
  'stop',
  'rename',
  'title',
  'history',
  'hist',
  'search',
  'find',
  'approval',
  'policy',
  'help',
  '?',
])

/** `/help` 的说明文本。 */
const WECHAT_HELP_TEXT = [
  '🧭 微信会话命令',
  '/sessions  列出最近会话',
  '/use 2     切到第 2 个会话',
  '/new       换到新会话',
  '/current   查看当前会话',
  '/rename 标题  给当前会话改名',
  '/history 6  看最近 6 条对话',
  '/search 关键词  跨会话搜历史',
  '/models    列出可用模型',
  '/model 2   切换模型（可带推理档：/model 2 high）',
  '/status    会话状态（模型 / 运行 / 队列）',
  '/approval ask|never  审批策略',
  '/stop      停止当前这一轮',
  '/help      这条帮助',
  '',
  '其他消息照常发给当前会话。',
].join('\n')

/**
 * 解析微信侧会话命令。
 * @param {string} text 微信原文
 * @returns {{ name: string, args: string } | null} 命中的命令；不是命令时返回 null
 */
function parseWechatCommand(text) {
  const raw = String(text ?? '').trim()
  const match = /^[\/／]\s*([a-zA-Z?]+)\s*([\s\S]*)$/.exec(raw)
  if (!match) return null
  const name = match[1].toLowerCase()
  if (!WECHAT_COMMANDS.has(name)) return null
  return { name, args: String(match[2] ?? '').trim() }
}

/**
 * 会话在微信里的显示名：标题（没有就用 id）+ 末 8 位。
 * @param {object} item 会话行
 * @returns {string} 显示名
 */
function sessionDisplayName(item) {
  const title = String(item?.title ?? '').trim()
  return title || String(item?.id ?? '').slice(0, 24)
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
    // 跨账号转发：同一会话下，A 号收到的消息也发到 B/C 号的聊天里
    relayAcrossAccounts: c.relayAcrossAccounts !== false,
    relayPrefix: typeof c.relayPrefix === 'string' ? c.relayPrefix : '[{account}] ',
    // 发到微信前按这个宽度按句读断行（中文一行 ~20 字，60 字约三屏）
    formatMaxLine: Number.isFinite(c.formatMaxLine) && c.formatMaxLine >= 20 ? c.formatMaxLine : 60,
    // 选项/审批转发：DSH 里弹出选项（ask_user_question）或审批卡时，也在微信里发一份并接受序号回复
    relayOptions: c.relayOptions !== false,
    // 微信里等选项回复的时长，超时就把问题交还给电脑端（GUI 弹卡）。
    // 比 ask_user_question 的默认 120 秒略短，保证先由微信侧超时、再干净地交给 GUI。
    optionReplyTimeoutMs:
      Number.isFinite(c.optionReplyTimeoutMs) && c.optionReplyTimeoutMs >= 5000
        ? c.optionReplyTimeoutMs
        : 110_000,
    // 进度提示：一轮跑得久时，每隔一段时间在微信里报一次「已经思考多久」
    progressHeartbeat: c.progressHeartbeat !== false,
    progressIntervalMs:
      Number.isFinite(c.progressIntervalMs) && c.progressIntervalMs >= 30_000
        ? c.progressIntervalMs
        : 120_000,
    // 微信消息插入正在跑的对话（steer），而不是排在当前这一轮后面等
    insertWhileBusy: c.insertWhileBusy !== false,
    // 微信里等不到回复时：skip = 直接跳过（选项卡标未作答 / 审批按拒绝）继续这一轮；
    // handoff = 交还电脑端弹卡（没人守在电脑旁时会一直等）
    optionTimeoutMode: c.optionTimeoutMode === 'handoff' ? 'handoff' : 'skip',
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
  const quoteFile = path.join(config.stateDir, 'quotes.json')

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
  /** 正在等微信回复的选项/审批：binding.key → waiter */
  const optionWaits = new Map()

  let mirrorTimer = null
  let mirrorBusy = false
  let saveTimer = null
  let progressTimer = null

  // 构造时先读一次状态：工具与测试可以直接使用绑定表；start() 会再读一次（幂等）
  loadState()

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

  // -- 引用（ref_msg）解析 -------------------------------------------------

  const QUOTE_MAX = 800
  let quotes = {}
  let quoteSaveTimer = null

  function loadQuotes() {
    try {
      const parsed = JSON.parse(fs.readFileSync(quoteFile, 'utf8'))
      if (parsed && typeof parsed === 'object') quotes = parsed
    } catch {
      quotes = {}
    }
  }

  function saveQuotes() {
    if (quoteSaveTimer) return
    quoteSaveTimer = setTimeout(() => {
      quoteSaveTimer = null
      try {
        const entries = Object.entries(quotes).sort((a, b) => Number(b[1]?.at ?? 0) - Number(a[1]?.at ?? 0))
        quotes = Object.fromEntries(entries.slice(0, QUOTE_MAX))
        fs.mkdirSync(config.stateDir, { recursive: true })
        fs.writeFileSync(quoteFile, JSON.stringify(quotes), { encoding: 'utf8', mode: 0o600 })
      } catch (err) {
        log('warn', 'saveQuotes failed', { error: String(err?.message ?? err) })
      }
    }, 800)
  }

  const quoteKey = (accountId, chatId, messageId) => `${accountId}|${chatId}|${messageId}`

  function rememberQuote(accountId, chatId, messageId, text) {
    const id = messageId === undefined || messageId === null ? '' : String(messageId)
    const body = String(text ?? '').trim()
    if (!id || !body) return
    quotes[quoteKey(accountId, chatId, id)] = { text: body.slice(0, 4000), at: Date.now() }
    saveQuotes()
  }

  function lookupQuote(accountId, chatId, messageId) {
    const id = messageId === undefined || messageId === null ? '' : String(messageId)
    if (!id) return ''
    return quotes[quoteKey(accountId, chatId, id)]?.text ?? ''
  }

  /** 取一条 MessageItem 的纯文本（文本/图片/文件等给个可读标签）。 */
  function itemText(item) {
    if (!item || typeof item !== 'object') return ''
    const type = Number(item.type ?? 0)
    if (type === ITEM_TEXT) return String(item.text_item?.text ?? '').trim()
    if (type === 2) return '[图片]'
    if (type === 3) return item.voice_item?.text ? `[语音] ${item.voice_item.text}` : '[语音]'
    if (type === 4) return `[文件 ${item.file_item?.file_name ?? ''}]`.trim()
    if (type === 5) return '[视频]'
    return ''
  }

  /**
   * 解析引用：优先 ref_msg.message_item，其次按 svr_id 查本地引用库，最后退回 title 摘要。
   * 有 partial_text（只引用一段）时按 startindex/endindex 截取。
   */
  function resolveQuoteRef(accountId, chatId, item) {
    const ref = item?.ref_msg
    if (!ref || typeof ref !== 'object') return null
    let full = itemText(ref.message_item)
    if (!full && ref.svr_id) full = lookupQuote(accountId, chatId, ref.svr_id)
    if (!full && ref.title) full = String(ref.title)
    if (!full) return null
    const partial = ref.partial_text
    if (partial && typeof partial === 'object') {
      const start = Number(partial.startindex)
      const end = Number(partial.endindex)
      if (Number.isFinite(start) && Number.isFinite(end) && end > start && end <= full.length) {
        full = full.slice(start, end)
      } else if (partial.start) {
        const at = full.indexOf(String(partial.start))
        if (at >= 0) full = full.slice(at)
      }
    }
    const text = String(full).replace(/\s+/g, ' ').trim()
    return text ? text.slice(0, 2000) : null
  }

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

  /** 下载并解密一条入站媒体（图片/语音/文件/视频），落盘返回路径。 */
  const INBOUND_MAX_BYTES = 100 * 1024 * 1024

  function safeFileStem(name, fallback) {
    const base = String(name ?? '')
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/[\u0000-\u001f]/g, '')
      .trim()
    return (base || fallback).slice(0, 60)
  }

  function payloadOf(item) {
    const type = Number(item?.type ?? 0)
    if (type === 2) return { type, payload: item.image_item }
    if (type === 3) return { type, payload: item.voice_item }
    if (type === 4) return { type, payload: item.file_item }
    if (type === 5) return { type, payload: item.video_item }
    return { type, payload: null }
  }

  async function downloadInboundMedia(item) {
    const { type, payload } = payloadOf(item)
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
    if (encrypted.length > INBOUND_MAX_BYTES) {
      throw new Error(`媒体过大（${Math.round(encrypted.length / 1048576)} MB），上限 100 MB`)
    }
    const plain = aesKeyBase64 ? decryptAesEcb(encrypted, parseAesKeyBase64(aesKeyBase64)) : encrypted
    const dir = path.join(config.stateDir, 'inbound')
    fs.mkdirSync(dir, { recursive: true })
    let ext = 'bin'
    let stem = 'wx'
    if (type === 2) {
      ext = sniffImageExt(plain)
      stem = 'img'
    } else if (type === 3) {
      ext = 'silk'
      stem = 'voice'
    } else if (type === 4) {
      ext = path.extname(String(payload.file_name ?? '')).replace(/^\./, '').toLowerCase() || 'bin'
      stem = safeFileStem(String(payload.file_name ?? '').replace(/\.[^.]+$/, ''), 'file')
    } else if (type === 5) {
      ext = 'mp4'
      stem = 'video'
    }
    const file = path.join(dir, `${stem}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.${ext}`)
    fs.writeFileSync(file, plain)
    return {
      file,
      bytes: plain.length,
      kind: type,
      fileName: type === 4 ? String(payload.file_name ?? '') : '',
      durationMs: Number(payload.playtime ?? payload.play_length ?? 0) || 0,
      encodeType: type === 3 ? Number(payload.encode_type ?? 0) : 0,
    }
  }

  async function describeInbound(accountId, chatId, msg) {
    const items = Array.isArray(msg?.item_list) ? msg.item_list : []
    const parts = []
    for (const item of items) {
      const type = Number(item?.type ?? 0)
      // 微信「引用/回复」：把被引用的原文（或选中的那一段）一起带给模型
      const quoted = resolveQuoteRef(accountId, chatId, item)
      const prefix = quoted ? `【引用】${quoted}\n` : ''
      if (type === ITEM_TEXT) {
        const body = String(item?.text_item?.text ?? '').trim()
        if (body || quoted) parts.push(`${prefix}${body}`.trim())
        continue
      }
      if (![2, 3, 4, 5].includes(type)) continue

      const label =
        type === 2 ? '图片' : type === 3 ? '语音' : type === 4 ? `文件 ${item?.file_item?.file_name ?? ''}`.trim() : '视频'
      try {
        const saved = await downloadInboundMedia(item)
        if (!saved) {
          parts.push(`${prefix}[${label}]（没有可下载的媒体引用）`.trim())
          continue
        }
        log('info', 'inbound media saved', {
          type,
          file: saved.file,
          bytes: saved.bytes,
          name: saved.fileName || undefined,
        })
        const size = `${(saved.bytes / 1024).toFixed(1)} KB`
        const seconds = saved.durationMs > 0 ? `${(saved.durationMs / 1000).toFixed(1)} 秒` : ''
        if (type === 2) {
          parts.push(`${prefix}[图片] 已解密保存到 ${saved.file}（${size}）。看图就用 read_image 打开这个路径。`.trim())
        } else if (type === 3) {
          const asr = String(item?.voice_item?.text ?? '').trim()
          parts.push(
            `${prefix}[语音${seconds ? ` ${seconds}` : ''}] ${asr ? `转写：${asr}` : '（无转写）'}；` +
              `原始文件已保存到 ${saved.file}（${size}，silk 编码，需要转码才能播放）`.trim(),
          )
        } else if (type === 4) {
          parts.push(
            `${prefix}[文件 ${saved.fileName || path.basename(saved.file)}] 已保存到 ${saved.file}（${size}）。`.trim(),
          )
        } else {
          parts.push(`${prefix}[视频${seconds ? ` ${seconds}` : ''}] 已保存到 ${saved.file}（${size}）。`.trim())
        }
      } catch (err) {
        const message = String(err?.message ?? err)
        const { payload } = payloadOf(item)
        log('warn', 'inbound media failed', {
          type,
          error: message,
          hasAeskey: Boolean(payload?.aeskey),
          hasMediaKey: Boolean(payload?.media?.aes_key),
          hasFullUrl: Boolean(payload?.media?.full_url),
          eqpLen: String(payload?.media?.encrypt_query_param ?? '').length,
        })
        parts.push(`${prefix}[${label}] 下载/解密失败：${message}`.trim())
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

  async function promptSession(sessionId, text, signal, mode = 'queue') {
    const controller = requireService('sessionController')
    await controller.prompt(
      { requestId: uid('wx-req'), sessionId, mode, content: [{ type: 'text', text }] },
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

  async function sendToChat({ accountId, toUserId, contextToken, text }) {
    const account = state.accounts[accountId]
    if (!account?.botToken) throw new Error('账号未登录或已移除')
    const chunks = splitText(formatWechatText(text, { maxLine: config.formatMaxLine }), config.maxReplyChars)
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
            `${describeSendError(attempt.ret, attempt.resp?.errmsg)}` +
              `；去掉 context_token 重试仍失败：${describeSendError(retry.ret, retry.resp?.errmsg)}`,
          )
        }
        attempt = retry
      } else if (attempt.ret !== 0) {
        throw new Error(describeSendError(attempt.ret, attempt.resp?.errmsg))
      }
      results.push({
        messageId: attempt.resp?.message_id ?? null,
        ret: attempt.ret,
        withoutContextToken: fallback,
      })
      // 记住这条自己发出的消息，用户以后「引用」它时能还原原文
      rememberQuote(accountId, `user:${toUserId}`, attempt.resp?.message_id, chunk)
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

  /** 把 iLink 的业务错误码翻译成能指导操作的中文说明。 */
  function describeSendError(ret, errmsg) {
    const code = Number(ret)
    const hint =
      code === -2
        ? '（发送上下文失效，通常是 context_token 过期：让对方先给机器人发一条消息即可恢复）'
        : code === -3
          ? '（参数无效：目标微信 id 不对，或该用户还没和机器人建立会话）'
          : code === -14
            ? '（token 已失效，需要重新扫码登录）'
            : ''
    return `sendmessage ret=${code} ${String(errmsg ?? '')}${hint}`.trim()
  }

  async function postMessage(account, msg) {
    const resp = JSON.parse(
      await apiPost(apiBaseOf(account), 'ilink/bot/sendmessage', { msg }, account.botToken),
    )
    const ret = Number(resp?.ret ?? 0)
    if (ret !== 0) throw new Error(describeSendError(ret, resp?.errmsg))
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

  // -- 跨账号转发：A 号收到的消息也送到 B 号的聊天 --------------------------

  function siblingBindings(binding) {
    return Object.values(state.bindings).filter(
      (b) =>
        b.key !== binding.key &&
        b.sessionId === binding.sessionId &&
        b.accountId !== binding.accountId &&
        String(b.toUserId ?? b.chatId ?? '').includes('@im.'),
    )
  }

  /** 转发用摘要：只要能读懂的文本，不带本地路径。 */
  function relaySummary(msg) {
    const items = Array.isArray(msg?.item_list) ? msg.item_list : []
    return items
      .map((item) => itemText(item))
      .filter(Boolean)
      .join('\n')
      .trim()
  }

  // -- 任务进度播报 --------------------------------------------------------

  const REPORT_ICON = { done: '✅', doing: '🔄', todo: '⬜', blocked: '⛔', warn: '⚠️' }

  function renderReport({ title, steps, note }) {
    const lines = [`📋 ${String(title ?? '任务进度').trim()}`]
    const list = Array.isArray(steps) ? steps : []
    list.forEach((step, index) => {
      const name = typeof step === 'string' ? step : String(step?.name ?? '')
      const status = typeof step === 'string' ? 'todo' : String(step?.status ?? 'todo')
      lines.push(`${REPORT_ICON[status] ?? '⬜'} ${index + 1}. ${name}`)
    })
    if (note) lines.push(`\n${String(note).trim()}`)
    lines.push(`\n— dsh-channel-wechat v${CHANNEL_VERSION}`)
    return lines.join('\n')
  }

  async function sendReport({ accountId, toUserId, title, steps, note, text }) {
    const all = Object.values(state.bindings)
    const real = all.filter((b) => String(b.toUserId ?? b.chatId ?? '').includes('@im.'))
    const target = toUserId
      ? all.find(
          (b) =>
            (!accountId || b.accountId === accountId) &&
            (b.toUserId === toUserId || b.chatId === `user:${toUserId}`),
        )
      : (accountId ? real.filter((b) => b.accountId === accountId) : real).sort(
          (a, b) => Number(b.lastInboundAt ?? 0) - Number(a.lastInboundAt ?? 0),
        )[0]
    if (!target) throw new Error('没有可用的微信会话：先让对方给机器人发一条消息')
    const body = text ? String(text) : renderReport({ title, steps, note })
    try {
      await sendToBinding(target, body)
      return { ok: true, delivered: true, key: target.key, text: body }
    } catch (err) {
      const queued = normalizePending(target.pending).length
      log('warn', 'report queued', { key: target.key, error: String(err?.message ?? err) })
      return {
        ok: false,
        delivered: false,
        queued,
        key: target.key,
        error: String(err?.message ?? err),
        text: body,
        hint: '消息已进发送队列，等对方下次给机器人发消息（刷新 context_token）后自动补发',
      }
    }
  }

  async function relayInbound(binding, msg) {
    if (!config.relayAcrossAccounts) return []
    const siblings = siblingBindings(binding)
    if (siblings.length === 0) return []
    const body = relaySummary(msg) || '[非文本消息]'
    const name = state.accounts[binding.accountId]?.name ?? binding.accountId
    const prefix = String(config.relayPrefix).replace('{account}', name)
    const text = `${prefix}${body}`.slice(0, Math.max(200, config.maxReplyChars))
    const sent = []
    for (const sibling of siblings) {
      try {
        await sendToBinding(sibling, text)
        sent.push(sibling.key)
      } catch (err) {
        log('warn', 'relay failed', {
          from: binding.key,
          to: sibling.key,
          error: String(err?.message ?? err),
        })
      }
    }
    if (sent.length) log('info', 'relayed inbound', { from: binding.key, to: sent })
    return sent
  }

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
      const plain = reply || '（本轮没有产生文本回复）'
      await sendToBinding(binding, plain)
      return { sessionId, reply: plain }
    } finally {
      binding.turnActive = false
      binding.lastInboundAt = Date.now()
      saveState()
    }
  }

  // -- 选项 / 审批：DSH 弹选项时也发到微信 ---------------------------------

  function bindingsOfSession(sessionId) {
    return Object.values(state.bindings).filter((binding) => binding && binding.sessionId === sessionId)
  }

  function optionTargets(sessionId) {
    return bindingsOfSession(sessionId).filter((binding) => Boolean(state.accounts[binding.accountId]?.botToken))
  }

  function disposeOptionWaiter(waiter) {
    for (const key of waiter.keys) {
      if (optionWaits.get(key) === waiter) optionWaits.delete(key)
    }
    if (waiter.timer) clearTimeout(waiter.timer)
    waiter.timer = null
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort)
  }

  function waitOptionReply({ keys, kind, signal, timeoutMs }) {
    return new Promise((resolve) => {
      const waiter = { keys: [...keys], kind, signal, settled: false, timer: null, onAbort: null }
      const settle = (result) => {
        if (waiter.settled) return
        waiter.settled = true
        disposeOptionWaiter(waiter)
        resolve(result)
      }
      waiter.settle = settle
      for (const key of waiter.keys) optionWaits.set(key, waiter)
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        waiter.timer = setTimeout(() => settle({ status: 'timeout' }), timeoutMs)
        if (typeof waiter.timer?.unref === 'function') waiter.timer.unref()
      }
      if (signal) {
        waiter.onAbort = () => settle({ status: 'aborted' })
        if (signal.aborted) waiter.onAbort()
        else signal.addEventListener('abort', waiter.onAbort, { once: true })
      }
    })
  }

  async function sendOptionPrompt(targets, text) {
    let sent = 0
    for (const binding of targets) {
      try {
        await sendToBinding(binding, text)
        sent += 1
      } catch (err) {
        log('warn', 'option prompt send failed', { key: binding.key, error: String(err?.message ?? err) })
      }
    }
    return sent
  }

  /**
   * DSH 弹出 ask_user_question 时把题目发到绑定的微信，等微信回复序号/文字。
   * @returns {Promise<{answers: object[]} | undefined>} 答案；undefined 表示交还电脑端（GUI 弹卡）
   */
  async function relayUserQuestion(request) {
    if (!config.relayOptions) return undefined
    const sessionId = request?.agent?.id
    if (!sessionId) return undefined
    const questions = Array.isArray(request.questions) ? request.questions : []
    if (questions.length === 0) return undefined
    const targets = optionTargets(sessionId)
    if (targets.length === 0) return undefined
    const keys = targets.map((binding) => binding.key)
    const timeoutSec = Math.round(config.optionReplyTimeoutMs / 1000)
    const answers = []
    for (let index = 0; index < questions.length; index += 1) {
      const question = questions[index]
      const prompt = formatQuestionPrompt(question, index, questions.length, { timeoutSec })
      if ((await sendOptionPrompt(targets, prompt)) === 0) return undefined
      let answer = null
      while (answer === null) {
        const reply = await waitOptionReply({
          keys,
          kind: 'question',
          signal: request.signal,
          timeoutMs: config.optionReplyTimeoutMs,
        })
        if (reply.status === 'aborted') return undefined
        if (reply.status === 'timeout') {
          if (config.optionTimeoutMode === 'handoff') {
            void sendOptionPrompt(targets, '⏱ 微信等待超时，这道题已转到电脑端。')
            return undefined
          }
          for (let rest = index; rest < questions.length; rest += 1) {
            answers.push({ id: String(questions[rest].id), selected: [] })
          }
          await sendOptionPrompt(
            targets,
            `⏱ 微信 ${timeoutSec} 秒没收到回复，已按「跳过」继续（这题标记为未作答）。`,
          )
          log('info', 'question timeout skipped', { sessionId, from: index, total: questions.length })
          return { answers }
        }
        const parsed = parseQuestionReply(reply.text, question)
        if (parsed.error) {
          await sendOptionPrompt(targets, `⚠️ ${parsed.error}`)
          continue
        }
        answer = parsed.answer
      }
      answers.push(answer)
      const picked = answer.custom ? `自定义「${answer.custom}」` : answer.selected.join('、')
      await sendOptionPrompt(targets, `✅ 已收到：${picked}`)
    }
    log('info', 'question relayed to wechat', { sessionId, answers: answers.length })
    return { answers }
  }

  /**
   * DSH 请求审批时把审批发到绑定的微信，等 1/2 回复。
   * @returns {Promise<string | undefined>} 'allowed-once' / 'rejected'；undefined 表示交还电脑端
   */
  async function relayApproval(request) {
    if (!config.relayOptions) return undefined
    const sessionId = request?.agent?.id
    if (!sessionId) return undefined
    const targets = optionTargets(sessionId)
    if (targets.length === 0) return undefined
    const keys = targets.map((binding) => binding.key)
    const timeoutSec = Math.round(config.optionReplyTimeoutMs / 1000)
    const prompt = formatApprovalPrompt(request, { timeoutSec })
    if ((await sendOptionPrompt(targets, prompt)) === 0) return undefined
    for (;;) {
      const reply = await waitOptionReply({
        keys,
        kind: 'approval',
        signal: request.signal,
        timeoutMs: config.optionReplyTimeoutMs,
      })
      if (reply.status === 'aborted') return 'cancelled'
      if (reply.status === 'timeout') {
        if (config.optionTimeoutMode === 'handoff') {
          void sendOptionPrompt(targets, '⏱ 微信等待超时，审批已转到电脑端。')
          return undefined
        }
        await sendOptionPrompt(targets, `⏱ 微信 ${timeoutSec} 秒没收到回复，已按「拒绝」继续这一轮。`)
        log('info', 'approval timeout rejected', { sessionId, toolName: request.toolName })
        return 'rejected'
      }
      const parsed = parseApprovalReply(reply.text)
      if (parsed.error) {
        await sendOptionPrompt(targets, `⚠️ ${parsed.error}`)
        continue
      }
      log('info', 'approval relayed to wechat', {
        sessionId,
        toolName: request.toolName,
        outcome: parsed.outcome,
      })
      await sendOptionPrompt(targets, parsed.outcome === 'allowed-once' ? '✅ 已允许一次' : '⛔ 已拒绝')
      return parsed.outcome
    }
  }

  function optionReplyWaiter(accountId, chatId) {
    return optionWaits.get(bindingKeyOf(accountId, chatId))
  }

  // -- 会话切换命令：/sessions /use /new /current /help --------------------

  async function replyText(binding, text) {
    try {
      await sendToBinding(binding, text)
    } catch (err) {
      log('warn', 'command reply failed', { key: binding.key, error: String(err?.message ?? err) })
    }
  }

  function shortSessionId(id) {
    return String(id ?? '').slice(-8)
  }

  function formatSessionRow(item, index, currentId) {
    const marks = []
    if (item.running) marks.push('运行中')
    if (item.id === currentId) marks.push('当前')
    const suffix = marks.length ? `（${marks.join(' · ')}）` : ''
    return `${index + 1}. ${sessionDisplayName(item)} · ${shortSessionId(item.id)}${suffix}`
  }

  /** 会话列表按最近活动排序；分页只取前 12 条供微信选择。 */
  async function sortedSessions() {
    const rows = await listSessions()
    return rows.sort((a, b) => Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0))
  }

  /** 读取模型目录；老版本 DSH 拿不到时返回 null。 */
  async function modelCatalogOf() {
    const controller = ctx.get('sessionController')
    if (!controller?.modelCatalog) return null
    try {
      return await controller.modelCatalog()
    } catch (err) {
      log('warn', 'model catalog failed', { error: String(err?.message ?? err) })
      return null
    }
  }

  /** 会话当前模型：优先 requestContext，其次 requestHeader。 */
  function currentModelOf(sessionId) {
    const session = ctx.get('sessions')?.get?.(sessionId)
    if (!session) return null
    try {
      const context = session.requestContext?.()
      if (context?.provider && context?.model) return { provider: context.provider, model: context.model }
    } catch {
      /* ignore */
    }
    try {
      const header = session.requestHeader?.()
      const config = header?.config
      if (config?.provider && config?.model) return { provider: config.provider, model: config.model }
    } catch {
      /* ignore */
    }
    return null
  }

  /** 模型目录拍平成 [{ provider, providerName, model }]。 */
  function flattenModelCatalog(catalog) {
    const flat = []
    for (const group of Array.isArray(catalog?.groups) ? catalog.groups : []) {
      for (const model of Array.isArray(group?.models) ? group.models : []) {
        flat.push({ provider: String(group.id), providerName: String(group.name ?? group.id), model })
      }
    }
    return flat
  }

  /**
   * 处理一条微信会话命令。
   * @returns {Promise<boolean>} true 表示已作为命令处理（不再转发给会话）
   */
  async function handleSessionCommand(binding, command) {
    const name = command.name
    if (name === 'help' || name === '?') {
      await replyText(binding, WECHAT_HELP_TEXT)
      return true
    }
    if (name === 'current' || name === 'now') {
      const rows = await sortedSessions()
      const current = rows.find((item) => item.id === binding.sessionId)
      const live = Boolean(ctx.get('sessions')?.get?.(binding.sessionId))
      const lines = ['📌 当前会话']
      lines.push(current ? `${sessionDisplayName(current)} · ${shortSessionId(current.id)}` : `${binding.sessionId}（不在会话列表里）`)
      lines.push(
        `状态：${live ? '在线' : binding.explicit ? '未打开（下条消息会尝试打开）' : '自动会话（下条消息新建）'}`,
      )
      lines.push(`绑定：${binding.explicit ? '手动绑定' : '自动会话'}`)
      await replyText(binding, lines.join('\n'))
      return true
    }
    if (name === 'models') {
      const catalog = await modelCatalogOf()
      const flat = flattenModelCatalog(catalog)
      if (flat.length === 0) {
        await replyText(binding, '（这个 DSH 版本拿不到模型目录）')
        return true
      }
      binding.modelOptions = flat.map((item) => ({ provider: item.provider, model: String(item.model.id) }))
      saveState(true)
      const current = currentModelOf(binding.sessionId)
      const fallback = catalog?.default
      const lines = ['🧠 可用模型（回 /model 序号 切换）']
      const limit = Math.min(flat.length, 20)
      for (let index = 0; index < limit; index += 1) {
        const item = flat[index]
        const marks = []
        if (current && current.provider === item.provider && current.model === String(item.model.id)) marks.push('当前')
        if (fallback && fallback.provider === item.provider && fallback.model === String(item.model.id)) marks.push('默认')
        const efforts =
          Array.isArray(item.model.reasoning?.efforts) && item.model.reasoning.efforts.length > 0
            ? `，推理档 ${item.model.reasoning.efforts.map((effort) => effort.id).join('/')}`
            : ''
        lines.push(
          `${index + 1}. ${item.providerName} / ${item.model.name}（${item.model.id}${efforts}）` +
            `${marks.length ? ` ← ${marks.join(' · ')}` : ''}`,
        )
      }
      if (flat.length > limit) lines.push(`（共 ${flat.length} 个，只列前 ${limit}）`)
      lines.push('', '例如：/model 2   或   /model 2 high')
      await replyText(binding, lines.join('\n'))
      return true
    }
    if (name === 'model') {
      const args = command.args
      const controller = ctx.get('sessionController')
      if (!args) {
        const catalog = await modelCatalogOf()
        const current = currentModelOf(binding.sessionId)
        const lines = ['🧠 模型']
        lines.push(current ? `当前：${current.provider} / ${current.model}` : '当前：会话还没打开，读不到（打开后再 /model）')
        if (catalog?.default) lines.push(`默认：${catalog.default.provider} / ${catalog.default.model}`)
        lines.push('', '发 /models 看清单，/model 序号 切换。')
        await replyText(binding, lines.join('\n'))
        return true
      }
      let selection = null
      const numbered = /^(\d+)(?:\s+([\w.-]+))?$/.exec(args)
      if (numbered) {
        const options = Array.isArray(binding.modelOptions) ? binding.modelOptions : []
        const entry = options[Number(numbered[1]) - 1]
        if (!entry) {
          await replyText(binding, `序号 ${numbered[1]} 不在上次列表里，先发 /models 重新取列表。`)
          return true
        }
        selection = { provider: entry.provider, model: entry.model }
        if (numbered[2]) selection.reasoningEffort = numbered[2]
      } else if (/^[\w.-]+\s*\/\s*[\w.:-]+$/.test(args)) {
        const [provider, model] = args.split('/').map((part) => part.trim())
        selection = { provider, model }
      } else {
        await replyText(binding, '用法：/model（看当前）· /model 2（切换）· /model 2 high（带推理档）· /model provider/modelId')
        return true
      }
      if (!controller?.selectModel) {
        await replyText(binding, '⚠️ 这个 DSH 版本不支持切换模型。')
        return true
      }
      try {
        await ensureSession(binding.sessionId)
        const result = await controller.selectModel({ sessionId: binding.sessionId, ...selection })
        const selected = result?.selected ?? selection
        const effort = selected.reasoningEffort ? `（推理档 ${selected.reasoningEffort}）` : ''
        await replyText(binding, `✅ 已切换模型：${selected.provider} / ${selected.model}${effort}\n下一轮生效。`)
        log('info', 'model switched from wechat', {
          key: binding.key,
          sessionId: binding.sessionId,
          provider: selected.provider,
          model: selected.model,
          reasoningEffort: selected.reasoningEffort ?? null,
        })
      } catch (err) {
        await replyText(binding, `⚠️ 切换模型失败：${String(err?.message ?? err)}`)
      }
      return true
    }
    if (name === 'status') {
      const controller = ctx.get('sessionController')
      const rows = await sortedSessions()
      const row = rows.find((item) => item.id === binding.sessionId)
      const session = ctx.get('sessions')?.get?.(binding.sessionId)
      let state = null
      if (controller?.state) {
        try {
          state = await controller.state({ sessionId: binding.sessionId }, new AbortController().signal)
        } catch (err) {
          log('warn', 'session state failed', { error: String(err?.message ?? err) })
        }
      }
      const current = currentModelOf(binding.sessionId)
      const pending = Array.isArray(state?.pendingInput) ? state.pendingInput : []
      const lines = ['📊 会话状态']
      lines.push(row ? `${sessionDisplayName(row)} · ${shortSessionId(row.id)}` : `${binding.sessionId}（不在会话列表里）`)
      lines.push(
        `在线：${session ? '是' : '否'} · 运行中：${state ? (state.running ? '是' : '否') : isSessionBusy(binding.sessionId) ? '是' : '否'}`,
      )
      lines.push(current ? `模型：${current.provider} / ${current.model}` : '模型：读不到（会话未打开）')
      if (state) {
        lines.push(
          `队列：${Array.isArray(state.queue) ? state.queue.length : 0} 条${pending.length ? ` · 待输入：${pending.join(' / ')}` : ''}`,
        )
      }
      const cwd = row?.cwd ?? session?.header?.cwd
      if (cwd) lines.push(`目录：${cwd}`)
      lines.push(`绑定：${binding.explicit ? '手动绑定' : '自动会话'}`)
      await replyText(binding, lines.join('\n'))
      return true
    }
    if (name === 'stop') {
      const controller = ctx.get('sessionController')
      if (!controller?.cancel) {
        await replyText(binding, '⚠️ 这个 DSH 版本不支持停止。')
        return true
      }
      if (!isSessionBusy(binding.sessionId)) {
        await replyText(binding, '没有在跑的轮次，不用停。')
        return true
      }
      try {
        controller.cancel({ sessionId: binding.sessionId })
        await replyText(binding, '🛑 已请求停止当前这一轮；排队的消息还在，需要的话发 /new 或继续发消息。')
        log('info', 'cancel requested from wechat', { key: binding.key, sessionId: binding.sessionId })
      } catch (err) {
        await replyText(binding, `⚠️ 停止失败：${String(err?.message ?? err)}`)
      }
      return true
    }
    if (name === 'rename' || name === 'title') {
      const title = String(command.args ?? '').trim().slice(0, 60)
      if (!title) {
        await replyText(binding, '用法：/rename 新标题')
        return true
      }
      const controller = ctx.get('sessionController')
      if (!controller?.rename) {
        await replyText(binding, '⚠️ 这个 DSH 版本不支持改名。')
        return true
      }
      try {
        await ensureSession(binding.sessionId)
        const result = await controller.rename({ sessionId: binding.sessionId, title })
        await replyText(binding, `✅ 会话已改名为：${result?.title ?? title}`)
        log('info', 'session renamed from wechat', { key: binding.key, sessionId: binding.sessionId, title })
      } catch (err) {
        await replyText(binding, `⚠️ 改名失败：${String(err?.message ?? err)}`)
      }
      return true
    }
    if (name === 'history' || name === 'hist') {
      const requested = Number(command.args)
      const count = Number.isFinite(requested) && requested > 0 ? Math.min(20, Math.trunc(requested)) : 6
      const controller = ctx.get('sessionController')
      if (!controller?.events) {
        await replyText(binding, '⚠️ 这个 DSH 版本读不了历史。')
        return true
      }
      try {
        const page = await controller.events(
          { address: { kind: 'session', sessionId: binding.sessionId }, maxMessages: count * 4 },
          new AbortController().signal,
        )
        const records = Array.isArray(page?.records) ? page.records : []
        const rows = []
        for (const record of records) {
          const event = record?.event ?? record
          const type = String(event?.type ?? '')
          if (type !== 'user/message' && type !== 'assistant/message') continue
          const data = event.data ?? {}
          const message = type === 'assistant/message' ? data.message : data
          const text = textOfMessage(message)
          if (!text) continue
          rows.push({ role: type === 'user/message' ? '你' : 'DSH', text })
        }
        const tail = rows.slice(-count)
        if (tail.length === 0) {
          await replyText(binding, '（这段会话里还没有可读的对话）')
          return true
        }
        const lines = [`📜 最近 ${tail.length} 条`]
        for (const row of tail) {
          const oneLine = row.text.replace(/\s+/g, ' ').trim()
          lines.push(`${row.role}：${oneLine.length > 140 ? `${oneLine.slice(0, 140)}…` : oneLine}`)
        }
        await replyText(binding, lines.join('\n'))
      } catch (err) {
        await replyText(binding, `⚠️ 读历史失败：${String(err?.message ?? err)}`)
      }
      return true
    }
    if (name === 'search' || name === 'find') {
      const query = String(command.args ?? '').trim()
      if (!query) {
        await replyText(binding, '用法：/search 关键词')
        return true
      }
      const controller = ctx.get('sessionController')
      if (!controller?.search) {
        await replyText(binding, '⚠️ 这个 DSH 版本不支持搜索。')
        return true
      }
      try {
        const result = await controller.search({ query }, new AbortController().signal)
        const items = Array.isArray(result?.items) ? result.items : []
        if (items.length === 0) {
          await replyText(binding, `没有找到包含「${query}」的会话。`)
          return true
        }
        const rows = await sortedSessions()
        const shown = items.slice(0, 8)
        binding.sessionOptions = shown.map((item) => String(item.sessionId))
        saveState(true)
        const lines = [`🔎 「${query}」找到 ${items.length} 个会话（/use 序号 切过去）`]
        shown.forEach((item, index) => {
          const row = rows.find((candidate) => candidate.id === String(item.sessionId))
          const name = row ? `${sessionDisplayName(row)} · ${shortSessionId(row.id)}` : shortSessionId(item.sessionId)
          const snippet = String(item.snippet ?? '').replace(/\s+/g, ' ').trim()
          lines.push(`${index + 1}. ${name}`)
          if (snippet) lines.push(`   ${snippet.length > 120 ? `${snippet.slice(0, 120)}…` : snippet}`)
        })
        if (result.hasMore) lines.push('（还有更多结果，换更具体的关键词试试）')
        await replyText(binding, lines.join('\n'))
      } catch (err) {
        await replyText(binding, `⚠️ 搜索失败：${String(err?.message ?? err)}`)
      }
      return true
    }
    if (name === 'approval' || name === 'policy') {
      const controller = ctx.get('approval')
      const session = ctx.get('sessions')?.get?.(binding.sessionId)
      const agent = ctx.get('agents')?.get?.(binding.sessionId)
      const value = String(command.args ?? '').trim().toLowerCase()
      if (!value) {
        if (!controller?.overrideOf) {
          await replyText(binding, '⚠️ 这个 DSH 版本不支持查看审批策略。')
          return true
        }
        const current = session ? controller.overrideOf(session) : undefined
        const lines = ['🔐 审批策略']
        lines.push(`当前：${current ?? 'ask（默认，需要时询问）'}`)
        lines.push('', '/approval ask 需要时询问 · /approval never 需要审批的操作直接拒绝')
        await replyText(binding, lines.join('\n'))
        return true
      }
      if (value !== 'ask' && value !== 'never') {
        await replyText(binding, '用法：/approval ask 或 /approval never')
        return true
      }
      if (!controller?.setPolicy) {
        await replyText(binding, '⚠️ 这个 DSH 版本不支持切换审批策略。')
        return true
      }
      if (!agent) {
        await replyText(binding, '⚠️ 会话没打开，先在电脑端打开它或先发一条消息。')
        return true
      }
      try {
        controller.setPolicy(agent, value)
        await replyText(binding, `✅ 审批策略已切到「${value}」（随会话保存，下一轮生效）`)
        log('info', 'approval policy switched from wechat', {
          key: binding.key,
          sessionId: binding.sessionId,
          policy: value,
        })
      } catch (err) {
        await replyText(binding, `⚠️ 切换审批策略失败：${String(err?.message ?? err)}`)
      }
      return true
    }
    if (name === 'sessions' || name === 'ls' || name === 'list') {
      const rows = (await sortedSessions()).slice(0, 12)
      if (rows.length === 0) {
        await replyText(binding, '（没有可切换的会话）')
        return true
      }
      binding.sessionOptions = rows.map((item) => item.id)
      saveState(true)
      const lines = ['📚 最近会话（回 /use 序号 切换）']
      rows.forEach((item, index) => lines.push(formatSessionRow(item, index, binding.sessionId)))
      lines.push('', '其他：/new 新会话 · /current 当前 · /help 帮助')
      await replyText(binding, lines.join('\n'))
      return true
    }
    if (name === 'new') {
      if (binding.turnActive) {
        await replyText(binding, '⏳ 这一轮还在回复，等结束再 /new。')
        return true
      }
      unbindSession(binding.key)
      await replyText(binding, '🆕 已换到新会话：下一条消息会开一段新对话（原会话仍保留在电脑端）。')
      return true
    }
    if (name === 'use' || name === 'switch') {
      if (binding.turnActive) {
        await replyText(binding, '⏳ 这一轮还在回复，等结束再切换。')
        return true
      }
      const args = command.args
      if (!args) {
        await replyText(binding, '用法：/use 序号（先发 /sessions 拿列表），或 /use <会话 id>')
        return true
      }
      let targetId = ''
      if (/^\d+$/.test(args)) {
        const options = Array.isArray(binding.sessionOptions) ? binding.sessionOptions : []
        targetId = String(options[Number(args) - 1] ?? '')
        if (!targetId) {
          await replyText(binding, `序号 ${args} 不在上次列表里，先发 /sessions 重新取列表。`)
          return true
        }
      } else {
        targetId = args.replace(/^[<"'（(]+|[>"'）)]+$/g, '').trim()
      }
      let live = Boolean(ctx.get('sessions')?.get?.(targetId))
      if (!live) {
        const controller = ctx.get('sessionController')
        if (controller?.resolveAgent) {
          try {
            const resolved = await controller.resolveAgent(targetId)
            if (resolved?.error) {
              await replyText(binding, `⚠️ 打不开这个会话：${resolved.error.code ?? 'unknown'}`)
              return true
            }
            live = Boolean(resolved?.agent) || Boolean(ctx.get('sessions')?.get?.(targetId))
          } catch (err) {
            log('warn', 'switch session failed', { key: binding.key, error: String(err?.message ?? err) })
          }
        }
      }
      if (!live) {
        await replyText(binding, '⚠️ 这个会话现在打不开（可能已归档或不在本机），先在电脑端打开它再试。')
        return true
      }
      const rows = await sortedSessions()
      const known = rows.find((item) => item.id === targetId)
      const result = bindSession(binding.key, targetId)
      if (!result?.ok) {
        await replyText(binding, `⚠️ 切换失败：${result?.message ?? '未知原因'}`)
        return true
      }
      log('info', 'session switched from wechat', { key: binding.key, sessionId: targetId })
      const label = known ? `${sessionDisplayName(known)} · ${shortSessionId(known.id)}` : shortSessionId(targetId)
      await replyText(binding, `✅ 已切换到：${label}\n下一条消息会发到这里。`)
      return true
    }
    return false
  }

  // -- 进度提示：一轮跑得久时，隔一段时间报一次「已经思考多久」 -------------

  /** sessionId → { startedAt, beats } */
  const activeTurns = new Map()

  /**
   * 这个会话现在是不是有一轮在跑（能插话的那种）。
   * 依据是 turn/start・turn/end 的跟踪，加上微信自己这一轮 started 但事件还没到的窗口。
   * @param {string} sessionId 会话 id
   * @returns {boolean} true 表示正在跑
   */
  function isSessionBusy(sessionId) {
    if (!sessionId) return false
    if (activeTurns.has(String(sessionId))) return true
    return Object.values(state.bindings).some((item) => item.sessionId === sessionId && item.turnActive)
  }

  /**
   * 记录会话的开轮/收轮，供进度提示使用。
   * @param {object|string} session 会话对象或会话 id
   * @param {{ type?: string }} event Session 事件
   */
  function observeSessionEvent(session, event) {
    const sessionId = String(session?.id ?? session ?? '')
    if (!sessionId) return
    const type = String(event?.type ?? '')
    if (type === 'turn/start') {
      if (!activeTurns.has(sessionId)) activeTurns.set(sessionId, { startedAt: Date.now(), beats: 0 })
      return
    }
    if (type === 'turn/end') activeTurns.delete(sessionId)
  }

  async function sendProgressMessage(binding, text) {
    try {
      await sendToChat({
        accountId: binding.accountId,
        toUserId: binding.toUserId || String(binding.chatId).replace(/^user:/, ''),
        contextToken: binding.contextToken,
        text,
      })
      binding.lastOutboundAt = Date.now()
      return true
    } catch (err) {
      // 进度提示是尽力而为：失败不排队，避免恢复后一次性刷屏
      log('warn', 'progress send failed', { key: binding.key, error: String(err?.message ?? err) })
      return false
    }
  }

  /** 到点就给所有有绑定的会话发一条进度；等待选项回复时改报「等你回复」。 */
  async function progressTick() {
    if (!config.progressHeartbeat) return
    const now = Date.now()
    for (const [sessionId, turn] of [...activeTurns]) {
      const session = ctx.get('sessions')?.get?.(sessionId)
      const stale = !session || now - turn.startedAt > 6 * 3600_000
      if (stale) {
        activeTurns.delete(sessionId)
        continue
      }
      const targets = optionTargets(sessionId)
      if (targets.length === 0) continue
      const elapsed = now - turn.startedAt
      if (elapsed < config.progressIntervalMs * (turn.beats + 1)) continue
      turn.beats += 1
      const label = formatDuration(elapsed)
      for (const binding of targets) {
        const waiting = optionWaits.get(binding.key)
        const text = waiting
          ? `⌛ 在等你回复：已经等了 ${label}\n回复对应序号即可继续；超时会转回电脑端处理。`
          : `⏳ 还在处理：已经思考 ${label}（第 ${turn.beats} 次进度）\nDSH 仍在执行，完成后会把结果发到微信。`
        await sendProgressMessage(binding, text)
      }
      log('info', 'progress sent', {
        sessionId,
        elapsedMs: elapsed,
        beat: turn.beats,
        waiting: targets.some((binding) => Boolean(optionWaits.get(binding.key))),
      })
    }
  }

  function startProgress() {
    if (progressTimer) return
    progressTimer = setInterval(() => {
      void progressTick().catch((err) => log('warn', 'progress tick failed', { error: String(err?.message ?? err) }))
    }, 15_000)
    if (typeof progressTimer?.unref === 'function') progressTimer.unref()
  }

  function stopProgress() {
    if (progressTimer) clearInterval(progressTimer)
    progressTimer = null
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
    const chatId = chatIdOf(msg)
    const text = await describeInbound(accountId, chatId, msg)
    if (!text) return { empty: true }

    // 有选项/审批在等微信回复：这条消息当作答案消费掉，不再转发给会话
    const waiting = optionReplyWaiter(accountId, chatId)
    if (waiting) {
      log('info', 'option reply', { accountId, chatId, kind: waiting.kind, chars: text.length })
      waiting.settle({ status: 'ok', text })
      return { optionReply: true, kind: waiting.kind }
    }

    // 会话命令：/sessions /use /new /current /help；表外的 /xxx 照常转发给会话
    const command = parseWechatCommand(text)
    if (command) {
      const bindingForCommand =
        state.bindings[bindingKeyOf(accountId, chatId)] ??
        ensureBinding(accountId, chatId, fromUserId, String(msg?.context_token ?? ''))
      log('info', 'wechat command', { accountId, chatId, command: command.name })
      await handleSessionCommand(bindingForCommand, command)
      return { command: command.name }
    }

    // 记下这条入站原文供后续「引用」回查；用干净摘要（不带本地媒体路径）
    rememberQuote(accountId, chatId, msg?.message_id, relaySummary(msg) || text)
    const binding = ensureBinding(accountId, chatId, fromUserId, String(msg?.context_token ?? ''))
    const signal = monitors.get(accountId)?.abort?.signal ?? new AbortController().signal

    // 会话正在跑：把这条消息直接插进当前对话（steer），不再排在这一轮后面等
    if (config.insertWhileBusy && isSessionBusy(binding.sessionId)) {
      const framed = config.messagePrefix ? `${config.messagePrefix}${text}` : text
      try {
        await promptSession(binding.sessionId, framed, signal, 'steer')
        binding.lastInboundAt = Date.now()
        saveState()
        const now = Date.now()
        if (!binding.lastInsertAckAt || now - binding.lastInsertAckAt > 10_000) {
          binding.lastInsertAckAt = now
          await replyText(binding, '📥 已插入当前对话（不用等这一轮结束）')
        }
        log('info', 'inbound steered into running turn', {
          accountId,
          chatId,
          sessionId: binding.sessionId,
          chars: text.length,
        })
        return { inserted: true, sessionId: binding.sessionId }
      } catch (err) {
        log('warn', 'steer failed, fall back to queue', { accountId, chatId, error: String(err?.message ?? err) })
      }
    }

    return enqueue(binding.key, async () => {
      log('info', 'inbound', { accountId, chatId, chars: text.length })
      const started = Date.now()
      // 同一会话下还有别的微信号：把这条消息也送到它们那边
      try {
        await relayInbound(binding, msg)
      } catch (err) {
        log('warn', 'relay error', { key: binding.key, error: String(err?.message ?? err) })
      }
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
        const text = textOfMessage(event.data?.message)
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
        const text = textOfMessage(event.data?.message ?? event.data)
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
      options: { relay: config.relayOptions, waiting: optionWaits.size, replyTimeoutMs: config.optionReplyTimeoutMs },
      progress: {
        heartbeat: config.progressHeartbeat,
        intervalMs: config.progressIntervalMs,
        tracking: activeTurns.size,
      },
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
      if (method === 'GET' && route === 'relay-test') {
        if (url.searchParams.get('confirm') !== '1') {
          return json(res, { error: '该接口会真的给其它微信号发消息，加 &confirm=1 再试' }, 400)
        }
        const key = url.searchParams.get('key') || ''
        const text = url.searchParams.get('text') || 'relay test'
        const binding =
          Object.values(state.bindings).find((b) => b.key === key) ??
          Object.values(state.bindings).find((b) => String(b.chatId).includes('@im.'))
        if (!binding) return json(res, { error: '没有可用绑定' }, 404)
        const sent = await relayInbound(binding, { item_list: [{ type: 1, text_item: { text } }] })
        return json(res, { from: binding.key, siblings: siblingBindings(binding).map((b) => b.key), sent })
      }
      if (method === 'GET' && route === 'quote-probe') {
        const chatId = url.searchParams.get('chatId') || 'user:probe'
        let item = {}
        try {
          item = JSON.parse(url.searchParams.get('item') || '{}')
        } catch {
          return json(res, { error: 'item 不是合法 JSON' }, 400)
        }
        return json(res, {
          resolved: resolveQuoteRef('probe', chatId, item),
          quotes: Object.keys(quotes).length,
        })
      }
      if (method === 'GET' && route === 'mirror-probe') {
        const fromParam = Number(url.searchParams.get('from') ?? NaN)
        const send = url.searchParams.get('send') === '1'
        if (send && url.searchParams.get('confirm') !== '1') {
          return json(res, { error: 'send=1 会真的补发消息，加 &confirm=1 再试' }, 400)
        }
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
        if (url.searchParams.get('confirm') !== '1') {
          return json(res, { error: '该接口会真的发 9 条消息，加 &confirm=1 再试' }, 400)
        }
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
    loadQuotes()
    for (const account of accounts()) startMonitor(account.id)
    startMirror()
    startProgress()
    log('info', 'channel started', { accounts: accounts().length, quotes: Object.keys(quotes).length })
  }

  function stop() {
    for (const accountId of [...monitors.keys()]) stopMonitor(accountId)
    stopMirror()
    stopProgress()
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
    relayUserQuestion,
    relayApproval,
    handleInbound,
    observeSessionEvent,
    progressTick,
    waitingOptions: () => optionWaits.size,
    handleHttp,
    sendToChat,
    sendProbe,
    sendReport,
    sendMediaToChat,
    sendToUser: async ({ accountId, toUserId, text }) => {
      const matches = (b) => b.toUserId === toUserId || b.chatId === `user:${toUserId}`
      // 先按指定账号找；找不到就退到任意账号里同一聊天的绑定（调用方常常不知道消息在哪个号上）
      const binding =
        Object.values(state.bindings).find((b) => b.accountId === accountId && matches(b)) ??
        Object.values(state.bindings).find((b) => matches(b))
      if (!binding) {
        throw new Error(
          `没有与 ${toUserId} 的会话记录：微信不接受对陌生人的主动消息，` +
            `先让对方给机器人发一条消息（iLink 会带回 context_token），再发就行`,
        )
      }
      return sendToChat({
        accountId: binding.accountId,
        toUserId,
        contextToken: binding.contextToken ?? '',
        text,
      })
    },
    /** 主动发文本，失败自动进队列（不会因为 token 过期就丢消息）。 */
    sendTextToUser: async ({ accountId, toUserId, text }) => {
      const matches = (b) => b.toUserId === toUserId || b.chatId === `user:${toUserId}`
      const binding =
        Object.values(state.bindings).find((b) => b.accountId === accountId && matches(b)) ??
        Object.values(state.bindings).find((b) => matches(b))
      if (!binding) {
        throw new Error(
          `没有与 ${toUserId} 的会话记录：微信不接受对陌生人的主动消息，` +
            `先让对方给机器人发一条消息（iLink 会带回 context_token），再发就行`,
        )
      }
      try {
        await sendToBinding(binding, text)
        return { ok: true, delivered: true, accountId: binding.accountId, key: binding.key }
      } catch (err) {
        return {
          ok: false,
          delivered: false,
          queued: normalizePending(binding.pending).length,
          accountId: binding.accountId,
          key: binding.key,
          error: String(err?.message ?? err),
          hint: '消息已进发送队列，等对方下次给机器人发消息（刷新 context_token）后自动补发',
        }
      }
    },
    sendFileToUser: async ({ accountId, toUserId, filePath, caption }) => {
      const all = Object.values(state.bindings)
      const isRealChat = (b) => String(b.toUserId ?? b.chatId ?? '').includes('@im.')
      const matches = (b) => b.toUserId === toUserId || b.chatId === `user:${toUserId}`
      const target = toUserId
        ? (all.find((b) => b.accountId === accountId && matches(b)) ?? all.find((b) => matches(b)))
        : (all.filter((b) => isRealChat(b) && (!accountId || b.accountId === accountId)).sort(
            (a, b) => Number(b.lastInboundAt ?? b.lastOutboundAt ?? 0) - Number(a.lastInboundAt ?? a.lastOutboundAt ?? 0),
          )[0] ?? all.filter(isRealChat)[0])
      if (!target) {
        throw new Error('没有可用的微信会话：先让对方给机器人发一条消息（或用 to 显式指定微信用户 id）')
      }
      const resolvedTo = toUserId || target.toUserId || String(target.chatId).replace(/^user:/, '')
      if (!String(resolvedTo).includes('@im.') && !String(resolvedTo).includes('@chatroom')) {
        throw new Error(`发送目标看起来不是真实微信 id：${resolvedTo}（请传 to）`)
      }
      return sendMediaToChat({
        accountId: target.accountId,
        toUserId: resolvedTo,
        contextToken: target.contextToken ?? '',
        filePath,
        caption,
      })
    },
    simulate: async (text, chatId, timeoutMs) => {
      // 自测用：不落盘绑定、不污染 state，直接用临时会话 id
      const sessionId = `wx-${hashId(`simulate:${chatId || 'sim-user'}:${Date.now()}`)}`
      try {
        await ensureSession(sessionId)
        const baseline = currentSeq(sessionId)
        await promptSession(sessionId, text, new AbortController().signal)
        const reply = await waitForReply(sessionId, baseline, new AbortController().signal, timeoutMs)
        return { ok: true, sessionId, reply }
      } catch (err) {
        return { ok: false, sessionId, error: String(err?.message ?? err) }
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
      if (!snapshot.accounts?.length) throw new Error('还没有已登录的微信账号')
      // 不强制指定账号：按目标微信 id 反查绑定，失败自动进队列
      const accountId = args?.accountId
        ? String(args.accountId)
        : snapshot.bindings?.find((b) => b.chatId === `user:${String(args.to)}`)?.accountId
      return channel.sendTextToUser({
        accountId,
        toUserId: String(args.to),
        text: String(args.text),
      })
    },
  })

  register({
    name: 'wechat_report',
    description:
      'Publish a structured task-progress report to WeChat (title + checklist + optional note). ' +
      'Statuses: done / doing / todo / blocked / warn. Falls back to the send queue when the token is stale. ' +
      '把任务进度（标题 + 勾选清单 + 备注）发到微信。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Report title, e.g. "v2.2.0 发布进度".' },
        steps: {
          type: 'array',
          description: 'Checklist items.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Step description.' },
              status: {
                type: 'string',
                enum: ['done', 'doing', 'todo', 'blocked', 'warn'],
                description: 'done=✅ doing=🔄 todo=⬜ blocked=⛔ warn=⚠️',
              },
            },
            required: ['name'],
            additionalProperties: false,
          },
        },
        note: { type: 'string', description: 'Optional extra line, e.g. next steps.' },
        to: { type: 'string', description: 'WeChat user id; defaults to the most recently active chat.' },
        accountId: { type: 'string', description: 'Account to send from; defaults to any.' },
      },
      required: ['title'],
      additionalProperties: false,
    },
    timeoutMs: 120_000,
    output: textOutput('Delivery result: delivered / queued, the rendered text, and any error.'),
    async execute(args) {
      if (!args?.title) throw new Error('title 必填')
      return channel.sendReport({
        title: String(args.title),
        steps: Array.isArray(args?.steps) ? args.steps : [],
        note: args?.note ? String(args.note) : '',
        toUserId: args?.to ? String(args.to) : undefined,
        accountId: args?.accountId ? String(args.accountId) : undefined,
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

  // 选项 / 审批：抢在 Web 客户端桥接之前拿到请求，优先走微信；拿不到（或超时）就 next() 交还 GUI。
  if (typeof ctx.on === 'function') {
    cleanups.push(
      ctx.on(
        'user-questions/request',
        async (request, next) => {
          try {
            const answer = await channel.relayUserQuestion(request)
            if (answer !== undefined) return answer
          } catch (err) {
            try {
              ctx.logger?.warn?.(`[wechat] question relay failed: ${String(err)}`)
            } catch {
              /* ignore */
            }
          }
          return next()
        },
        { prepend: true, global: true },
      ),
    )
    cleanups.push(
      ctx.on(
        'approval/request',
        async (request, next) => {
          try {
            const outcome = await channel.relayApproval(request)
            if (outcome !== undefined) return outcome
          } catch (err) {
            try {
              ctx.logger?.warn?.(`[wechat] approval relay failed: ${String(err)}`)
            } catch {
              /* ignore */
            }
          }
          return next()
        },
        { prepend: true, global: true },
      ),
    )
    // 进度提示要跟着每个会话的开轮/收轮走，所以全局收 session/event
    cleanups.push(
      ctx.on(
        'session/event',
        (session, event) => {
          try {
            channel.observeSessionEvent(session, event)
          } catch (err) {
            try {
              ctx.logger?.warn?.(`[wechat] session event observe failed: ${String(err)}`)
            } catch {
              /* ignore */
            }
          }
        },
        { global: true },
      ),
    )
  }

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

/** 单测钩子：上面这些纯函数只做排版/解析，导出给 test-options.mjs 用，不改变运行时行为。 */
export const __test = {
  formatQuestionPrompt,
  parseQuestionReply,
  parseNumberList,
  formatApprovalPrompt,
  parseApprovalReply,
  describeApprovalReason,
  formatDuration,
  parseWechatCommand,
  sessionDisplayName,
  normalizeConfig,
  createChannel,
}
