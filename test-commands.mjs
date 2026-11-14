// 微信内会话切换命令自测（假 iLink 服务）：
//   node test-commands.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { __test } from './index.js'

const { createChannel, normalizeConfig, parseWechatCommand, sessionDisplayName } = __test
const accountId = 'acct-test'
const chatId = 'user:u-test@im.wechat'
const sessionId = 'sess-aaaaaaa1'
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

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-commands-'))
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

// 两个会话：甲在线（较新）、乙是冷会话（需要 resolveAgent 才恢复）
const rows = [
  { sessionId: sessionId, updatedAt: 3000, running: true, projections: { values: { title: '会话甲' } } },
  { sessionId: 'sess-bbbbbbb2', updatedAt: 2000, running: false, projections: { values: { title: '会话乙' } } },
]
const live = new Set([sessionId])
const ctx = {
  get: (name) => {
    if (name === 'sessions') {
      return { get: (id) => (live.has(id) ? { id } : undefined), list: () => [...live].map((id) => ({ id })) }
    }
    if (name === 'sessionController') {
      return {
        list: async () => ({ items: rows }),
        resolveAgent: async (id) => {
          if (id === rows[1].sessionId) {
            live.add(id)
            return { agent: { id } }
          }
          return { error: { code: 'session/not-found' } }
        },
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
const reset = () => { sent.length = 0 }

let passed = 0
const check = async (name, fn) => {
  await fn()
  passed += 1
  console.log(`ok ${passed} - ${name}`)
}

try {
  await check('解析：只认表内命令，表外 /xxx 与普通文字不拦截', async () => {
    assert.deepEqual(parseWechatCommand('/sessions'), { name: 'sessions', args: '' })
    assert.deepEqual(parseWechatCommand('／use 2'), { name: 'use', args: '2' })
    assert.deepEqual(parseWechatCommand('/help'), { name: 'help', args: '' })
    assert.equal(parseWechatCommand('/unknown'), null)
    assert.equal(parseWechatCommand('帮我看看 /tmp 目录'), null)
  })

  await check('显示名：优先标题，没有标题用 id 前缀', async () => {
    assert.equal(sessionDisplayName({ id: 'abcdefgh-1', title: '标题' }), '标题')
    assert.equal(sessionDisplayName({ id: 'abcdefgh-1' }), 'abcdefgh-1')
  })

  await check('/sessions 列出最近会话并标出当前', async () => {
    reset()
    const result = await inbound('/sessions', 'msg-1')
    assert.deepEqual(result, { command: 'sessions' })
    const reply = lastReply()
    assert.match(reply, /最近会话/)
    assert.match(reply, /1\. 会话甲 · aaaaaaa1（运行中 · 当前）/)
    assert.match(reply, /2\. 会话乙 · bbbbbbb2/)
  })

  await check('/use 2 切到冷会话并恢复它', async () => {
    reset()
    await inbound('/use 2', 'msg-2')
    assert.match(lastReply(), /已切换到：会话乙/)
    const saved = JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8'))
    assert.equal(saved.bindings[bindingKey].sessionId, rows[1].sessionId)
    assert.equal(live.has(rows[1].sessionId), true)
  })

  await check('/current 显示当前会话与在线状态', async () => {
    reset()
    await inbound('/current', 'msg-3')
    const reply = lastReply()
    assert.match(reply, /当前会话/)
    assert.match(reply, /会话乙 · bbbbbbb2/)
    assert.match(reply, /在线/)
    assert.match(reply, /手动绑定/)
  })

  await check('/use 9 越界提示重新取列表', async () => {
    reset()
    await inbound('/use 9', 'msg-4')
    assert.match(lastReply(), /序号 9 不在上次列表里/)
  })

  await check('/use <完整 id> 可以按 id 切回', async () => {
    reset()
    await inbound(`/use ${sessionId}`, 'msg-5')
    assert.match(lastReply(), /已切换到：会话甲/)
    const saved = JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8'))
    assert.equal(saved.bindings[bindingKey].sessionId, sessionId)
  })

  await check('/new 换到自动新会话', async () => {
    reset()
    await inbound('/new', 'msg-6')
    assert.match(lastReply(), /已换到新会话/)
    const saved = JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8'))
    assert.ok(saved.bindings[bindingKey].sessionId.startsWith('wx-'))
    assert.equal(saved.bindings[bindingKey].explicit, false)
  })

  await check('/help 输出命令表', async () => {
    reset()
    await inbound('/help', 'msg-7')
    const reply = lastReply()
    assert.match(reply, /微信会话命令/)
    assert.match(reply, /\/use 2/)
    assert.match(reply, /\/new/)
  })
} finally {
  channel.stop()
  await new Promise((resolve) => server.close(resolve))
  fs.rmSync(stateDir, { recursive: true, force: true })
}

console.log(`\n${passed} command checks passed`)
