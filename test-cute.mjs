// 可爱化回复自测：node test-cute.mjs
import assert from 'node:assert/strict'
import { __test } from './index.js'

const { decorateReply } = __test

let passed = 0
const check = async (name, fn) => {
  await fn()
  passed += 1
  console.log(`ok ${passed} - ${name}`)
}

try {
  await check('decorateReply：off / always / subtle', async () => {
    assert.equal(decorateReply('好', { level: 'off' }), '好')
    assert.equal(decorateReply('好', { level: 'always', pool: ['🌊'], random: () => 0 }), '好 🌊')
    assert.equal(decorateReply('好', { level: 'subtle', pool: ['🌊'], random: () => 0.1 }), '好 🌊')
    assert.equal(decorateReply('好', { level: 'subtle', pool: ['🌊'], random: () => 0.9 }), '好')
  })

  await check('decorateReply：去重 / 空文本 / 默认池', async () => {
    assert.equal(decorateReply('好的 🌊', { level: 'always', pool: ['🌊'], random: () => 0 }), '好的 🌊')
    assert.equal(decorateReply('', { level: 'always' }), '')
    const decorated = decorateReply('好', { level: 'always', random: () => 0 })
    assert.notEqual(decorated, '好')
  })
} finally {
  /* nothing to clean */
}

console.log(`\n${passed} cute checks passed`)
