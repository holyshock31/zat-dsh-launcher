'use strict'

// 工具链执行器回归测试（0.6.21）：
//  - run / runWithProgress 两种风格都能正确执行
//  - pnpm 的 { file, args } 对象形态必须展开为 node <pnpm.cjs>，绝不 execFile .cmd
// 历史：0.6.19 EINVAL（execFile .cmd）、0.6.20 "callback must be function"
// （runWithProgress 风格下对象参数未展开，掉进 run 风格参数错位）

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const { makeToolchainExecute } = require('../src/toolchain-execute')

test('run style: plain file + args works', async () => {
  const exec = makeToolchainExecute({ ...process.env })
  const r = await exec(process.execPath, ['-e', 'console.log("hello-tc")'], undefined, 15000)
  assert.equal(r.ok, true, r.err)
  assert.ok(r.out.includes('hello-tc'))
})

test('runWithProgress style: description + plain file works', async () => {
  const exec = makeToolchainExecute({ ...process.env })
  const progress = []
  const r = await exec('测试', process.execPath, ['-e', 'console.log("line1");console.log("line2")'], undefined, (stage, message) => progress.push(message), 15000)
  assert.equal(r.ok, true, r.err)
  assert.ok(progress.some(m => m.includes('line1')), `进度未转发: ${JSON.stringify(progress)}`)
  assert.ok(progress.some(m => m.includes('line2')))
})

test('runWithProgress style: pnpm { file, args } object expands (regression 0.6.20)', async () => {
  const exec = makeToolchainExecute({ ...process.env })
  // 模拟 executablePnpm 返回：node <pnpm.cjs> 组合。用 node 自身 + -e 作为"pnpm 假体"
  const fakeCjs = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zat-tce-')), 'fake.cjs')
  fs.writeFileSync(fakeCjs, 'console.log("pnpm-args:"+JSON.stringify(process.argv.slice(1)));\n', 'utf8')
  const pnpm = { file: process.execPath, args: [fakeCjs] }
  const r = await exec('下载', pnpm, ['--version'], undefined, null, 15000, { ...process.env })
  assert.equal(r.ok, true, r.err)
  // node <fake.cjs> --version → argv.slice(1) = [fake.cjs, '--version']
  assert.ok(r.out.includes('pnpm-args:["' + fakeCjs.replace(/\\/g, '\\\\') + '","--version"]') || r.out.includes('--version'),
    `对象形态未正确展开: ${r.out}`)
})

test('run style: pnpm { file, args } object expands too', async () => {
  const exec = makeToolchainExecute({ ...process.env })
  const fakeCjs = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zat-tce2-')), 'fake.cjs')
  fs.writeFileSync(fakeCjs, 'console.log("ok-run-style");\n', 'utf8')
  const pnpm = { file: process.execPath, args: [fakeCjs] }
  const r = await exec(pnpm, ['-x'], undefined, 15000)
  assert.equal(r.ok, true, r.err)
  assert.ok(r.out.includes('ok-run-style'), `run 风格对象未展开: ${r.out}`)
})

test('execFile .cmd is never used: object args never become the execFile file', async () => {
  // 若对象未展开会 execFile(对象,...) 抛 "callback must be function"，这里验证两种风格都不抛
  const exec = makeToolchainExecute({ ...process.env })
  const fake = { file: process.execPath, args: ['-e', 'console.log("obj-ok")'] }
  const r1 = await exec('下载', fake, [], undefined, null, 15000, { ...process.env })
  const r2 = await exec(fake, [], undefined, 15000)
  assert.equal(r1.ok, true, r1.err)
  assert.equal(r2.ok, true, r2.err)
  assert.ok(r1.out.includes('obj-ok') && r2.out.includes('obj-ok'))
})
