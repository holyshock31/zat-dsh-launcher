'use strict'

// CLI 参数兼容性探测回归测试：
// 探测方法 = 真实启动形态：`node <bin.js> web --no-open --port <随机>`，
// stderr 出现 "unknown option '--no-open'" 即判不支持（保守省略参数），
// 其它情况（正常退出/常驻/超时）判支持。
// 旧方法（--help 输出/带 --no-open 跑 --help）被 rc.7/rc.8 npm 包的透传容忍骗过：
// rc.7 的 --help 列不出 --no-open 但真实启动却会 unknown option 崩溃（0.6.23 事故）；
// rc.8 的 --help 列出 --no-open 但真实启动同样崩溃（1.0.4 事故）。
// 唯一可靠的信号 = 真实启动。

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { cliNoOpenSupported, forceNoOpenUnsupported } = require('../src/cli-probe')

// 模拟 CLI：真实启动（不带 --help）时是否拒绝 --no-open。
// rejectOnRealStart=true → 打印 "error: unknown option '--no-open'" 退出 1（rc.7/rc.8 npm 包行为）；
// false → 打印 'starting...' 正常启动（源码版 rc.8 行为）。
function fakeCli(dir, { rejectOnRealStart }) {
  const cliDir = path.join(dir, 'apps', 'cli', 'lib')
  fs.mkdirSync(cliDir, { recursive: true })
  const unknown = rejectOnRealStart ? 'console.error("error: unknown option \'--no-open\'"); process.exit(1);' : ''
  const script = `${unknown} console.log('starting...');`
  fs.writeFileSync(path.join(cliDir, 'bin.js'), script, 'utf8')
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fake-dsh', version: '0.0.1' }), 'utf8')
}

test('detects support when real startup accepts --no-open (source rc.8 style)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zat-probe-yes-'))
  try {
    fakeCli(dir, { rejectOnRealStart: false })
    assert.equal(await cliNoOpenSupported(dir, process.execPath, { timeoutMs: 5000 }), true)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('detects NO support when real startup rejects --no-open (rc.7/rc.8 npm pkg style) — regression 0.6.23 & 1.0.4', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zat-probe-no-'))
  try {
    fakeCli(dir, { rejectOnRealStart: true })
    // 关键陷阱：--help 形态探测不可靠，必须真实启动；真实启动报 unknown option → 必须判 false
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
    fakeCli(dir, { rejectOnRealStart: false })
    assert.equal(await cliNoOpenSupported(dir, process.execPath, { timeoutMs: 5000 }), true)
    forceNoOpenUnsupported(dir)
    // 缓存期内应立刻读到 false（启动失败自适应路径）
    assert.equal(await cliNoOpenSupported(dir, process.execPath, { timeoutMs: 5000 }), false)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
