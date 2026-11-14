// 思考片段摘要自测：node test-thinking.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { __test } from './index.js'

const { createChannel, normalizeConfig, summarizeThinkingDelta } = __test
const accountId = 'acct-test'
const chatId = 'user:u-test@im.wechat'
const sessionId = 'sess-think-01'
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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-think-'))
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
        state: async () => ({ running: true, active: true, queue: [], pendingInput: [] }),
        prompt: async () => {},
        list: async () => ({ items: [{ sessionId, updatedAt: 1, running: true, projections: { values: { title: '思考测试' } } }] }),
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
  thinkingSummaryIntervalMs: 1000,
  thinkingSummaryChars: 80,
}
const channel = createChannel(ctx, config)

const obs = (text, target = sessionId) =>
  channel.observeAssistantStream({
    agent: { id: target },
    frame: { type: 'chunk', attemptId: 'a', revision: 1, index: 0, time: Date.now(), chunk: { type: 'reasoning-delta', index: 0, text } },
  })
const finish = () =>
  channel.observeAssistantStream({
    agent: { id: sessionId },
    frame: { type: 'end', attemptId: 'a', revision: 1, index: 0, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 1 } },
  })
const waitFor = async (predicate, timeoutMs = 1500) => {
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
  await check('summarizeThinkingDelta 截取与去代码块', async () => {
    assert.equal(summarizeThinkingDelta('短句', 80), '短句')
    const long = '我先看一下文件结构，再决定怎么改这一段逻辑。后面还有很长的内容需要继续阅读和确认。'
    const summary = summarizeThinkingDelta(long, 30)
    assert.ok(summary.length <= 31, summary)
    assert.ok(summary.endsWith('。') || summary.endsWith('…'), summary)
    assert.equal(summarizeThinkingDelta('```js\ncode\n```\n看这里', 80), '看这里')
    assert.equal(summarizeThinkingDelta('   ', 80), '')
  })

  await check('首段思考立即发摘要', async () => {
    sent.length = 0
    obs('我先看一下文件结构，再决定怎么改这一段。')
    assert.equal(await waitFor(() => sent.length >= 1), true)
    assert.match(sent[0], /^💭 思考中：/)
    assert.match(sent[0], /文件结构/)
  })

  await check('间隔内不重复发', async () => {
    const before = sent.length
    obs('继续分析一下这个函数的调用关系。')
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.equal(sent.length, before)
  })

  await check('过了间隔后发下一段摘要', async () => {
    await new Promise((resolve) => setTimeout(resolve, 1000))
    const before = sent.length
    obs('再检查一下边界条件和错误处理。')
    assert.equal(await waitFor(() => sent.length > before), true)
    assert.match(sent[sent.length - 1], /边界条件/)
  })

  await check('turn/end 清空思考缓冲', async () => {
    finish()
    const result = await channel.maybeSendThinking(sessionId)
    assert.equal(result.reason, 'no-session')
  })

  await check('关闭时完全不发', async () => {
    const quiet = createChannel(ctx, { ...config, thinkingSummary: false })
    sent.length = 0
    quiet.observeAssistantStream({
      agent: { id: sessionId },
      frame: { type: 'chunk', chunk: { type: 'reasoning-delta', text: '这段不应该发出去。' } },
    })
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.equal(sent.length, 0)
  })

  await check('未绑定微信的会话不发', async () => {
    sent.length = 0
    obs('这段属于没人绑定的会话，不该发到微信。', 'session-unbound')
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.equal(sent.length, 0)
  })
} finally {
  channel.stop()
  server.closeAllConnections?.()
  server.close()
  fs.rmSync(root, { recursive: true, force: true })
}

console.log(`\n${passed} thinking checks passed`)
