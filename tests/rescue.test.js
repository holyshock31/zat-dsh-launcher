'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createRescueSnapshot, rescueStatus, restoreRescueSnapshot, listBundles, diagnoseCrash, excludePlugin, recordCrash, markCrashRecovered } = require('../src/rescue')

function tmp(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `zat-rescue-${label}-`))
}

test('create + restore rescue snapshot round-trips profile files', () => {
  const dir = tmp('rt')
  try {
    const profile = path.join(dir, 'profiles', 'web')
    const rescue = path.join(dir, 'rescue')
    fs.mkdirSync(profile, { recursive: true })
    fs.writeFileSync(path.join(profile, 'cordis.yml'), '[]\n')
    fs.writeFileSync(path.join(profile, 'package.json'), '{"dsh":{"profile":{"bundles":["a","b"]}}}\n')
    const created = createRescueSnapshot(profile, rescue, 12345)
    assert.equal(created.ok, true)
    assert.deepEqual(created.files.sort(), ['cordis.yml', 'package.json'])
    fs.writeFileSync(path.join(profile, 'cordis.yml'), 'broken: [\n')
    const restored = restoreRescueSnapshot(profile, rescue)
    assert.equal(restored.ok, true)
    assert.equal(fs.readFileSync(path.join(profile, 'cordis.yml'), 'utf8'), '[]\n')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('rescueStatus reports missing snapshot', () => {
  const dir = tmp('st')
  try {
    assert.deepEqual(rescueStatus(path.join(dir, 'nope')), { exists: false, at: 0, files: [], lastCrash: null })
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('last crash record survives recovery marking', () => {
  const dir = tmp('crash')
  try {
    const record = recordCrash(dir, { exitCode: 1, issues: [{ type: 'missing-bundle', plugin: 'bad-plugin' }], logTail: ['cannot resolve profile bundle "bad-plugin"'] })
    assert.equal(record.recoveredAt, 0)
    assert.equal(rescueStatus(dir).lastCrash.issues[0].plugin, 'bad-plugin')
    const recovered = markCrashRecovered(dir, 20000)
    assert.equal(recovered.recoveredAt, 20000)
    assert.equal(rescueStatus(dir).lastCrash.issues[0].plugin, 'bad-plugin')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('excludePlugin removes whole insert block referencing missing package (#880 pattern)', () => {
  const dir = tmp('ex880')
  try {
    const profile = path.join(dir, 'profiles', 'web')
    fs.mkdirSync(profile, { recursive: true })
    fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'zat-dsh-engine'] } } }, null, 2))
    fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), [
      '# 用户 patch 层',
      '- insert:',
      '    - id: ui-dsh-aionui-panel',
      "      name: '@deepseek-ai/dsh-client-ui-aionui-panel'",
      '      config:',
      '        mirror: https://gh-proxy.com/',
      '- insert:',
      '    - id: plugin-market',
      '      name: zat-dsh-engine',
      '      config:',
      '        mirror: https://gh-proxy.com/',
    ].join('\n') + '\n')
    const r = excludePlugin(profile, '@deepseek-ai/dsh-client-ui-aionui-panel')
    assert.equal(r.ok, true)
    const patch = fs.readFileSync(path.join(profile, 'cordis.patch.yml'), 'utf8')
    assert.ok(!patch.includes('aionui'), '坏条目块应被整体删除')
    assert.ok(patch.includes('plugin-market'), '同文件其它 insert 条目必须保留')
    assert.ok(patch.includes('zat-dsh-engine'), '其它插件引用必须保留')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('excludePlugin appends [] when removal leaves comment-only patch file', () => {
  const dir = tmp('excmt')
  try {
    const profile = path.join(dir, 'profiles', 'web')
    fs.mkdirSync(profile, { recursive: true })
    fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }, null, 2))
    fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), [
      '# 用户 patch 层',
      '- insert:',
      '    - id: ui-dsh-aionui-panel',
      "      name: '@deepseek-ai/dsh-client-ui-aionui-panel'",
    ].join('\n') + '\n')
    const r = excludePlugin(profile, '@deepseek-ai/dsh-client-ui-aionui-panel')
    assert.equal(r.ok, true)
    const patch = fs.readFileSync(path.join(profile, 'cordis.patch.yml'), 'utf8')
    assert.ok(!patch.includes('aionui'))
    // DSH 的 parsePatchList 要求顶层是 YAML 数组：只剩注释时必须补 []
    assert.ok(/^\s*\[\s*\]\s*$/m.test(patch), `patch 必须以合法空数组结尾: ${JSON.stringify(patch)}`)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('diagnoseCrash finds missing bundle / failed plugin / bad profile', () => {
  const logs = [
    'Error: dsh: cannot resolve profile bundle "bad-plugin" from the dsh installation',
    'Error: dsh: plugin(s) failed to load: plugin-a, plugin-b; Cordis startup failed',
    'Error: dsh: failed to parse patches C:/x/cordis.patch.yml: ...',
  ]
  const r = diagnoseCrash(logs)
  const keys = r.issues.map(i => `${i.type}:${i.plugin}`)
  assert.ok(keys.includes('missing-bundle:bad-plugin'))
  assert.ok(keys.includes('plugin-failed:plugin-a'))
  assert.ok(keys.includes('plugin-failed:plugin-b'))
  assert.ok(keys.includes('bad-profile:'))
  assert.equal(r.issues.find(i => i.type === 'bad-profile').fix, 'restore')
  assert.equal(r.issues.find(i => i.type === 'missing-bundle').fix, 'exclude-bundle')
})

// 0.6.22 回归：npm 预构建包 rc.7 不认 --no-open 导致的启动失败，
// 救援一键检测必须能识别（用户反馈：装好后启动失败 3 次，救援却说"没事"）。
test('diagnoseCrash detects unknown CLI option (rc.7 --no-open regression)', () => {
  const logs = [
    'error: unknown option \'--no-open\'',
    'error: unknown option "--port"',
  ]
  const r = diagnoseCrash(logs)
  const cliIssues = r.issues.filter(i => i.type === 'cli-arg')
  assert.equal(cliIssues.length, 1, `应识别出 cli-arg 问题: ${JSON.stringify(r.issues)}`)
  assert.equal(cliIssues[0].fix, 'restart')
  assert.ok(cliIssues[0].message.includes('--no-open'))
})

test('excludePlugin removes only the bad bundle, keeps others and node_modules', () => {
  const dir = tmp('ex')
  try {
    const profile = path.join(dir, 'profiles', 'web')
    fs.mkdirSync(path.join(profile, 'node_modules', 'bad-plugin'), { recursive: true })
    fs.mkdirSync(path.join(profile, 'node_modules', 'good-plugin'), { recursive: true })
    fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'bad-plugin', 'good-plugin'] } } }, null, 2))
    const r = excludePlugin(profile, 'bad-plugin')
    assert.equal(r.ok, true)
    assert.deepEqual(r.bundles, ['@deepseek-ai/dsh-base', 'good-plugin'])
    assert.ok(fs.existsSync(path.join(profile, 'node_modules', 'good-plugin')))
    assert.ok(fs.existsSync(path.join(profile, 'node_modules', 'bad-plugin')))
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('listBundles returns empty for missing profile', () => {
  const dir = tmp('lb')
  try { assert.deepEqual(listBundles(path.join(dir, 'nope')), []) } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
