'use strict'

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { execFile, execFileSync } = require('node:child_process')

// 大小写不敏感、去尾部反斜杠的规范路径，用于目录判重
function normalizeDshPath(value) {
  return path.resolve(String(value || '')).replace(/[\\/]+$/, '').toLowerCase()
}

// npm 包形态的 dshDir 可能是「包根」（node_modules\@deepseek-ai\dsh，旧版启动器登记格式），
// 也可能是「项目根」（DSH_HOME 所在，profiles 在其下）。统一归一化到项目根。
function normalizeNpmRoot(value) {
  if (!value || typeof value !== 'string') return value
  const trimmed = String(value).replace(/[\\/]+$/, '')
  const tail = trimmed.match(/(?:^|[\\/])node_modules[\\/]@deepseek-ai[\\/]dsh$/i)
  if (!tail) return trimmed
  return trimmed.slice(0, tail.index).replace(/[\\/]+$/, '')
}

// 判断 npm 包安装模式的子类型，供调用方区分 dshHome 归属：
//  - npx：npm 缓存 _npx 目录（包在 AppData\Local\npm-cache\_npx\<hash>），官方 npx 方式
//  - npm-standalone：全局 npm/pnpm 安装（包在 node_modules/@deepseek-ai/dsh，
//    项目根没有 package.json 的独立安装）
//  - npm：启动器一键安装的标准项目根（根有 package.json，profiles 就在其下）
function classifyNpmMode(root, originalDir) {
  const lowerRoot = root.toLowerCase()
  // npx 缓存特征：路径含 \_npx\ 或 /_npx/
  if (lowerRoot.includes('\\_npx\\') || lowerRoot.includes('/_npx/')) return 'npx'
  // 从包根（node_modules/@deepseek-ai/dsh）归一化到项目根：检查项目根是否有 package.json。
  // 没有则说明是全局安装的包管理前缀（如 %APPDATA%\npm），不是项目根。
  if (originalDir && normalizeNpmRoot(originalDir) !== originalDir) {
    if (!fs.existsSync(path.join(root, 'package.json'))) return 'npm-standalone'
  }
  return 'npm'
}

// 官方 npx / 全局 npm / pnpm 的落盘点：这些目录不在常规"主目录/盘符"扫描范围内，
// 但恰恰是 README 首推方式（npx @deepseek-ai/dsh web）与常见全局安装的真实位置。
function extraScanRoots() {
  const roots = []
  const home = os.homedir()
  const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
  const roaming = process.env.APPDATA || path.join(home, 'AppData', 'Roaming')
  const pf = process.env.ProgramFiles || 'C:\\Program Files'
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
  const pushIfExists = (dir) => {
    if (dir && fs.existsSync(dir)) roots.push(dir)
  }
  // npx 缓存：npm 常见 cache 位置
  for (const cache of [path.join(local, 'npm-cache', '_npx'), path.join(roaming, 'npm-cache', '_npx'), path.join(home, '.npm', '_npx')]) {
    if (!fs.existsSync(cache)) continue
    try {
      for (const name of fs.readdirSync(cache, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name)) {
        const hashDir = path.join(cache, name)
        roots.push(hashDir)
        // 旧版 npx 布局兜底：直接给包根
        const pkgDir = path.join(hashDir, 'node_modules', '@deepseek-ai', 'dsh')
        if (fs.existsSync(pkgDir)) roots.push(pkgDir)
      }
    } catch { /* 缓存目录不可读则跳过 */ }
  }
  if (process.platform !== 'win32') {
    // POSIX 全局/用户级 npm 安装（npm prefix 常见为 ~/.local、/usr/local、Homebrew）。
    for (const prefix of [path.join(home, '.local'), '/usr/local', '/opt/homebrew']) {
      pushIfExists(path.join(prefix, 'lib', 'node_modules', '@deepseek-ai', 'dsh'))
      pushIfExists(path.join(prefix, 'node_modules', '@deepseek-ai', 'dsh'))
    }
  }
  // 全局 npm：npm prefix 下的 node_modules/@deepseek-ai/dsh
  for (const prefix of [path.join(roaming, 'npm'), path.join(local, 'npm'), path.join(pf, 'nodejs'), path.join(pf86, 'nodejs')]) {
    pushIfExists(path.join(prefix, 'node_modules', '@deepseek-ai', 'dsh'))
    // 个别 npm 版本会直接把包展开在 prefix 下
    pushIfExists(path.join(prefix, '@deepseek-ai', 'dsh'))
  }
  // 全局 pnpm：常见 prefix + global 目录，递归两层找 @deepseek-ai/dsh
  for (const base of [path.join(local, 'pnpm'), path.join(roaming, 'pnpm'), path.join(home, '.pnpm')]) {
    if (!fs.existsSync(base)) continue
    pushIfExists(path.join(base, 'node_modules', '@deepseek-ai', 'dsh'))
    const scan = (dir, depth) => {
      if (depth > 2) return
      let entries = []
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        if (!e.isDirectory() || e.name === 'node_modules') continue
        const full = path.join(dir, e.name)
        pushIfExists(path.join(full, 'node_modules', '@deepseek-ai', 'dsh'))
        scan(full, depth + 1)
      }
    }
    scan(base, 0)
  }
  return roots
}

