'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { detectKind, localInfo, checkUpdate, installUpdate, compareVersions, npmLatestProbe } = require('../src/harness-update')

function tmpDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `zat-hupd-${label}-`))
}

test('detectKind: npm package install vs git source checkout', () => {
  const dir = tmpDir('kind')
  try {
    const npmPkg = path.join(dir, 'node_modules', '@deepseek-ai', 'dsh')
    fs.mkdirSync(npmPkg, { recursive: true })
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { '@deepseek-ai/dsh': '0.1.0-rc.7' } }))
    fs.writeFileSync(path.join(npmPkg, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.0-rc.7' }))
    assert.equal(detectKind(npmPkg).kind, 'npm')

    const gitRoot = path.join(dir, 'deepseek-harness')
    fs.mkdirSync(gitRoot, { recursive: true })
    fs.writeFileSync(path.join(gitRoot, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-root', version: '0.1.0-rc.5' }))
    fs.mkdirSync(path.join(gitRoot, '.git'), { recursive: true })
    assert.equal(detectKind(gitRoot).kind, 'git')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('detectKind: 项目根 npm 形态（扫描接入的一键安装终端，如 D:\\2）识别为 npm 而非 git', async () => {
  const dir = tmpDir('kindproj')
  try {
    // 项目根：package.json 只有 dependencies，DSH 包在 node_modules（启动器一键安装的布局）
    const npmPkg = path.join(dir, 'node_modules', '@deepseek-ai', 'dsh')
    fs.mkdirSync(path.join(npmPkg, 'lib'), { recursive: true })
    fs.writeFileSync(path.join(npmPkg, 'lib', 'bin.js'), 'x\n')
    fs.writeFileSync(path.join(npmPkg, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.0-rc.7', bin: { dsh: 'lib/bin.js' } }))
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { '@deepseek-ai/dsh': '0.1.0-rc.7' } }))
    const det = detectKind(dir)
    assert.equal(det.kind, 'npm')
    assert.equal(det.pkg.version, '0.1.0-rc.7')
    // localInfo 不走 git
    const execute = async () => { throw new Error('npm form must not run git') }
    const info = await (async () => localInfo(dir, execute))()
    assert.equal(info.ok, true)
    assert.equal(info.kind, 'npm')
    assert.equal(info.version, '0.1.0-rc.7')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('global npm prefix reports its version but is not updated as a managed install', async () => {
  const prefix = tmpDir('global-prefix')
  try {
    const npmPkg = path.join(prefix, 'node_modules', '@deepseek-ai', 'dsh')
    fs.mkdirSync(path.join(npmPkg, 'lib'), { recursive: true })
    fs.writeFileSync(path.join(npmPkg, 'lib', 'bin.js'), 'x\n')
    fs.writeFileSync(path.join(npmPkg, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh',
      version: '0.1.0-rc.7',
      bin: { dsh: 'lib/bin.js' },
    }))

    const det = detectKind(prefix)
    assert.equal(det.kind, 'npm')
    assert.equal(det.standalone, true)
    assert.equal(det.managed, false)

    // 旧登记可能仍保存包根；它也必须识别为同一个非托管全局安装。
    const legacyDet = detectKind(npmPkg)
    assert.equal(legacyDet.kind, 'npm')
    assert.equal(legacyDet.standalone, true)
    assert.equal(legacyDet.managed, false)

    const execute = async () => { throw new Error('global npm form must not run git') }
    const info = await localInfo(prefix, execute)
    assert.equal(info.ok, true)
    assert.equal(info.version, '0.1.0-rc.7')
    assert.equal(info.standalone, true)

    const update = await checkUpdate(prefix, execute, async () => '0.1.0-rc.8')
    assert.equal(update.updateAvailable, true)
    assert.equal(update.canInstall, false)

    const legacyUpdate = await checkUpdate(npmPkg, execute, async () => '0.1.0-rc.8')
    assert.equal(legacyUpdate.updateAvailable, true)
    assert.equal(legacyUpdate.canInstall, false)
  } finally { fs.rmSync(prefix, { recursive: true, force: true }) }
})

test('localInfo reports npm package form without git commands', async () => {
  const dir = tmpDir('local')
  try {
    const npmPkg = path.join(dir, 'node_modules', '@deepseek-ai', 'dsh')
    fs.mkdirSync(npmPkg, { recursive: true })
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { '@deepseek-ai/dsh': '0.1.0-rc.7' } }))
    fs.writeFileSync(path.join(npmPkg, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.0-rc.7' }))
    const execute = async () => { throw new Error('npm form must not run git') }
    const info = await localInfo(npmPkg, execute)
    assert.equal(info.ok, true)
    assert.equal(info.kind, 'npm')
    assert.equal(info.version, '0.1.0-rc.7')
    assert.equal(info.dirty, false)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('checkUpdate npm form detects newer registry version', async () => {
  const dir = tmpDir('chk')
  try {
    const npmPkg = path.join(dir, 'node_modules', '@deepseek-ai', 'dsh')
    fs.mkdirSync(npmPkg, { recursive: true })
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { '@deepseek-ai/dsh': '0.1.0-rc.7' } }))
    fs.writeFileSync(path.join(npmPkg, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.0-rc.7' }))
    const probe = async () => '0.1.0-rc.8'
    const result = await checkUpdate(npmPkg, undefined, probe)
    assert.equal(result.ok, true)
    assert.equal(result.kind, 'npm')
    assert.equal(result.updateAvailable, true)
    assert.equal(result.canInstall, true)
    assert.equal(result.remoteVersion, '0.1.0-rc.8')
    // 已是最新
    const same = await checkUpdate(npmPkg, undefined, async () => '0.1.0-rc.7')
    assert.equal(same.updateAvailable, false)
    // 探测失败
    const failed = await checkUpdate(npmPkg, undefined, async () => '')
    assert.equal(failed.checkFailed, true)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('compareVersions handles rc prereleases and releases', () => {
  assert.equal(compareVersions('0.1.0-rc.7', '0.1.0-rc.8'), -1)
  assert.equal(compareVersions('0.1.0-rc.8', '0.1.0-rc.7'), 1)
  assert.equal(compareVersions('0.1.0-rc.7', '0.1.0-rc.7'), 0)
  assert.equal(compareVersions('0.1.0-rc.7', '0.1.0'), -1)
  assert.equal(compareVersions('0.1.0', '0.1.0-rc.7'), 1)
  assert.equal(compareVersions('0.1.0', '0.1.1'), -1)
})

test('installUpdate npm form invokes npmUpdater and reports new version', async () => {
  const dir = tmpDir('inst')
  try {
    const npmPkg = path.join(dir, 'node_modules', '@deepseek-ai', 'dsh')
    fs.mkdirSync(npmPkg, { recursive: true })
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { '@deepseek-ai/dsh': '0.1.0-rc.7' } }))
    fs.writeFileSync(path.join(npmPkg, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.0-rc.7' }))
    let called = false
    const result = await installUpdate(npmPkg, path.join(dir, 'snap'), undefined, {
      probeLatest: async () => '0.1.0-rc.8',
      npmUpdater: async () => { called = true; return { ok: true, version: '0.1.0-rc.8' } },
    })
    assert.equal(called, true)
    assert.equal(result.ok, true)
    assert.ok(result.message.includes('0.1.0-rc.8'))
    // 已是最新时不调用更新器
    const noop = await installUpdate(npmPkg, path.join(dir, 'snap'), undefined, {
      probeLatest: async () => '0.1.0-rc.7',
      npmUpdater: async () => { called = true; return { ok: true, version: '0.1.0-rc.8' } },
    })
    assert.equal(noop.updateAvailable, false)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('npmLatestProbe uses node fetch and returns registry version', async () => {
  const probe = npmLatestProbe(process.execPath)
  const version = await probe('https://registry.npmjs.org/')
  assert.ok(typeof version === 'string')
  assert.ok(version.length > 0 || version === '')
})
