// 自动化任务完成反馈自测：node test-automation.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { __test } from './index.js'

const { createChannel, normalizeConfig } = __test
const accountId = 'acct-test'
const chatId = 'user:u-test@im.wechat'
const sessionId = 'sess-auto-01'
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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-auto-'))
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
let catalog = []
const ctx = {
  get: (name) => {
    if (name === 'sessions') return { get: (id) => (id === sessionId ? liveSession : undefined), list: () => [liveSession] }
    if (name === 'sessionController') {
      return {
        state: async () => ({ running: false, active: false, queue: [], pendingInput: [] }),
        prompt: async () => {},
        list: async () => ({ items: [{ sessionId, updatedAt: 1, running: false, projections: { values: { title: '自动化测试' } } }] }),
      }
    }
    if (name === 'schedule') return { catalog: async () => catalog }
    return undefined
  },
  logger: { info() {}, warn() {}, error() {} },
  on: () => () => {},
}
const baseConfig = { ...normalizeConfig({ stateDir }), progressHeartbeat: false }
const channel = createChannel(ctx, baseConfig)
const waitFor = async (predicate, timeoutMs = 2000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return false
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
  await check('定时任务触发的轮次结束会发完成通知', async () => {
    catalog = [
      {
        id: 'task-1',
        title: '每日站会提醒',
        status: 'active',
        target: { kind: 'session', sessionId },
        scheduledAt: new Date().toISOString(),
        lastDelivery: { deliveredAt: new Date().toISOString(), targetSessionId: sessionId, messageId: 'msg-1' },
      },
    ]
    sent.length = 0
    channel.observeSessionEvent(liveSession, { type: 'turn/start' })
    channel.observeSessionEvent(liveSession, { type: 'turn/end' })
    assert.equal(await waitFor(() => sent.some((item) => item.includes('⏰ 定时任务完成'))), true, JSON.stringify(sent))
    const reply = sent.find((item) => item.includes('⏰'))
    assert.ok(reply.includes('每日站会提醒'))
    assert.ok(reply.includes('用时'))
  })

  await check('旧投递不会误报', async () => {
    catalog = [
      {
        id: 'task-1',
        title: '每日站会提醒',
        status: 'active',
        target: { kind: 'session', sessionId },
        lastDelivery: { deliveredAt: new Date(Date.now() - 600_000).toISOString(), targetSessionId: sessionId, messageId: 'msg-1' },
      },
    ]
    sent.length = 0
    channel.observeSessionEvent(liveSession, { type: 'turn/start' })
    channel.observeSessionEvent(liveSession, { type: 'turn/end' })
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(sent.filter((item) => item.includes('⏰')).length, 0)
  })

  await check('detectAutomationTurn 直接判断', async () => {
    catalog = [
      {
        id: 'task-2',
        title: '喝水',
        status: 'active',
        target: { kind: 'session', sessionId },
        lastDelivery: { deliveredAt: new Date().toISOString(), targetSessionId: sessionId, messageId: 'm' },
      },
    ]
    const task = await channel.detectAutomationTurn(sessionId, Date.now())
    assert.equal(task?.title, '喝水')
    assert.equal(await channel.detectAutomationTurn('other-session', Date.now()), null)
  })

  await check('automationReport=false 时不发通知', async () => {
    const dir2 = path.join(root, 'state2')
    fs.mkdirSync(dir2, { recursive: true })
    fs.copyFileSync(path.join(stateDir, 'state.json'), path.join(dir2, 'state.json'))
    const quiet = createChannel(ctx, { ...baseConfig, stateDir: dir2, automationReport: false })
    catalog = [
      {
        id: 'task-3',
        title: '关闭测试',
        status: 'active',
        target: { kind: 'session', sessionId },
        lastDelivery: { deliveredAt: new Date().toISOString(), targetSessionId: sessionId, messageId: 'm' },
      },
    ]
    sent.length = 0
    quiet.observeSessionEvent(liveSession, { type: 'turn/start' })
    quiet.observeSessionEvent(liveSession, { type: 'turn/end' })
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(sent.length, 0)
  })

  await check('/tasks 列出定时任务', async () => {
    catalog = [
      {
        id: 'task-1',
        title: '每日站会提醒',
        status: 'active',
        target: { kind: 'session', sessionId },
        scheduledAt: '2026-11-15T01:00:00.000Z',
      },
    ]
    sent.length = 0
    await inbound(channel, '/tasks', 'm-1')
    const reply = sent[sent.length - 1]
    assert.match(reply, /定时任务（1）/)
    assert.match(reply, /每日站会提醒/)
  })

  await check('schedule 服务不可用时 /tasks 提示', async () => {
    const ctx2 = {
      ...ctx,
      get: (name) => (name === 'schedule' ? undefined : ctx.get(name)),
    }
    const dir3 = path.join(root, 'state3')
    fs.mkdirSync(dir3, { recursive: true })
    fs.copyFileSync(path.join(stateDir, 'state.json'), path.join(dir3, 'state.json'))
    const noSchedule = createChannel(ctx2, { ...baseConfig, stateDir: dir3 })
    sent.length = 0
    await inbound(noSchedule, '/tasks', 'm-2')
    assert.match(sent[sent.length - 1], /定时任务服务不可用/)
  })
} finally {
  channel.stop()
  server.closeAllConnections?.()
  server.close()
  fs.rmSync(root, { recursive: true, force: true })
}

console.log(`\n${passed} automation checks passed`)