// DSH 官方推荐 `npx @deepseek-ai/dsh web`，很多用户根本没有“项目根”，
// 数据在 DSH_HOME（默认 ~/.dsh）。识别 DSH_HOME：profiles 下有带 dsh.profile.bundles 的 profile，
// 或 profiles/node_modules 里有 @deepseek-ai/dsh-base。
function isDshHomeDir(value) {
  if (!value || typeof value !== 'string') return false
  const dir = path.resolve(value)
  const profilesDir = path.join(dir, 'profiles')
  if (!fs.existsSync(profilesDir)) return false
  try {
    for (const ent of fs.readdirSync(profilesDir, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue
      const pkgFile = path.join(profilesDir, ent.name, 'package.json')
      if (!fs.existsSync(pkgFile)) continue
      const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'))
      if (pkg && pkg.dsh && pkg.dsh.profile && Array.isArray(pkg.dsh.profile.bundles)) return true
    }
  } catch { /* 读取失败继续 */ }
  return fs.existsSync(path.join(profilesDir, 'node_modules', '@deepseek-ai', 'dsh-base'))
}

// 通过 dsh 命令 / 常见全局安装位置 / npm+pnpm 全局根，定位 @deepseek-ai/dsh 包根。
// 参照 deepseek-harness-box：`Get-Command dsh` 的 shim 在 <prefix>，包在 <prefix>\node_modules\@deepseek-ai\dsh。
function findDshPackageRoots() {
  const roots = []
  const push = (p) => {
    if (!p || !fs.existsSync(p)) return
    const normalized = path.resolve(p)
    if (!roots.some(r => r.toLowerCase() === normalized.toLowerCase())) roots.push(normalized)
  }
  // 1) dsh 命令 shim：where dsh → C:\Users\x\AppData\Roaming\npm\dsh.cmd
  try {
    const where = String(execFileSync('where.exe', ['dsh'], { encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }) || '')
    for (const line of where.split(/\r?\n/)) {
      const p = String(line || '').trim()
      if (!p) continue
      const prefix = p.toLowerCase().includes('node_modules\\.bin')
        ? path.join(path.dirname(path.dirname(path.dirname(p))), 'node_modules')
        : path.dirname(p)
      push(path.join(prefix, 'node_modules', '@deepseek-ai', 'dsh'))
      push(path.join(prefix, '@deepseek-ai', 'dsh'))
    }
  } catch { /* 无 dsh 命令 */ }
  // 2) npm / pnpm 全局根（cmd 包装，避免 Node 直接 exec .cmd 的 EINVAL）
  for (const tool of ['npm', 'pnpm']) {
    try {
      const whereTool = String(execFileSync('where.exe', [tool], { encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }) || '')
      const toolPath = whereTool.split(/\r?\n/).map(s => s.trim()).find(Boolean)
      if (!toolPath) continue
      const rootOut = String(execFileSync('cmd.exe', ['/c', `"${toolPath}" root -g`], { encoding: 'utf8', windowsHide: true, timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] }) || '').trim()
      if (rootOut) {
        push(path.join(rootOut, '@deepseek-ai', 'dsh'))
        push(path.join(rootOut, 'node_modules', '@deepseek-ai', 'dsh'))
      }
    } catch { /* 无该工具或执行失败 */ }
  }
  // 3) 常见全局目录兜底（与 extraScanRoots 同源）
  for (const extra of extraScanRoots()) push(extra)
  return roots
}

