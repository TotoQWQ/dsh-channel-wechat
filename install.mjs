#!/usr/bin/env node
/**
 * dsh-channel-wechat 单文件安装器
 *
 *   node install.mjs                 # 装进默认 profile
 *   node install.mjs --profile web   # 指定 profile
 *   node install.mjs --dry-run       # 只打印计划，不动任何文件
 *
 * 它会：
 *   1. 从 GitHub 拉取插件文件到 <DSH_HOME>/plugins/dsh-channel-wechat
 *   2. 用 `dsh plugin --profile <p> add <目录>` 把插件链接进 profile
 *   3. 把 dsh-channel-wechat 追加进 profile package.json 的 dsh.profile.bundles
 *   4. 在 profile 的 cordis.patch.yml 末尾追加一条 channel-wechat 行
 * 全部步骤幂等；改文件前会写 .bak 备份。
 *
 * 装完重启 DSH 桌面应用即可（客户端面板是启动时扫描的）。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { execFileSync } from 'node:child_process'

const REPO = 'TotoQWQ/dsh-channel-wechat'
const PKG = 'dsh-channel-wechat'
const ROW_ID = 'channel-wechat'

function parseArgs(argv) {
  const out = { profile: '', dir: '', home: '', ref: 'main', dryRun: false, skipPnpm: false, skipPatch: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => argv[++i]
    if (arg === '--profile') out.profile = next()
    else if (arg === '--dir') out.dir = next()
    else if (arg === '--home') out.home = next()
    else if (arg === '--ref') out.ref = next()
    else if (arg === '--dry-run') out.dryRun = true
    else if (arg === '--skip-pnpm') out.skipPnpm = true
    else if (arg === '--skip-patch') out.skipPatch = true
    else if (arg === '--help' || arg === '-h') {
      console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0])
      process.exit(0)
    } else {
      console.error(`未知参数: ${arg}`)
      process.exit(2)
    }
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const home = args.home || process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const profile = args.profile || process.env.DSH_PROFILE || 'desktop'
const profileDir = path.join(home, 'profiles', profile)
const targetDir = args.dir || path.join(home, 'plugins', PKG)

const say = (msg) => console.log(msg)
const plan = (msg) => console.log(`  ${args.dryRun ? '[dry-run] ' : ''}${msg}`)

function backup(file) {
  if (!fs.existsSync(file)) return
  const bak = `${file}.bak`
  if (!fs.existsSync(bak)) fs.copyFileSync(file, bak)
}

/** GitHub 的 raw/codeload 偶尔 ECONNRESET，统一重试。 */
async function fetchBuffer(url, attempts = 4) {
  let lastErr
  for (let i = 1; i <= attempts; i += 1) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': 'dsh-channel-wechat-installer' } })
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`)
      return Buffer.from(await res.arrayBuffer())
    } catch (err) {
      lastErr = err
      if (i < attempts) await new Promise((r) => setTimeout(r, 400 * i))
    }
  }
  throw lastErr
}

/** 极简 tar 解析：只需要普通文件，够解 GitHub 的 tarball。 */
function untar(buffer) {
  const out = []
  let offset = 0
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const rawName = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '')
    const sizeField = header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim()
    const size = parseInt(sizeField || '0', 8)
    const typeflag = String.fromCharCode(header[156] || 48)
    const name = prefix ? `${prefix}/${rawName}` : rawName
    offset += 512
    if (typeflag === '0' || typeflag === '\0' || typeflag === '7') {
      const body = buffer.subarray(offset, offset + size)
      // 去掉 tarball 顶层的 <repo>-<ref>/ 目录
      const rel = name.split('/').slice(1).join('/')
      if (rel && !rel.startsWith('.git/')) out.push({ path: rel, body: Buffer.from(body) })
    }
    offset += Math.ceil(size / 512) * 512
  }
  return out
}

async function download() {
  say(`\n1/4 拉取插件文件 → ${targetDir}`)
  const tarballUrl = `https://api.github.com/repos/${REPO}/tarball/${args.ref}`
  const gz = await fetchBuffer(tarballUrl)
  const entries = untar(zlib.gunzipSync(gz))
  if (entries.length === 0) throw new Error('tarball 里没有文件')
  if (!args.dryRun) fs.mkdirSync(targetDir, { recursive: true })
  for (const entry of entries) {
    plan(`${entry.path} (${entry.body.length} B)`)
    if (args.dryRun) continue
    const dest = path.join(targetDir, entry.path)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, entry.body)
  }
  say(`  共 ${entries.length} 个文件`)
}

