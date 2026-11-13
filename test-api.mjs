#!/usr/bin/env node
/**
 * dsh-channel-wechat 全功能自测（走插件自己的 HTTP 接口）
 *
 *   DSH_WEB_URL=http://127.0.0.1:60260 node test-api.mjs
 *
 * 覆盖：状态/版本、会话列表、客户端模块、引用解析、镜像干跑、
 * 默认会话、新建会话、绑定/解绑、验证码、二维码、未知路由。
 * 不发送微信消息（不打扰用户）。
 */

import fs from 'node:fs'

const BASE = process.env.DSH_WEB_URL || 'http://127.0.0.1:60260'
const API = `${BASE}/wechat-channel`
const pkg = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

async function get(path) {
  const res = await fetch(API + path, { headers: { 'user-agent': 'dsh-channel-wechat-test' } })
  const text = await res.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }
  return { status: res.status, json, text }
}

async function post(path, body) {
  const res = await fetch(API + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'dsh-channel-wechat-test' },
    body: JSON.stringify(body ?? {}),
  })
  const text = await res.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }
  return { status: res.status, json, text }
}

const quoteOf = async (item) =>
  (await get(`/quote-probe?chatId=user:probe&item=${encodeURIComponent(JSON.stringify(item))}`)).json?.resolved

// 1. 状态
const status = await get('/status')
check('GET /status 200', status.status === 200)
check(
  '版本号与 package.json 一致',
  status.json?.version === pkg.version,
  `runtime=${status.json?.version} pkg=${pkg.version}`,
)
check('accounts 非空', Array.isArray(status.json?.accounts) && status.json.accounts.length > 0, `${status.json?.accounts?.length} 个`)
check('settings.defaultSessionId 存在', typeof status.json?.settings?.defaultSessionId === 'string')
check('mirror 运行中', status.json?.mirror?.running === true)
const binding = (status.json?.bindings ?? []).find((b) => String(b.chatId).includes('@im.wechat'))
check('至少一条真实微信绑定', Boolean(binding), binding?.chatId ?? 'none')

// 2. 会话列表
const sessions = await get('/sessions')
check(
  'GET /sessions 200 + 列表',
  sessions.status === 200 && Array.isArray(sessions.json?.items) && sessions.json.items.length > 0,
  `${sessions.json?.items?.length} 条`,
)

// 3. 客户端模块
const modules = await get('/client-modules')
check('客户端模块已注册', modules.status === 200 && String(modules.text).includes('dsh-channel-wechat'))

// 4. 引用解析
check('quote: 内联全文', (await quoteOf({ ref_msg: { message_item: { type: 1, text_item: { text: 'ABC' } } } })) === 'ABC')
check(
  'quote: 部分切片',
  (await quoteOf({
    ref_msg: { message_item: { type: 1, text_item: { text: '0123456789' } }, partial_text: { startindex: 2, endindex: 6 } },
  })) === '2345',
)
check('quote: title 兜底', (await quoteOf({ ref_msg: { title: '摘要X' } })) === '摘要X')
check('quote: 无引用返回 null', (await quoteOf({ type: 1, text_item: { text: 'x' } })) === null)

// 5. 镜像干跑
const probe = await get(`/mirror-probe?from=${Math.max(0, Number(binding?.lastSeq ?? 0) - 50)}`)
check('mirror-probe 干跑', probe.status === 200 && probe.json?.dryRun === true && Array.isArray(probe.json?.reports))

// 6. 默认接收会话
const before = status.json?.settings?.defaultSessionId ?? ''
check('POST /default-session 设置', (await post('/default-session', { sessionId: before || 'session-test' })).json?.ok === true)
check(
  'POST /default-session 恢复',
  (await post('/default-session', { sessionId: before })).json?.defaultSessionId === before,
)

// 7. 新建会话
const created = await post('/new-session', { asDefault: false })
check('POST /new-session 建会话', created.status === 200 && Boolean(created.json?.sessionId), created.json?.sessionId ?? '')

// 8. 绑定 / 解绑
if (binding) {
  const target = binding.sessionId
  check('POST /bind 幂等', (await post('/bind', { key: binding.key, sessionId: target })).json?.ok === true)
  check('POST /unbind', (await post('/unbind', { key: binding.key })).json?.ok === true)
  check('POST /bind 恢复原会话', (await post('/bind', { key: binding.key, sessionId: target })).json?.binding?.sessionId === target)
}

// 9. 其它
check('POST /verify 不崩', (await post('/verify', { code: '1234' })).status === 200)
const qr = await get('/qr.png')
check('GET /qr.png 可用', qr.status === 200 || qr.status === 404, `status=${qr.status}`)
check('未知路由 404', (await get('/nope')).status === 404)

const failed = results.filter((r) => !r.ok)
console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`)
if (failed.length) {
  console.log('FAILED: ' + failed.map((f) => f.name).join(' | '))
  process.exit(1)
}
