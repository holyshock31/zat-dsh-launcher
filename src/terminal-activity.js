'use strict'

const fs = require('node:fs')
const path = require('node:path')

/* 终端活动历史：读取当前终端 DSH_HOME 下的会话投影缓存 + sessions 目录，
 * 展示这个终端"曾经发生过什么"（会话数/轮数/步骤/token/时间），每终端独立，只读不写。 */

function walkFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walkFiles(full, out)
    else if (entry.isFile()) out.push({ path: full, size: fs.statSync(full).size })
  }
  return out
}

// ---- 启动器自有的终端活动日志（每个终端独立，userData/activity/<terminalId>.jsonl）----

function activityFileFor(userData, terminalId) {
  return path.join(userData, 'activity', `${terminalId}.jsonl`)
}

// 追加一条活动记录：{ at, summary, detail }
function appendActivity(userData, terminalId, entry) {
  const file = activityFileFor(userData, terminalId)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, `${JSON.stringify({ at: Date.now(), ...entry })}\n`, 'utf8')
}

// 读取最近 limit 条活动（旧→新）
function readActivities(userData, terminalId, limit = 300) {
  const file = activityFileFor(userData, terminalId)
  if (!fs.existsSync(file)) return []
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).slice(-limit).map(line => {
      try { return JSON.parse(line) } catch { return null }
    }).filter(Boolean)
  } catch { return [] }
}

// 读一个终端的活动历史。home = 该终端的 DSH_HOME（独立，绝不跨终端）。
function readActivity(home) {
  const projFile = path.join(home, 'storages', 'session_projcache.json')
  const sessionsDir = path.join(home, 'sessions')
  const sessions = []
  let totalTurns = 0
  let totalSteps = 0
  let totalTokens = 0
  if (fs.existsSync(projFile)) {
    try {
      const j = JSON.parse(fs.readFileSync(projFile, 'utf8'))
      const table = (j && j.tables && j.tables.sessions) || {}
      for (const [sid, v] of Object.entries(table)) {
        const stats = (v && v.rows && v.rows.sessionStats && v.rows.sessionStats.val) || {}
        const turns = Number(stats.turns) || 0
        const steps = Number(stats.steps) || 0
        const tokens = Number(stats.decodeTokens) || 0
        totalTurns += turns
        totalSteps += steps
        totalTokens += tokens
        const openRaw = stats.openStep
        const active = !!(openRaw && openRaw !== 'null' && openRaw !== '{}')
        sessions.push({
          id: sid,
          createdAt: (v && v.identity && v.identity.createdAt) || 0,
          cwd: (v && v.identity && v.identity.cwd) || '',
          turns,
          steps,
          tokens,
          llmMs: Number(stats.llmMs) || 0,
          active,
        })
      }
    } catch { /* 投影缓存损坏时忽略，仍返回 sessions 目录统计 */ }
  }
  sessions.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
  let files = 0
  let bytes = 0
  if (fs.existsSync(sessionsDir)) {
    try {
      for (const f of walkFiles(sessionsDir)) { files += 1; bytes += f.size }
    } catch { /* 忽略 */ }
  }
  return {
    ok: true,
    home,
    sessions,
    summary: { count: sessions.length, turns: totalTurns, steps: totalSteps, tokens: totalTokens, files, bytes },
  }
}

module.exports = { readActivity, activityFileFor, appendActivity, readActivities }
