// 风险邮件预警自测：node test-risk.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { __test } from './index.js'

const { createChannel, normalizeConfig, detectRisk } = __test
const accountId = 'acct-test'
const chatId = 'user:u-test@im.wechat'
const sessionId = 'sess-risk-01'
const bindingKey = `${accountId}::${chatId}`

const sent = []
const wechat = http.createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => { body += chunk })
  req.on('end', () => {
    if (req.url?.includes('sendmessage')) {
      const parsed = JSON.parse(body || '{}')
      const text = parsed?.msg?.item_list?.[0]?.text_item?.text
      if (text) sent.push(text)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ret: 0, message_id: `m-${sent.length}` }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{}')
  })
})
await new Promise((resolve) => wechat.listen(0, '127.0.0.1', resolve))
const apiBase = `http://127.0.0.1:${wechat.address().port}`

// 极简 SMTP mock
const emails = []
const smtpSockets = new Set()
const smtp = net.createServer((socket) => {
  smtpSockets.add(socket)
  socket.on('close', () => smtpSockets.delete(socket))
  socket.on('error', () => {})
  socket.write('220 mock ESMTP\r\n')
  let buffer = ''
  let inData = false
  let data = ''
  let authStep = 0
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8')
    let idx
    while ((idx = buffer.indexOf('\r\n')) >= 0) {
      const line = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 2)
      if (inData) {
        if (line === '.') {
          inData = false
          emails.push(data)
          socket.write('250 queued\r\n')
        } else {
          data += `${line}\r\n`
        }
        continue
      }
      const upper = line.toUpperCase()
      if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
        socket.write('250-mock\r\n250 AUTH LOGIN\r\n')
      } else if (upper.startsWith('AUTH LOGIN')) {
        authStep = 1
        socket.write('334 VXNlcm5hbWU6\r\n')
      } else if (authStep === 1) {
        authStep = 2
        socket.write('334 UGFzc3dvcmQ6\r\n')
      } else if (authStep === 2) {
        authStep = 0
        socket.write('235 ok\r\n')
      } else if (upper.startsWith('MAIL FROM')) socket.write('250 ok\r\n')
      else if (upper.startsWith('RCPT TO')) socket.write('250 ok\r\n')
      else if (upper.startsWith('DATA')) {
        inData = true
        data = ''
        socket.write('354 go\r\n')
      } else if (upper.startsWith('QUIT')) {
        socket.write('221 bye\r\n')
        socket.end()
      } else socket.write('250 ok\r\n')
    }
  })
})
await new Promise((resolve) => smtp.listen(0, '127.0.0.1', resolve))
const smtpPort = smtp.address().port

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-risk-'))
const makeState = (dir) => {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'state.json'),
    JSON.stringify({
      version: 2,
      accounts: {
        [accountId]: { id: accountId, name: 'test-bot', botToken: 'fake-token', botId: 'bot@im.bot', userId: 'u-test@im.wechat', apiBase, createdAt: Date.now() },
      },
      bindings: {
        [bindingKey]: {
          key: bindingKey,
          accountId,
          chatId,
          toUserId: chatId.replace(/^user:/, ''),
          sessionId,
          explicit: true,
          contextToken: 'ctx-token',
          lastSeq: 0,
        },
      },
      settings: { defaultSessionId: sessionId },
    }),
    'utf8',
  )
}
const stateDir = path.join(root, 'state')
makeState(stateDir)

const prompts = []
const liveSession = { id: sessionId, seq: 0, snapshotEvents: () => [] }
const ctx = {
  get: (name) => {
    if (name === 'sessions') return { get: (id) => (id === sessionId ? liveSession : undefined), list: () => [liveSession] }
    if (name === 'sessionController') {
      return {
        state: async () => ({ running: false, active: false, queue: [], pendingInput: [] }),
        prompt: async (...args) => { prompts.push(args) },
        list: async () => ({ items: [{ sessionId, updatedAt: 1, running: false, projections: { values: { title: '风险测试' } } }] }),
      }
    }
    return undefined
  },
  logger: { info() {}, warn() {}, error() {} },
  on: () => () => {},
}
const baseConfig = {
  ...normalizeConfig({ stateDir }),
  progressHeartbeat: false,
  replyTimeoutMs: 500,
  riskAlert: true,
  riskEmailTo: 'host@example.com',
  riskEmailFrom: 'bot@example.com',
  riskSmtpHost: '127.0.0.1',
  riskSmtpPort: smtpPort,
  riskSmtpSecure: false,
  riskSmtpUser: 'u',
  riskSmtpPass: 'p',
  riskCooldownMs: 300_000,
}
const channel = createChannel(ctx, baseConfig)