// 用户随便选了一个父目录：在里面递归找 DSH 根，不再要求“选的目录本身就是根”。
function findDshRootNear(value, maxDepth = 4) {
  if (!value || typeof value !== 'string') return null
  const root = path.resolve(value)
  const found = []
  let visited = 0
  const walk = (dir, depth) => {
    if (depth > maxDepth || visited > 3000) return
    visited++
    const inspected = inspectDshDir(dir)
    if (inspected) { found.push({ dir, inspected, depth }); return }
    let entries = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue
      if (['node_modules', '.git', '$RECYCLE.BIN', 'System Volume Information', 'Windows', 'Program Files', 'Program Files (x86)'].includes(ent.name)) continue
      walk(path.join(dir, ent.name), depth + 1)
      if (found.length) return
    }
  }
  walk(root, 0)
  if (found.length) return found[0].inspected
  return null
}

// 严格校验 DSH 根目录，支持多种形态（返回 mode 供调用方区分）：
//  - source：源码仓库（根 package.json + apps/cli，name/workspaces 特征）
//  - npx：npm 缓存 _npx 安装（包在 npx 缓存，dshHome 应为 ~/.dsh）
//  - npm-standalone：全局安装或裸装（dshHome 应为 ~/.dsh）
//  - npm：npm/pnpm 包安装形态（根 package.json 依赖 @deepseek-ai/dsh，
//    node_modules 里有完整包结构；目录自身同时是 DSH_HOME，profiles 就在其下）
function inspectDshDir(value) {
  if (!value || typeof value !== 'string') return null
  const dir = path.resolve(value)
  const packageFile = path.join(dir, 'package.json')
  if (!fs.existsSync(packageFile)) return null
  // 源码形态：根 package.json + apps/cli
  const cliDir = path.join(dir, 'apps', 'cli')
  if (fs.existsSync(cliDir)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8'))
      if (pkg.name !== '@deepseek-ai/dsh-root' && !Array.isArray(pkg.workspaces)) return null
      return { dir, version: String(pkg.version || '未知'), name: path.basename(dir) || 'DeepSeek Harness', mode: 'source' }
    } catch { return null }
  }
  // npm 包形态：node_modules 里有 @deepseek-ai/dsh 完整包（lib/bin.js 存在）
  const npmPkgFile = path.join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  const npmCliFile = path.join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (fs.existsSync(npmPkgFile) && fs.existsSync(npmCliFile)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(npmPkgFile, 'utf8'))
      if (pkg.name !== '@deepseek-ai/dsh' || !pkg.bin || !pkg.bin.dsh) return null
      const mode = classifyNpmMode(dir, dir)
      const displayName = mode === 'npx' || mode === 'npm-standalone'
        ? `@deepseek-ai/dsh v${pkg.version || '未知'}`
        : path.basename(dir) || 'DeepSeek Harness'
      return { dir, version: String(pkg.version || '未知'), name: displayName, mode }
    } catch { return null }
  }
  // ★ npm 包根形态（1.0.10 修复）：传入目录本身是 @deepseek-ai/dsh 包根
  //   （旧版登记格式/用户手动选到包目录），归一化到项目根（DSH_HOME）。
  //   旧逻辑在这里直接判 null，导致"npm 安装的 DSH 检测不到"（用户反馈）。
  const selfPkgFile = path.join(dir, 'package.json')
  if (fs.existsSync(selfPkgFile) && fs.existsSync(path.join(dir, 'lib', 'bin.js'))) {
    try {
      const pkg = JSON.parse(fs.readFileSync(selfPkgFile, 'utf8'))
      if (pkg.name === '@deepseek-ai/dsh' && pkg.bin && pkg.bin.dsh) {
        const root = normalizeNpmRoot(dir)
        const mode = classifyNpmMode(root, dir)
        const displayName = mode === 'npx' || mode === 'npm-standalone'
          ? `@deepseek-ai/dsh v${pkg.version || '未知'}`
          : path.basename(root) || 'DeepSeek Harness'
        return { dir: root, version: String(pkg.version || '未知'), name: displayName, mode }
      }
    } catch { /* 无效包 */ }
  }
  return null
}

