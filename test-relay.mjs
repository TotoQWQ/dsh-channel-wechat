// 选项 / 审批转发端到端自测（不需要真实 iLink）：
//   node test-relay.mjs
// 起一个假的 iLink HTTP 服务，构造一个带绑定账号的临时 state，直接驱动 channel：
//   1) DSH 发问 → 插件把选项发到「微信」（假服务记录请求）
//   2) 用 handleInbound 模拟微信回复「2」
//   3) 断言返回 {answers:[{id,selected:['B']}]}，并发出「已收到」确认
//   4) 审批同理：回 1 → allowed-once
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { __test } from './index.js'

const { createChannel, normalizeConfig } = __test
const accountId = 'acct-test'
const chatId = 'user:u-test@im.wechat'
const sessionId = 'session-test-1'
const bindingKey = `${accountId}::${chatId}`

const sent = []
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => { body += chunk })
  req.on('end', () => {
    if (req.url?.includes('sendmessage')) {
      const parsed = JSON.parse(body || '{}')
      const text = parsed?.msg?.item_list?.[0]?.text_item?.text ?? ''
      sent.push(text)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ret: 0, message_id: `m-${sent.length}` }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ret: 0, updates: [] }))
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const apiBase = `http://127.0.0.1:${port}`

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-relay-'))
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

const ctx = {
  get: () => undefined,
  logger: { info() {}, warn() {}, error() {} },
  on: () => () => {},
}
const config = normalizeConfig({ stateDir, enabled: true, optionReplyTimeoutMs: 5000 })
const channel = createChannel(ctx, config)

const waitFor = async (predicate, timeoutMs = 3000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
  return false
}

const inbound = (text, messageId) =>
  channel.handleInbound(accountId, {
    message_type: 1,
    from_user_id: chatId.replace(/^user:/, ''),
    message_id: messageId,
    context_token: 'ctx-token-2',
    item_list: [{ type: 1, text_item: { text } }],
  })

let passed = 0
const check = async (name, fn) => {
  await fn()
  passed += 1
  console.log(`ok ${passed} - ${name}`)
}

// 1) 选项卡：发出 → 回「2」→ 得到 B
const question = channel.relayUserQuestion({
  agent: { id: sessionId },
  questions: [
    {
      id: 'mode',
      question: '用哪种模式？',
      options: [{ label: 'A 快速' }, { label: 'B 完整' }],
    },
  ],
  signal: new AbortController().signal,
})
await check('选项卡发到微信', async () => {
  assert.equal(await waitFor(() => sent.length >= 1), true, '没有发出选项提示')
  assert.match(sent[0], /DSH 需要你选择/)
  assert.match(sent[0], /1\. A 快速/)
  assert.match(sent[0], /2\. B 完整/)
})

await check('微信回「2」得到 B，并回确认', async () => {
  const result = await inbound('2', 'msg-1')
  assert.deepEqual(result, { optionReply: true, kind: 'question' })
  const answer = await question
  assert.deepEqual(answer, { answers: [{ id: 'mode', selected: ['B 完整'] }] })
  assert.equal(await waitFor(() => sent.some((text) => text.includes('已收到：B 完整'))), true)
})

// 2) 序号越界：提示后继续等，再回「1」仍能答对
const question2 = channel.relayUserQuestion({
  agent: { id: sessionId },
  questions: [{ id: 'pick', question: '选一个', options: [{ label: '甲' }, { label: '乙' }] }],
  signal: new AbortController().signal,
})
await check('越界序号提示重回，随后回「1」成功', async () => {
  assert.equal(await waitFor(() => sent.some((text) => text.includes('1. 甲'))), true)
  await inbound('9', 'msg-2')
  assert.equal(await waitFor(() => sent.some((text) => text.includes('超出范围'))), true)
  await inbound('1', 'msg-3')
  assert.deepEqual(await question2, { answers: [{ id: 'pick', selected: ['甲'] }] })
})

// 3) 审批：回 1 → allowed-once
const approval = channel.relayApproval({
  agent: { id: sessionId },
  toolName: 'bash',
  reason: '要执行命令',
  signal: new AbortController().signal,
})
await check('审批卡发到微信并回 1 得到 allowed-once', async () => {
  assert.equal(await waitFor(() => sent.some((text) => text.includes('DSH 需要你审批'))), true)
  await inbound('1', 'msg-4')
  assert.equal(await approval, 'allowed-once')
  assert.equal(await waitFor(() => sent.some((text) => text.includes('已允许一次'))), true)
})

// 4) 未绑定的会话不接管（返回 undefined，交还 GUI）
await check('未绑定会话返回 undefined', async () => {
  const untouched = await channel.relayUserQuestion({
    agent: { id: 'session-not-bound' },
    questions: [{ id: 'q', question: '?' }],
    signal: new AbortController().signal,
  })
  assert.equal(untouched, undefined)
})

// 5) 超时（默认 skip）：问题标记未作答、审批按拒绝，都继续这一轮
await check('微信超时 → 选项卡按「跳过」继续', async () => {
  const result = await channel.relayUserQuestion({
    agent: { id: sessionId },
    questions: [{ id: 'timeout-q', question: '还选吗？', options: [{ label: '甲' }, { label: '乙' }] }],
    signal: new AbortController().signal,
  })
  assert.deepEqual(result, { answers: [{ id: 'timeout-q', selected: [] }] })
  assert.equal(await waitFor(() => sent.some((text) => text.includes('已按「跳过」')), true), true)
})

await check('微信超时 → 审批按「拒绝」继续', async () => {
  const result = await channel.relayApproval({
    agent: { id: sessionId },
    toolName: 'pwsh',
    signal: new AbortController().signal,
  })
  assert.equal(result, 'rejected')
  assert.equal(await waitFor(() => sent.some((text) => text.includes('已按「拒绝」')), true), true)
})

// 6) optionTimeoutMode: handoff 时保留老行为：交还电脑端
await check('handoff 模式超时 → 交还电脑端', async () => {
  const handoff = createChannel(ctx, { ...config, optionTimeoutMode: 'handoff' })
  const result = await handoff.relayApproval({
    agent: { id: sessionId },
    toolName: 'pwsh',
    signal: new AbortController().signal,
  })
  assert.equal(result, undefined)
  assert.equal(await waitFor(() => sent.some((text) => text.includes('转到电脑端')), true), true)
  handoff.stop()
})

channel.stop()
server.close()
fs.rmSync(stateDir, { recursive: true, force: true })
console.log(`\n${passed} relay checks passed`)
