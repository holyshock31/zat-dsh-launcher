'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')

const {
  findNodeExe,
  mergePath,
  listPortPids,
  killPidTree,
  nodeDistributionSpec,
} = require('../src/platform-runtime')

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`))
}

function waitForLine(stream, expected, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let pending = ''
    const timer = setTimeout(() => reject(new Error(`等待输出超时：${expected}`)), timeoutMs)
    stream.on('data', chunk => {
      pending += String(chunk)
      if (pending.includes(expected)) {
        clearTimeout(timer)
        resolve()
      }
    })
    stream.on('error', reject)
  })
}

test('Finder 精简 PATH 下仍能发现用户目录中的合格 Node', () => {
  const home = tmp('zat-mac-node')
  const node = path.join(home, '.hermes', 'node', 'bin', 'node')
  fs.mkdirSync(path.dirname(node), { recursive: true })
  fs.writeFileSync(node, '#!/bin/sh\nprintf "v22.23.0\\n"\n', 'utf8')
  fs.chmodSync(node, 0o755)
  try {
    const found = findNodeExe({
      platform: 'darwin',
      homedir: home,
      env: { HOME: home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
      useLoginShell: false,
    })
    assert.equal(found, node)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('macOS 工具链 PATH 使用冒号且去重', () => {
  assert.equal(mergePath(['/opt/homebrew/bin', '/usr/local/bin'], '/usr/bin:/bin:/opt/homebrew/bin', ':'), '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin')
})

test('Node 下载规格按 macOS 与 CPU 架构选择，不会落到 win-x64', () => {
  const spec = nodeDistributionSpec('v22.19.0', 'darwin', 'arm64')
  assert.equal(spec.folder, 'node-v22.19.0-darwin-arm64')
  assert.equal(spec.archiveName, 'node-v22.19.0-darwin-arm64.tar.gz')
  assert.equal(spec.nodeRelativePath, path.join('bin', 'node'))
})

test('macOS 能识别监听端口 PID 并停止启动器管理的进程', { skip: process.platform !== 'darwin' }, async () => {
  const child = spawn(process.execPath, ['-e', [
    'const net=require("node:net")',
    'const s=net.createServer()',
    's.listen(0,"127.0.0.1",()=>console.log("READY:"+s.address().port))',
    'setInterval(()=>{},1000)',
  ].join(';')], { stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  let output = ''
  child.stdout.on('data', chunk => { output += String(chunk) })
  try {
    await waitForLine(child.stdout, 'READY:')
    const match = output.match(/READY:(\d+)/)
    assert.ok(match)
    const port = Number(match[1])
    const pids = await listPortPids(port)
    assert.ok(pids.includes(child.pid), `端口 ${port} 应包含 PID ${child.pid}，实际 ${pids.join(',')}`)
    assert.equal(await killPidTree(child.pid), true)
  } finally {
    try { process.kill(child.pid, 'SIGKILL') } catch { /* 已停止 */ }
  }
})