function execText(file, args, options, execute = execFile) {
  return new Promise(resolve => {
    execute(file, args, options, (error, stdout) => resolve(error ? '' : String(stdout || '')))
  })
}

// 列出 node/dsh 进程：pid|命令行|cwd|监听端口（只读探测）。
// cwd 通过进程 PEB 读取（Node 进程常以相对路径 apps/cli 启动，命令行里没有根目录）。
// 监听端口用于命令行未带 --port 时确定实例实际端口。
// C# 探测代码首次编译缓存到 %TEMP%\dsh-cwd-probe.dll，之后直接加载（编译本身 1-2 秒，加载 ~50ms）。
function windowsProcessEntries(execute) {
  return new Promise(resolve => {
    const csharp = [
      "'using System;using System.Runtime.InteropServices;",
      "public class CwdProbe {",
      "[StructLayout(LayoutKind.Sequential)] public struct PBI { public IntPtr R1; public IntPtr Peb; public IntPtr R2; public IntPtr R3; public IntPtr Pid; public IntPtr R4; }",
      "[DllImport(\"ntdll.dll\")] static extern int NtQueryInformationProcess(IntPtr h,int cls,out PBI info,int len,out int ret);",
      "[DllImport(\"kernel32.dll\")] static extern bool ReadProcessMemory(IntPtr h,IntPtr addr,byte[] buf,int size,out IntPtr read);",
      "[DllImport(\"kernel32.dll\")] static extern IntPtr OpenProcess(int access,bool inherit,int pid);",
      "[DllImport(\"kernel32.dll\")] static extern bool CloseHandle(IntPtr h);",
      "public static string GetCwd(int pid){",
      "IntPtr h=OpenProcess(0x1010,false,pid); if(h==IntPtr.Zero) h=OpenProcess(0x0410,false,pid); if(h==IntPtr.Zero) return \"\";",
      "try{ PBI pbi; int ret; if(NtQueryInformationProcess(h,0,out pbi,Marshal.SizeOf(typeof(PBI)),out ret)!=0) return \"\";",
      "bool is64=IntPtr.Size==8; byte[] b=new byte[IntPtr.Size]; IntPtr read;",
      "int ppOff=is64?0x20:0x10; if(!ReadProcessMemory(h,pbi.Peb+ppOff,b,IntPtr.Size,out read)) return \"\";",
      "IntPtr rtl=is64?(IntPtr)BitConverter.ToInt64(b,0):(IntPtr)BitConverter.ToInt32(b,0); if(rtl==IntPtr.Zero) return \"\";",
      "int cdOff=is64?0x38:0x24; byte[] us=new byte[is64?16:8]; if(!ReadProcessMemory(h,rtl+cdOff,us,us.Length,out read)) return \"\";",
      "ushort len=(ushort)(us[0]|(us[1]<<8)); IntPtr bp=is64?(IntPtr)BitConverter.ToInt64(us,8):(IntPtr)BitConverter.ToInt32(us,4);",
      "if(len<=0||len>4096) return \"\"; byte[] s=new byte[len]; if(!ReadProcessMemory(h,bp,s,len,out read)) return \"\";",
      "return System.Text.Encoding.Unicode.GetString(s); } finally { CloseHandle(h); } } }'",
    ].join(' ')
    const command = [
      "$dll=Join-Path $env:TEMP 'dsh-cwd-probe.dll';",
      "if (-not (Test-Path $dll)) { Add-Type -TypeDefinition " + csharp + " -OutputAssembly $dll -ErrorAction SilentlyContinue };",
      "try { Add-Type -Path $dll -ErrorAction Stop } catch { Add-Type -TypeDefinition " + csharp + " -ErrorAction SilentlyContinue };",
      "$portsByPid=@{};",
      "Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | ForEach-Object { $portsByPid[$_.OwningProcess]=($portsByPid[$_.OwningProcess]+','+$_.LocalPort).TrimStart(',') };",
      "Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'node|dsh' -and $_.CommandLine -match 'bin\\.js' } | ForEach-Object {",
      "$p=$_.ProcessId; $cwd=''; try { $cwd=[CwdProbe]::GetCwd($p) } catch {}; $ports=$portsByPid[$p];",
      "$p.ToString()+'|'+$_.CommandLine+'|'+$cwd+'|'+$ports }",
    ].join(' ')
    execute('powershell.exe', ['-NoProfile', '-Command', command], { windowsHide: true, timeout: 12000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) return resolve([])
      resolve(String(stdout || '').split(/\r?\n/).map(parseProcessEntry).filter(Boolean))
    })
  })
}

