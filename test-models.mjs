// /models /model /status /stop 自测（假 iLink 服务）：
//   node test-models.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { __test } from './index.js'

const { createChannel, normalizeConfig } = __test
const accountId = 'acct-test'
const chatId = 'user:u-test@im.wechat'
const sessionId = 'sess-model-01'
const bindingKey = `${accountId}::${chatId}`

const sent = []
const selects = []
const cancels = []
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

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-models-'))
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

const catalog = {
  default: { provider: 'deepseek', model: 'deepseek-chat' },
  groups: [
    {
      id: 'deepseek',
      name: 'DeepSeek',
      models: [
        { id: 'deepseek-chat', name: 'DeepSeek Chat', reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } },
        { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
      ],
    },
    { id: 'other', name: 'Other', models: [{ id: 'x-1', name: 'X One' }] },
  ],
}
const liveSession = {
  id: sessionId,
  header: { cwd: 'C:\\work' },
  requestContext: () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
  requestHeader: () => undefined,
}
const sessionState = { running: true, active: true, queue: [{ id: 'q1' }, { id: 'q2' }], pendingInput: ['question'] }
const ctx = {
  get: (name) => {
    if (name === 'sessions') {
      return { get: (id) => (id === sessionId ? liveSession : undefined), list: () => [liveSession] }
    }
    if (name === 'sessionController') {
      return {
        modelCatalog: async () => catalog,
        selectModel: async (request) => {
          selects.push(request)
          const { sessionId: _ignored, ...selection } = request
          return { selected: selection }
        },
        state: async () => sessionState,
        cancel: (request) => {
          cancels.push(request)
          return { accepted: true }
        },
        list: async () => ({ items: [{ sessionId, updatedAt: 1, running: true, cwd: 'C:\\work', projections: { values: { title: '模型会话' } } }] }),
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
// 发到微信前的排版会按行宽折行，断言时先把空白去掉
const plain = (text) => String(text ?? '').replace(/\s+/g, '')
const reset = () => { sent.length = 0; selects.length = 0; cancels.length = 0 }

let passed = 0
const check = async (name, fn) => {
  await fn()
  passed += 1
  console.log(`ok ${passed} - ${name}`)
}

try {
  await check('/models 列目录，标出当前/默认，并记住序号', async () => {
    reset()
    await inbound('/models', 'm-1')
    const reply = plain(lastReply())
    assert.match(reply, /可用模型/)
    assert.ok(reply.includes('1.DeepSeek/DeepSeekChat（deepseek-chat，推理档low/high）←当前·默认'), reply)
    assert.ok(reply.includes('2.DeepSeek/DeepSeekReasoner（deepseek-reasoner）'), reply)
    assert.ok(reply.includes('3.Other/XOne（x-1）'), reply)
    const saved = JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8'))
    assert.deepEqual(saved.bindings[bindingKey].modelOptions, [
      { provider: 'deepseek', model: 'deepseek-chat' },
      { provider: 'deepseek', model: 'deepseek-reasoner' },
      { provider: 'other', model: 'x-1' },
    ])
  })

  await check('/model 不带参数：当前 + 默认', async () => {
    reset()
    await inbound('/model', 'm-2')
    const reply = lastReply()
    assert.match(reply, /当前：deepseek \/ deepseek-chat/)
    assert.match(reply, /默认：deepseek \/ deepseek-chat/)
  })

  await check('/model 2 切换，并回执', async () => {
    reset()
    await inbound('/model 2', 'm-3')
    assert.deepEqual(selects[0], { sessionId, provider: 'deepseek', model: 'deepseek-reasoner' })
    assert.match(lastReply(), /已切换模型：deepseek \/ deepseek-reasoner/)
  })

  await check('/model 1 high 带推理档', async () => {
    reset()
    await inbound('/model 1 high', 'm-4')
    assert.deepEqual(selects[0], { sessionId, provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' })
    assert.match(lastReply(), /推理档 high/)
  })

  await check('/model provider/modelId 直接指定', async () => {
    reset()
    await inbound('/model other/x-1', 'm-5')
    assert.deepEqual(selects[0], { sessionId, provider: 'other', model: 'x-1' })
  })

  await check('/model 序号越界与错误用法', async () => {
    reset()
    await inbound('/model 99', 'm-6')
    assert.match(lastReply(), /序号 99 不在上次列表里/)
    reset()
    await inbound('/model 瞎写', 'm-7')
    assert.match(lastReply(), /用法：\/model/)
  })

  await check('/status 显示模型、运行、队列、目录', async () => {
    reset()
    await inbound('/status', 'm-8')
    const reply = lastReply()
    assert.match(reply, /会话状态/)
    assert.match(reply, /模型会话 · model-01/) 
    assert.match(reply, /运行中：是/)
    assert.match(reply, /模型：deepseek \/ deepseek-chat/)
    assert.match(reply, /队列：2 条 · 待输入：question/)
    assert.match(reply, /目录：C:\\work/)
  })

  await check('/stop 仅在运行中可停', async () => {
    reset()
    await inbound('/stop', 'm-9')
    assert.match(lastReply(), /没有在跑的轮次/)
    assert.equal(cancels.length, 0)

    channel.observeSessionEvent(liveSession, { type: 'turn/start' })
    reset()
    await inbound('/stop', 'm-10')
    assert.deepEqual(cancels[0], { sessionId })
    assert.match(lastReply(), /已请求停止当前这一轮/)
    channel.observeSessionEvent(liveSession, { type: 'turn/end' })
  })
} finally {
  channel.stop()
  await new Promise((resolve) => server.close(resolve))
  fs.rmSync(stateDir, { recursive: true, force: true })
}

console.log(`\n${passed} model checks passed`)
