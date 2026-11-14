// 「微信消息插进正在跑的对话」自测（假 iLink 服务）：
//   node test-insert.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { __test } from './index.js'

const { createChannel, normalizeConfig } = __test
const accountId = 'acct-test'
const chatId = 'user:u-test@im.wechat'
const sessionId = 'sess-insert-01'
const bindingKey = `${accountId}::${chatId}`

const sent = []
const prompts = []
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

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-insert-'))
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

const liveSession = { id: sessionId, seq: 0, snapshotEvents: () => [] }
const ctx = {
  get: (name) => {
    if (name === 'sessions') {
      return { get: (id) => (id === sessionId ? liveSession : undefined), list: () => [liveSession] }
    }
    if (name === 'sessionController') {
      return {
        prompt: async (request) => { prompts.push(request) },
        list: async () => ({ items: [{ sessionId, updatedAt: 1, running: false, projections: { values: {} } }] }),
      }
    }
    return undefined
  },
  logger: { info() {}, warn() {}, error() {} },
  on: () => () => {},
}
const baseConfig = normalizeConfig({ stateDir })
const channel = createChannel(ctx, { ...baseConfig, progressHeartbeat: false, replyTimeoutMs: 5000 })

const inbound = (text, messageId) =>
  channel.handleInbound(accountId, {
    message_type: 1,
    from_user_id: chatId.replace(/^user:/, ''),
    message_id: messageId,
    context_token: 'ctx-token-2',
    item_list: [{ type: 1, text_item: { text } }],
  })
const reset = () => { sent.length = 0; prompts.length = 0 }

let passed = 0
const check = async (name, fn) => {
  await fn()
  passed += 1
  console.log(`ok ${passed} - ${name}`)
}

try {
  await check('会话空闲时仍走 queue（一轮一答）', async () => {
    reset()
    const result = await inbound('第一句', 'm-1')
    assert.equal(result.ok, true)
    assert.equal(prompts.length, 1)
    assert.equal(prompts[0].mode, 'queue')
    assert.match(sent[sent.length - 1], /本轮没有产生文本回复/)
  })

  await check('会话在跑时插进当前对话（steer）并回执', async () => {
    channel.observeSessionEvent(liveSession, { type: 'turn/start' })
    reset()
    const result = await inbound('补充一句：用中文', 'm-2')
    assert.deepEqual(result, { inserted: true, sessionId })
    assert.equal(prompts.length, 1)
    assert.equal(prompts[0].mode, 'steer')
    assert.equal(prompts[0].content[0].text, '补充一句：用中文')
    assert.match(sent[sent.length - 1], /已插入当前对话/)
  })

  await check('10 秒内连续插入只回执一次', async () => {
    reset()
    await inbound('再补一句', 'm-3')
    assert.equal(prompts.length, 1)
    assert.equal(prompts[0].mode, 'steer')
    assert.equal(sent.length, 0, '第二条不应该再发回执')
  })

  await check('消息前缀仍会加到插入内容前', async () => {
    const prefixed = createChannel(ctx, { ...baseConfig, progressHeartbeat: false, messagePrefix: '[微信] ' })
    prefixed.observeSessionEvent(liveSession, { type: 'turn/start' })
    reset()
    await prefixed.handleInbound(accountId, {
      message_type: 1,
      from_user_id: chatId.replace(/^user:/, ''),
      message_id: 'm-4',
      context_token: 'ctx-token-3',
      item_list: [{ type: 1, text_item: { text: '继续' } }],
    })
    assert.equal(prompts[0].mode, 'steer')
    assert.equal(prompts[0].content[0].text, '[微信] 继续')
    prefixed.stop()
  })

  await check('insertWhileBusy=false 时不插话，回退到排队', async () => {
    const queued = createChannel(ctx, { ...baseConfig, progressHeartbeat: false, insertWhileBusy: false, replyTimeoutMs: 5000 })
    queued.observeSessionEvent(liveSession, { type: 'turn/start' })
    reset()
    await queued.handleInbound(accountId, {
      message_type: 1,
      from_user_id: chatId.replace(/^user:/, ''),
      message_id: 'm-5',
      context_token: 'ctx-token-4',
      item_list: [{ type: 1, text_item: { text: '排着吧' } }],
    })
    assert.equal(prompts[0].mode, 'queue')
    queued.stop()
  })
} finally {
  channel.stop()
  await new Promise((resolve) => server.close(resolve))
  fs.rmSync(stateDir, { recursive: true, force: true })
}

console.log(`\n${passed} insert checks passed`)
