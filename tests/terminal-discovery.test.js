'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {
  normalizeDshPath,
  inspectDshDir,
  parseProcessEntry,
  instanceFromCommandLine,
  rootsFromCommandLine,
  findRegisteredByDshDir,
  firstFreePortAvoiding,
  scanDshInstallations,
} = require('../src/terminal-discovery')

// 在临时目录构造一个"假 DSH 根"：根 package.json + apps/cli
function makeFakeDshRoot(tag, pkg) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `zat-dsh-${tag}-`))
  fs.mkdirSync(path.join(dir, 'apps', 'cli'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh-root',
    version: pkg.version || '0.1.0-test',
    workspaces: ['apps/*', 'packages/*/*'],
  }, null, 2))
  return dir
}

// 在临时目录构造"npm 包形态"DSH 根：根 package.json 依赖 @deepseek-ai/dsh + node_modules 包结构
function makeFakeNpmDshRoot(tag, pkg) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `zat-npm-${tag}-`))
  const pkgDir = path.join(dir, 'node_modules', '@deepseek-ai', 'dsh')
  fs.mkdirSync(path.join(pkgDir, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(pkgDir, 'lib', 'bin.js'), 'console.log("dsh")\n')
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh',
    version: pkg.version || '0.1.0-rc.7',
    bin: { dsh: 'lib/bin.js' },
  }, null, 2))
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    dependencies: { '@deepseek-ai/dsh': pkg.version || '0.1.0-rc.7' },
  }, null, 2))
  return dir
}

test('normalizeDshPath 大小写不敏感且去除尾部反斜杠', () => {
  const p = path.join('C:', 'Some', 'Dir')
  assert.equal(normalizeDshPath(`${p}\\`), normalizeDshPath(`${p.toLowerCase()}`))
  assert.equal(normalizeDshPath(path.join('C:', 'a', 'b')), normalizeDshPath(path.join('c:', 'A', 'B')))
})