// macOS/Linux：ps 提供完整命令行，lsof 补充 cwd 与监听端口。
// 只对命令行已命中 DSH CLI 的少量进程调用 lsof，避免全系统逐进程扫描。
async function posixProcessEntries(execute) {
  const ps = fs.existsSync('/bin/ps') ? '/bin/ps' : 'ps'
  const lsof = fs.existsSync('/usr/sbin/lsof') ? '/usr/sbin/lsof' : 'lsof'
  const output = await execText(ps, ['-ww', '-axo', 'pid=,command='], { timeout: 12000, maxBuffer: 8 * 1024 * 1024 }, execute)
  const candidates = []
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/)
    if (!match) continue
    const commandLine = match[2]
    const normalized = commandLine.replace(/\\/g, '/').toLowerCase()
    const isCliEntry = /(?:^|\/)bin\.(?:js|ts)(?:\s|$)/.test(normalized)
    if (!isCliEntry || (!normalized.includes('apps/cli/') && !normalized.includes('node_modules/@deepseek-ai/dsh/'))) continue
    candidates.push({ pid: Number(match[1]), commandLine })
  }
  const results = []
  for (const candidate of candidates) {
    const pidText = String(candidate.pid)
    const cwdOutput = await execText(lsof, ['-a', '-p', pidText, '-d', 'cwd', '-Fn'], { timeout: 4000, maxBuffer: 1024 * 1024 }, execute)
    const cwd = cwdOutput.split(/\r?\n/).find(line => line.startsWith('n'))
    const portOutput = await execText(lsof, ['-Pan', '-p', pidText, '-iTCP', '-sTCP:LISTEN', '-Fn'], { timeout: 4000, maxBuffer: 1024 * 1024 }, execute)
    const ports = [...new Set(portOutput.split(/\r?\n/).flatMap(line => {
      if (!line.startsWith('n')) return []
      const match = line.match(/:(\d+)(?:\s|$)/)
      const port = match && Number(match[1])
      return Number.isSafeInteger(port) && port > 0 && port <= 65535 ? [port] : []
    }))]
    results.push({ ...candidate, cwd: cwd ? cwd.slice(1) : null, ports })
  }
  return results
}

function processEntries(options = {}) {
  const platform = options.platform || process.platform
  const execute = options.execFile || execFile
  return platform === 'win32' ? windowsProcessEntries(execute) : posixProcessEntries(execute)
}

