// 流式分段自测：node test-stream.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { __test } from './index.js'

const { createChannel, normalizeConfig } = __test
const accountId = 'acct-test'
const chatId = 'user:u-test@im.wechat'
const sessionId = 'sess-stream-01'
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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-stream-'))
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
const baseConfig = { ...normalizeConfig({ stateDir }), progressHeartbeat: false, mirrorIntervalMs: 60_000, streamMinChars: 50, streamMinIntervalMs: 0, segmentMaxChars: 200, segmentDelayMs: 0 }
const channel = createChannel(ctx, baseConfig)

const delta = (text) =>
  channel.observeAssistantStream({
    agent: { id: sessionId },
    frame: { type: 'chunk', attemptId: 'a', revision: 1, index: 0, time: Date.now(), chunk: { type: 'text-delta', index: 0, text } },
  })
const waitFor = async (predicate, timeoutMs = 1500) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return false
}

let passed = 0
const check = async (name, fn) => {
  await fn()
  passed += 1
  console.log(`ok ${passed} - ${name}`)
}

try {
  await check('没有空行边界时不发（等整段输出完）', async () => {
    sent.length = 0
    channel.beginWechatTurn(sessionId)
    delta('甲'.repeat(60))
    await new Promise((resolve) => setTimeout(resolve, 80))
    assert.equal(sent.length, 0)
  })

  await check('完整段落（空行结束）立即发送', async () => {
    sent.length = 0
    delta(`\n\n${'乙'.repeat(60)}\n\n`)
    assert.equal(await waitFor(() => sent.length >= 2), true, `实际发送：${JSON.stringify(sent)}`)
    assert.ok(sent[0].startsWith('甲'))
    assert.ok(sent[1].startsWith('乙'))
  })

  await check('最终回复扣掉已发前缀，只发剩余', async () => {
    delta('丙'.repeat(20))
    const full = `${'甲'.repeat(60)}\n\n${'乙'.repeat(60)}\n\n${'丙'.repeat(20)}`
    const remainder = channel.takeStreamRemainder(sessionId, full)
    assert.equal(remainder, '丙'.repeat(20))
  })

  await check('非微信发起的轮次不流式发', async () => {
    sent.length = 0
    channel.endWechatTurn(sessionId)
    delta(`\n\n${'丁'.repeat(60)}\n\n`)
    await new Promise((resolve) => setTimeout(resolve, 80))
    assert.equal(sent.length, 0)
  })

  await check('streamSegment=false 时完全不流式', async () => {
    const quiet = createChannel(ctx, { ...baseConfig, streamSegment: false })
    quiet.beginWechatTurn(sessionId)
    sent.length = 0
    quiet.observeAssistantStream({
      agent: { id: sessionId },
      frame: { type: 'chunk', chunk: { type: 'text-delta', text: `${'戊'.repeat(60)}\n\n` } },
    })
    await new Promise((resolve) => setTimeout(resolve, 80))
    assert.equal(sent.length, 0)
  })
} finally {
  channel.stop()
  server.closeAllConnections?.()
  server.close()
  fs.rmSync(root, { recursive: true, force: true })
}

console.log(`\n${passed} stream checks passed`)
