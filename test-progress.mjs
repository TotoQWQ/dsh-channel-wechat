// 进度提示自测（假 iLink 服务，不需要真实微信）：
//   node test-progress.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { __test } from './index.js'

const { createChannel, normalizeConfig, formatDuration } = __test
const accountId = 'acct-test'
const chatId = 'user:u-test@im.wechat'
const sessionId = 'session-test-1'
const bindingKey = `${accountId}::${chatId}`
const step = 100 // 进度间隔（毫秒），测试用
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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
    res.end(JSON.stringify({ ret: 0, updates: [] }))
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const apiBase = `http://127.0.0.1:${server.address().port}`

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-progress-'))
fs.writeFileSync(
  path.join(stateDir, 'state.json'),
  JSON.stringify({
    version: 2,
    accounts: {
      [accountId]: {
        id: accountId,
        name: 'test-bot',
        botToken: 'fake-token',
        botId: 'bot@im.bot',
        userId: chatId.replace(/^user:/, ''),
        apiBase,
        createdAt: Date.now(),
      },
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

const liveSession = { id: sessionId }
const ctx = {
  get: (name) => (name === 'sessions' ? { get: (id) => (id === sessionId ? liveSession : undefined) } : undefined),
  logger: { info() {}, warn() {}, error() {} },
  on: () => () => {},
}
const config = { ...normalizeConfig({ stateDir }), progressIntervalMs: step }
const channel = createChannel(ctx, config)
const inbound = (text, messageId) =>
  channel.handleInbound(accountId, {
    message_type: 1,
    from_user_id: chatId.replace(/^user:/, ''),
    message_id: messageId,
    context_token: 'ctx-token-2',
    item_list: [{ type: 1, text_item: { text } }],
  })

let passed = 0
const check = async (name, fn) => {
  await fn()
  passed += 1
  console.log(`ok ${passed} - ${name}`)
}

try {
  await check('时长格式', async () => {
    assert.equal(formatDuration(4_000), '4 秒')
    assert.equal(formatDuration(65_000), '1 分 5 秒')
    assert.equal(formatDuration(3_700_000), '1 小时 1 分')
  })

  await check('开轮后到点发「还在处理：已经思考 ...」', async () => {
    channel.observeSessionEvent(liveSession, { type: 'turn/start' })
    await sleep(step + 40)
    await channel.progressTick()
    const hit = sent.find((text) => text.includes('还在处理：已经思考'))
    assert.ok(hit, `没有进度消息：${JSON.stringify(sent)}`)
    assert.match(hit, /第 1 次进度/)
  })

  await check('同一间隔内不重复发', async () => {
    const before = sent.filter((text) => text.includes('还在处理')).length
    await channel.progressTick()
    const after = sent.filter((text) => text.includes('还在处理')).length
    assert.equal(after, before, `同一间隔重复发了：${JSON.stringify(sent)}`)
  })

  await check('等选项时进度改报「在等你回复」', async () => {
    const pending = channel.relayUserQuestion({
      agent: { id: sessionId },
      questions: [{ id: 'q', question: '选一个', options: [{ label: 'A' }, { label: 'B' }] }],
      signal: new AbortController().signal,
    })
    await sleep(step * 2 + 80)
    await channel.progressTick()
    assert.ok(sent.some((text) => text.includes('在等你回复')), `没有等待提示：${JSON.stringify(sent)}`)
    await inbound('2', 'msg-1')
    assert.deepEqual(await pending, { answers: [{ id: 'q', selected: ['B'] }] })
  })

  await check('收轮后不再发', async () => {
    channel.observeSessionEvent(liveSession, { type: 'turn/end' })
    sent.length = 0
    await sleep(step + 40)
    await channel.progressTick()
    assert.equal(sent.filter((text) => text.includes('还在处理')).length, 0)
  })

  await check('progressHeartbeat=false 时完全静默', async () => {
    const quiet = createChannel(ctx, { ...config, progressHeartbeat: false })
    quiet.observeSessionEvent(liveSession, { type: 'turn/start' })
    sent.length = 0
    await sleep(step + 40)
    await quiet.progressTick()
    assert.equal(sent.length, 0)
    quiet.stop()
  })
} finally {
  channel.stop()
  await new Promise((resolve) => server.close(resolve))
  fs.rmSync(stateDir, { recursive: true, force: true })
}

console.log(`\n${passed} progress checks passed`)
