// token 消耗统计自测：node test-usage.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { __test } from './index.js'

const { createChannel, normalizeConfig, formatTokens } = __test
const accountId = 'acct-test'
const chatId = 'user:u-test@im.wechat'
const sessionId = 'sess-usage-01'
const bindingKey = `${accountId}::${chatId}`

const sent = []
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => { body += chunk })
  req.on('end', () => {
    if (req.url?.includes('sendmessage')) {
      const parsed = JSON.parse(body || '{}')
      sent.push(parsed?.msg?.item_list?.[0]?.text_item?.text ?? '')
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

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-usage-'))
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

const now = Date.now()
const session = {
  id: sessionId,
  seq: 2,
  events: [
    { type: 'assistant/message', seq: 0, time: now, data: { turn: 1, usage: { inputTokens: 60, outputTokens: 40, totalTokens: 100 } } },
    { type: 'assistant/message', seq: 1, time: now, data: { turn: 1, usage: { inputTokens: 30, outputTokens: 70, totalTokens: 100 } } },
    { type: 'user/message', seq: 2, time: now, data: { content: [{ type: 'text', text: 'hi' }] } },
  ],
  snapshotEvents(from = 0, to = this.seq) {
    return this.events.filter((event) => event.seq >= from && event.seq < to)
  },
}
const ctx = {
  get: (name) => {
    if (name === 'sessions') return { get: (id) => (id === sessionId ? session : undefined), list: () => [session] }
    if (name === 'sessionController') {
      return {
        state: async () => ({ running: false, active: false, queue: [], pendingInput: [] }),
        prompt: async () => {},
        list: async () => ({ items: [{ sessionId, updatedAt: 1, running: false, projections: { values: { title: '用量会话' } } }] }),
      }
    }
    return undefined
  },
  logger: { info() {}, warn() {}, error() {} },
  on: () => () => {},
}
const channel = createChannel(ctx, { ...normalizeConfig({ stateDir }), progressHeartbeat: false, replyTimeoutMs: 5000 })

let passed = 0
const check = async (name, fn) => {
  await fn()
  passed += 1
  console.log(`ok ${passed} - ${name}`)
}

try {
  await check('formatTokens 中文短写', async () => {
    assert.equal(formatTokens(0), '0')
    assert.equal(formatTokens(950), '950')
    assert.equal(formatTokens(3200), '3.2k')
    assert.equal(formatTokens(15200), '1.5 万')
    assert.equal(formatTokens(210_000_000), '2.1 亿')
  })

  await check('usageOf 累计 assistant 的 usage', async () => {
    const usage = channel.usageOf(sessionId)
    assert.equal(usage.totalTokens, 200)
    assert.equal(usage.inputTokens, 90)
    assert.equal(usage.outputTokens, 110)
    assert.equal(usage.todayTokens, 200)
    assert.equal(usage.lastTurnTokens, 100)
  })

  await check('增量扫描：重复调用不重复累计，新事件继续累加', async () => {
    assert.equal(channel.usageOf(sessionId).totalTokens, 200)
    session.events.push({
      type: 'assistant/message',
      seq: 3,
      time: now,
      data: { turn: 2, usage: { inputTokens: 20, outputTokens: 30, totalTokens: 50 } },
    })
    session.seq = 4
    const usage = channel.usageOf(sessionId)
    assert.equal(usage.totalTokens, 250)
    assert.equal(usage.todayTokens, 250)
    assert.equal(usage.lastTurnTokens, 50)
  })

  await check('snapshot 绑定里带 usage', async () => {
    const snapshot = channel.snapshot()
    const binding = snapshot.bindings.find((item) => item.key === bindingKey)
    assert.ok(binding)
    assert.equal(binding.usage.totalTokens, 250)
    assert.equal(binding.usage.lastTurnTokens, 50)
  })

  await check('/status 里显示用量', async () => {
    sent.length = 0
    await channel.handleInbound(accountId, {
      message_type: 1,
      from_user_id: chatId.replace(/^user:/, ''),
      message_id: 'm-1',
      context_token: 'ctx-token-2',
      item_list: [{ type: 1, text_item: { text: '/status' } }],
    })
    const reply = sent[sent.length - 1] ?? ''
    assert.match(reply, /用量：250 token/)
    assert.match(reply, /今日 250/)
  })

  await check('缓存读取单列，不混进计费 token', async () => {
    session.events.push({
      type: 'assistant/message',
      seq: 4,
      time: now,
      data: { turn: 3, usage: { inputTokens: 10, outputTokens: 0, cacheReadTokens: 5000, totalTokens: 5010 } },
    })
    session.seq = 5
    const usage = channel.usageOf(sessionId)
    assert.equal(usage.totalTokens, 260)
    assert.equal(usage.inputTokens, 120)
    assert.equal(usage.outputTokens, 140)
    assert.equal(usage.cacheReadTokens, 5000)
    assert.equal(usage.todayTokens, 260)
    assert.equal(usage.todayCacheReadTokens, 5000)
  })
} finally {
  channel.stop()
  server.closeAllConnections?.()
  server.close()
  fs.rmSync(stateDir, { recursive: true, force: true })
}

console.log(`\n${passed} usage checks passed`)
