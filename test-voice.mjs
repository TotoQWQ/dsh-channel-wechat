// 语音兜底自测：node test-voice.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { __test } from './index.js'

const { createChannel, normalizeConfig } = __test
const accountId = 'acct-test'
const chatId = 'user:u-test@im.wechat'
const sessionId = 'sess-voice-01'

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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-voice-'))
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

const liveSession = { id: sessionId, seq: 0, snapshotEvents: () => [] }
const asrCalls = []
const speechToText = {
  listProviders: () => [{ id: 'local-whisper', name: '本地 Whisper' }],
  resolve: (request) => ({ audio: request.audio, provider: { id: 'local-whisper' }, language: 'zh' }),
  transcribe: async (spec) => {
    asrCalls.push(spec)
    return { text: '你好世界', audioSeconds: 1, inferenceSeconds: 0.1 }
  },
}
const ctx = {
  get: (name) => {
    if (name === 'speechToText') return speechToText
    if (name === 'sessions') return { get: (id) => (id === sessionId ? liveSession : undefined), list: () => [liveSession] }
    if (name === 'sessionController') {
      return {
        state: async () => ({ running: false, active: false, queue: [], pendingInput: [] }),
        prompt: async () => {},
        list: async () => ({ items: [{ sessionId, updatedAt: 1, running: false, projections: { values: { title: '语音测试' } } }] }),
      }
    }
    return undefined
  },
  logger: { info() {}, warn() {}, error() {} },
  on: () => () => {},
}
const baseConfig = { ...normalizeConfig({ stateDir }), progressHeartbeat: false, replyTimeoutMs: 400 }
const channel = createChannel(ctx, baseConfig)

const inbound = (channel_, msg, messageId) =>
  channel_.handleInbound(accountId, {
    message_type: 1,
    from_user_id: chatId.replace(/^user:/, ''),
    message_id: messageId,
    context_token: 'ctx-token-2',
    ...msg,
  })
const voiceMsg = (text) => ({ item_list: [{ type: 3, voice_item: { text, duration: 3200 } }] })

let passed = 0
const check = async (name, fn) => {
  await fn()
  passed += 1
  console.log(`ok ${passed} - ${name}`)
}

try {
  await check('非 silk 音频走 DSH speechToText 兜底', async () => {
    const wav = path.join(root, 'sample.wav')
    fs.writeFileSync(wav, Buffer.from('RIFF0000WAVEfmt '))
    asrCalls.length = 0
    const text = await channel.transcribeVoiceFile(wav)
    assert.equal(text, '你好世界')
    assert.equal(asrCalls.length, 1)
  })

  await check('silk 文件跳过 ASR', async () => {
    const silk = path.join(root, 'sample.silk')
    fs.writeFileSync(silk, Buffer.from('silk'))
    asrCalls.length = 0
    assert.equal(await channel.transcribeVoiceFile(silk), '')
    assert.equal(asrCalls.length, 0)
  })

  await check('/voice 显示本地 ASR 与兜底开关', async () => {
    sent.length = 0
    await inbound(channel, { item_list: [{ type: 1, text_item: { text: '/voice' } }] }, 'm-1')
    const reply = sent[sent.length - 1]
    assert.match(reply, /语音输入/)
    assert.match(reply, /本地 Whisper/)
    assert.match(reply, /未识别时的提示：开/)
  })

  await check('没有转写的语音会提示对方打字', async () => {
    sent.length = 0
    await inbound(channel, voiceMsg(''), 'm-2')
    assert.ok(sent.some((item) => item.includes('🎙️') && item.includes('打字')), JSON.stringify(sent))
  })

  await check('有腾讯转写的语音不提示', async () => {
    sent.length = 0
    await inbound(channel, voiceMsg('这是腾讯转写好的'), 'm-3')
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.ok(!sent.some((item) => item.includes('🎙️')), JSON.stringify(sent))
  })

  await check('voiceFallbackHint=false 时不提示', async () => {
    const dir2 = path.join(root, 'state2')
    fs.mkdirSync(dir2, { recursive: true })
    fs.copyFileSync(path.join(stateDir, 'state.json'), path.join(dir2, 'state.json'))
    const quiet = createChannel(ctx, { ...baseConfig, stateDir: dir2, voiceFallbackHint: false })
    sent.length = 0
    await quiet.handleInbound(accountId, {
      message_type: 1,
      from_user_id: chatId.replace(/^user:/, ''),
      message_id: 'm-4',
      context_token: 'ctx-token-3',
      item_list: [{ type: 3, voice_item: { text: '' } }],
    })
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.ok(!sent.some((item) => item.includes('🎙️')))
  })
} finally {
  channel.stop()
  server.closeAllConnections?.()
  server.close()
  fs.rmSync(root, { recursive: true, force: true })
}

console.log(`\n${passed} voice checks passed`)
