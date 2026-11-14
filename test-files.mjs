// 输出文件转发自测：node test-files.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { __test } from './index.js'

const { createChannel, normalizeConfig } = __test
const accountId = 'acct-test'
const chatId = 'user:u-test@im.wechat'
const sessionId = 'sess-files-01'

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
      res.writeHead(200, { 'x-encrypted-param': 'enc-param', 'content-type': 'application/json' })
      res.end('ok')
      return
    }
    if (req.url?.includes('sendmessage')) {
      const parsed = JSON.parse(body || '{}')
      items.push(parsed?.msg?.item_list?.[0] ?? {})
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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-files-'))
const stateDir = path.join(root, 'state')
fs.mkdirSync(stateDir, { recursive: true })
const png = path.join(root, 'pic.png')
const pdf = path.join(root, 'report.pdf')
const js = path.join(root, 'code.js')
const big = path.join(root, 'big.pdf')
fs.writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]))
fs.writeFileSync(pdf, Buffer.from('%PDF-1.4 test'))
fs.writeFileSync(js, 'console.log(1)')
fs.writeFileSync(big, Buffer.alloc(4096))

fs.writeFileSync(
  path.join(stateDir, 'state.json'),
  JSON.stringify({
    version: 2,
    accounts: {
      [accountId]: { id: accountId, name: 'test-bot', botToken: 'fake-token', botId: 'bot@im.bot', userId: 'u-test@im.wechat', apiBase: base, createdAt: Date.now() },
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

const imageRef = { attachmentId: 'img-1', mediaType: 'image/png', bytes: 7, width: 1, height: 1, name: 'pic.png' }
const fileRef = { attachmentId: 'file-1', name: 'report.pdf', bytes: 14 }
const events = [
  { type: 'assistant/message', seq: 1, time: Date.now(), data: { message: { blocks: [{ type: 'text', text: '图好了' }, { type: 'image', attachment: imageRef }] } } },
  { type: 'assistant/message', seq: 2, time: Date.now(), data: { message: { blocks: [{ type: 'file', attachment: fileRef }] } } },
  { type: 'assistant/message', seq: 3, time: Date.now(), data: { message: { blocks: [{ type: 'text', text: `报表在 ${pdf}` }] } } },
]
let currentEvents = events
const liveSession = {
  id: sessionId,
  seq: 3,
  snapshotEvents: (from, to) => currentEvents.filter((event) => event.seq >= from && event.seq < to),
}
const attachments = {
  imageHostPath: (ref) => (ref.attachmentId === 'img-1' ? png : undefined),
  fileHostPath: (ref) => (ref.attachmentId === 'file-1' ? pdf : undefined),
  readImage: async () => { throw new Error('not needed') },
  readFileStream: async () => { throw new Error('not needed') },
}
const ctx = {
  get: (name) => {
    if (name === 'sessions') return { get: (id) => (id === sessionId ? liveSession : undefined), list: () => [liveSession] }
    if (name === 'attachments') return attachments
    if (name === 'workingDirectory') return { get: () => root }
    if (name === 'sessionController') {
      return {
        state: async () => ({ running: false, active: false, queue: [], pendingInput: [] }),
        prompt: async () => {},
        list: async () => ({ items: [{ sessionId, updatedAt: 1, running: false, projections: { values: { title: '文件测试' } } }] }),
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
  mirrorIntervalMs: 60_000,
  mirrorAssistantMessages: true,
  mirrorUserMessages: false,
  mirrorFiles: true,
  mirrorFileMaxBytes: 1024,
}
const channel = createChannel(ctx, baseConfig)
const binding = {
  key: `${accountId}::${chatId}`,
  accountId,
  chatId,
  toUserId: chatId.replace(/^user:/, ''),
  sessionId,
  contextToken: 'ctx-token',
}
const reset = () => { items.length = 0 }
const types = () => items.map((item) => item.type)

let passed = 0
const check = async (name, fn) => {
  await fn()
  passed += 1
  console.log(`ok ${passed} - ${name}`)
}

try {
  await check('聊天里的图片/文件附件 + 文本路径都会转发', async () => {
    reset()
    const report = await channel.scanAndMirror(binding, 1, 4, { send: true })
    assert.equal(report.ok, true)
    const foundTypes = types()
    assert.ok(foundTypes.includes(1), `缺文本消息：${JSON.stringify(foundTypes)}`)
    assert.ok(foundTypes.includes(2), `缺图片：${JSON.stringify(foundTypes)}`)
    assert.ok(foundTypes.filter((type) => type === 4).length >= 1, `缺文件：${JSON.stringify(foundTypes)}`)
    const files = report.candidates.filter((item) => item.kind === 'file')
    assert.ok(files.some((item) => item.name === 'pic.png'))
    assert.ok(files.some((item) => String(item.path ?? '').endsWith('report.pdf')))
  })

  await check('同一附件不会重复发', async () => {
    reset()
    const report = await channel.scanAndMirror(binding, 1, 2, { send: true })
    assert.equal(report.ok, true)
    assert.equal(types().filter((type) => type === 2).length, 0, '图片不应重复发送')
    assert.equal(types().filter((type) => type === 4).length, 0, '文件不应重复发送')
  })

  await check('不转发 .js 等非输出文件，超限文件跳过', async () => {
    reset()
    currentEvents = [
      { type: 'assistant/message', seq: 10, time: Date.now(), data: { message: { blocks: [{ type: 'text', text: `代码 ${js} 生成完毕` }] } } },
      { type: 'assistant/message', seq: 11, time: Date.now(), data: { message: { blocks: [{ type: 'text', text: `大文件 ${big}` }] } } },
    ]
    const report = await channel.scanAndMirror(binding, 10, 12, { send: true })
    assert.equal(report.ok, true)
    assert.equal(items.length, 2, '只应发送两条文本，不应发 js/大文件')
    const fileCandidates = report.candidates.filter((item) => item.kind === 'file')
    assert.ok(fileCandidates.some((item) => String(item.error ?? '').includes('超过')), JSON.stringify(fileCandidates))
  })

  await check('微信轮次（runTurn）的文件也会补发', async () => {
    reset()
    const pathFile = path.join(root, 'turn-output.png')
    fs.writeFileSync(pathFile, Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 9, 9]))
    currentEvents = [
      { type: 'assistant/message', seq: 20, time: Date.now(), data: { message: { blocks: [{ type: 'text', text: `生成的文件：${pathFile}` }] } } },
    ]
    liveSession.seq = 21
    const turnBinding = {
      key: `${accountId}::${chatId}`,
      accountId,
      chatId,
      toUserId: chatId.replace(/^user:/, ''),
      sessionId,
      contextToken: 'ctx-token',
    }
    const sentFiles = await channel.forwardTurnFiles(turnBinding, sessionId, 20)
    assert.equal(sentFiles, 1)
    assert.equal(items.filter((item) => item.type === 2).length, 1)
  })
} finally {
  channel.stop()
  server.closeAllConnections?.()
  server.close()
  fs.rmSync(root, { recursive: true, force: true })
}

console.log(`\n${passed} file checks passed`)
