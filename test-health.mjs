// 断联检测自测：node test-health.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { __test } from './index.js'

const { createChannel, normalizeConfig, evaluateAccountHealth } = __test
const accountId = 'acct-test'
const chatId = 'user:u-test@im.wechat'
const sessionId = 'sess-health-01'
const bindingKey = `${accountId}::${chatId}`

const sent = []
let silent = false
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => { body += chunk })
  req.on('end', () => {
    if (req.url?.includes('getupdates')) {
      if (silent) return // 故意不回，模拟轮询卡住
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ret: 0, msgs: [], get_updates_buf: '' }))
      return
    }
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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-health-'))
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
    if (name === 'sessionController') {
      return {
        state: async () => ({ running: false, active: false, queue: [], pendingInput: [] }),
        prompt: async () => {},
        list: async () => ({ items: [{ sessionId, updatedAt: 1, running: false, projections: { values: { title: '健康测试' } } }] }),
      }
    }
    return undefined
  },
  logger: { info() {}, warn() {}, error() {} },
  on: () => () => {},
}
const config = {
  ...normalizeConfig({ stateDir }),
  progressHeartbeat: false,
  healthStaleMs: 1000,
}
const channel = createChannel(ctx, config)

const inbound = (text, messageId) =>
  channel.handleInbound(accountId, {
    message_type: 1,
    from_user_id: chatId.replace(/^user:/, ''),
    message_id: messageId,
    context_token: 'ctx-token-2',
    item_list: [{ type: 1, text_item: { text } }],
  })
const waitFor = async (predicate, timeoutMs = 2000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
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
  await check('evaluateAccountHealth：新鲜/超时/未运行', async () => {
    const now = 10_000_000
    const fresh = evaluateAccountHealth({ lastPollAt: now - 5_000, lastError: '' }, true, now, 120_000)
    assert.equal(fresh.stale, false)
    assert.equal(fresh.running, true)
    assert.equal(fresh.lastPollAgoMs, 5_000)
    const stale = evaluateAccountHealth({ lastPollAt: now - 200_000 }, true, now, 120_000)
    assert.equal(stale.stale, true)
    const stopped = evaluateAccountHealth({ lastPollAt: now - 200_000 }, false, now, 120_000)
    assert.equal(stopped.stale, false)
    assert.equal(stopped.running, false)
    const never = evaluateAccountHealth({}, true, now, 120_000)
    assert.equal(never.lastPollAt, null)
    assert.equal(never.lastPollAgoMs, null)
  })

  await check('未启动时 /ping 报连接异常', async () => {
    sent.length = 0
    await inbound('/ping', 'm-1')
    assert.match(sent[sent.length - 1], /⚠️ 微信连接异常/)
  })

  await check('启动后轮询成功，/ping 报连接正常', async () => {
    channel.start()
    assert.equal(await waitFor(() => channel.healthSummary().accounts[0]?.lastPollAt != null), true)
    const health = channel.healthSummary()
    assert.equal(health.ok, true)
    assert.equal(health.accounts[0].running, true)
    sent.length = 0
    await inbound('/ping', 'm-2')
    const reply = sent[sent.length - 1]
    assert.match(reply, /✅ 微信连接正常/)
    assert.match(reply, /轮询中/)
    assert.match(reply, /镜像：运行中/)
  })

  await check('轮询卡住时 healthTick 重启 monitor 并记录', async () => {
    silent = true
    const future = Date.now() + 10_000
    const restarted = channel.healthTick(future)
    assert.deepEqual(restarted, [accountId])
    const saved = JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8'))
    assert.equal(saved.accounts[accountId].staleRestarts, 1)
    const again = channel.healthTick(future + 500)
    assert.deepEqual(again, [])
    const savedAgain = JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8'))
    assert.equal(savedAgain.accounts[accountId].staleRestarts, 1)
    silent = false
  })

  await check('healthCheck=false 时不做自动重启', async () => {
    const quiet = createChannel(ctx, { ...config, healthCheck: false })
    quiet.start()
    await waitFor(() => quiet.healthSummary().accounts[0]?.lastPollAt != null)
    const result = quiet.healthTick(Date.now() + 60_000)
    assert.deepEqual(result, [])
    quiet.stop()
  })
} finally {
  channel.stop()
  server.closeAllConnections?.()
  server.close()
  fs.rmSync(root, { recursive: true, force: true })
}

console.log(`\n${passed} health checks passed`)
