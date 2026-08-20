'use strict'

function parseNetstatListeningPids(output, targetPort) {
  const port = Number(targetPort)
  const pids = new Set()
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) return []
  for (const raw of String(output || '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || !/\bLISTENING\b/i.test(line)) continue
    const columns = line.split(/\s+/)
    if (columns.length < 5) continue
    const localAddress = columns[1]
    const pid = Number(columns[columns.length - 1])
    const match = localAddress.match(/:(\d+)$/)
    if (!match || Number(match[1]) !== port || !Number.isSafeInteger(pid) || pid <= 0) continue
    pids.add(pid)
  }
  return [...pids]
}

module.exports = { parseNetstatListeningPids }
