'use strict'

// DSH CLI 参数兼容性探测（0.6.22 根因：npm 预构建包 rc.7 的 web 命令不支持 --no-open，
// 传了会 "error: unknown option '--no-open'" 启动即退；源码版 rc.8+ 支持）。
// 不能按版本静态判断（选项定义在 web app 插件层，版本/形态都可能变），
// 只能实际探测。0.6.24 修正探测方法：
//  旧方法（带 --no-open 跑 --help 看是否报 unknown option）不可靠——rc.7 的 web app
//  对未知选项容忍（透传设计），`web --no-open --help` 直接打印帮助退出 0 不报错，
//  导致误判为"支持"，真实启动时 unknown option 崩溃（0.6.23 事故）。
//  新方法：跑 `node <bin.js> web --help`，读 help 文本（CLI 自己生成的选项列表），
//  rc.7 无 --no-open、rc.8 有，可靠。另加 forceNoOpenUnsupported 供启动失败自适应。

const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const cache = new Map() // dshDir -> { ok, at }

// dshCommand 逻辑（与 main.js 一致，避免循环依赖）：返回 { nodeExe, cli, built }
function resolveCli(dshDir, nodeExe) {
  const pkgFile = path.join(dshDir, 'package.json')
  let pkg = null
  try { pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8')) } catch { /* 非 npm 包形态 */ }
  if (pkg && pkg.name === '@deepseek-ai/dsh') {
    // npm 包形态：lib/bin.js
    return { cli: path.join(dshDir, 'lib', 'bin.js'), built: true }
  }
  // 源码形态：apps/cli/lib/bin.js（编译产物）或 apps/cli/src/bin.ts（tsx 运行）
  const compiled = path.join(dshDir, 'apps', 'cli', 'lib', 'bin.js')
  const source = path.join(dshDir, 'apps', 'cli', 'src', 'bin.ts')
  if (fs.existsSync(compiled)) return { cli: compiled, built: true }
  if (fs.existsSync(source)) return { cli: source, built: false }
  return { cli: '', built: false }
}

/**
 * 探测 dshDir 的 DSH CLI 是否支持 --no-open。
 * 方法：跑 `node <bin.js> web --help`，help 选项列表里是否列出 --no-open。
 * @param {string} dshDir  DSH 根目录
 * @param {string} nodeExe node 可执行文件
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<boolean>} 支持返回 true；任何不确定/失败返回 false（保守：省略参数，
 *   宁可不拦浏览器也不让启动失败）
 */
async function cliNoOpenSupported(dshDir, nodeExe, opts = {}) {
  const key = String(dshDir || '')
  if (!key) return false
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.ok
  const timeoutMs = opts.timeoutMs || 10000
  let ok = false
  try {
    const { cli, built } = resolveCli(dshDir, nodeExe)
    if (!cli) { ok = false }
    else {
      const execNode = String(nodeExe || 'node')
      // 真实启动形态探测：--help 的选项列表不可靠（rc.7/rc.8 的 npm 包在 --help 时
      // 透传容忍、真实启动却报 "unknown option '--no-open'"）。改为带随机端口真实启动，
      // 3 秒内 stderr 出现 unknown option 即判不支持；否则视为支持（失败有启动自适应兜底）。
      const probePort = 50000 + Math.floor(Math.random() * 10000)
      const execArgs = built ? [cli, 'web', '--no-open', '--port', String(probePort)] : ['--import', 'tsx/esm', cli, 'web', '--no-open', '--port', String(probePort)]
      const r = await new Promise(resolve => {
        let child
        try {
          child = spawn(execNode, execArgs, {
            cwd: dshDir,
            windowsHide: true,
            shell: false,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env },
          })
        } catch (e) { return resolve({ code: -1, out: String(e && e.message || e) }) }
        let out = ''
        const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* 已退出 */ } }, timeoutMs)
        child.stdout.on('data', d => { out += d.toString() })
        child.stderr.on('data', d => { out += d.toString() })
        child.on('error', () => { clearTimeout(timer); resolve({ code: -1, out }) })
        child.on('exit', code => { clearTimeout(timer); resolve({ code, out }) })
      })
      // 真实启动报 unknown option '--no-open' → 不支持；其他情况（启动成功/超时/其它错误）→ 支持
      ok = !/unknown option ['"]--no-open['"]/i.test(r.out)
    }
  } catch { ok = false }
  cache.set(key, { ok, at: Date.now() })
  return ok
}

// 启动失败自适应：真实启动报 "unknown option '--no-open'" 时，强制把该 dshDir 缓存为不支持，
// 让后续启动（含救援「重新启动」）自动省略参数。
function forceNoOpenUnsupported(dshDir) {
  const key = String(dshDir || '')
  if (!key) return
  cache.set(key, { ok: false, at: Date.now() })
}

module.exports = { cliNoOpenSupported, forceNoOpenUnsupported, resolveCli }
