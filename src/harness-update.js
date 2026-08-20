'use strict'

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { execFile } = require('node:child_process')

/* Harness 更新：支持两种安装形态
 *  - git 源码仓库：git fetch + ff-only merge + pnpm install + build
 *  - npm 包安装（一键安装的终端）：npm registry 版本对比 + pnpm add 更新
 * 每个终端独立，只操作当前终端的 dshDir / 终端根目录。
 *
 * 兼容策略（对未来版本变化尽量自适应，不卡死在某一种方式）：
 *  - install：pnpm frozen 官方 → frozen 镜像 → no-frozen 官方 → no-frozen 镜像 四连回退
 *  - build：必须用 npm 触发（新版 DSH 的 scripts/build.ts 用 npm_execpath 并执行
 *    `node <npm_execpath> run ...`；pnpm 的 npm_execpath 指向 @pnpm/exe/pnpm.exe 会被
 *    node 当 JS 加载报 ERR_UNKNOWN_FILE_EXTENSION，npm 的 npm_execpath 是 npm-cli.js 纯 JS）。
 *    npm-cli.js 自动探测（工具链 PATH → %TEMP%\zat-tools 自举 → 系统 node 目录），
 *    失败再分步 build:lib / build:web，最后兜底 pnpm run build（兼容旧版构建）。
 *  - 任何失败都回滚 git 到旧提交并返回完整错误尾部，绝不留下半更新状态。 */

const NPM_REGISTRIES = ['https://registry.npmjs.org/', 'https://registry.npmmirror.com/']

const { expandExec } = require('./toolchain-execute')

function run(file, args, cwd, timeout = 120000) {
  return new Promise(resolve => {
    const n = expandExec(file, args)
    execFile(n.file, n.args, { cwd, windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout }, (error, stdout, stderr) => {
      resolve({ ok: !error, code: error && error.code || 0, out: String(stdout || '').trim(), err: String(stderr || error && error.message || '').trim() })
    })
  })
}

