// 建议入口自测：node test-suggest.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { __test } from './index.js'

const { createChannel, normalizeConfig } = __test
const accountId = 'acct-test'
const chatId = 'user:u-test@im.wechat'
const sessionId = 'sess-suggest-01'
const bindingKey = `${accountId}::${chatId}`

const sent = []
const issues = []
let issueMode = 'ok' // ok | forbidden
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => { body += chunk })
  req.on('end', () => {
    if (req.method === 'POST' && req.url === '/repos/owner/repo/issues') {
      issues.push({ headers: req.headers, body: JSON.parse(body || '{}') })
      if (issueMode === 'forbidden') {
        res.writeHead(403, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ message: 'Bad credentials' }))
        return
      }
      res.writeHead(201, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ html_url: 'https://github.com/owner/repo/issues/7', number: 7 }))
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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-suggest-'))
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

const prompts = []
const liveSession = { id: sessionId, seq: 0, snapshotEvents: () => [] }
const ctx = {
  get: (name) => {
    if (name === 'sessions') return { get: (id) => (id === sessionId ? liveSession : undefined), list: () => [liveSession] }
    if (name === 'sessionController') {
      return {
        state: async () => ({ running: false, active: false, queue: [], pendingInput: [] }),
        prompt: async (...args) => { prompts.push(args) },
        list: async () => ({ items: [{ sessionId, updatedAt: 1, running: false, projections: { values: { title: '建议测试' } } }] }),
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
  suggestToken: 'test-token',
  suggestRepo: 'owner/repo',
  suggestCooldownMs: 30_000,
  githubApiBase: apiBase,
}
const channel = createChannel(ctx, baseConfig)

const inbound = (text, messageId) =>
  channel.handleInbound(accountId, {
    message_type: 1,
    from_user_id: chatId.replace(/^user:/, ''),
    message_id: messageId,
    context_token: 'ctx-token-2',
    item_list: [{ type: 1, text_item: { text } }],
  })
const lastReply = () => sent[sent.length - 1] ?? ''

let passed = 0
const check = async (name, fn) => {
  await fn()
  passed += 1
  console.log(`ok ${passed} - ${name}`)
}

try {
  await check('/suggest 提交 issue 并回链接', async () => {
    sent.length = 0
    issues.length = 0
    prompts.length = 0
    await inbound('/suggest 增加语音输入支持\n希望支持方言', 'm-1')
    assert.match(lastReply(), /✅ 建议已提交：https:\/\/github\.com\/owner\/repo\/issues\/7/)
    assert.equal(prompts.length, 0, '命令不应转发给会话')
    assert.equal(issues.length, 1)
    const payload = issues[0].body
    assert.equal(payload.title, '增加语音输入支持')
    assert.ok(payload.body.includes('希望支持方言'))
    assert.ok(payload.body.includes(chatId))
    assert.deepEqual(payload.labels, ['suggestion', 'from-wechat'])
    assert.equal(issues[0].headers.authorization, 'Bearer test-token')
  })

  await check('冷却时间内不重复提交', async () => {
    sent.length = 0
    await inbound('/suggest 再来一条', 'm-2')
    assert.match(lastReply(), /刚提交过建议/)
    assert.equal(issues.length, 1, '冷却内不应再请求 GitHub')
  })

  await check('没配 token 时给出提示且不请求', async () => {
    const saved = { gh: process.env.GH_TOKEN, github: process.env.GITHUB_TOKEN }
    delete process.env.GH_TOKEN
    delete process.env.GITHUB_TOKEN
    try {
      const noToken = createChannel(ctx, { ...baseConfig, suggestToken: '' })
      sent.length = 0
      await noToken.handleInbound(accountId, {
        message_type: 1,
        from_user_id: chatId.replace(/^user:/, ''),
        message_id: 'm-3',
        context_token: 'ctx-token-3',
        item_list: [{ type: 1, text_item: { text: '/suggest 没有 token' } }],
      })
      assert.match(lastReply(), /提交失败：还没有配置 GitHub token/)
      assert.equal(issues.length, 1)
    } finally {
      if (saved.gh !== undefined) process.env.GH_TOKEN = saved.gh
      if (saved.github !== undefined) process.env.GITHUB_TOKEN = saved.github
    }
  })

  await check('GitHub 报错时回显状态码', async () => {
    issueMode = 'forbidden'
    fs.mkdirSync(path.join(root, 'state2'), { recursive: true })
    fs.copyFileSync(path.join(stateDir, 'state.json'), path.join(root, 'state2', 'state.json'))
    const errChannel = createChannel(ctx, { ...baseConfig, stateDir: path.join(root, 'state2'), suggestCooldownMs: 10_000 })
    sent.length = 0
    await errChannel.handleInbound(accountId, {
      message_type: 1,
      from_user_id: chatId.replace(/^user:/, ''),
      message_id: 'm-4',
      context_token: 'ctx-token-4',
      item_list: [{ type: 1, text_item: { text: '/suggest 会失败的' } }],
    })
    assert.match(lastReply(), /提交失败：GitHub 返回 403/)
    issueMode = 'ok'
  })

  await check('/suggest 无参数时显示用法', async () => {
    sent.length = 0
    await inbound('/suggest', 'm-5')
    assert.match(lastReply(), /用法：\/suggest/)
  })
} finally {
  channel.stop()
  server.closeAllConnections?.()
  server.close()
  fs.rmSync(root, { recursive: true, force: true })
}

console.log(`\n${passed} suggest checks passed`)
