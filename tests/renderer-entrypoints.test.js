'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')

test('empty terminal view does not claim DSH is missing and keeps connection actions visible', () => {
  const html = fs.readFileSync(path.join(root, 'renderer', 'index.v2.html'), 'utf8')
  const renderer = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8')

  assert.match(html, /这个终端尚未接入 DSH/)
  assert.match(html, /id="empty-scan"/)
  assert.match(html, /id="empty-manual"/)
  assert.match(renderer, /els\.emptyScan\.hidden = false/)
  assert.match(renderer, /els\.emptyManual\.hidden = false/)
})

test('add terminal wizard always includes scan and manual connection actions', () => {
  const renderer = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8')

  assert.match(renderer, /data-action="scan"/)
  assert.match(renderer, /data-action="manual"/)
  assert.match(renderer, /\$\{fresh\}\$\{scan\}\$\{manual\}/)
})

test('auto-open is opt-in and configurable from the run controls', () => {
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8')
  const html = fs.readFileSync(path.join(root, 'renderer', 'index.v2.html'), 'utf8')
  const renderer = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8')

  assert.match(main, /settings: \{ autoRestart: true, autoOpen: false \}/)
  assert.match(html, /<input type="checkbox" id="switch-autoopen">/)
  assert.match(html, /启动后打开网页/)
  assert.match(renderer, /setSettings\(\{ autoOpen: els\.autoOpen\.checked \}\)/)
})