// 探测 npm-cli.js（纯 JS 的 npm 入口）：工具链 PATH 目录 → %TEMP%\zat-tools 自举 → 系统 node 目录
function findNpmCli(env) {
  const candidates = []
  const pathValue = String((env && env.PATH) || process.env.PATH || '')
  for (const d of pathValue.split(';')) {
    const dir = String(d || '').trim()
    if (!dir) continue
    candidates.push(path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'))
    candidates.push(path.join(dir, '..', 'node_modules', 'npm', 'bin', 'npm-cli.js'))
  }
  try {
    const tools = path.join(os.tmpdir(), 'zat-tools')
    const walk = (dir, depth) => {
      if (depth > 4) return ''
      let entries
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return '' }
      for (const e of entries) {
        if (e.isDirectory()) {
          const r = walk(path.join(dir, e.name), depth + 1)
          if (r) return r
        } else if (e.name === 'npm-cli.js' && path.basename(path.dirname(path.join(dir, e.name))) === 'bin') {
          return path.join(dir, e.name)
        }
      }
      return ''
    }
    const found = walk(tools, 0)
    if (found) candidates.push(found)
  } catch { /* 自举探测失败不阻断 */ }
  candidates.push(path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node_modules', 'npm', 'bin', 'npm-cli.js'))
  candidates.push(path.join(process.env.LOCALAPPDATA || '', 'Programs', 'nodejs', 'node_modules', 'npm', 'bin', 'npm-cli.js'))
  for (const c of candidates) {
    try { if (c && fs.existsSync(c)) return c } catch { /* 继续 */ }
  }
  return ''
}

// 构建：多级自适应。返回 { ok }，失败带完整错误尾部。
// 兼容矩阵：
//  - 旧版 build script（npm run build:lib && npm run build:web）与新版（tsx scripts/build.ts）
//    都用 npm 触发（npm_execpath=npm-cli.js 纯 JS，pnpm 的 npm_execpath=pnpm.exe 会让 node 报错）
//  - build:lib 是核心（tsc/tsdown 编译全部包），必须成功
//  - build:web 的上游 script 长期引用 workspace 中不存在的 filter 包（新旧版都是历史遗留失效
//    脚本；真实 web UI 由 profile bundles @deepseek-ai/dsh-web-app 提供，不依赖此构建）——
//    失败且错误为「No projects matched the filters」时智能跳过，其余失败照常报错
//  - pnpm run build 作为最后兜底（兼容未来上游修正后 pnpm 也可用的场景）
async function runBuild(dshDir, execute, env, pnpmExe) {
  const npmCli = findNpmCli(env)
  const nodeFile = process.env.npm_node_execpath || 'node'
  // build:web 的 script 是 `pnpm --filter ... run build`，npm 执行 script 时必须在 PATH 里
  // 能找到 pnpm——把 pnpm 所在目录显式前置进构建环境（工具链 PATH 缺 pnpm 时也能构建）。
  const extraPath = []
  if (pnpmExe) {
    // pnpm 可能是 { file, args } 对象（executablePnpm：node <pnpm.cjs>），取 file 的目录加 PATH
    const pnpmFile = pnpmExe && typeof pnpmExe === 'object' ? pnpmExe.file : pnpmExe
    const d = path.dirname(String(pnpmFile).replace(/\.cmd$/i, ''))
    if (d && d !== '.') extraPath.push(d)
  }
  const buildEnv = { ...(env || process.env), PATH: [...extraPath, String((env && env.PATH) || process.env.PATH || '')].filter(Boolean).join(';') }
  const runNpm = (script) => npmCli
    ? execute(nodeFile, [npmCli, 'run', script], dshDir, 25 * 60 * 1000, buildEnv)
    // 无自举 npm-cli 时让系统 PATH 解析 npm（'npm.cmd' 字面量在 Node 24 无 shell 会 EINVAL）
    : execute('npm', ['run', script], dshDir, 25 * 60 * 1000, buildEnv)

  // 1) 整体 build
  let r = await runNpm('build')
  if (r.ok) return { ok: true, used: 'npm run build' }

  // 2) 分步：build:lib（核心，必须成功）
  r = await runNpm('build:lib')
  if (!r.ok) {
    const libErr = String(r.err || r.out || '').slice(-1500)
    // 3) 兜底：pnpm run build
    const p = await execute(pnpmExe || null, ['run', 'build'], dshDir, 25 * 60 * 1000, buildEnv)
    if (p.ok) return { ok: true, used: 'pnpm run build（兜底）' }
    return { ok: false, err: `build:lib 失败：${libErr}；pnpm 兜底也失败：${String(p.err || p.out || '').slice(-800)}` }
  }

  // 4) build:web：识别上游失效脚本（filter 包不存在），智能跳过
  r = await runNpm('build:web')
  if (r.ok) return { ok: true, used: 'npm run build:lib + build:web' }
  const webErr = String(r.err || r.out || '')
  if (/No projects matched the filters/i.test(webErr)) {
    return { ok: true, used: 'npm run build:lib（build:web 上游脚本引用不存在的包，已智能跳过）', skippedWeb: true }
  }
  return { ok: false, err: `build:web 失败：${webErr.slice(-1500)}` }
}

function readVersion(dshDir) {
  try { return JSON.parse(fs.readFileSync(path.join(dshDir, 'package.json'), 'utf8')).version || '未知' } catch { return '未知' }
}

// npm 包形态的包根：项目根/node_modules/@deepseek-ai/dsh（包自己的 package.json 才是 name=@deepseek-ai/dsh）
function npmPkgDir(dshDir) {
  const direct = path.join(dshDir, 'node_modules', '@deepseek-ai', 'dsh')
  const binJs = path.join(direct, 'lib', 'bin.js')
  if (fs.existsSync(path.join(direct, 'package.json')) && fs.existsSync(binJs)) return direct
  return ''
}

// 识别安装形态：npm 包（name=@deepseek-ai/dsh 且无 .git）还是 git 源码仓库。
// dshDir 可能是包根（node_modules/@deepseek-ai/dsh，旧登记格式）或项目根（一键安装/扫描接入，
// 根 package.json 只有 dependencies，DSH 包在 node_modules 里）——两者都识别为 npm 形态。
function detectKind(dshDir) {
  if (!dshDir || typeof dshDir !== 'string') return { kind: 'invalid' }
  const pkgFile = path.join(dshDir, 'package.json')
  if (!fs.existsSync(pkgFile)) return { kind: 'invalid' }
  let pkg
  try { pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8')) } catch { return { kind: 'invalid' } }
  // 包根形态：package.json 自身就是 dsh 包
  if (pkg && pkg.name === '@deepseek-ai/dsh' && !fs.existsSync(path.join(dshDir, '.git'))) {
    return { kind: 'npm', pkg }
  }
  // 项目根形态：根 package.json 依赖 @deepseek-ai/dsh，node_modules 里有包 → npm 形态
  if (!fs.existsSync(path.join(dshDir, '.git'))) {
    const pkgDir = npmPkgDir(dshDir)
    if (pkgDir) {
      try {
        const npmPkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
        if (npmPkg && npmPkg.name === '@deepseek-ai/dsh') return { kind: 'npm', pkg: npmPkg }
      } catch { /* 包损坏则按 git 分支走，最终由 git 命令给出明确错误 */ }
    }
  }
  return { kind: 'git', pkg }
}

async function localInfo(dshDir, execute = run) {
  const det = detectKind(dshDir)
  if (det.kind === 'invalid') return { ok: false, message: 'DSH 目录无效' }
  if (det.kind === 'npm') {
    return {
      ok: true,
      kind: 'npm',
      version: det.pkg.version || '未知',
      commit: '',
      branch: 'npm 包',
      origin: '',
      dirty: false,
      dirtyCount: 0,
    }
  }
  const [head, branch, status, origin] = await Promise.all([
    execute('git', ['rev-parse', '--short', 'HEAD'], dshDir),
    execute('git', ['branch', '--show-current'], dshDir),
    execute('git', ['status', '--porcelain'], dshDir),
    execute('git', ['remote', 'get-url', 'origin'], dshDir),
  ])
  if (!head.ok || !branch.ok) return { ok: false, message: '该 DSH 目录不是可更新的 Git 仓库' }
  return {
    ok: true,
    kind: 'git',
    version: det.pkg.version || readVersion(dshDir),
    commit: head.out,
    branch: branch.out || 'master',
    origin: origin.ok ? origin.out : '',
    dirty: !!status.out,
    dirtyCount: status.out ? status.out.split(/\r?\n/).filter(Boolean).length : 0,
  }
}

function updateSources(origin) {
  const official = origin || 'https://github.com/deepseek-ai/deepseek-harness.git'
  if (!/^https:\/\/github\.com\//i.test(official)) return [official]
  return [
    official,
    `https://ghfast.top/${official}`,
    `https://gh-proxy.com/${official}`,
  ]
}

// 版本号比较：0.1.0-rc.7 -> [0,1,0,-1,7]；数字段比较，预发布段（rc/beta/alpha）比正式段旧
function versionParts(v) {
  return String(v || '').split(/[.\-]/).map(p => /^\d+$/.test(p) ? parseInt(p, 10) : (p === 'rc' || p === 'beta' || p === 'alpha' ? -1 : 0))
}
function compareVersions(a, b) {
  const pa = versionParts(a)
  const pb = versionParts(b)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = i < pa.length ? pa[i] : 0
    const y = i < pb.length ? pb[i] : 0
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

// npm 形态检查：探测 registry 最新版本（node -e fetch），官方优先、npmmirror 回退，每个源 3 秒超时快速切换。
// 2026-08 实测：@deepseek-ai/dsh 的 latest=0.1.0-rc.7、next=0.1.0-rc.8 —— 必须取 dist-tags 中较新者，
// 只看 latest 会"检查不到更新"（本地 rc.7 永远最新）。URL 必须带 -/package/ 前缀（否则 404）。
function npmLatestProbe(nodeExe) {
  return async function probeLatest(registry) {
    const base = String(registry).replace(/\/$/, '')
    const script = 'fetch(process.argv[1]).then(r=>r.json()).then(j=>{console.log((j.latest||"")+" "+(j.next||""))}).catch(()=>process.exit(1))'
    const r = await run(nodeExe, ['-e', script, `${base}/-/package/@deepseek-ai/dsh/dist-tags`], null, 3000)
    if (!r.ok) return ''
    const parts = r.out.trim().split(/\s+/).filter(Boolean)
    const latest = parts[0] || ''
    const next = parts[1] || ''
    if (latest && next) return compareVersions(next, latest) > 0 ? next : latest
    return latest || next || ''
  }
}

async function checkUpdate(dshDir, execute = run, probeLatest = null) {
  const local = await localInfo(dshDir, execute)
  if (!local.ok) return local
  if (local.kind === 'npm') {
    if (!probeLatest) return { ...local, ok: true, checkFailed: true, updateAvailable: false, canInstall: false, message: '更新检查不可用（缺少 registry 探测）' }
    let remoteVersion = ''
    for (const base of NPM_REGISTRIES) {
      remoteVersion = await probeLatest(base)
      if (remoteVersion) break
    }
    if (!remoteVersion) return { ...local, ok: true, checkFailed: true, updateAvailable: false, canInstall: false, message: '网络暂不可用，未完成更新检查' }
    const newer = compareVersions(remoteVersion, local.version) > 0
    return {
      ...local,
      ok: true,
      remoteRef: 'npm:latest',
      remoteCommit: remoteVersion,
      remoteVersion,
      behindCount: newer ? 1 : 0,
      updateAvailable: newer,
      canInstall: newer,
      message: newer ? `发现新版本 ${remoteVersion}（当前 ${local.version}）` : '当前已是最新版本',
    }
  }
  const remoteRef = `refs/remotes/zat-update/${local.branch}`
  let source = ''
  for (const candidate of updateSources(local.origin)) {
    const fetched = await execute('git', ['fetch', '--force', '--no-tags', candidate, `${local.branch}:${remoteRef}`], dshDir, 3000)
    if (fetched.ok) { source = candidate; break }
  }
  if (!source) return { ...local, ok: true, checkFailed: true, updateAvailable: false, canInstall: false, message: '网络暂不可用，未完成更新检查' }
  const [remoteHead, behind, remotePackage] = await Promise.all([
    execute('git', ['rev-parse', '--short', remoteRef], dshDir),
    execute('git', ['rev-list', '--count', `HEAD..${remoteRef}`], dshDir),
    execute('git', ['show', `${remoteRef}:package.json`], dshDir),
  ])
  if (!remoteHead.ok || !behind.ok) return { ...local, ok: false, message: `无法读取远端分支 ${remoteRef}` }
  let remoteVersion = '未知'
  try { remoteVersion = JSON.parse(remotePackage.out).version || '未知' } catch { /* keep unknown */ }
  const behindCount = Number(behind.out) || 0
  return {
    ...local,
    ok: true,
    remoteRef,
    source,
    remoteCommit: remoteHead.out,
    remoteVersion,
    behindCount,
    updateAvailable: behindCount > 0,
    // 有本地修改也能安装：安装时会自动 stash 暂存备份，更新完成后恢复（见 installUpdate）
    canInstall: behindCount > 0,
    message: behindCount > 0 ? `发现 ${behindCount} 个新提交` : '当前已是最新版本',
  }
}

// 清理 tsc 增量缓存（*.tsbuildinfo）：更新前后强制全量编译。
// 旧缓存会让 tsc -b 误判「已是最新」跳过部分包 → 更新后产物缺失/新旧混合
// → 启动时 Cannot find module .../lib/index.js（曾导致更新后 DSH 起不来）。
function clearTsBuildInfo(dshDir) {
  try {
    const walk = (dir) => {
      let entries
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        const full = path.join(dir, e.name)
        if (e.isDirectory()) {
          if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist') continue
          walk(full)
        } else if (e.name.endsWith('.tsbuildinfo')) {
          try { fs.rmSync(full, { force: true }) } catch { /* 忽略 */ }
        }
      }
    }
    walk(dshDir)
  } catch { /* 清理失败不阻断 */ }
}

// 在仓库内按「包名（package.json name）」找包目录（排除 node_modules/.git/dist）。
// 注意：包目录名 ≠ 包名（如 @deepseek-ai/dsh-host-apiproxy 的目录是 packages/host/apiproxy）。
function findPkgByName(dshDir, name) {
  const walk = (dir, depth) => {
    if (depth > 5) return ''
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return '' }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const full = path.join(dir, e.name)
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist') continue
      try {
        const pj = path.join(full, 'package.json')
        if (fs.existsSync(pj)) {
          const pkg = JSON.parse(fs.readFileSync(pj, 'utf8'))
          if (pkg.name === name) return full
        }
      } catch { /* 非包目录 */ }
      const r = walk(full, depth + 1)
      if (r) return r
    }
    return ''
  }
  return walk(dshDir, 0)
}

// 验证关键包编译产物存在（更新/恢复后 DSH 能启动的最低要求）
function verifyKeyArtifacts(dshDir) {
  const keys = ['@deepseek-ai/dsh-host-apiproxy', '@deepseek-ai/dsh-app-boot', '@deepseek-ai/dsh-session-persistence-jsonl', '@deepseek-ai/dsh-client-runtime']
  for (const pkg of keys) {
    const dir = findPkgByName(dshDir, pkg)
    if (!dir) continue
    if (!fs.existsSync(path.join(dir, 'lib', 'index.js'))) return { ok: false, missing: pkg }
  }
  return { ok: true }
}

// 恢复旧版本到可运行状态：回滚代码 + 清增量缓存 + 重装依赖 + 重建旧代码产物
async function restoreOldVersion(dshDir, oldHead, execute, installAttempts, pnpm) {
  const steps = []
  await execute('git', ['reset', '--hard', oldHead], dshDir, 120000)
  steps.push('代码已回滚')
  clearTsBuildInfo(dshDir)
  let restoreInstall = { ok: false }
  for (const args of installAttempts) {
    restoreInstall = await execute(pnpm, args, dshDir, 15 * 60 * 1000)
    if (restoreInstall.ok) break
  }
  if (!restoreInstall.ok) return { ok: false, err: `依赖恢复失败：${String(restoreInstall.err || '').slice(-500)}（${steps.join('、')}）` }
  steps.push('依赖已重装')
  const restore = await runBuild(dshDir, execute, execute && execute.env || process.env, pnpm)
  if (!restore.ok) return { ok: false, err: `旧版本重建失败：${String(restore.err || '').slice(-500)}（${steps.join('、')}）` }
  const artifact = verifyKeyArtifacts(dshDir)
  if (!artifact.ok) return { ok: false, err: `旧版本产物缺失：${artifact.missing}（${steps.join('、')}）` }
  return { ok: true, detail: `${steps.join(' + ')} + 产物重建` }
}

async function installUpdate(dshDir, snapshotDir, execute = run, options = {}) {
  const info = await checkUpdate(dshDir, execute, options.probeLatest)
  if (!info.ok) return info
  if (info.kind === 'npm') {
    if (!info.updateAvailable) return { ...info, message: '当前已是最新版本' }
    if (!options.npmUpdater) return { ...info, ok: false, message: 'npm 包形态更新器不可用' }
    fs.mkdirSync(snapshotDir, { recursive: true })
    fs.writeFileSync(path.join(snapshotDir, 'update.json'), `${JSON.stringify({ createdAt: Date.now(), dshDir, kind: 'npm', from: info.version, target: info.remoteVersion }, null, 2)}\n`, 'utf8')
    const updated = await options.npmUpdater()
    if (!updated.ok) return { ...info, ok: false, message: updated.message }
    const next = await localInfo(dshDir, execute)
    return { ...next, updateAvailable: false, message: `Harness 已更新到 ${updated.version || next.version}，等待用户启动终端` }
  }
  if (!info.updateAvailable) return { ...info, message: '当前已是最新版本' }
  const oldHead = (await execute('git', ['rev-parse', 'HEAD'], dshDir)).out
  fs.mkdirSync(snapshotDir, { recursive: true })
  fs.writeFileSync(path.join(snapshotDir, 'update.json'), `${JSON.stringify({ createdAt: Date.now(), dshDir, oldHead, target: info.remoteRef, targetCommit: info.remoteCommit }, null, 2)}\n`, 'utf8')
  // 有本地修改：ff-only merge 需要干净工作区，先 stash 清空（含未跟踪文件）。
  // 按用户要求「本地修改不要了，就要官方版本」：更新成功后不恢复、不提示；
  // 失败回滚后也不恢复（修改留在 stash 里可自行 git stash pop 找回，界面不打扰）。
  let stashed = false
  if (info.dirty) {
    const stash = await execute('git', ['stash', 'push', '--include-untracked', '-m', `zat-update-${Date.now()}`], dshDir, 120000)
    if (!stash.ok) return { ...info, ok: false, message: `工作区清理失败（${stash.err || stash.out}），未开始更新` }
    stashed = true
  }
  const merge = await execute('git', ['merge', '--ff-only', info.remoteRef], dshDir, 120000)
  if (!merge.ok) return { ...info, ok: false, message: `更新快进失败：${merge.err || merge.out}` }
  const pnpm = options.pnpmExe || null
  // 依赖安装四连：frozen 镜像 → frozen 官方 → 非 frozen 镜像 → 非 frozen 官方。
  // 国内网络直连 npmjs 常断（UND_ERR_DESTROYED），镜像优先命中率最高；
  // 非 frozen（--no-frozen-lockfile）专门解决 lockfile 与 package.json 失配
  // —— 重新解析生成匹配的 lockfile，而不是失败回滚。
  let install = { ok: false, err: '依赖安装失败' }
  const installAttempts = [
    ['install', '--frozen-lockfile', '--registry', 'https://registry.npmmirror.com/'],
    ['install', '--frozen-lockfile'],
    ['install', '--no-frozen-lockfile', '--registry', 'https://registry.npmmirror.com/'],
    ['install', '--no-frozen-lockfile'],
  ]
  for (const args of installAttempts) {
    install = await execute(pnpm, args, dshDir, 15 * 60 * 1000)
    if (install.ok) break
  }
  // build 必须用 npm 触发（新版 DSH build.ts 用 npm_execpath + `node <path> run ...`，
  // pnpm 的 npm_execpath 是 pnpm.exe 会被 node 当 JS 加载报错；npm 的是 npm-cli.js 纯 JS）。
  // runBuild 内部多级自适应：npm run build → 分步 build:lib/build:web → pnpm run build 兜底。
  // build 前清 tsc 增量缓存：旧 tsbuildinfo 会让部分包跳过编译，产物缺失/新旧混合。
  clearTsBuildInfo(dshDir)
  const build = install.ok ? await runBuild(dshDir, execute, execute && execute.env || process.env, pnpm) : { ok: false, err: '依赖安装失败' }
  const artifact = install.ok && build.ok ? verifyKeyArtifacts(dshDir) : { ok: true }
  if (!install.ok || !build.ok || !artifact.ok) {
    // 失败：完整恢复旧版本可运行状态（代码回滚 + 清缓存 + 重装依赖 + 重建旧代码产物），
    // 绝不留「新代码 + 旧产物 / 旧代码 + 新产物」的混合状态（曾导致更新后 DSH 起不来）。
    let fail = (install.ok ? build.err : install.err || '依赖安装失败') || '未知错误'
    if (artifact.ok === false) fail = `编译产物缺失（${artifact.missing}）：${fail}`
    const restored = await restoreOldVersion(dshDir, oldHead, execute, installAttempts, pnpm)
    const restoredNote = restored.ok
      ? `已完整恢复旧版本（${restored.detail}），DSH 可正常启动`
      : `已回滚代码，但旧版本恢复失败：${restored.err}`
    return { ...info, ok: false, rolledBack: true, message: `更新验证失败：${String(fail).slice(-1500)}。${restoredNote}` }
  }
  return { ...(await localInfo(dshDir, execute)), updateAvailable: false, message: 'Harness 已更新到官方版本，等待用户启动终端' }
}

module.exports = { run, readVersion, localInfo, updateSources, checkUpdate, installUpdate, npmLatestProbe, compareVersions, detectKind, NPM_REGISTRIES, runBuild, verifyKeyArtifacts, clearTsBuildInfo, findNpmCli }
