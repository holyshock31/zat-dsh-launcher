'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8')

test('window close hides the launcher instead of quitting it', () => {
  assert.match(main, /ipcMain\.on\('window:close', \(\) => hideMainWindow\(\)\)/)
  assert.match(main, /state\.win\.on\('close', \(e\) => \{[\s\S]*?e\.preventDefault\(\)[\s\S]*?hideMainWindow\(\)/)
})

test('startup fallback cannot reopen a window after its first show', () => {
  assert.match(main, /let initialWindowShown = false/)
  assert.match(main, /win\.once\('show', \(\) => \{ initialWindowShown = true \}\)/)
  assert.match(main, /if \(initialWindowShown \|\| win\.isDestroyed\(\)\) return/)
  assert.doesNotMatch(main, /!state\.win\.isVisible\(\)\) state\.win\.show\(\)/)
})

test('Windows avoids transparent BrowserWindow hide/show flicker', () => {
  assert.match(main, /const useTransparentWindow = process\.platform !== 'win32'/)
  assert.match(main, /roundedCorners: true/)
  assert.match(main, /transparent: useTransparentWindow/)
  assert.match(main, /backgroundColor: useTransparentWindow \? '#00000000' : '#edf2fb'/)
})

test('tray restores the window and provides an explicit exit action', () => {
  assert.match(main, /new Tray\(/)
  assert.match(main, /label: '打开主窗口', click: \(\) => showMainWindow\(\)/)
  assert.match(main, /label: '退出启动器', click: \(\) => requestQuit\(\)/)
  assert.match(main, /tray\.on\('click', \(\) => showMainWindow\(\)\)/)
})

test('restoring a hidden window does not focus it a second time', () => {
  const showMainWindow = main.slice(main.indexOf('function showMainWindow()'), main.indexOf('function hideMainWindow()'))
  assert.match(showMainWindow, /if \(!win\.isVisible\(\)\) \{[\s\S]*?win\.show\(\)[\s\S]*?return/)
  assert.match(showMainWindow, /if \(!win\.isFocused\(\)\) win\.focus\(\)/)
  assert.doesNotMatch(showMainWindow, /win\.show\(\)\s*win\.focus\(\)/)
})

test('explicit exit stops running terminals before allowing the window to close', () => {
  const stopIndex = main.indexOf('await stopAllTerminals()')
  const allowCloseIndex = main.indexOf('quitConfirmed = true', stopIndex)
  assert.ok(stopIndex >= 0)
  assert.ok(allowCloseIndex > stopIndex)
})