test('inspectDshDir 拒绝非 DSH 目录', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zat-not-dsh-'))
  try {
    assert.equal(inspectDshDir(''), null)
    assert.equal(inspectDshDir(undefined), null)
    assert.equal(inspectDshDir(path.join(dir, 'not-exist')), null)
    // 有 package.json 但没有 apps/cli
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'not-dsh' }))
    assert.equal(inspectDshDir(dir), null)
    // 有 apps/cli 但 name/workspaces 不匹配
    fs.mkdirSync(path.join(dir, 'apps', 'cli'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'some-other' }))
    assert.equal(inspectDshDir(dir), null)
    // package.json 是非法 JSON
    fs.writeFileSync(path.join(dir, 'package.json'), '{ broken')
    assert.equal(inspectDshDir(dir), null)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('inspectDshDir 识别合法 DSH 根并返回元信息', () => {
  const dir = makeFakeDshRoot('valid', { version: '0.1.0-rc.9' })
  try {
    const info = inspectDshDir(dir)
    assert.ok(info)
    assert.equal(info.dir.toLowerCase(), dir.toLowerCase())
    assert.equal(info.version, '0.1.0-rc.9')
    assert.equal(info.name, path.basename(dir))
    assert.equal(info.mode, 'source')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('inspectDshDir 识别 npm 包形态 DSH 根（目录名任意，如 D:\\2）', () => {
  const dir = makeFakeNpmDshRoot('valid', { version: '0.1.0-rc.7' })
  try {
    const info = inspectDshDir(dir)
    assert.ok(info)
    assert.equal(info.dir.toLowerCase(), dir.toLowerCase())
    assert.equal(info.version, '0.1.0-rc.7')
    assert.equal(info.name, path.basename(dir))
    assert.equal(info.mode, 'npm')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('inspectDshDir 拒绝 npm 形态但不完整/非 dsh 包的目录', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zat-npm-bad-'))
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { '@deepseek-ai/dsh': '0.1.0-rc.7' } }))
    // 有依赖声明但没有 node_modules 包 → 不是可运行的 DSH
    assert.equal(inspectDshDir(dir), null)
    // node_modules 有包但 bin 缺 dsh 入口 → 拒绝
    const pkgDir = path.join(dir, 'node_modules', '@deepseek-ai', 'dsh')
    fs.mkdirSync(path.join(pkgDir, 'lib'), { recursive: true })
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.0-rc.7', bin: {} }))
    assert.equal(inspectDshDir(dir), null)
    // lib/bin.js 存在但包名不符 → 拒绝
    fs.writeFileSync(path.join(pkgDir, 'lib', 'bin.js'), 'x\n')
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: 'some-other-pkg', version: '0.1.0-rc.7', bin: { dsh: 'lib/bin.js' } }))
    assert.equal(inspectDshDir(dir), null)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('parseProcessEntry 解析 PID|命令行|cwd|端口', () => {
  assert.deepEqual(parseProcessEntry('1234|C:\\node\\node.exe x'), { pid: 1234, commandLine: 'C:\\node\\node.exe x', cwd: null, ports: [] })
  assert.deepEqual(parseProcessEntry('1234|node apps\\cli\\lib\\bin.js web|D:\\dsh|3080'), { pid: 1234, commandLine: 'node apps\\cli\\lib\\bin.js web', cwd: 'D:\\dsh', ports: [3080] })
  assert.deepEqual(parseProcessEntry('1234|node apps\\cli\\lib\\bin.js web|D:\\dsh|3080,3081'), { pid: 1234, commandLine: 'node apps\\cli\\lib\\bin.js web', cwd: 'D:\\dsh', ports: [3080, 3081] })
  assert.equal(parseProcessEntry(''), null)
  assert.equal(parseProcessEntry('abc|x'), null)
  assert.equal(parseProcessEntry('0|x'), null)
  assert.equal(parseProcessEntry('-5|x'), null)
})

test('instanceFromCommandLine 从运行中的 DSH CLI 提取根目录与端口', () => {
  const cli = `"C:\\node\\node.exe" "D:\\deepseek-harness\\apps\\cli\\lib\\bin.js" web --port 3081`
  const parsed = instanceFromCommandLine(cli)
  assert.deepEqual(parsed, { root: 'D:\\deepseek-harness', port: 3081, mode: 'source' })
  // 无端口
  assert.deepEqual(instanceFromCommandLine('"C:\\node\\node.exe" "D:\\dsh2\\apps\\cli\\src\\bin.ts" web'), { root: 'D:\\dsh2', port: null, mode: 'source' })
  // 相对路径启动（无根目录），用 cwd 补全
  assert.deepEqual(instanceFromCommandLine('"C:\\node\\node.exe" apps\\cli\\lib\\bin.js web', 'D:\\deepseek-harness\\'), { root: 'D:\\deepseek-harness', port: null, mode: 'source' })
  // 启动器 spawn 形态：绝对路径但 bin.js 不带引号（node.exe" 与路径间有空格）→ 不能带前导空格
  // （曾因 root 带空格导致运行实例识别失败，已占用的 3081 被跳过误分 3082）
  assert.deepEqual(instanceFromCommandLine('"C:\\node\\node.exe" D:\\deepseek-harness\\apps\\cli\\lib\\bin.js web --port 3080'), { root: 'D:\\deepseek-harness', port: 3080, mode: 'source' })
  // 相对路径但无 cwd → 无法确定根目录
  assert.equal(instanceFromCommandLine('"C:\\node\\node.exe" apps\\cli\\lib\\bin.js web'), null)
  // 非 DSH 命令行
  assert.equal(instanceFromCommandLine('C:\\Windows\\System32\\cmd.exe /c dir'), null)
})

test('instanceFromCommandLine 识别 npm 包形态运行实例并归一化到项目根', () => {
  // npm 包形态：node_modules/@deepseek-ai/dsh/lib/bin.js，根目录归一化为项目根（DSH_HOME）
  const cli = `"C:\\node\\node.exe" "D:\\2\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" web --port 3081`
  assert.deepEqual(instanceFromCommandLine(cli), { root: 'D:\\2', port: 3081, mode: 'npm' })
  // 相对路径 + cwd 指向项目根
  assert.deepEqual(instanceFromCommandLine('"C:\\node\\node.exe" node_modules\\@deepseek-ai\\dsh\\lib\\bin.js web', 'D:\\2'), { root: 'D:\\2', port: null, mode: 'npm' })
  // 启动器 spawn 形态：绝对路径、bin.js 不带引号 → 不能带前导空格
  assert.deepEqual(instanceFromCommandLine('"C:\\node\\node.exe" D:\\2\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js web --port 3081'), { root: 'D:\\2', port: 3081, mode: 'npm' })
  // cwd 也指向 npm 包根（旧版启动器以包根为 dshDir 启动）→ 归一化到项目根
  assert.deepEqual(instanceFromCommandLine('"C:\\node\\node.exe" node_modules\\@deepseek-ai\\dsh\\lib\\bin.js web --port 3099', 'D:\\2\\node_modules\\@deepseek-ai\\dsh'), { root: 'D:\\2', port: 3099, mode: 'npm' })
  // 无端口无 cwd → 无法确定根目录
  assert.equal(instanceFromCommandLine('"C:\\node\\node.exe" node_modules\\@deepseek-ai\\dsh\\lib\\bin.js web'), null)
})

test('rootsFromCommandLine 兼容返回根目录数组', () => {
  assert.deepEqual(rootsFromCommandLine('node "D:\\dsh\\apps\\cli\\lib\\bin.js" web'), ['D:\\dsh'])
  assert.deepEqual(rootsFromCommandLine('powershell -NoProfile -Command Get-Help'), [])
})

test('findRegisteredByDshDir 大小写不敏感判重', () => {
  const terminals = [
    { id: 'a', dshDir: 'D:\\deepseek-harness' },
    { id: 'b', dshDir: path.join('C:', 'Other', 'dsh') },
  ]
  assert.equal(findRegisteredByDshDir('d:\\DEEPSEEK-HARNESS', terminals).id, 'a')
  assert.equal(findRegisteredByDshDir(terminals[1].dshDir, terminals).id, 'b')
  assert.equal(findRegisteredByDshDir(path.join('C:', 'New', 'Dir'), terminals), null)
  assert.equal(findRegisteredByDshDir('', terminals), null)
})

test('firstFreePortAvoiding 避开已登记与已预留端口', () => {
  assert.equal(firstFreePortAvoiding([3080], [3081, 3083]), 3082)
  assert.equal(firstFreePortAvoiding([], [], port => port !== 3084, 3080), 3080)
  assert.equal(firstFreePortAvoiding([3080, 3081], [3082], port => port !== 3083, 3080), 3084)
  assert.throws(() => firstFreePortAvoiding([0], [0], () => false, 65534), /没有可用端口/)
})

test('scanDshInstallations 识别运行实例、去重并标记来源', async () => {
  const running = makeFakeDshRoot('run', { version: '0.1.0-rc.7' })
  const local = makeFakeDshRoot('local', { version: '0.1.0-rc.8' })
  const nonDsh = fs.mkdtempSync(path.join(os.tmpdir(), 'zat-scan-nd-'))
  try {
    // 普通文件目录，不是 DSH
    fs.writeFileSync(path.join(nonDsh, 'package.json'), JSON.stringify({ name: 'not-dsh' }))
    const entries = [
      { pid: 4001, commandLine: `"C:\\node\\node.exe" "${running}\\apps\\cli\\lib\\bin.js" web --port 3081` },
      { pid: 4002, commandLine: `powershell.exe -NoProfile -Command x` }, // 非 DSH
    ]
    const results = await scanDshInstallations({
      explicit: [local, nonDsh, running], // running 与 explicit 重复
      processEntries: entries,
      includeCommonDirs: false,
      scanDrives: false, // 测试环境不扫描真实磁盘根目录
    })
    assert.equal(results.length, 2)
    const runItem = results.find(r => path.resolve(r.dir).toLowerCase() === running.toLowerCase())
    const localItem = results.find(r => path.resolve(r.dir).toLowerCase() === local.toLowerCase())
    assert.ok(runItem)
    assert.ok(localItem)
    assert.equal(runItem.source, 'running-process')
    assert.equal(runItem.port, 3081)
    assert.equal(runItem.pid, 4001)
    assert.equal(localItem.source, 'filesystem')
    assert.equal(localItem.port, null)
  } finally {
    fs.rmSync(running, { recursive: true, force: true })
    fs.rmSync(local, { recursive: true, force: true })
    fs.rmSync(nonDsh, { recursive: true, force: true })
  }
})

test('scanDshInstallations 识别 npm 包形态（显式目录 + 运行实例均归一化到项目根）', async () => {
  const npmRoot = makeFakeNpmDshRoot('run', { version: '0.1.0-rc.7' })
  const entries = [
    // 旧版启动器以包根为 cwd 启动 npm 形态 → 归一化到项目根
    { pid: 4101, commandLine: `"C:\\node\\node.exe" node_modules\\@deepseek-ai\\dsh\\lib\\bin.js web --port 3081`, cwd: npmRoot },
  ]
  const results = await scanDshInstallations({
    explicit: [npmRoot],
    processEntries: entries,
    scanDrives: false,
  })
  assert.equal(results.length, 1)
  assert.equal(results[0].source, 'running-process')
  assert.equal(results[0].port, 3081)
  assert.equal(path.resolve(results[0].dir).toLowerCase(), npmRoot.toLowerCase())
  // 显式目录（非运行中）→ filesystem
  const results2 = await scanDshInstallations({
    explicit: [npmRoot],
    processEntries: [],
    scanDrives: false,
  })
  assert.equal(results2.length, 1)
  assert.equal(results2[0].source, 'filesystem')
  assert.equal(results2[0].port, null)
})

// 1.0.10 回归：直接传 npm 包根（node_modules\@deepseek-ai\dsh）必须识别并归一化到项目根。
// 旧逻辑 inspectDshDir 对包根判 null → "npm 安装的 DSH 检测不到"（用户反馈）。
test('inspectDshDir 识别 npm 包根并归一化到项目根', () => {
  const npmRoot = makeFakeNpmDshRoot('pkgroot', { version: '0.1.1-rc.2' })
  try {
    const pkgRoot = path.join(npmRoot, 'node_modules', '@deepseek-ai', 'dsh')
    const r = inspectDshDir(pkgRoot)
    assert.ok(r, 'npm 包根应被识别为 DSH')
    assert.equal(r.mode, 'npm')
    assert.equal(path.resolve(r.dir).toLowerCase(), npmRoot.toLowerCase(), '必须归一化到项目根（DSH_HOME）')
  } finally { fs.rmSync(npmRoot, { recursive: true, force: true }) }
})

// 1.0.12 回归：同一 DSH 的深层子目录（apps\cli 等）不得被当成独立安装——
// 浅目录优先 accepted，深层子目录自动跳过（用户截图：扫出 deepseek-harness 和 apps\cli 两个）。
test('scanDshInstallations 排除已识别 DSH 根的深层子目录', async () => {
  // 真实场景：D:\deepseek-harness 是源码形态（根带 workspaces + apps/cli），
  // apps\cli 下 pnpm workspace 软链 node_modules\@deepseek-ai\dsh → 被误判成独立安装。
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zat-src-sub-'))
  try {
    fs.mkdirSync(path.join(root, 'apps', 'cli'), { recursive: true })
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh-root',
      version: '0.1.1-rc.2',
      workspaces: ['apps/*', 'packages/*/*'],
    }, null, 2))
    // apps\cli 下造假 npm 形态（workspace 软链特征）
    const cliDir = path.join(root, 'apps', 'cli')
    const cliNpmDir = path.join(cliDir, 'node_modules', '@deepseek-ai', 'dsh')
    fs.mkdirSync(path.join(cliNpmDir, 'lib'), { recursive: true })
    fs.writeFileSync(path.join(cliNpmDir, 'lib', 'bin.js'), 'console.log("dsh")\n')
    fs.writeFileSync(path.join(cliNpmDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.1-rc.2', bin: { dsh: 'lib/bin.js' } }, null, 2))
    fs.writeFileSync(path.join(cliDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-cli' }, null, 2))

    const results = await scanDshInstallations({
      explicit: [root, cliDir],
      processEntries: [],
      scanDrives: false,
    })
    assert.equal(results.length, 1, `深层子目录应被排除,只留最浅根: ${JSON.stringify(results.map(r => r.dir))}`)
    assert.equal(path.resolve(results[0].dir).toLowerCase(), root.toLowerCase())
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

// 1.0.14: official npx cache installs must be marked as npx so DSH_HOME resolves to ~/.dsh
test('inspectDshDir identifies npx cache installs', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'zat-npx-root-'))
  const npxRoot = path.join(base, '_npx', 'hash123')
  try {
    const pkgDir = path.join(npxRoot, 'node_modules', '@deepseek-ai', 'dsh')
    fs.mkdirSync(path.join(pkgDir, 'lib'), { recursive: true })
    fs.writeFileSync(path.join(pkgDir, 'lib', 'bin.js'), 'console.log("dsh")\n')
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.1-rc.2', bin: { dsh: 'lib/bin.js' } }, null, 2))
    fs.writeFileSync(path.join(npxRoot, 'package.json'), JSON.stringify({ dependencies: { '@deepseek-ai/dsh': '0.1.1-rc.2' } }, null, 2))
    const r = inspectDshDir(npxRoot)
    assert.ok(r, 'npx cache project root should be recognized')
    assert.equal(r.mode, 'npx')
    assert.equal(r.name, '@deepseek-ai/dsh v0.1.1-rc.2')
  } finally { fs.rmSync(base, { recursive: true, force: true }) }
})

// 1.0.14: global npm installs (package under a prefix without root package.json) use ~/.dsh
test('inspectDshDir identifies global npm installs', () => {
  const prefix = fs.mkdtempSync(path.join(os.tmpdir(), 'zat-global-'))
  try {
    const pkgDir = path.join(prefix, 'node_modules', '@deepseek-ai', 'dsh')
    fs.mkdirSync(path.join(pkgDir, 'lib'), { recursive: true })
    fs.writeFileSync(path.join(pkgDir, 'lib', 'bin.js'), 'console.log("dsh")\n')
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.1-rc.2', bin: { dsh: 'lib/bin.js' } }, null, 2))
    const r = inspectDshDir(pkgDir)
    assert.ok(r, 'global package root should be recognized')
    assert.equal(r.mode, 'npm-standalone')
    assert.equal(path.resolve(r.dir).toLowerCase(), prefix.toLowerCase())
  } finally { fs.rmSync(prefix, { recursive: true, force: true }) }
})

test('instanceFromCommandLine identifies npx cache processes', () => {
  const cli = `"C:\\node\\node.exe" "C:\\Users\\foo\\AppData\\Local\\npm-cache\\_npx\\abc123\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" web --port 3081`
  assert.deepEqual(instanceFromCommandLine(cli), {
    root: 'C:\\Users\\foo\\AppData\\Local\\npm-cache\\_npx\\abc123',
    port: 3081,
    mode: 'npx',
  })
})
