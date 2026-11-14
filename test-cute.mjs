// 可爱化回复 + /sticker 表情包自测：node test-cute.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { __test } from './index.js'

const { createChannel, normalizeConfig, decorateReply, listStickers, pickSticker } = __test
const accountId = 'acct-test'
const chatId = 'user:u-test@im.wechat'
const sessionId = 'sess-cute-01'
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
      items.push(parsed?.msg?.item_list?.[0] ?? {})
      const text = parsed?.msg?.item_list?.[0]?.text_item?.text
      if (text) sent.push(text)
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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-cute-'))
const stateDir = path.join(root, 'state')
const stickerDir = path.join(root, 'stickers')
fs.mkdirSync(stickerDir, { recursive: true })
fs.writeFileSync(path.join(stickerDir, 'happy.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]))
fs.writeFileSync(path.join(stickerDir, 'angry.gif'), Buffer.from('GIF89a'))
fs.writeFileSync(path.join(stickerDir, 'note.txt'), 'ignore me')
fs.mkdirSync(path.join(stickerDir, 'sub'))

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
        list: async () => ({ items: [{ sessionId, updatedAt: 1, running: false, projections: { values: { title: '可爱测试' } } }] }),
      }
    }
    return undefined
  },
  logger: { info() {}, warn() {}, error() {} },
  on: () => () => {},
}
const config = { ...normalizeConfig({ stateDir, stickerDir }), progressHeartbeat: false, replyTimeoutMs: 5000 }
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
const reset = () => { sent.length = 0; items.length = 0 }

let passed = 0
const check = async (name, fn) => {
  await fn()
  passed += 1
  console.log(`ok ${passed} - ${name}`)
}

try {
  await check('decorateReply：off/always/subtle 与去重', async () => {
    assert.equal(decorateReply('好', { level: 'off' }), '好')
    assert.equal(decorateReply('好', { level: 'always', pool: ['🌊'], random: () => 0 }), '好 🌊')
    assert.equal(decorateReply('好', { level: 'subtle', pool: ['🌊'], random: () => 0.1 }), '好 🌊')
    assert.equal(decorateReply('好', { level: 'subtle', pool: ['🌊'], random: () => 0.9 }), '好')
    assert.equal(decorateReply('好的 🌊', { level: 'always', pool: ['🌊'], random: () => 0 }), '好的 🌊')
    assert.equal(decorateReply('', { level: 'always' }), '')
  })

  await check('listStickers/pickSticker：只认图片、按关键词筛、无匹配给全量', async () => {
    const files = listStickers(stickerDir)
    assert.equal(files.length, 2)
    assert.ok(files.every((file) => /\.(png|gif)$/i.test(file)))
    const byKeyword = pickSticker(stickerDir, 'angry')
    assert.equal(byKeyword.picked, path.join(stickerDir, 'angry.gif'))
    const noMatch = pickSticker(stickerDir, 'zzz')
    assert.equal(noMatch.picked, null)
    assert.equal(noMatch.stickers.length, 2)
    assert.deepEqual(listStickers(path.join(root, 'missing')), [])
  })

  await check('/sticker 发一张图片（走 CDN 上传 + image_item）', async () => {
    reset()
    const result = await inbound('/sticker', 'm-1')
    assert.deepEqual(result, { command: 'sticker' })
    assert.equal(items.length, 1)
    assert.equal(items[0].type, 2)
    assert.ok(items[0].image_item)
    assert.equal(sent.length, 0, '发表情包时不应该再发文字')
  })

  await check('/sticker 关键词筛到指定文件', async () => {
    reset()
    await inbound('/sticker angry', 'm-2')
    assert.equal(items.length, 1)
    assert.equal(items[0].type, 2)
  })

  await check('/sticker 列表 与 无匹配提示', async () => {
    reset()
    await inbound('/sticker 列表', 'm-3')
    assert.match(lastReply(), /表情包 2 张/)
    assert.match(lastReply(), /happy/)
    assert.match(lastReply(), /angry/)
    reset()
    await inbound('/sticker zzz', 'm-4')
    assert.match(lastReply(), /没有匹配「zzz」/)
  })

  await check('目录为空时给出放置提示', async () => {
    const empty = path.join(root, 'empty')
    fs.mkdirSync(empty, { recursive: true })
    const emptyChannel = createChannel(ctx, { ...config, stickerDir: empty })
    reset()
    await emptyChannel.handleInbound(accountId, {
      message_type: 1,
      from_user_id: chatId.replace(/^user:/, ''),
      message_id: 'm-5',
      context_token: 'ctx-token-3',
      item_list: [{ type: 1, text_item: { text: '/sticker' } }],
    })
    assert.match(lastReply(), /还没有表情包/)
    emptyChannel.stop()
  })
} finally {
  channel.stop()
  server.closeAllConnections?.()
  server.close()
  fs.rmSync(root, { recursive: true, force: true })
}

console.log(`\n${passed} cute checks passed`)
