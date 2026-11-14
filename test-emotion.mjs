// 表情包库（/emotion）自测：node test-emotion.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { __test } from './index.js'

const {
  createChannel,
  normalizeConfig,
  guessEmotionCategory,
  emotionContextScore,
  sanitizeEmotionStem,
} = __test
const accountId = 'acct-test'
const chatId = 'user:u-test@im.wechat'
const sessionId = 'sess-emotion-01'
const bindingKey = `${accountId}::${chatId}`

const sent = []
const items = []
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => { body += chunk })
  req.on('end', () => {
    if (req.url?.endsWith('/getuploadurl')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ret: 0, upload_full_url: `${base}/upload` }))
      return
    }
    if (req.url === '/upload') {
      res.writeHead(200, { 'x-encrypted-param': 'enc-param' })
      res.end('ok')
      return
    }
    if (req.url?.includes('sendmessage')) {
      const parsed = JSON.parse(body || '{}')
      const item = parsed?.msg?.item_list?.[0] ?? {}
      items.push(item)
      if (item?.text_item?.text) sent.push(item.text_item.text)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ret: 0, message_id: `m-${items.length}` }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{}')
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-emotion-'))
const stateDir = path.join(root, 'state')
const emotionDir = path.join(root, 'emotions')
fs.mkdirSync(stateDir, { recursive: true })
fs.writeFileSync(
  path.join(stateDir, 'state.json'),
  JSON.stringify({
    version: 2,
    accounts: {
      [accountId]: { id: accountId, name: 'test-bot', botToken: 'fake-token', botId: 'bot@im.bot', userId: 'u-test@im.wechat', apiBase: base, createdAt: Date.now() },
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
        state: async () => ({ running: false, active: false, queue: [], pendingInput: [] }),
        prompt: async () => {},
        list: async () => ({ items: [{ sessionId, updatedAt: 1, running: false, projections: { values: { title: '表情测试' } } }] }),
      }
    }
    return undefined
  },
  logger: { info() {}, warn() {}, error() {} },
  on: () => () => {},
}
const config = {
  ...normalizeConfig({ stateDir, emotionDir, emotionAuto: 'subtle', emotionThreshold: 2, emotionCooldownMs: 300000 }),
  progressHeartbeat: false,
  replyTimeoutMs: 5000,
}
const channel = createChannel(ctx, config)
channel.start()
channel.stop() // start 会 syncEmotions 建目录；随后停止网络监听（这里没有账号轮询也无妨）

const inbound = (text, messageId) =>
  channel.handleInbound(accountId, {
    message_type: 1,
    from_user_id: chatId.replace(/^user:/, ''),
    message_id: messageId,
    context_token: 'ctx-token-2',
    item_list: [{ type: 1, text_item: { text } }],
  })
const lastReply = () => sent[sent.length - 1] ?? ''
const reset = () => { sent.length = 0; items.length = 0 }
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])

let passed = 0
const check = async (name, fn) => {
  await fn()
  passed += 1
  console.log(`ok ${passed} - ${name}`)
}

