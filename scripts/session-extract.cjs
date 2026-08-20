'use strict'

// 会话活动提取 worker：由启动器主进程 spawn「系统 node」执行。
// 原因：Electron 内置 Node 20 没有 zstd 支持（node:zlib.zstdDecompressSync 是 Node 22.5+），
// 而 DSH 会话是 zstd 逐帧压缩的 JSONL。系统 node（24+）具备 zstd，可完整解压提取。
// 用法：node session-extract.cjs <DSH_HOME> [limit]

const path = require('node:path')
const { readSessions } = require(path.join(__dirname, '..', 'src', 'session-activity.js'))

const home = process.argv[2] || ''
const limit = Number(process.argv[3] || 20)
try {
  const sessions = readSessions(home, limit)
  process.stdout.write(JSON.stringify({ ok: true, sessions, home }))
} catch (e) {
  process.stdout.write(JSON.stringify({ ok: false, sessions: [], home, message: String((e && e.message) || e) }))
}