const inbound = (channel_, text, messageId) =>
  channel_.handleInbound(accountId, {
    message_type: 1,
    from_user_id: chatId.replace(/^user:/, ''),
    message_id: messageId,
    context_token: 'ctx-token-2',
    item_list: [{ type: 1, text_item: { text } }],
  })
const waitFor = async (predicate, timeoutMs = 2500) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return false
}
const decodeSubject = (raw) => {
  const line = raw.split('\r\n').find((item) => item.startsWith('Subject:')) ?? ''
  const b64 = line.match(/=\?UTF-8\?B\?([^?]+)\?=/)?.[1] ?? ''
  return b64 ? Buffer.from(b64, 'base64').toString('utf8') : line
}
const decodeBody = (raw) => {
  const body = raw.split('\r\n\r\n')[1] ?? ''
  return Buffer.from(body.replace(/\.\r\n$/, ''), 'base64').toString('utf8')
}

let passed = 0
const check = async (name, fn) => {
  await fn()
  passed += 1
  console.log(`ok ${passed} - ${name}`)
}

try {
  await check('detectRisk 命中/不命中/命令不参与', async () => {
    assert.deepEqual(detectRisk('今天天气不错'), [])
    const hits = detectRisk('来赌博吗，加微信 abc123')
    assert.ok(hits.some((hit) => hit.name === '赌博'))
    assert.ok(hits.some((hit) => hit.name === '引流外链'))
    assert.deepEqual(detectRisk(''), [])
  })

  await check('风险消息发邮件，但消息照常进会话', async () => {
    prompts.length = 0
    emails.length = 0
    sent.length = 0
    await inbound(channel, '来赌博吗，加微信 abc123', 'm-1')
    assert.equal(await waitFor(() => emails.length === 1), true, '应有 1 封邮件')
    const raw = emails[0]
    assert.equal(decodeSubject(raw).includes('赌博'), true)
    const body = decodeBody(raw)
    assert.ok(body.includes('来赌博吗'))
    assert.ok(body.includes(chatId))
    assert.ok(body.includes(accountId))
    assert.equal(prompts.length, 1, '消息仍应进入会话（不拦截）')
  })

  await check('非风险消息不发邮件', async () => {
    emails.length = 0
    await inbound(channel, '今天天气不错', 'm-2')
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(emails.length, 0)
  })

  await check('冷却时间内不重复发邮件', async () => {
    emails.length = 0
    await inbound(channel, '继续赌博', 'm-3')
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(emails.length, 0, '冷却内不应再发')
  })

  await check('未配置 SMTP 时静默跳过且不崩', async () => {
    const dir2 = path.join(root, 'state2')
    makeState(dir2)
    const quiet = createChannel(ctx, { ...baseConfig, stateDir: dir2, riskSmtpHost: '', riskEmailTo: '' })
    emails.length = 0
    await inbound(quiet, '赌博测试', 'm-4')
    assert.equal(emails.length, 0)
    assert.equal(prompts.length >= 1, true)
  })

  await check('/risk 查看状态、/risk test 发测试邮件', async () => {
    sent.length = 0
    await inbound(channel, '/risk', 'm-5')
    assert.match(sent[sent.length - 1], /风险消息预警/)
    emails.length = 0
    sent.length = 0
    await inbound(channel, '/risk test', 'm-6')
    assert.equal(await waitFor(() => emails.length === 1), true)
    assert.match(sent[sent.length - 1], /测试邮件已发送/)
  })
} finally {
  channel.stop()
  for (const socket of smtpSockets) socket.destroy()
  smtp.close()
  wechat.closeAllConnections?.()
  wechat.close()
  fs.rmSync(root, { recursive: true, force: true })
}

console.log(`\n${passed} risk checks passed`)
