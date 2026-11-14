// 选项 / 审批转发的纯函数自测：node test-options.mjs
import assert from 'node:assert/strict'
import { __test } from './index.js'

const {
  formatQuestionPrompt,
  parseQuestionReply,
  parseNumberList,
  formatApprovalPrompt,
  parseApprovalReply,
  describeApprovalReason,
} = __test

let passed = 0
const check = (name, fn) => {
  fn()
  passed += 1
  console.log(`ok ${passed} - ${name}`)
}

check('单题带选项：问句、编号、单选提示、超时提示', () => {
  const text = formatQuestionPrompt(
    {
      id: 'q1',
      header: 'Choose Mode',
      question: '用哪种模式？',
      options: [
        { label: '快速模式（Recommended）', description: '先出结果' },
        { label: '完整模式' },
      ],
    },
    0,
    1,
    { timeoutSec: 120 },
  )
  assert.match(text, /DSH 需要你选择/)
  assert.match(text, /【Choose Mode】/)
  assert.match(text, /用哪种模式？/)
  assert.match(text, /1\. 快速模式（Recommended） —— 先出结果/)
  assert.match(text, /2\. 完整模式/)
  assert.match(text, /回复序号选择；也可以直接回复你自己的答案。/)
  assert.match(text, /120 秒内回复有效/)
  assert.ok(!text.includes('多选'))
})

check('多题多选：题号与多选提示', () => {
  const text = formatQuestionPrompt(
    { id: 'q2', question: '要哪些？', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }] },
    1,
    3,
  )
  assert.match(text, /第 2\/3 题/)
  assert.match(text, /多选用逗号/)
})

check('无选项：提示直接回复', () => {
  const text = formatQuestionPrompt({ id: 'q3', question: '名字？' }, 0, 1)
  assert.match(text, /直接回复你的答案即可/)
})

check('序号解析支持中英文逗号与顿号', () => {
  assert.deepEqual(parseNumberList('1'), [1])
  assert.deepEqual(parseNumberList('1,3'), [1, 3])
  assert.deepEqual(parseNumberList('1，3'), [1, 3])
  assert.deepEqual(parseNumberList('2、4'), [2, 4])
  assert.equal(parseNumberList('1 3'), null)
  assert.equal(parseNumberList('随便'), null)
})

check('回复解析：单选序号 / 超范围 / 多选 / 名称 / 自定义 / 无选项', () => {
  const single = { id: 'q1', options: [{ label: '甲' }, { label: '乙' }] }
  assert.deepEqual(parseQuestionReply('2', single).answer, { id: 'q1', selected: ['乙'] })
  assert.match(parseQuestionReply('3', single).error, /超出范围/)
  assert.match(parseQuestionReply('1,2', single).error, /只能选一个/)

  const multi = { id: 'q2', multiSelect: true, options: [{ label: '甲' }, { label: '乙' }, { label: '丙' }] }
  assert.deepEqual(parseQuestionReply('1,3', multi).answer, { id: 'q2', selected: ['甲', '丙'] })

  assert.deepEqual(parseQuestionReply('乙', single).answer, { id: 'q1', selected: ['乙'] })
  assert.deepEqual(parseQuestionReply('都不是，我自己写', single).answer, {
    id: 'q1',
    selected: [],
    custom: '都不是，我自己写',
  })
  assert.deepEqual(parseQuestionReply('张三', { id: 'q3' }).answer, { id: 'q3', selected: [], custom: '张三' })
})

check('审批提示：工具名 + 原因 + 两个选项', () => {
  const text = formatApprovalPrompt(
    {
      toolName: 'bash',
      displayReason: { en: 'Run a shell command', zh: '执行一条命令' },
    },
    { timeoutSec: 90 },
  )
  assert.match(text, /DSH 需要你审批/)
  assert.match(text, /工具：bash/)
  assert.match(text, /执行一条命令/)
  assert.match(text, /1\. 允许一次/)
  assert.match(text, /2\. 拒绝/)
  assert.match(text, /90 秒内有效/)
})

check('审批原因回退到 reason', () => {
  assert.equal(describeApprovalReason({ displayReason: { ja: '日本語だけ' } }), '日本語だけ')
  assert.equal(describeApprovalReason({ reason: '需要写入磁盘' }), '需要写入磁盘')
})

check('审批回复：1/2 与中英文同义词，其余报错', () => {
  assert.equal(parseApprovalReply('1').outcome, 'allowed-once')
  assert.equal(parseApprovalReply('允许').outcome, 'allowed-once')
  assert.equal(parseApprovalReply('OK').outcome, 'allowed-once')
  assert.equal(parseApprovalReply('2').outcome, 'rejected')
  assert.equal(parseApprovalReply('拒绝').outcome, 'rejected')
  assert.equal(parseApprovalReply('No').outcome, 'rejected')
  assert.match(parseApprovalReply('再看下').error, /请回复 1/)
})

check('超长提示被截断到上限内', () => {
  const long = formatQuestionPrompt(
    { id: 'q9', question: 'x'.repeat(5000), options: [{ label: 'A' }] },
    0,
    1,
  )
  assert.ok(long.length <= 1800)
})

console.log(`\n${passed} checks passed`)
