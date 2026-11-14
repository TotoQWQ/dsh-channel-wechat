// 功能开关自测：node test-features.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { __test } from './index.js'

const { createChannel, normalizeConfig } = __test
const accountId = 'acct-test'
const chatId = 'user:u-test@im.wechat'
const sessionId = 'sess-feature-01'

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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-feature-'))
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
const ctx = {
  get: (name) => {
    if (name === 'sessions') return { get: (id) => (id === sessionId ? liveSession : undefined), list: () => [liveSession] }
    if (name === 'sessionController') {
      return {
        state: async () => ({ running: false, active: false, queue: [], pendingInput: [] }),
        prompt: async () => {},
        list: async () => ({ items: [{ sessionId, updatedAt: 1, running: false, projections: { values: { title: '开关测试' } } }] }),
      }
    }
    return undefined
  },
  logger: { info() {}, warn() {}, error() {} },
  on: () => () => {},
}
const baseConfig = normalizeConfig({ stateDir })
const channel = createChannel(ctx, baseConfig)

let passed = 0
const check = async (name, fn) => {
  await fn()
  passed += 1
  console.log(`ok ${passed} - ${name}`)
}

try {
  await check('默认值：打扰型功能默认关', async () => {
    const features = channel.featureValues()
    assert.equal(features.thinkingSummary, false)
    assert.equal(features.streamSegment, false)
    assert.equal(features.automationReport, true)
    assert.equal(features.progressHeartbeat, true)
    assert.equal(features.riskAlert, false)
    assert.equal(features.emotionAuto, true)
    assert.equal(features.autoHotReload, false)
  })

  await check('setFeature 立即生效并写回 snapshot', async () => {
    const result = channel.setFeature('thinkingSummary', true)
    assert.equal(result.ok, true)
    assert.equal(result.features.thinkingSummary, true)
    assert.equal(channel.snapshot().features.thinkingSummary, true)
  })

  await check('开关持久化，新实例加载覆盖值', async () => {
    const saved = JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8'))
    assert.deepEqual(saved.settings.features, { thinkingSummary: true })
    const reloaded = createChannel(ctx, { ...baseConfig })
    assert.equal(reloaded.featureValues().thinkingSummary, true)
    reloaded.stop()
  })

  await check('emotionAuto 用布尔切换为 subtle/off', async () => {
    const result = channel.setFeature('emotionAuto', false)
    assert.equal(result.features.emotionAuto, false)
    const saved = JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8'))
    assert.equal(saved.settings.features.emotionAuto, false)
  })

  await check('未知开关被拒绝', async () => {
    const result = channel.setFeature('not-a-feature', true)
    assert.equal(result.ok, false)
    assert.match(result.message, /未知功能开关/)
  })

  await check('配置文件显式开启优先于默认', async () => {
    const dir2 = path.join(root, 'state2')
    makeState(dir2)
    const configured = createChannel(ctx, { ...baseConfig, stateDir: dir2, streamSegment: true })
    assert.equal(configured.featureValues().streamSegment, true)
    configured.stop()
  })
} finally {
  channel.stop()
  server.closeAllConnections?.()
  server.close()
  fs.rmSync(root, { recursive: true, force: true })
}

console.log(`\n${passed} feature checks passed`)
