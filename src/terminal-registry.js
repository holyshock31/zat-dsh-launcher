'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

function normalizePath(value) {
  return path.resolve(String(value || '')).replace(/[\\/]+$/, '').toLowerCase()
}

function assertPathInside(root, target, label = '目标路径') {
  const base = normalizePath(root)
  const candidate = normalizePath(target)
  if (!base || !candidate || candidate === base || !candidate.startsWith(`${base}${path.sep}`)) {
    throw new Error(`${label}不在允许的终端目录内`)
  }
  return path.resolve(target)
}

function normalizeTerminal(input) {
  const now = Date.now()
  const port = Number(input.port)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('终端端口无效')
  const id = String(input.id || `terminal-${crypto.randomUUID()}`)
  return {
    id,
    name: String(input.name || `终端 ${port}`),
    port,
    dshDir: String(input.dshDir || ''),
    dshHome: String(input.dshHome || ''),
    profileName: String(input.profileName || 'web'),
    sourceType: String(input.sourceType || 'manual'),
    ownership: input.ownership === 'attached' ? 'attached' : 'managed',
    // 启动器最后一次 spawn 的 DSH 进程 PID；用于重启后识别「自己的 detached 终端」，避免误判为外部接入。
    managedPid: Number.isSafeInteger(Number(input.managedPid)) && Number(input.managedPid) > 0 ? Number(input.managedPid) : null,
    // 该终端累计运行时长（毫秒），独立显示"已运行时间" + 后续按使用时长保留日志
    activeMs: Number.isFinite(Number(input.activeMs)) && Number(input.activeMs) > 0 ? Number(input.activeMs) : 0,
    engine: {
      repository: 'https://github.com/mishibeikejie/zat-dsh-engine',
      installedVersion: input.engine && input.engine.installedVersion || null,
      state: input.engine && input.engine.state || 'unknown',
    },
    createdAt: Number(input.createdAt) || now,
    updatedAt: now,
  }
}

class TerminalRegistry {
  constructor(filePath) {
    this.filePath = filePath
    this.terminals = new Map()
    this.selectedTerminalId = ''
  }

