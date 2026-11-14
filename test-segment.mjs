// 分段发送自测：node test-segment.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { __test } from './index.js'

const { createChannel, normalizeConfig, segmentText, splitByLength } = __test
const accountId = 'acct-test'
const chatId = 'user:u-test@im.wechat'
const sessionId = 'sess-seg-01'
const bindingKey = `${accountId}::${chatId}`

const sent = []
const server = http.createServer((req, res) => {
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
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const apiBase = `http://127.0.0.1:${server.address().port}`

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-seg-'))
const stateDir = path.join(root, 'state')
fs.mkdirSync(stateDir, { recursive: true })
fs.writeFileSync(
  path.join(stateDir, 'state.json'),
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

const liveSession = { id: sessionId, seq: 0, snapshotEvents: () => [] }
const ctx = {
  get: (name) => {
    if (name === 'sessions') return { get: (id) => (id === sessionId ? liveSession : undefined), list: () => [liveSession] }
    return undefined
  },
  logger: { info() {}, warn() {}, error() {} },
  on: () => () => {},
}
const baseConfig = normalizeConfig({ stateDir })
const channel = createChannel(ctx, {
  ...baseConfig,
  progressHeartbeat: false,
  segmentMode: 'paragraph',
  segmentMaxChars: 200,
  segmentDelayMs: 60,
  segmentIndex: true,
})
const send = (text, cfg = channel) =>
  cfg.sendToChat({ accountId, toUserId: chatId.replace(/^user:/, ''), contextToken: 'ctx-token', text })

let passed = 0
const check = async (name, fn) => {
  await fn()
  passed += 1
  console.log(`ok ${passed} - ${name}`)
}

try {
  await check('segmentText：短段落合并、长段落切分、空文本', async () => {
    assert.deepEqual(segmentText('', { maxChars: 200 }), [])
    const merged = segmentText(`${'A'.repeat(80)}\n\n${'B'.repeat(80)}`, { maxChars: 200 })
    assert.equal(merged.length, 1)
    const blocks = `${'A'.repeat(150)}\n\n${'B'.repeat(150)}\n\n${'C'.repeat(150)}`
    const parts = segmentText(blocks, { maxChars: 200 })
    assert.equal(parts.length, 3)
    assert.ok(parts.every((part) => part.length <= 200))
    const long = 'D'.repeat(500)
    const split = segmentText(long, { maxChars: 200 })
    assert.ok(split.length >= 3)
    assert.equal(split.join('').length, 500)
  })

  await check('segmentText：length 模式与旧切分一致', async () => {
    const text = 'E'.repeat(450)
    assert.deepEqual(segmentText(text, { maxChars: 200, mode: 'length' }), splitByLength(text, 200))
  })

  await check('sendToChat：按段落分条、带序号、按间隔发送', async () => {
    sent.length = 0
    const text = `${'A'.repeat(150)}\n\n${'B'.repeat(150)}\n\n${'C'.repeat(150)}`
    const started = Date.now()
    const result = await send(text)
    const elapsed = Date.now() - started
    assert.equal(result.ok, true)
    assert.equal(result.chunks, 3)
    assert.equal(sent.length, 3)
    assert.match(sent[0], /^（1\/3）/)
    assert.match(sent[1], /^（2\/3）/)
    assert.match(sent[2], /^（3\/3）/)
    assert.ok(elapsed >= 100, `间隔不足：${elapsed}ms`)
  })

  await check('segmentIndex=false 时不加序号', async () => {
    const plain = createChannel(ctx, {
      ...baseConfig,
      progressHeartbeat: false,
      segmentMode: 'paragraph',
      segmentMaxChars: 200,
      segmentDelayMs: 0,
      segmentIndex: false,
    })
    sent.length = 0
    await plain.sendToChat({ accountId, toUserId: chatId.replace(/^user:/, ''), contextToken: 'ctx-token', text: `${'A'.repeat(150)}\n\n${'B'.repeat(150)}` })
    assert.equal(sent.length, 2)
    assert.ok(sent.every((item) => !item.startsWith('（')))
    plain.stop()
  })

  await check('segmentMode=length 时单段仍按长度切分', async () => {
    const lengthChannel = createChannel(ctx, {
      ...baseConfig,
      progressHeartbeat: false,
      segmentMode: 'length',
      segmentMaxChars: 200,
      segmentDelayMs: 0,
      segmentIndex: false,
    })
    sent.length = 0
    await lengthChannel.sendToChat({ accountId, toUserId: chatId.replace(/^user:/, ''), contextToken: 'ctx-token', text: 'F'.repeat(450) })
    assert.ok(sent.length >= 3)
    lengthChannel.stop()
  })
} finally {
  channel.stop()
  server.closeAllConnections?.()
  server.close()
  fs.rmSync(root, { recursive: true, force: true })
}

console.log(`\n${passed} segment checks passed`)
