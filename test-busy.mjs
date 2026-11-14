// 「重启后不会误判会话在跑」自测（修复微信不返回消息的 bug）：
//   node test-busy.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { __test } from './index.js'

const { createChannel, normalizeConfig } = __test
const accountId = 'acct-test'
const chatId = 'user:u-test@im.wechat'
const sessionId = 'sess-busy-01'
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
    res.end(JSON.stringify({ ret: 0, updates: [] }))
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const apiBase = `http://127.0.0.1:${server.address().port}`

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-busy-'))

/** 造一个带「上一次进程遗留 turnActive」的 state。 */
function makeStateDir(name, { turnActive = true, since = Date.now() } = {}) {
  const dir = path.join(root, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'state.json'),
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
          turnActive,
          ...(turnActive ? { turnActiveSince: since } : {}),
        },
      },
      settings: { defaultSessionId: sessionId },
    }),
    'utf8',
  )
  return dir
}

function makeCtx({ running = false, withController = true } = {}) {
  const prompts = []
  const liveSession = { id: sessionId, seq: 0, snapshotEvents: () => [] }
  return {
    prompts,
    ctx: {
      get: (key) => {
        if (key === 'sessions') {
          return { get: (id) => (id === sessionId ? liveSession : undefined), list: () => [liveSession] }
        }
        if (key === 'sessionController' && withController) {
          return {
            state: async () => ({ running, active: running, queue: [], pendingInput: [] }),
            prompt: async (request) => { prompts.push(request) },
            list: async () => ({ items: [{ sessionId, updatedAt: 1, running, projections: { values: { title: '测试会话' } } }] }),
          }
        }
        return undefined
      },
      logger: { info() {}, warn() {}, error() {} },
      on: () => () => {},
    },
  }
}

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
  await check('加载时复位 turnActive（磁盘上残留也不会误判）', async () => {
    const dir = makeStateDir('reset', { turnActive: true })
    const { ctx } = makeCtx({ running: false })
    const channel = createChannel(ctx, { ...normalizeConfig({ stateDir: dir }), progressHeartbeat: false })
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'))
    // 磁盘上还没保存，但内存里必须是 false；isSessionBusy 也应返回 false
    assert.equal(await channel.isSessionBusy(sessionId), false)
    assert.equal(await channel.isSessionBusy(sessionId), false)
    assert.ok(saved.bindings[bindingKey])
    channel.stop()
  })

  await check('假忙时入站走正常排队（queue），不再 steer 后无声无息', async () => {
    const dir = makeStateDir('queue', { turnActive: true })
    const { ctx, prompts } = makeCtx({ running: false })
    const channel = createChannel(ctx, {
      ...normalizeConfig({ stateDir: dir }),
      progressHeartbeat: false,
      replyTimeoutMs: 5000,
    })
    sent.length = 0
    const result = await inbound(channel, '在吗', 'm-1')
    assert.equal(result.ok, true)
    assert.equal(prompts[0].mode, 'queue')
    assert.match(sent[sent.length - 1], /本轮没有产生文本回复/)
    // saveState 是 400ms 防抖，等它落盘后再看磁盘
    await new Promise((resolve) => setTimeout(resolve, 700))
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'))
    assert.equal('turnActive' in saved.bindings[bindingKey], false, 'turnActive 不应被写回磁盘')
    channel.stop()
  })

  await check('真运行时仍按 steer 插入并回执', async () => {
    const dir = makeStateDir('steer', { turnActive: true })
    const { ctx, prompts } = makeCtx({ running: true })
    const channel = createChannel(ctx, { ...normalizeConfig({ stateDir: dir }), progressHeartbeat: false })
    sent.length = 0
    const result = await inbound(channel, '插一句', 'm-2')
    assert.deepEqual(result, { inserted: true, sessionId })
    assert.equal(prompts[0].mode, 'steer')
    assert.match(sent[sent.length - 1], /已插入当前对话/)
    channel.stop()
  })

  await check('超龄的 turnActive 直接作废（不查状态也放行）', async () => {
    const dir = makeStateDir('stale', { turnActive: true, since: Date.now() - 2 * 3600_000 })
    const { ctx } = makeCtx({ withController: false })
    const channel = createChannel(ctx, { ...normalizeConfig({ stateDir: dir }), progressHeartbeat: false })
    assert.equal(await channel.isSessionBusy(sessionId), false)
    channel.stop()
  })

  await check('turn/start、turn/end 跟踪仍然有效', async () => {
    const dir = makeStateDir('track', { turnActive: false })
    const { ctx } = makeCtx({ running: false })
    const channel = createChannel(ctx, { ...normalizeConfig({ stateDir: dir }), progressHeartbeat: false })
    assert.equal(await channel.isSessionBusy(sessionId), false)
    channel.observeSessionEvent({ id: sessionId }, { type: 'turn/start' })
    assert.equal(await channel.isSessionBusy(sessionId), true)
    channel.observeSessionEvent({ id: sessionId }, { type: 'turn/end' })
    assert.equal(await channel.isSessionBusy(sessionId), false)
    channel.stop()
  })
} finally {
  // undici 会保持 keep-alive 连接，直接 close 回调可能永不触发
  server.closeAllConnections?.()
  server.close()
  fs.rmSync(root, { recursive: true, force: true })
}

console.log(`\n${passed} busy checks passed`)
