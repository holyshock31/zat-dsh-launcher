'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const os = require('node:os')
const { planTerminalDeletion, pathsOverlap } = require('../src/terminal-files')

const userData = path.resolve('C:\\Users\\tester\\AppData\\Roaming\\dsh-launcher')

test('manual/scanned terminal deletion removes its install dir but keeps shared default home', () => {
  const defaultHome = path.join(os.homedir(), '.dsh')
  const plan = planTerminalDeletion({ id: 'm', sourceType: 'manual', dshHome: defaultHome, dshDir: 'D:\\deepseek-harness' }, [], userData)
  assert.equal(plan.blocked, false)
  assert.deepEqual(plan.roots, [path.resolve('D:\\deepseek-harness')])
})

test('fresh-empty terminals in different 3 and 4 folders are independently deletable', () => {
  const terminal3 = { id: 't3', sourceType: 'fresh-empty', dshHome: 'C:\\Users\\tester\\Desktop\\3', dshDir: '' }
  const terminal4 = { id: 't4', sourceType: 'fresh-empty', dshHome: 'C:\\Users\\tester\\Desktop\\4', dshDir: '' }
  const plan = planTerminalDeletion(terminal3, [terminal4], userData)
  assert.equal(plan.blocked, false)
  assert.deepEqual(plan.roots, [path.resolve(terminal3.dshHome)])
})

test('migrated terminal id deletes its actual managed userData terminal root', () => {
  const terminal = {
    id: '.dsh-dev-web',
    sourceType: 'fresh-installed',
    dshHome: path.join(userData, 'terminals', 'terminal-3081-exp', 'dsh-home'),
    dshDir: path.join(userData, 'terminals', 'terminal-3081-exp', 'node_modules', '@deepseek-ai', 'dsh'),
  }
  const plan = planTerminalDeletion(terminal, [], userData)
  assert.equal(plan.blocked, false)
  assert.deepEqual(plan.roots, [path.join(userData, 'terminals', 'terminal-3081-exp')])
})

test('parent/child terminal paths block recursive file deletion', () => {
  const parent = { id: 'p', sourceType: 'fresh-empty', dshHome: 'C:\\Users\\tester\\Desktop\\terminals', dshDir: '' }
  const child = { id: 'c', sourceType: 'fresh-empty', dshHome: 'C:\\Users\\tester\\Desktop\\terminals\\child', dshDir: '' }
  const plan = planTerminalDeletion(parent, [child], userData)
  assert.equal(plan.blocked, true)
  assert.equal(pathsOverlap(parent.dshHome, child.dshHome), true)
})
