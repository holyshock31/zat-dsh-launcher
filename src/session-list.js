'use strict'

// DSH Web 对话列表获取：直接调 DSH 自己的 HTTP API（POST /api/session.list），
// 拿到与 DSH 界面左侧标题栏完全一致的对话列表（sessionId + 权威标题）。
// 只读不写；失败返回 null，由调用方回退到会话文件提取的标题。

const http = require('node:http')

/**
 * 获取 DSH 的对话列表。
 * @param {number} port DSH Web 端口（如 3080）
 * @param {number} timeoutMs 超时（默认 2500ms，不阻塞轮询）
 * @returns {Promise<Array<{ sid, title, updatedAt, running, blank }>|null>} 失败返回 null
 */
function fetchSessionList(port, timeoutMs = 2500) {
  return new Promise(resolve => {
    const body = JSON.stringify({ type: 'client-request', rpcId: `launcher-${Date.now()}-${Math.floor(Math.random() * 1e6)}`, method: 'session.list', payload: {} })
    const req = http.request({
      host: '127.0.0.1',
      port: Number(port),
      path: '/api/session.list',
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      timeout: timeoutMs,
    }, res => {
      let data = ''
      res.on('data', chunk => { data += chunk.toString() })
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data)
          const value = parsed && parsed.result && parsed.result.value
          const items = value && Array.isArray(value.items) ? value.items : []
          const out = items.map(item => {
            const proj = item && item.projections && item.projections.values
            return {
              sid: String(item.sessionId || ''),
              title: String((proj && proj.title) || '').trim(),
              updatedAt: Number(item.updatedAt) || 0,
              running: !!item.running,
              blank: !!item.blank,
            }
          }).filter(item => item.sid)
          resolve(out)
        } catch { resolve(null) }
      })
    })
    req.on('timeout', () => { req.destroy(); resolve(null) })
    req.on('error', () => resolve(null))
    req.write(body)
    req.end()
  })
}

module.exports = { fetchSessionList }
