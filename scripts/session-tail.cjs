'use strict'

// 会话活动增量提取 worker：由启动器主进程定时 spawn「系统 node」执行（Electron 内置 Node 无 zstd）。
// 输入：一个或多个 DSH_HOME + --seen-file <json>（主进程游标：home|sid -> {seq,size,mtime}）。
// 输出：每个 home 下每个会话的新事件（seq 大于已见游标的事件）。
// 一轮一轮模型（与参考的多终端启动器一致）：
//  1. 会话文件 size+mtime 未变 → 直接跳过，不解压不输出。
//     进行中的一轮（会话在写入）持续记；一轮结束（文件不再变）自动停，零开销；
//     新的一轮（新会话/重启）重新开始记。
//  2. 只输出 seq 游标之后的事件，主进程无需保存全部 key（游标只有 3 个数字）。
// 覆盖全部有意义事件：完整对话消息（用户/助手）、工具调用、目标变更、预设选择等。

const fs = require('node:fs')
const path = require('node:path')
const { listSessionFiles, extractSession } = require(path.join(__dirname, '..', 'src', 'session-activity.js'))

const args = process.argv.slice(2)
let seenFile = null
const homes = []
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a.startsWith('--seen-file=')) seenFile = a.slice(12)
  else if (a === '--seen-file' && args[i + 1]) { seenFile = args[i + 1]; i++ }
  else homes.push(a)
}
let seen = {}
if (seenFile) {
  try {
    let raw = fs.readFileSync(seenFile, 'utf8')
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1) // 容错 UTF-8 BOM
    seen = JSON.parse(raw)
  } catch { seen = {} }
}

const out = {}
for (const home of homes) {
  out[home] = {}
  try {
    const files = listSessionFiles(home, 50)
    const aliveKeys = new Set()
    for (const f of files) {
      const key = `${home}|${f.sid}`
      aliveKeys.add(key)
      const rec = seen[key] || null
      // 文件未变且已有游标 → 这一轮没有新帧，跳过（不解压）
      if (rec && rec.size === f.fileSize && rec.mtime === f.fileMtime) continue
      // 增量解压：只解已处理字节之后的新帧（文件大时从数秒降到几毫秒）；
      // 首次（无游标）或文件被重建（offset 失效）时自动退回全量。
      const fromByte = rec ? (Number(rec.offset) || 0) : 0
      const ex = extractSession(f.file, fromByte)
      if (!ex) continue
      // 只输出游标之后的新事件
      const since = rec ? Number(rec.seq) || 0 : 0
      const events = (ex.events || []).filter(ev => ev && ev.summary && Number(ev.seq) > since)
      out[home][f.sid] = {
        count: ex.events ? ex.events.length : 0,
        events,
        title: ex.title || '', // 对话标题；空 = 尚未生成标题（DSH 首次对话后才出）
        createdAt: (ex.header && ex.header.createdAt) || f.fileMtime || 0,
        fileSize: f.fileSize,
        fileMtime: f.fileMtime,
        offset: f.fileSize, // 已处理到文件末尾
      }
    }
    // 会话文件已被删除（DSH 里删了对话）：seen 里有但这次扫描没有 → 通知主进程清理下拉
    for (const key of Object.keys(seen)) {
      const idx = key.indexOf('|')
      if (idx < 0 || key.slice(0, idx) !== home) continue
      if (!aliveKeys.has(key)) out[home][key.slice(idx + 1)] = { deleted: true }
    }
  } catch {
    out[home] = {}
  }
}
process.stdout.write(JSON.stringify(out))
