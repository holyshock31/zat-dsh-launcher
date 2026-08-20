'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { readActivity } = require('../src/terminal-activity')

function tmpDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `zat-act-${label}-`))
}

test('readActivity parses session projections with stats', () => {
  const dir = tmpDir('proj')
  try {
    const home = path.join(dir, 'home')
    fs.mkdirSync(path.join(home, 'storages'), { recursive: true })
    fs.writeFileSync(path.join(home, 'storages', 'session_projcache.json'), JSON.stringify({
      tables: {
        sessions: {
          'session-a': {
            identity: { createdAt: 1000, cwd: 'C:\\work' },
            rows: { sessionStats: { val: { turns: 3, steps: 40, llmMs: 5000, decodeTokens: 1200, openStep: 'null' } } },
          },
          'session-b': {
            identity: { createdAt: 2000, cwd: 'C:\\work2' },
            rows: { sessionStats: { val: { turns: 7, steps: 90, llmMs: 8000, decodeTokens: 3000, openStep: '{"turn":1}' } } },
          },
        },
      },
    }, null, 2))
    const r = readActivity(home)
    assert.equal(r.ok, true)
    assert.equal(r.summary.count, 2)
    assert.equal(r.summary.turns, 10)
    assert.equal(r.summary.steps, 130)
    assert.equal(r.summary.tokens, 4200)
    // 按时间倒序
    assert.equal(r.sessions[0].id, 'session-b')
    assert.equal(r.sessions[0].active, true)
    assert.equal(r.sessions[1].id, 'session-a')
    assert.equal(r.sessions[1].active, false)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('readActivity reports empty history for fresh home and tolerates missing projection', () => {
  const dir = tmpDir('empty')
  try {
    const home = path.join(dir, 'fresh')
    fs.mkdirSync(home, { recursive: true })
    const r = readActivity(home)
    assert.equal(r.ok, true)
    assert.equal(r.summary.count, 0)
    assert.equal(r.summary.files, 0)
    // 有 sessions 目录但无投影缓存：只统计文件
    fs.mkdirSync(path.join(home, 'sessions', 's1'), { recursive: true })
    fs.writeFileSync(path.join(home, 'sessions', 's1', 'session.jsonl'), 'x')
    const r2 = readActivity(home)
    assert.equal(r2.summary.count, 0)
    assert.equal(r2.summary.files, 1)
    assert.equal(r2.summary.bytes, 1)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
