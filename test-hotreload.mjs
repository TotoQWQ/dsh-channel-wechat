// 热重载自测：node test-hotreload.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { __test } from './index.js'

const { createChannel, normalizeConfig } = __test
const accountId = 'acct-test'
const chatId = 'user:u-test@im.wechat'
const sessionId = 'sess-reload-01'

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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-reload-'))
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
        [`${accountId}::${chatId}`]: {
          key: `${accountId}::${chatId}`,
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
const reloadCalls = []
const exclusiveCalls = []
const hmr = {
  runExclusive: async (fn) => {
    exclusiveCalls.push(Date.now())
    return fn()
  },
  reconcileProfile: async () => {
    reloadCalls.push(Date.now())
    return { warnings: [], pending: [], restartReason: undefined }
  },
}
const makeCtx = (withHmr) => ({
  get: (name) => {
    if (name === 'hmr') return withHmr ? hmr : undefined
    if (name === 'sessions') return { get: (id) => (id === sessionId ? liveSession : undefined), list: () => [liveSession] }
    if (name === 'sessionController') {
      return {
        state: async () => ({ running: false, active: false, queue: [], pendingInput: [] }),
        prompt: async () => {},
        list: async () => ({ items: [{ sessionId, updatedAt: 1, running: false, projections: { values: { title: '重载测试' } } }] }),
      }
    }
    return undefined
  },
  logger: { info() {}, warn() {}, error() {} },
  on: () => () => {},
})
const baseConfig = { ...normalizeConfig({ stateDir }), progressHeartbeat: false }
const channel = createChannel(makeCtx(true), baseConfig)

const inbound = (channel_, text, messageId) =>
  channel_.handleInbound(accountId, {
    message_type: 1,
    from_user_id: chatId.replace(/^user:/, ''),
    message_id: messageId,
    context_token: 'ctx-token-2',
    item_list: [{ type: 1, text_item: { text } }],
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
  await check('hotReloadPlugin 调用 hmr.reconcileProfile', async () => {
    const result = await channel.hotReloadPlugin('test')
    assert.equal(result.ok, true)
    assert.equal(reloadCalls.length, 1)
    assert.equal(exclusiveCalls.length, 1, '必须包在 runExclusive 里')
  })

  await check('HMR 不可用时返回失败信息', async () => {
    const dir = path.join(root, 'state-nohmr')
    makeState(dir)
    const noHmr = createChannel(makeCtx(false), { ...baseConfig, stateDir: dir })
    const result = await noHmr.hotReloadPlugin('test')
    assert.equal(result.ok, false)
    assert.match(result.message, /HMR/)
    noHmr.stop()
  })

  await check('hotReload=false 时拒绝', async () => {
    const dir2 = path.join(root, 'state-off')
    makeState(dir2)
    const off = createChannel(makeCtx(true), { ...baseConfig, stateDir: dir2, hotReload: false })
    const result = await off.hotReloadPlugin('test')
    assert.equal(result.ok, false)
    assert.match(result.message, /hotReload/)
  })

  await check('/reload 先回执再触发热重载', async () => {
    reloadCalls.length = 0
    sent.length = 0
    await inbound(channel, '/reload', 'm-1')
    assert.match(sent[sent.length - 1], /热重载/)
    assert.equal(await waitFor(() => reloadCalls.length >= 1), true)
  })
} finally {
  channel.stop()
  server.closeAllConnections?.()
  server.close()
  fs.rmSync(root, { recursive: true, force: true })
}

console.log(`\n${passed} hot reload checks passed`)
