'use strict'

// 宿主平台适配层：集中处理 GUI 应用的可执行文件发现、PATH、端口 PID 与进程树。
// 上层终端模型不应再直接依赖 where.exe / PowerShell / netstat -ano / taskkill。

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { execFile, execFileSync } = require('node:child_process')
const { parseNetstatListeningPids } = require('./windows-process')

function nodeSatisfiesDsh(versionText) {
  const match = String(versionText || '').match(/v?(\d+)\.(\d+)\.(\d+)/)
  if (!match) return false
  const major = Number(match[1])
  const minor = Number(match[2])
  return major === 22 ? minor >= 19 : major >= 24
}

function mergePath(extraDirs, currentPath, delimiter = path.delimiter) {
  const seen = new Set()
  const result = []
  for (const value of [...(extraDirs || []), ...String(currentPath || '').split(delimiter)]) {
    const item = String(value || '').trim()
    if (!item) continue
    const key = process.platform === 'win32' ? item.toLowerCase() : item
    if (seen.has(key)) continue
    seen.add(key)
    result.push(item)
  }
  return result.join(delimiter)
}

function versionDirectoryCandidates(base, suffix) {
  let names = []
  try { names = fs.readdirSync(base, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name) } catch { return [] }
  names.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
  return names.map(name => path.join(base, name, suffix))
}

