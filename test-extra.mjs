// /rename /history /search /approval 自测（假 iLink 服务）：
//   node test-extra.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { __test } from './index.js'

const { createChannel, normalizeConfig } = __test
const accountId = 'acct-test'
const chatId = 'user:u-test@im.wechat'
const sessionId = 'sess-extra-01'
const otherSessionId = 'sess-other-02'
const bindingKey = `${accountId}::${chatId}`

const sent = []
const calls = { rename: [], search: [], setPolicy: [], events: [] }
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

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-extra-'))
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

const eventsPage = {
  records: [
    { type: 'event', event: { type: 'user/message', data: { content: [{ type: 'text', text: '帮我把这个改成中文' }] } } },
    { type: 'event', event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '好的，已经改完了' }] } } } },
    { type: 'event', event: { type: 'turn/end', data: {} } },
  ],
}
const liveSession = { id: sessionId, header: { cwd: 'C:\\work' }, requestContext: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) }
const live = new Set([sessionId])
const rows = [
  { sessionId, updatedAt: 3000, running: false, projections: { values: { title: '模型会话' } } },
  { sessionId: otherSessionId, updatedAt: 2000, running: false, projections: { values: { title: '旧对话' } } },
]
const ctx = {
  get: (name) => {
    if (name === 'sessions') {
      return {
        get: (id) => (live.has(id) ? { id, header: {}, requestContext: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) } : undefined),
        list: () => [...live].map((id) => ({ id })),
      }
    }
    if (name === 'agents') {
      return { get: (id) => (id === sessionId ? { id, session: liveSession } : undefined) }
    }
    if (name === 'approval') {
      return {
        overrideOf: () => 'ask',
        setPolicy: (agent, policy) => { calls.setPolicy.push({ agentId: agent.id, policy }) },
      }
    }
    if (name === 'sessionController') {
      return {
        list: async () => ({ items: rows }),
        events: async (request) => { calls.events.push(request); return eventsPage },
        search: async (request) => {
          calls.search.push(request)
          return { items: [{ sessionId: otherSessionId, snippet: '这段对话里提到过模型切换' }], hasMore: false }
        },
        rename: async (request) => { calls.rename.push(request); return { title: request.title, seq: 10 } },
        resolveAgent: async (id) => {
          live.add(id)
          return { agent: { id } }
        },
        prompt: async () => {},
      }
    }
    return undefined
  },
  logger: { info() {}, warn() {}, error() {} },
  on: () => () => {},
}
const config = { ...normalizeConfig({ stateDir }), progressHeartbeat: false }
const channel = createChannel(ctx, config)

const inbound = (text, messageId) =>
  channel.handleInbound(accountId, {
    message_type: 1,
    from_user_id: chatId.replace(/^user:/, ''),
    message_id: messageId,
    context_token: 'ctx-token-2',
    item_list: [{ type: 1, text_item: { text } }],
  })
const lastReply = () => sent[sent.length - 1] ?? ''
const plain = (text) => String(text ?? '').replace(/\s+/g, '')
const reset = () => { sent.length = 0; calls.rename.length = 0; calls.search.length = 0; calls.setPolicy.length = 0; calls.events.length = 0 }

let passed = 0
const check = async (name, fn) => {
  await fn()
  passed += 1
  console.log(`ok ${passed} - ${name}`)
}

try {
  await check('/history 读最近对话（你/DSH 两行）', async () => {
    reset()
    await inbound('/history', 'm-1')
    assert.equal(calls.events.length, 1)
    assert.deepEqual(calls.events[0].address, { kind: 'session', sessionId })
    const reply = plain(lastReply())
    assert.match(reply, /最近2条/)
    assert.ok(reply.includes('你：帮我把这个改成中文'), reply)
    assert.ok(reply.includes('DSH：好的，已经改完了'), reply)
  })

  await check('/rename 改会话标题', async () => {
    reset()
    await inbound('/rename 微信改的新标题', 'm-2')
    assert.deepEqual(calls.rename[0], { sessionId, title: '微信改的新标题' })
    assert.match(plain(lastReply()), /会话已改名为：微信改的新标题/)
  })

  await check('/rename 缺标题时给用法', async () => {
    reset()
    await inbound('/rename', 'm-3')
    assert.match(lastReply(), /用法：\/rename/)
  })

  await check('/search 跨会话搜索并列结果，序号可 /use', async () => {
    reset()
    await inbound('/search 模型', 'm-4')
    assert.deepEqual(calls.search[0], { query: '模型' })
    const reply = plain(lastReply())
    assert.ok(reply.includes('「模型」找到1个会话'), reply)
    assert.ok(reply.includes('1.旧对话·other-02'), reply)
    assert.ok(reply.includes('这段对话里提到过模型切换'), reply)
    const saved = JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8'))
    assert.deepEqual(saved.bindings[bindingKey].sessionOptions, [otherSessionId])

    reset()
    await inbound('/use 1', 'm-5')
    const after = JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8'))
    assert.equal(after.bindings[bindingKey].sessionId, otherSessionId)

    // 切回原会话，后面测审批用
    reset()
    await inbound(`/use ${sessionId}`, 'm-5b')
    const back = JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8'))
    assert.equal(back.bindings[bindingKey].sessionId, sessionId)
  })

  await check('/approval 看当前策略', async () => {
    reset()
    await inbound('/approval', 'm-6')
    const reply = plain(lastReply())
    assert.match(reply, /审批策略/)
    assert.ok(reply.includes('当前：ask'), reply)
  })

  await check('/approval never 切换策略', async () => {
    reset()
    await inbound('/approval never', 'm-7')
    assert.deepEqual(calls.setPolicy[0], { agentId: sessionId, policy: 'never' })
    assert.match(plain(lastReply()), /审批策略已切到「never」/)
  })

  await check('/approval 非法参数给用法', async () => {
    reset()
    await inbound('/approval 随便', 'm-8')
    assert.match(lastReply(), /用法：\/approval ask 或 \/approval never/)
  })

  await check('/help 已包含新增命令', async () => {
    reset()
    await inbound('/help', 'm-9')
    const reply = plain(lastReply())
    for (const cmd of ['/rename', '/history', '/search', '/approval']) {
      assert.ok(reply.includes(cmd), `${cmd} 不在帮助里`)
    }
  })
} finally {
  channel.stop()
  await new Promise((resolve) => server.close(resolve))
  fs.rmSync(stateDir, { recursive: true, force: true })
}

console.log(`\n${passed} extra checks passed`)
