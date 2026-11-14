// 故障回归自测（对应故障报告）：node test-faults.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { __test } from './index.js'

const { createChannel, normalizeConfig } = __test
const accountId = 'acct-test'
const chatId = 'user:u-test@im.wechat'
const sessionId = 'sess-fault-01'

let mode = 'reject' // ok | reject
const hits = []
const sent = []
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => { body += chunk })
  req.on('end', () => {
    if (req.url?.includes('sendmessage')) {
      hits.push(1)
      if (mode === 'reject') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ret: -2, errmsg: 'prepare failed' }))
        return
      }
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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-fault-'))
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
        [`${accountId}::${chatId}`]: {
          key: `${accountId}::${chatId}`,
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
        list: async () => ({ items: [{ sessionId, updatedAt: 1, running: false, projections: { values: { title: '故障测试' } } }] }),
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
  replyTimeoutMs: 300,
  sendBreakerThreshold: 2,
  sendBreakerMs: 60_000,
}
const channel = createChannel(ctx, baseConfig)
const fakeBinding = {
  key: `${accountId}::${chatId}`,
  accountId,
  chatId,
  toUserId: chatId.replace(/^user:/, ''),
  contextToken: 'ctx-token',
}
const inbound = (channel_, text, messageId) =>
  channel_.handleInbound(accountId, {
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
  await check('progress 失败不计入熔断', async () => {
    mode = 'reject'
    hits.length = 0
    for (let i = 0; i < 5; i += 1) await channel.sendProgressMessage({ ...fakeBinding }, `进度 ${i}`)
    assert.equal(channel.sendPauseRemaining(accountId), 0, 'progress 不应触发发送熔断')
    mode = 'ok'
    const result = await channel.sendToChat({ accountId, toUserId: fakeBinding.toUserId, contextToken: 'ctx-token', text: '真实回复' })
    assert.equal(result.chunks, 1)
  })

  await check('熔断期间 progress 直接跳过、不再请求接口', async () => {
    mode = 'reject'
    hits.length = 0
    await assert.rejects(() => channel.sendToChat({ accountId, toUserId: fakeBinding.toUserId, contextToken: 'ctx-token', text: 'x' }), /sendmessage/)
    await assert.rejects(() => channel.sendToChat({ accountId, toUserId: fakeBinding.toUserId, contextToken: 'ctx-token', text: 'x' }), /sendmessage/)
    assert.ok(channel.sendPauseRemaining(accountId) > 0, '应进入熔断')
    const before = hits.length
    const ok = await channel.sendProgressMessage({ ...fakeBinding }, '熔断期间的进度')
    assert.equal(ok, false)
    assert.equal(hits.length, before, '熔断期间 progress 不应请求接口')
    mode = 'ok'
    await assert.rejects(() => channel.sendToChat({ accountId, toUserId: fakeBinding.toUserId, contextToken: 'ctx-token', text: 'x' }), /发送暂缓/)
  })

  await check('新入站会清掉熔断并允许补发/回复', async () => {
    mode = 'ok'
    prompts.length = 0
    await inbound(channel, '你好', 'm-1')
    assert.equal(prompts.length, 1)
    assert.equal(channel.sendPauseRemaining(accountId), 0, '入站后应清除熔断')
    const result = await channel.sendToChat({ accountId, toUserId: fakeBinding.toUserId, contextToken: 'ctx-token', text: '恢复后回复' })
    assert.equal(result.chunks, 1)
  })

  await check('progressBusy 防重入（并发 tick 不叠加）', async () => {
    mode = 'reject'
    const tickResults = await Promise.all([channel.progressTick(), channel.progressTick(), channel.progressTick()])
    assert.equal(tickResults.length, 3)
  })
} finally {
  channel.stop()
  server.closeAllConnections?.()
  server.close()
  fs.rmSync(root, { recursive: true, force: true })
}

console.log(`\n${passed} fault checks passed`)