function loginShellExecutable(command, options) {
  if (!/^[a-zA-Z0-9._+-]+$/.test(command)) return ''
  const platform = options.platform
  if (platform === 'win32' || options.useLoginShell === false) return ''
  const env = options.env
  const shell = env.SHELL && path.isAbsolute(env.SHELL) ? env.SHELL : '/bin/zsh'
  try {
    const out = options.execFileSync(shell, ['-lic', `command -v ${command}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
      env,
    })
    return String(out || '').split(/\r?\n/).map(line => line.trim()).find(line => path.isAbsolute(line) && fs.existsSync(line)) || ''
  } catch { return '' }
}

function executableFromPath(command, env, delimiter) {
  for (const dir of String(env.PATH || '').split(delimiter)) {
    if (!dir) continue
    const candidate = path.join(dir, command)
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      return candidate
    } catch { /* 继续 */ }
  }
  return ''
}

function findNodeExe(options = {}) {
  const platform = options.platform || process.platform
  const home = options.homedir || os.homedir()
  const env = options.env || process.env
  const runSync = options.execFileSync || execFileSync
  const delimiter = platform === 'win32' ? ';' : ':'
  const candidates = [env.DSH_NODE_EXE]

  if (platform === 'win32') {
    candidates.push(
      path.join(env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node.exe'),
      path.join(env.LOCALAPPDATA || '', 'Programs', 'nodejs', 'node.exe'),
      executableFromPath('node.exe', env, delimiter),
      'node',
    )
  } else {
    candidates.push(
      path.join(home, '.hermes', 'node', 'bin', 'node'),
      path.join(home, '.local', 'bin', 'node'),
      path.join(home, '.volta', 'bin', 'node'),
      path.join(home, '.asdf', 'shims', 'node'),
      path.join(home, '.fnm', 'aliases', 'default', 'bin', 'node'),
      ...versionDirectoryCandidates(path.join(home, '.nvm', 'versions', 'node'), path.join('bin', 'node')),
      ...versionDirectoryCandidates(path.join(home, '.fnm', 'node-versions'), path.join('installation', 'bin', 'node')),
      '/opt/homebrew/bin/node',
      '/usr/local/bin/node',
      '/usr/bin/node',
      executableFromPath('node', env, delimiter),
      loginShellExecutable('node', { platform, env, execFileSync: runSync, useLoginShell: options.useLoginShell }),
      'node',
    )
  }

  const seen = new Set()
  for (const candidate of candidates) {
    const value = String(candidate || '').trim()
    if (!value || seen.has(value)) continue
    seen.add(value)
    if (value !== 'node' && !fs.existsSync(value)) continue
    try {
      const output = runSync(value, ['-v'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, env })
      if (nodeSatisfiesDsh(output)) return value
    } catch { /* 继续 */ }
  }
  return ''
}

function findSystemExecutable(command, options = {}) {
  const platform = options.platform || process.platform
  const home = options.homedir || os.homedir()
  const env = options.env || process.env
  const runSync = options.execFileSync || execFileSync
  const delimiter = platform === 'win32' ? ';' : ':'
  const candidates = [executableFromPath(command + (platform === 'win32' ? '.exe' : ''), env, delimiter)]
  if (platform === 'win32') {
    if (command === 'git') {
      candidates.push(
        path.join(env.ProgramFiles || 'C:\\Program Files', 'Git', 'cmd', 'git.exe'),
        path.join(env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Git', 'cmd', 'git.exe'),
        path.join(env.LOCALAPPDATA || '', 'Programs', 'Git', 'cmd', 'git.exe'),
      )
    }
  } else {
    candidates.push(
      path.join(home, '.local', 'bin', command),
      path.join(home, '.volta', 'bin', command),
      `/opt/homebrew/bin/${command}`,
      `/usr/local/bin/${command}`,
      `/usr/bin/${command}`,
      loginShellExecutable(command, { platform, env, execFileSync: runSync, useLoginShell: options.useLoginShell }),
    )
  }
  for (const candidate of candidates) {
    if (!candidate || !fs.existsSync(candidate)) continue
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      return candidate
    } catch { /* 继续 */ }
  }
  return ''
}

function nodeDistributionSpec(version, platform = process.platform, arch = process.arch) {
  const normalizedArch = arch === 'x64' || arch === 'arm64' ? arch : 'x64'
  if (platform === 'win32') {
    const folder = `node-${version}-win-${normalizedArch}`
    return { folder, archiveName: `${folder}.zip`, nodeRelativePath: 'node.exe', extractCommand: 'powershell.exe' }
  }
  if (platform === 'darwin' || platform === 'linux') {
    const folder = `node-${version}-${platform}-${normalizedArch}`
    return { folder, archiveName: `${folder}.tar.gz`, nodeRelativePath: path.join('bin', 'node'), extractCommand: 'tar' }
  }
  return null
}

function execAsync(file, args, options = {}, implementation = execFile) {
  return new Promise(resolve => {
    implementation(file, args, options, (error, stdout, stderr) => {
      resolve({ ok: !error, out: String(stdout || ''), err: String(stderr || (error && error.message) || '') })
    })
  })
}

function parsePidLines(output) {
  return [...new Set(String(output || '').split(/\r?\n/).map(line => Number(line.trim())).filter(pid => Number.isSafeInteger(pid) && pid > 0))]
}

async function listPortPids(port, options = {}) {
  const n = Number(port)
  if (!Number.isSafeInteger(n) || n < 1 || n > 65535) return []
  const platform = options.platform || process.platform
  const run = options.execFile || execFile
  if (platform === 'win32') {
    const result = await execAsync('netstat', ['-ano', '-p', 'tcp'], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, run)
    return result.ok ? parseNetstatListeningPids(result.out, n) : []
  }
  const lsof = fs.existsSync('/usr/sbin/lsof') ? '/usr/sbin/lsof' : 'lsof'
  const result = await execAsync(lsof, ['-nP', `-iTCP:${n}`, '-sTCP:LISTEN', '-t'], { maxBuffer: 1024 * 1024 }, run)
  return parsePidLines(result.out)
}

function processAlive(pid, kill = process.kill) {
  try { kill(pid, 0); return true } catch { return false }
}

async function descendantPids(pid, run) {
  const pgrep = fs.existsSync('/usr/bin/pgrep') ? '/usr/bin/pgrep' : 'pgrep'
  const result = await execAsync(pgrep, ['-P', String(pid)], { maxBuffer: 1024 * 1024 }, run)
  const direct = parsePidLines(result.out)
  const all = []
  for (const child of direct) all.push(...await descendantPids(child, run), child)
  return all
}

async function killPidTree(pid, options = {}) {
  const n = Number(pid)
  if (!Number.isSafeInteger(n) || n <= 0 || n === process.pid) return false
  const platform = options.platform || process.platform
  const run = options.execFile || execFile
  if (platform === 'win32') {
    const result = await execAsync('taskkill', ['/F', '/T', '/PID', String(n)], { windowsHide: true }, run)
    return result.ok
  }
  const send = options.kill || process.kill
  let descendants = []
  try { descendants = await descendantPids(n, run) } catch { descendants = [] }
  for (const target of [...descendants, n]) {
    try { send(target, 'SIGTERM') } catch { /* 已退出 */ }
  }
  const deadline = Date.now() + 1500
  while (Date.now() < deadline && processAlive(n, send)) await new Promise(resolve => setTimeout(resolve, 50))
  for (const target of [...descendants, n]) {
    if (!processAlive(target, send)) continue
    try { send(target, 'SIGKILL') } catch { /* 已退出 */ }
  }
  return !processAlive(n, send)
}

module.exports = {
  nodeSatisfiesDsh,
  mergePath,
  findNodeExe,
  findSystemExecutable,
  nodeDistributionSpec,
  parsePidLines,
  listPortPids,
  killPidTree,
}