  load() {
    let data = {}
    try {
      let text = fs.readFileSync(this.filePath, 'utf8')
      if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1) // 容忍 UTF-8 BOM
      data = JSON.parse(text)
    } catch { data = {} }
    this.terminals.clear()
    this.removedTerminalIds = new Set(Array.isArray(data.removedTerminalIds) ? data.removedTerminalIds.map(String) : [])
    for (const raw of Array.isArray(data.terminals) ? data.terminals : []) {
      try {
        const terminal = normalizeTerminal(raw)
        if (this.removedTerminalIds.has(terminal.id)) continue
        if (!this.hasPort(terminal.port) && !this.terminals.has(terminal.id)) this.terminals.set(terminal.id, terminal)
      } catch { /* skip invalid persisted terminal */ }
    }
    this.selectedTerminalId = this.terminals.has(data.selectedTerminalId)
      ? data.selectedTerminalId
      : (this.list()[0] && this.list()[0].id || '')
    return this.snapshot()
  }

  // 写前合并：先重读磁盘最新状态，把本实例内存中的改动合并回去，避免多实例互相覆盖。
  // 每个终端以"本实例内存里存在该 id 则用内存版，否则用磁盘版"为准；选中项以内存为准（谁最后切谁生效）。
  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    let disk = {}
    try {
      let text = fs.readFileSync(this.filePath, 'utf8')
      if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1) // 容忍 UTF-8 BOM
      disk = JSON.parse(text)
    } catch { disk = {} }
    const diskTerminals = new Map()
    for (const raw of Array.isArray(disk.terminals) ? disk.terminals : []) {
      try {
        const terminal = normalizeTerminal(raw)
        if (!diskTerminals.has(terminal.id) && !this.terminals.has(terminal.id)) diskTerminals.set(terminal.id, terminal)
      } catch { /* skip invalid */ }
    }
    // ★ 1.0.13：removedTerminalIds 必须与磁盘并集(全局墓碑)——否则另一实例(旧窗口残留)
    //   save 时把已删除的终端写回,删除"复活"。删除是全局全局的,墓碑只增不减。
    const removed = new Set([...new Set(this.removedTerminalIds || [])])
    if (Array.isArray(disk.removedTerminalIds)) for (const rid of disk.removedTerminalIds.map(String).filter(Boolean)) removed.add(rid)
    const candidates = [...diskTerminals.values(), ...this.list()].filter(t => !removed.has(String(t.id)))
    const byPort = new Map()
    for (const terminal of candidates) {
      const current = byPort.get(terminal.port)
      if (!current) { byPort.set(terminal.port, terminal); continue }
      // 同端口冲突时优先保留有真实 DSH 目录的记录，再取更新时间较新的记录。
      const currentScore = current.dshDir ? 2 : 0
      const nextScore = terminal.dshDir ? 2 : 0
      if (nextScore > currentScore || (nextScore === currentScore && terminal.updatedAt > current.updatedAt)) byPort.set(terminal.port, terminal)
    }
    const merged = [...byPort.values()].sort((a, b) => a.port - b.port)
    const snapshot = {
      version: 1,
      selectedTerminalId: this.selectedTerminalId || (disk.selectedTerminalId || ''),
      removedTerminalIds: [...removed],
      terminals: merged,
    }
    const tmp = `${this.filePath}.${process.pid}.tmp`
    fs.writeFileSync(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
    fs.renameSync(tmp, this.filePath)
  }

  snapshot() {
    return { version: 1, selectedTerminalId: this.selectedTerminalId, terminals: this.list() }
  }

  list() { return [...this.terminals.values()].sort((a, b) => a.port - b.port) }
  get(id) { return this.terminals.get(String(id)) }
  hasPort(port, exceptId = '') { return this.list().some(item => item.port === Number(port) && item.id !== exceptId) }

  add(input) {
    // 多实例/旧窗口可能持有过期内存；新增前强制读取最新磁盘状态，再做 ID/端口校验。
    if (fs.existsSync(this.filePath)) this.load()
    const terminal = normalizeTerminal(input)
    if (this.terminals.has(terminal.id)) throw new Error('终端 ID 已存在')
    if (this.hasPort(terminal.port)) throw new Error(`端口 ${terminal.port} 已被其他终端登记`)
    this.removedTerminalIds = this.removedTerminalIds || new Set()
    this.removedTerminalIds.delete(terminal.id)
    this.terminals.set(terminal.id, terminal)
    if (!this.selectedTerminalId) this.selectedTerminalId = terminal.id
    this.save()
    return terminal
  }

  update(id, patch) {
    const current = this.get(id)
    if (!current) throw new Error('终端不存在')
    const next = normalizeTerminal({ ...current, ...patch, id: current.id, createdAt: current.createdAt, engine: patch.engine || current.engine })
    if (this.hasPort(next.port, current.id)) throw new Error(`端口 ${next.port} 已被其他终端登记`)
    this.terminals.set(current.id, next)
    this.save()
    return next
  }

  remove(id) {
    const key = String(id)
    const existed = this.terminals.delete(key)
    if (!existed) return false
    this.removedTerminalIds = this.removedTerminalIds || new Set()
    this.removedTerminalIds.add(key)
    if (this.selectedTerminalId === id) this.selectedTerminalId = this.list()[0] && this.list()[0].id || ''
    this.save()
    return true
  }

  select(id) {
    if (!this.terminals.has(String(id))) throw new Error('终端不存在')
    this.selectedTerminalId = String(id)
    this.save()
    return this.get(id)
  }

  allocatePort(isUnavailable, start = 3080) {
    const registered = new Set(this.list().map(item => item.port))
    for (let port = start; port <= 65535; port++) {
      if (!registered.has(port) && !isUnavailable(port)) return port
    }
    throw new Error('没有可用端口')
  }
}

module.exports = { TerminalRegistry, normalizeTerminal, assertPathInside, normalizePath }