function findDsh() {
  const candidates = []
  if (process.env.DSH_CLI) candidates.push(process.env.DSH_CLI)
  candidates.push('dsh')
  if (process.platform === 'win32') {
    candidates.push(path.join(path.dirname(process.execPath), 'dsh.cmd'))
    for (const base of [process.env.LOCALAPPDATA, process.env.ProgramFiles]) {
      if (!base) continue
      candidates.push(path.join(base, 'deepseek-harness', 'runtime', 'cli', 'bin', 'dsh.cmd'))
    }
  }
  for (const candidate of candidates) {
    try {
      const out = execFileSync(candidate, ['--version'], { stdio: 'pipe', timeout: 20000 }).toString().trim()
      if (out) return { bin: candidate, version: out.split('\n')[0] }
    } catch {
      /* try next */
    }
  }
  return null
}

function linkIntoProfile() {
  say(`\n2/4 把插件链接进 profile「${profile}」`)
  const dsh = findDsh()
  if (args.skipPnpm) return say('  跳过（--skip-pnpm）')
  if (!dsh) {
    say('  没找到 dsh 命令，跳过自动链接。之后手动执行：')
    say(`    dsh plugin --profile ${profile} add "${targetDir}"`)
    return
  }
  if (args.dryRun) return plan(`dsh plugin --profile ${profile} add "${targetDir}"  (${dsh.bin})`)
  execFileSync(dsh.bin, ['plugin', '--profile', profile, 'add', targetDir], { stdio: 'inherit' })
  say(`  已链接（dsh ${dsh.version}）`)
}

function patchPackageJson() {
  say('\n3/4 登记 bundle')
  const file = path.join(profileDir, 'package.json')
  if (!fs.existsSync(file)) return say(`  跳过：找不到 ${file}`)
  const json = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  json.dsh = json.dsh || {}
  json.dsh.profile = json.dsh.profile || {}
  const bundles = Array.isArray(json.dsh.profile.bundles) ? json.dsh.profile.bundles : []
  if (bundles.includes(PKG)) return say('  已登记，跳过')
  if (args.dryRun) return plan(`dsh.profile.bundles += "${PKG}"`)
  bundles.push(PKG)
  json.dsh.profile.bundles = bundles
  backup(file)
  fs.writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`, 'utf8')
  say(`  已写入 ${file}`)
}

function patchCordisYaml() {
  say('\n4/4 追加插件行')
  const file = path.join(profileDir, 'cordis.patch.yml')
  const block = [
    '',
    `# --- ${PKG} (added by install.mjs) ---`,
    '- insert:',
    `    - id: ${ROW_ID}`,
    `      name: ${PKG}`,
    '      config:',
    '        enabled: true',
    '',
  ].join('\n')
  if (!fs.existsSync(file)) {
    if (args.dryRun) return plan(`创建 ${file} 并写入 ${ROW_ID} 行`)
    backup(file)
    fs.writeFileSync(file, block.trimStart(), 'utf8')
    return say(`  已创建 ${file}`)
  }
  const current = fs.readFileSync(file, 'utf8')
  if (new RegExp(`^\\s*-?\\s*id:\\s*${ROW_ID}\\s*$`, 'm').test(current) || current.includes(`name: ${PKG}`)) {
    return say('  已存在，跳过')
  }
  if (args.dryRun) return plan(`在 ${file} 末尾追加 ${ROW_ID} 行`)
  backup(file)
  fs.writeFileSync(file, `${current.replace(/\s*$/, '')}\n${block}`, 'utf8')
  say(`  已追加到 ${file}`)
}

try {
  say(`DSH home : ${home}`)
  say(`profile  : ${profile}`)
  say(`目标目录 : ${targetDir}`)
  await download()
  linkIntoProfile()
  if (!args.skipPatch) {
    patchPackageJson()
    patchCordisYaml()
  }
  say('\n完成。重启 DSH 桌面应用并刷新页面：左侧栏会出现「微信」面板。')
  say('不需要的话，删掉 profile 的 cordis.patch.yml 里 channel-wechat 那段、再移除依赖即可。')
} catch (err) {
  console.error(`\n安装失败: ${err && err.message ? err.message : err}`)
  process.exit(1)
}
