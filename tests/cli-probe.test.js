'use strict'

// CLI 参数兼容性探测回归测试（0.6.24 修正）：
// 探测方法 = `web --help` 输出里是否列出 --no-open 选项。
// 旧方法（带 --no-open 跑 --help 看 unknown option）被 rc.7 的透传容忍骗过（0.6.23 事故）：
// rc.7 的 web --no-open --help 直接打印帮助退出 0 不报错，误判"支持"，真实启动时崩溃。

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { cliNoOpenSupported, forceNoOpenUnsupported } = require('../src/cli-probe')

// 模拟 CLI：help 是否列出 --no-open；带 --no-open 跑 --help 是否报错（rc.7 容忍=不报错）
function fakeCli(dir, { helpHasNoOpen, tolerateUnknown }) {
  const cliDir = path.join(dir, 'apps', 'cli', 'lib')
  fs.mkdirSync(cliDir, { recursive: true })
  const helpText = helpHasNoOpen
    ? "Usage: dsh --profile web [options]\nOptions:\n  --no-open  do not open the Web UI in the default browser\n  --port <port>  listen port\n"
    : "Usage: dsh --profile web [options]\nOptions:\n  --port <port>  listen port\n"
  const unknown = tolerateUnknown ? '' : 'console.error("error: unknown option \'--no-open\'"); process.exit(1);'
  const script = `const args = process.argv.slice(2); if (args.includes('--help')) { console.log(${JSON.stringify(helpText)}); process.exit(0); } ${unknown} console.log('starting...');`
  fs.writeFileSync(path.join(cliDir, 'bin.js'), script, 'utf8')
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fake-dsh', version: '0.0.1' }), 'utf8')
}

test('detects support when help lists --no-open (rc.8 style)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zat-probe-yes-'))
  try {
    fakeCli(dir, { helpHasNoOpen: true, tolerateUnknown: true })
    assert.equal(await cliNoOpenSupported(dir, process.execPath, { timeoutMs: 5000 }), true)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('detects NO support when help lacks --no-open (rc.7 style, tolerateUnknown) — regression 0.6.23', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zat-probe-no-'))
  try {
    fakeCli(dir, { helpHasNoOpen: false, tolerateUnknown: true })
    // rc.7 的关键陷阱：带 --no-open 跑 --help 不报错，但 help 里没有这个选项 → 必须判 false
    assert.equal(await cliNoOpenSupported(dir, process.execPath, { timeoutMs: 5000 }), false)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('detects NO support when help lacks --no-open and CLI errors on it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zat-probe-no2-'))
  try {
    fakeCli(dir, { helpHasNoOpen: false, tolerateUnknown: false })
    assert.equal(await cliNoOpenSupported(dir, process.execPath, { timeoutMs: 5000 }), false)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('returns false for missing CLI (conservative: omit flag, never fail startup)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zat-probe-miss-'))
  try {
    assert.equal(await cliNoOpenSupported(dir, process.execPath, { timeoutMs: 5000 }), false)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('forceNoOpenUnsupported overrides cache so next start omits the flag', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zat-probe-force-'))
  try {
    fakeCli(dir, { helpHasNoOpen: true, tolerateUnknown: true })
    assert.equal(await cliNoOpenSupported(dir, process.execPath, { timeoutMs: 5000 }), true)
    forceNoOpenUnsupported(dir)
    // 缓存期内应立刻读到 false（启动失败自适应路径）
    assert.equal(await cliNoOpenSupported(dir, process.execPath, { timeoutMs: 5000 }), false)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