// 解析 "{pid}|{commandLine}|{cwd}|{ports}" 行 → { pid, commandLine, cwd, ports }；无效返回 null
function parseProcessEntry(line) {
  const text = String(line || '')
  let sep = text.indexOf('|')
  if (sep <= 0) return null
  const pid = Number(text.slice(0, sep))
  if (!Number.isSafeInteger(pid) || pid <= 0) return null
  const rest = text.slice(sep + 1)
  sep = rest.indexOf('|')
  const commandLine = sep < 0 ? rest : rest.slice(0, sep)
  let cwd = null
  let ports = []
  if (sep >= 0) {
    const rest2 = rest.slice(sep + 1)
    const sep2 = rest2.indexOf('|')
    cwd = (sep2 < 0 ? rest2 : rest2.slice(0, sep2)) || null
    if (sep2 >= 0) {
      ports = rest2.slice(sep2 + 1).split(',').map(Number).filter(n => Number.isSafeInteger(n) && n > 0 && n <= 65535)
    }
  }
  return { pid, commandLine, cwd, ports }
}

// 从命令行提取 DSH 根目录与 --port 端口；命令行是相对路径（apps/cli）时用进程 cwd 补全根目录。
// 支持三种形态：源码形态（apps\cli\...bin.js）、npm 包形态（node_modules\@deepseek-ai\dsh\lib\bin.js）、
// npx 缓存形态（node_modules\@deepseek-ai\dsh\lib\bin.js，但路径在 _npx 缓存下）。
// npm 包形态会把根目录归一化到项目根（剥掉 node_modules\@deepseek-ai\dsh 尾巴），
// 因为项目根才是 DSH_HOME（profiles 就在项目根下）；npx 形态的 DSH_HOME 是 ~/.dsh。
const NPM_PKG_MARKER = 'node_modules\\@deepseek-ai\\dsh\\lib\\bin.js'
const NPM_PKG_TAIL = 'node_modules\\@deepseek-ai\\dsh'

