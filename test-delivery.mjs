// 投递恢复自测：node test-delivery.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { __test } from './index.js'

const { createChannel, normalizeConfig, isDeliveryError } = __test
const accountId = 'acct-test'
const chatId = 'user:u-test@im.wechat'
const sessionId = 'sess-delivery-01'
const bindingKey = `${accountId}::${chatId}`

let mode = 'ok' // ok | reject
const hits = []
const sent = []
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => { body += chunk })
  req.on('end', () => {
    if (req.url?.includes('getupdates')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ret: 0, msgs: [], get_updates_buf: '' }))
      return
    }
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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-delivery-'))
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

const liveSession = { id: sessionId, seq: 0, snapshotEvents: () => [] }
const ctx = {
  get: (name) => {
    if (name === 'sessions') return { get: (id) => (id === sessionId ? liveSession : undefined), list: () => [liveSession] }
    if (name === 'sessionController') {
      return {
        state: async () => ({ running: false, active: false, queue: [], pendingInput: [] }),
        prompt: async () => {},
        list: async () => ({ items: [{ sessionId, updatedAt: 1, running: false, projections: { values: { title: '投递测试' } } }] }),
      }
    }
    return undefined
  },
  logger: { info() {}, warn() {}, error() {} },
  on: () => () => {},
}
const baseConfig = { ...normalizeConfig({ stateDir }), progressHeartbeat: false, mirrorIntervalMs: 60_000 }
const sendArgs = { accountId, toUserId: chatId.replace(/^user:/, ''), contextToken: 'ctx-token', text: 'x' }

const inbound = (channel, text, messageId) =>
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
  await check('isDeliveryError 只认 sendmessage 失败', async () => {
    assert.equal(isDeliveryError('sendmessage ret=-2 prepare failed'), true)
    assert.equal(isDeliveryError('boom'), false)
    assert.equal(isDeliveryError(''), false)
  })

  await check('连续失败触发熔断，暂缓后不再打接口', async () => {
    mode = 'reject'
    hits.length = 0
    const channel = createChannel(ctx, { ...baseConfig, sendBreakerThreshold: 2, sendBreakerMs: 60_000 })
    await assert.rejects(() => channel.sendToChat({ ...sendArgs }), /sendmessage/)
    await assert.rejects(() => channel.sendToChat({ ...sendArgs }), /sendmessage/)
    const before = hits.length
    assert.ok(before >= 2)
    await assert.rejects(() => channel.sendToChat({ ...sendArgs }), /发送暂缓/)
    assert.equal(hits.length, before, '熔断后不应再请求接口')
    channel.stop()
  })

  await check('inbound 带回新 token 时自动补发旧回复', async () => {
    const dir2 = path.join(root, 'state2')
    makeState(dir2)
    const channel = createChannel(ctx, { ...baseConfig, stateDir: dir2 })
    mode = 'reject'
    const queued = await channel.sendTextToUser({ accountId, toUserId: chatId.replace(/^user:/, ''), text: '补发甲' })
    assert.equal(queued.queued, 1, '失败应进队列')
    mode = 'ok'
    sent.length = 0
    await inbound(channel, '/ping', 'm-1')
    assert.ok(sent.includes('补发甲'), `实际发送：${JSON.stringify(sent)}`)
    const saved = JSON.parse(fs.readFileSync(path.join(dir2, 'state.json'), 'utf8'))
    assert.equal((Object.values(saved.bindings)[0].pending ?? []).length, 0, '补发成功后队列应清空')
    channel.stop()
  })

  await check('同一 stateDir 只保留一个活跃 channel', async () => {
    const dir3 = path.join(root, 'state3')
    makeState(dir3)
    mode = 'ok'
    const first = createChannel(ctx, { ...baseConfig, stateDir: dir3 })
    first.start()
    assert.equal(first.running(), true)
    const second = createChannel(ctx, { ...baseConfig, stateDir: dir3 })
    second.start()
    assert.equal(first.running(), false, '旧实例应被停掉')
    assert.equal(second.running(), true)
    second.stop()
  })
} finally {
  server.closeAllConnections?.()
  server.close()
  fs.rmSync(root, { recursive: true, force: true })
}

console.log(`\n${passed} delivery checks passed`)