try {
  await check('语境分类与打分（纯本地不耗 token）', async () => {
    assert.equal(guessEmotionCategory('哈哈太好笑了'), '开心')
    assert.equal(guessEmotionCategory('好难过想哭'), '难过')
    assert.equal(guessEmotionCategory('今天天气不错'), null)
    assert.deepEqual(emotionContextScore('哈哈', '好耶'), { category: '开心', score: 3 })
    assert.deepEqual(emotionContextScore('谢谢', '不客气'), null)
    assert.equal(sanitizeEmotionStem('a/b c.png'), 'a_b_c')
  })

  await check('saveEmotionBuffer 按分类落盘并建索引（重名加序号）', async () => {
    const first = channel.saveEmotionBuffer(png, '.png', { category: '开心', source: 'user', name: 'haha' })
    assert.equal(first.file, '开心/haha.png')
    assert.ok(fs.existsSync(path.join(emotionDir, first.file)))
    const second = channel.saveEmotionBuffer(png, '.png', { category: '开心', source: 'user', name: 'haha' })
    assert.equal(second.file, '开心/haha_2.png')
    const builtin = channel.saveEmotionBuffer(png, '.png', { category: '开心', source: 'builtin', name: '内置' })
    assert.equal(builtin.source, 'builtin')
    assert.ok(fs.existsSync(path.join(emotionDir, 'index.json')))
    assert.equal(channel.listEmotionEntries('开心', false).length, 2, '默认不含外来来源')
    assert.equal(channel.listEmotionEntries('开心', true).length, 3)
  })

  await check('/emotion add → end 流程与分类计数', async () => {
    reset()
    await inbound('/emotion add 难过', 'm-1')
    assert.match(lastReply(), /开始收录到「难过」/)
    const saved = JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8'))
    assert.equal(saved.bindings[bindingKey].emotionUpload.category, '难过')
    reset()
    await inbound('/emotion end', 'm-2')
    assert.match(lastReply(), /收录结束：「难过」现在共 0 张/)
  })

  await check('/emotion list 汇总与按分类列出', async () => {
    reset()
    await inbound('/emotion list', 'm-3')
    assert.match(lastReply(), /表情包（2）/)
    assert.match(lastReply(), /开心 2/)
    reset()
    await inbound('/emotion list 开心', 'm-4')
    assert.match(lastReply(), /haha/)
    assert.doesNotMatch(lastReply(), /内置/, '默认不列外来来源')
  })

  await check('/emotion rename / delete', async () => {
    reset()
    await inbound('/emotion rename haha 笑死', 'm-5')
    assert.match(lastReply(), /已重命名为「笑死」/)
    assert.ok(fs.existsSync(path.join(emotionDir, '开心', '笑死.png')))
    reset()
    await inbound('/emotion delete 笑死', 'm-6')
    assert.match(lastReply(), /已删除「笑死」/)
    assert.ok(!fs.existsSync(path.join(emotionDir, '开心', '笑死.png')))
  })

  await check('/emotion other source true 后才允许外来来源', async () => {
    reset()
    await inbound('/emotion other source true', 'm-7')
    assert.match(lastReply(), /已允许使用外来表情包/)
    const saved = JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8'))
    assert.equal(saved.settings.emotionAllowOtherSource, true)
    reset()
    await inbound('/emotion list 开心', 'm-8')
    assert.match(lastReply(), /内置/)
  })

  await check('/emotion send 开心 手动发图片', async () => {
    reset()
    await inbound('/emotion send 开心', 'm-9')
    assert.ok(items.length >= 1)
    assert.equal(items[0].type, 2)
    assert.ok(items[0].image_item)
  })

  await check('maybeSendEmotions：命中语境发 1–2 张，冷却内不再发', async () => {
    reset()
    const first = await channel.maybeSendEmotions(bindingKey, '哈哈太搞笑了', '好耶')
    assert.ok(first.sent >= 1 && first.sent <= 2)
    assert.equal(items.length, first.sent)
    const second = await channel.maybeSendEmotions(bindingKey, '哈哈', '好耶')
    assert.equal(second.sent, 0)
    assert.equal(second.reason, 'cooldown')
  })

  await check('emotion off 时完全不发', async () => {
    const quiet = createChannel(ctx, { ...config, emotionAuto: 'off' })
    quiet.start()
    quiet.stop()
    const result = await quiet.maybeSendEmotions(bindingKey, '哈哈', '好耶')
    assert.equal(result.sent, 0)
    assert.equal(result.reason, 'disabled')
    quiet.stop()
  })
} finally {
  channel.stop()
  server.closeAllConnections?.()
  server.close()
  fs.rmSync(root, { recursive: true, force: true })
}

console.log(`\n${passed} emotion checks passed`)