function instanceFromCommandLine(commandLine, cwd) {
  const original = String(commandLine || '')
  // 只统一用于查找 marker 的副本；根路径保留原始分隔符，确保随后能被宿主文件系统访问。
  const normalized = original.replace(/\//g, '\\')
  const lower = normalized.toLowerCase()
  const srcMarker = 'apps\\cli\\'
  let index = lower.indexOf(srcMarker)
  let isNpm = false
  if (index < 0) {
    index = lower.indexOf(NPM_PKG_MARKER)
    isNpm = index >= 0
  }
  if (index < 0) return null
  let root = original.slice(0, index).trim().replace(/^['"]|['"]$/g, '')
  const quote = Math.max(root.lastIndexOf('"'), root.lastIndexOf("'"))
  if (quote >= 0) root = root.slice(quote + 1).trim()
  root = root.replace(/[\\/]+$/, '').trim()
  // npm 包形态：剥掉 node_modules\@deepseek-ai\dsh 尾巴，回到项目根（DSH_HOME）
  if (isNpm) root = normalizeNpmRoot(root)
  // 相对路径启动：marker 前只有 node.exe 等可执行文件 → 根目录用进程 cwd 补全
  if (/\.(exe|cmd|bat|ps1|com)$/i.test(root) || /^(?:node|nodejs|dsh)$/i.test(root)) root = ''
  if (!root && cwd) root = String(cwd || '').replace(/[\\/]+$/, '')
  // cwd 也可能指向 npm 包根（旧版启动器以包根为 dshDir 启动），同样归一化到项目根
  if (isNpm && root) root = normalizeNpmRoot(root)
  if (!root) return null
  let port = null
  const match = normalized.match(/--port[=\s]+(\d{1,5})\b/i)
  if (match) {
    const n = Number(match[1])
    if (Number.isSafeInteger(n) && n >= 1 && n <= 65535) port = n
  }
  const isNpx = isNpm && (root.toLowerCase().includes('\\_npx\\') || root.toLowerCase().includes('/_npx/'))
  return { root, port, mode: isNpx ? 'npx' : isNpm ? 'npm' : 'source' }
}

// 兼容旧 API：返回根目录数组
function rootsFromCommandLine(commandLine) {
  const parsed = instanceFromCommandLine(commandLine)
  return parsed ? [parsed.root] : []
}

// 在给定终端列表中按 DSH 目录判重（大小写不敏感；npm 包形态的包根与项目根视为同一 DSH）
function findRegisteredByDshDir(dshDir, terminals) {
  if (!dshDir || !Array.isArray(terminals)) return null
  const key = normalizeDshPath(normalizeNpmRoot(dshDir))
  return terminals.find(terminal => normalizeDshPath(normalizeNpmRoot(terminal.dshDir || '')) === key) || null
}

// 纯函数：避开已登记与已预留端口，返回第一个空闲端口；isPortFree 缺省视为全空闲
function firstFreePortAvoiding(registeredPorts = [], reservedPorts = [], isPortFree = () => true, start = 3080) {
  const taken = new Set()
  for (const p of [...registeredPorts, ...reservedPorts]) {
    const n = Number(p)
    if (Number.isSafeInteger(n) && n >= 1 && n <= 65535) taken.add(n)
  }
  for (let port = start; port <= 65535; port++) {
    if (!taken.has(port) && isPortFree(port)) return port
  }
  throw new Error('没有可用端口')
}

// 扫描本机 DSH：运行实例（优先）+ 常见位置 + 显式目录 + 官方 npx/全局安装位置，结果去重。
// 常见位置 = 用户主目录一级 + 每个磁盘根目录一级，逐个做「内容识别」（inspectDshDir）。
// 目录名不重要（源码形态惯例叫 deepseek-harness，npm 包形态可能叫任何名字，如 D:\2），
// 只要里面是 DSH 程序就算。运行时枚举盘符，不含任何个人路径字面量，白板/隐私不受影响。
// options.processEntries 可注入（[{pid,commandLine}]）。
async function scanDshInstallations(options = {}) {
  const explicit = Array.isArray(options.explicit) ? options.explicit : []
  const entries = Array.isArray(options.processEntries)
    ? options.processEntries
    : await processEntries()
  const common = []
  const scanDrives = options.scanDrives !== false
  // 枚举目录的一级子目录，返回「可能是 DSH 根」的候选（内容识别由 consider 统一做）
  const collectLevel1Dirs = (base) => {
    const out = []
    let names = []
    try { names = fs.readdirSync(base, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name) } catch { return out }
    for (const name of names) out.push(path.join(base, name))
    return out
  }
  // ★ 递归扫描（1.0.10 修复）：用户把 DSH 装在多级目录（如 D:\工具\环境\DSH）时
  //   旧逻辑只扫"用户主目录一级+每盘根一级"检测不到。现在从常见起点递归 2 层，
  //   配合内容识别（inspectDshDir）精确过滤，误扫成本可控（每级目录多读少量 package.json）。
  const collectDeepDirs = (base, depth) => {
    const out = []
    if (depth > 2) return out
    let entries = []
    try { entries = fs.readdirSync(base, { withFileTypes: true }) } catch { return out }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      // 跳过无关大目录（扫描性能 + 避免权限异常）
      if (['node_modules', '$RECYCLE.BIN', 'System Volume Information', 'Windows', 'Program Files', 'Program Files (x86)'].includes(e.name)) continue
      try {
        const full = path.join(base, e.name)
        // 命名的直接子目录先全部纳入（含深一层）
        out.push(full)
        const next = collectDeepDirs(full, depth + 1)
        for (const n of next) out.push(n)
      } catch { /* 单个访问失败跳过 */ }
    }
    return out
  }
  try {
    const home = os.homedir()
    // 用户主目录一级：任意名字的目录都可能装着 DSH（npm 包形态常见）
    if (scanDrives) for (const dir of collectLevel1Dirs(home)) common.push(dir)
    // 用户主目录再深两级（Documents/Desktop/Downloads 下常见）
    if (scanDrives && process.platform === 'win32') {
      for (const dir of ['Documents', 'Desktop', 'Downloads', 'dev', 'Dev', 'developer', 'code', 'Code']) {
        const full = path.join(home, dir)
        if (fs.existsSync(full)) for (const d of collectDeepDirs(full, 0)) common.push(d)
      }
    }
    // 每个磁盘根目录一级：任意名字（如 D:\2），内容识别后自动过滤非 DSH
    if (scanDrives) {
      for (let code = 65; code <= 90; code++) {
        const root = `${String.fromCharCode(code)}:\\`
        try {
          if (fs.existsSync(root)) {
            for (const dir of collectLevel1Dirs(root)) common.push(dir)
            // 每盘根再深两级（用户自选路径常见，如 D:\环境\DSH 或 D:\工具\代理\harness）
            for (const d of collectDeepDirs(root, 0)) common.push(d)
          }
        } catch { /* 盘符不可访问则跳过 */ }
      }
    }
  } catch { /* 常见位置枚举失败不阻断 */ }
  // 官方 npx/全局安装位置（不在主目录/盘符递归范围内，必须显式补扫）
  if (scanDrives) {
    for (const extra of extraScanRoots()) common.push(extra)
    // dsh 命令 / npm / pnpm 全局根：官方推荐 npx 方式，很多用户没有项目根目录
    for (const pkgRoot of findDshPackageRoots()) common.push(pkgRoot)
  }
  const running = []
  for (const entry of entries) {
    const parsed = instanceFromCommandLine(entry.commandLine || '', entry.cwd)
    if (parsed && parsed.root) {
      running.push({
        ...parsed,
        pid: entry.pid,
        // 命令行未带 --port 时，用进程实际监听端口（可能有多个，取最小的）
        port: parsed.port || (entry.ports && entry.ports.length ? Math.min(...entry.ports) : null),
      })
    }
  }
  const seen = new Set()
  const acceptedRoots = [] // 已接受的 DSH 根，用于排除同一 DSH 的深层子目录（如 apps\cli 误判）
  const results = []
  const consider = (dir, meta) => {
    const inspected = inspectDshDir(dir)
    if (!inspected) return
    const key = normalizeDshPath(inspected.dir)
    if (seen.has(key)) return
    // ★ 子目录跳过（1.0.12）：已识别 DSH 根的子目录（如 D:\deepseek-harness\apps\cli）是同一
    //   DSH 的深层目录（pnpm workspace 软链让 apps\cli\node_modules\@deepseek-ai\dsh 被误认成
    //   独立安装），绝不能接入成第二个终端（DSH_HOME/profile/端口互相打架）。
    //   浅目录先 to 入 acceptedRoots（运行实例/显式目录/深度浅的优先），子路径自动排除。
    if (acceptedRoots.some(root => key.startsWith(root + '\\') || key.startsWith(root + '/'))) return
    seen.add(key)
    acceptedRoots.push(key)
    results.push({ ...inspected, source: meta.source, port: meta.port || null, pid: meta.pid || null })
  }
  for (const item of running) consider(item.root, { source: 'running-process', port: item.port, pid: item.pid })
  // 显式目录最优先（用户明确指定），随后常见位置按深度排序（浅的先 accepted，深的子目录被排除）
  const sortedCommon = [...explicit, ...common].sort((a, b) => normalizeDshPath(a).length - normalizeDshPath(b).length)
  for (const dir of sortedCommon) consider(dir, { source: 'filesystem' })
  return results
}

module.exports = {
  normalizeDshPath,
  normalizeNpmRoot,
  inspectDshDir,
  parseProcessEntry,
  processEntries,
  instanceFromCommandLine,
  rootsFromCommandLine,
  findRegisteredByDshDir,
  firstFreePortAvoiding,
  scanDshInstallations,
  extraScanRoots,
  isDshHomeDir,
  findDshPackageRoots,
  findDshRootNear,
}
