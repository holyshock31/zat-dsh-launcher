'use strict'

const path = require('node:path')
const os = require('node:os')

const MANAGED_INSTALL_SOURCE_TYPES = new Set([
  'fresh-empty',
  'fresh-installed-empty',
  'fresh-installed',
  'cloned',
])

function normalizeNonEmpty(value) {
  const text = String(value || '').trim()
  return text ? path.resolve(text) : ''
}

function isSameOrInside(parent, child) {
  const base = normalizeNonEmpty(parent)
  const candidate = normalizeNonEmpty(child)
  if (!base || !candidate) return false
  const rel = path.relative(base, candidate)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

function pathsOverlap(a, b) {
  return isSameOrInside(a, b) || isSameOrInside(b, a)
}

function uniqueTopRoots(values) {
  const roots = [...new Set(values.map(normalizeNonEmpty).filter(Boolean))]
  return roots.filter(root => !roots.some(other => other !== root && isSameOrInside(other, root)))
}

// 安装文件归属与进程 ownership 是两件事：前者决定删除登记时能否碰安装目录，
// 后者只描述当前进程是否由启动器拉起。旧登记没有该字段时按来源保守推断。
function installationOwnership(terminal) {
  const explicit = String(terminal && terminal.installationOwnership || '')
  if (explicit === 'managed' || explicit === 'external') return explicit
  const sourceType = String(terminal && terminal.sourceType || 'manual')
  return MANAGED_INSTALL_SOURCE_TYPES.has(sourceType) ? 'managed' : 'external'
}

function planTerminalDeletion(terminal, others, userData) {
  const home = normalizeNonEmpty(terminal.dshHome)
  const dshDir = normalizeNonEmpty(terminal.dshDir)
  const sourceType = String(terminal && terminal.sourceType || '')
  const terminalsRoot = path.join(path.resolve(userData), 'terminals')
  const defaultHome = path.join(os.homedir(), '.dsh')
  const managedContainer = value => {
    if (!value || !isSameOrInside(terminalsRoot, value)) return ''
    const rel = path.relative(terminalsRoot, value)
    const first = rel.split(path.sep).filter(Boolean)[0]
    return first ? path.join(terminalsRoot, first) : ''
  }
  let roots = []

  // 手动选择、自动扫描、运行实例接入的 DSH 都不属于启动器。
  // 删除终端仅移除登记和启动器自身数据，绝不能递归删除源码仓库、npx 缓存或全局 npm prefix。
  if (installationOwnership(terminal) === 'external') {
    return { registrationOnly: true, roots: [], blocked: false, reason: 'external-install' }
  }

  if (sourceType === 'fresh-empty') {
    roots = [home]
  } else {
    // 删除范围 = 该终端独占的目录：
    //  - launcher 自建终端（fresh-installed/cloned）：整个 terminals/<id> 容器一起删
    //  - 手动/扫描接入：安装目录（dshDir）+ 非共享 home（~/.dsh 保留——可能被其他终端/DSH 使用）
    const candidates = []
    if (dshDir) candidates.push(dshDir)
    const homeNorm = normalizeNonEmpty(home)
    const defaultNorm = normalizeNonEmpty(defaultHome)
    if (homeNorm && homeNorm.toLowerCase() !== defaultNorm.toLowerCase() && homeNorm !== normalizeNonEmpty(dshDir)) candidates.push(home)
    const containers = candidates.map(managedContainer).filter(Boolean)
    if (containers.length) roots = uniqueTopRoots(containers)
    else roots = uniqueTopRoots(candidates)
  }

  const protectedPaths = [path.parse(userData).root, os.homedir(), path.resolve(userData)].map(normalizeNonEmpty)
  roots = roots.filter(root => root && !protectedPaths.some(protectedPath => root.toLowerCase() === protectedPath.toLowerCase()))

  const otherPaths = (others || []).flatMap(item => [normalizeNonEmpty(item.dshHome), normalizeNonEmpty(item.dshDir)]).filter(Boolean)
  const conflict = roots.find(root => otherPaths.some(other => pathsOverlap(root, other)))
  if (conflict) return { registrationOnly: false, roots: [], blocked: true, reason: 'shared-or-nested', conflict }
  return { registrationOnly: false, roots, blocked: false, reason: '' }
}

module.exports = { normalizeNonEmpty, isSameOrInside, pathsOverlap, installationOwnership, planTerminalDeletion }
