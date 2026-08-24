'use strict'

/**
 * 生成 assets/icon.png（512×512，无第三方依赖）。
 *
 * 用纯 Node 手写 PNG 编码器 + 4× 超采样绘制：
 *  - 浅蓝渐变圆角底（DeepSeek 品牌蓝）
 *  - 白色鲸鱼剪影：官方 DeepSeek logo（assets/deepseek-whale.svg 的 path，
 *    Simple Icons 收录的官方剪影），SVG path 解析 + 扫描线填充栅格化
 *  - 白色几何粗体「ZAT」
 *
 * 用途：窗口标题栏图标 / 界面左上角 logo / 打包 exe 的图标。
 *
 * 用法：node scripts/make-icon.js
 */

const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

// electron-builder 的 macOS 图标输入最低为 512×512；窗口图标会由 Electron 自动缩放。
const SIZE = 512
const SS = 4
const GRID = SIZE * SS

// ---------------------------------------------------------------------------
// PNG 编码（RGBA8）
// ---------------------------------------------------------------------------
function crc32(buf) {
  let c
  let table = crc32.table
  if (!table) {
    table = crc32.table = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      c = n
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
      }
      table[n] = c
    }
  }
  c = 0xFFFFFFFF
  for (let i = 0; i < buf.length; i++) {
    c = table[(c ^ buf[i]) & 0xFF] ^ (c >>> 8)
  }
  return (c ^ 0xFFFFFFFF) >>> 0
}

function pngChunk(type, data) {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 4 + 1)
    raw[rowStart] = 0 // filter: None
    rgba.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4)
  }

  const idat = zlib.deflateSync(raw, { level: 9 })
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

// ---------------------------------------------------------------------------
// 绘图基础
// ---------------------------------------------------------------------------
function mixColor(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ]
}

const BLUE_DEEP = [0x4D, 0x6B, 0xFE]
const BLUE_LIGHT = [0x7E, 0xA6, 0xFF]

function insideRoundRect(x, y) {
  const min = 0.035
  const max = 0.965
  const r = 0.205
  if (x < min || x > max || y < min || y > max) return false
  const cx = Math.max(min + r, Math.min(x, max - r))
  const cy = Math.max(min + r, Math.min(y, max - r))
  const dx = x - cx
  const dy = y - cy
  return dx * dx + dy * dy <= r * r
}

// ---------------------------------------------------------------------------
// 官方 DeepSeek 鲸鱼剪影：SVG path 解析 + 扫描线栅格化
// ---------------------------------------------------------------------------
const WHALE_SVG = path.join(__dirname, '..', 'assets', 'deepseek-whale.svg')
const WHALE_PATH = (() => {
  try {
    const svg = fs.readFileSync(WHALE_SVG, 'utf8')
    const m = svg.match(/<path d="([^"]+)"/)
    if (!m) throw new Error('no path in svg')
    return m[1]
  } catch {
    return ''
  }
})()

// path → 闭合子路径数组（每段为 [x,y] 点列，曲线已平坦化）
function parsePath(d) {
  const out = []
  const re = /([MmLlHhVvCcSsQqTtAaZz])|(-?\d*\.?\d+(?:e[-+]?\d+)?)/g
  const cmds = []
  let cur = null
  let m
  while ((m = re.exec(d))) {
    if (m[1]) {
      cur = m[1]
      cmds.push({ cmd: m[1], args: [] })
    } else if (cur) {
      cmds[cmds.length - 1].args.push(parseFloat(m[2]))
    }
  }

  const TOL = 0.02
  function cubicToPoly(p0, p1, p2, p3) {
    const pts = []
    const stack = [[p0, p1, p2, p3]]
    while (stack.length) {
      const [a, b, c, dd] = stack.pop()
      const flat =
        Math.abs(a[0] - 2 * b[0] + c[0]) + Math.abs(a[1] - 2 * b[1] + c[1]) +
        Math.abs(b[0] - 2 * c[0] + dd[0]) + Math.abs(b[1] - 2 * c[1] + dd[1])
      if (flat < TOL) {
        pts.push(dd)
        continue
      }
      const ab = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
      const bc = [(b[0] + c[0]) / 2, (b[1] + c[1]) / 2]
      const cd = [(c[0] + dd[0]) / 2, (c[1] + dd[1]) / 2]
      const abc = [(ab[0] + bc[0]) / 2, (ab[1] + bc[1]) / 2]
      const bcd = [(bc[0] + cd[0]) / 2, (bc[1] + cd[1]) / 2]
      const abcd = [(abc[0] + bcd[0]) / 2, (abc[1] + bcd[1]) / 2]
      stack.push([abcd, bcd, cd, dd], [a, ab, abc, abcd])
    }
    return pts
  }

  const polys = []
  let pos = [0, 0]
  let start = [0, 0]
  let pen = [0, 0]
  let ctrl = null
  let ctrl2 = null
  let poly = null
  const abs = (a, rel) => (rel ? [pos[0] + a[0], pos[1] + a[1]] : [a[0], a[1]])
  const closePoly = () => {
    if (poly && poly.length) polys.push(poly)
    poly = null
  }

  for (const { cmd, args } of cmds) {
    let i = 0
    const c = cmd.toUpperCase()
    const rel = cmd !== c
    if (c === 'M') {
      closePoly()
      const p = abs(args.slice(i, i + 2), rel)
      i += 2
      pos = p
      start = p
      pen = p
      poly = [p]
      while (i + 1 < args.length) {
        const p2 = abs(args.slice(i, i + 2), rel)
        i += 2
        poly.push(p2)
        pos = p2
      }
    } else if (c === 'L') {
      while (i + 1 < args.length) {
        const p = abs(args.slice(i, i + 2), rel)
        i += 2
        poly.push(p)
        pos = p
      }
    } else if (c === 'H') {
      const x = rel ? pos[0] + args[i++] : args[i++]
      const p = [x, pos[1]]
      poly.push(p)
      pos = p
    } else if (c === 'V') {
      const y = rel ? pos[1] + args[i++] : args[i++]
      const p = [pos[0], y]
      poly.push(p)
      pos = p
    } else if (c === 'C') {
      while (i + 5 < args.length) {
        const p1 = abs(args.slice(i, i + 2), rel)
        const p2 = abs(args.slice(i + 2, i + 4), rel)
        const p = abs(args.slice(i + 4, i + 6), rel)
        i += 6
        for (const pt of cubicToPoly(pos, p1, p2, p)) poly.push(pt)
        pos = p
        ctrl = p2
        ctrl2 = null
      }
    } else if (c === 'S') {
      while (i + 3 < args.length) {
        const p2 = abs(args.slice(i, i + 2), rel)
        const p = abs(args.slice(i + 2, i + 4), rel)
        i += 4
        const p1 = ctrl2 ? [2 * pos[0] - ctrl2[0], 2 * pos[1] - ctrl2[1]] : pos
        for (const pt of cubicToPoly(pos, p1, p2, p)) poly.push(pt)
        pos = p
        ctrl2 = p2
      }
    } else if (c === 'Q') {
      while (i + 3 < args.length) {
        const p1 = abs(args.slice(i, i + 2), rel)
        const p = abs(args.slice(i + 2, i + 4), rel)
        i += 4
        const c1 = [pos[0] + (2 / 3) * (p1[0] - pos[0]), pos[1] + (2 / 3) * (p1[1] - pos[1])]
        const c2 = [p[0] + (2 / 3) * (p1[0] - p[0]), p[1] + (2 / 3) * (p1[1] - p[1])]
        for (const pt of cubicToPoly(pos, c1, c2, p)) poly.push(pt)
        pos = p
        ctrl = p1
        ctrl2 = null
      }
    } else if (c === 'T') {
      while (i + 1 < args.length) {
        const p = abs(args.slice(i, i + 2), rel)
        i += 2
        const p1 = ctrl ? [2 * pos[0] - ctrl[0], 2 * pos[1] - ctrl[1]] : pos
        const c1 = [pos[0] + (2 / 3) * (p1[0] - pos[0]), pos[1] + (2 / 3) * (p1[1] - pos[1])]
        const c2 = [p[0] + (2 / 3) * (p1[0] - p[0]), p[1] + (2 / 3) * (p1[1] - p[1])]
        for (const pt of cubicToPoly(pos, c1, c2, p)) poly.push(pt)
        pos = p
        ctrl = p1
      }
    } else if (c === 'A') {
      while (i + 6 < args.length) {
        const rx = args[i++]
        const ry = args[i++]
        const rot = args[i++]
        const laf = args[i++]
        const sf = args[i++]
        const p = abs(args.slice(i, i + 2), rel)
        i += 2
        // arc → cubic 近似
        const x1 = pos[0]
        const y1 = pos[1]
        const x2 = p[0]
        const y2 = p[1]
        let rxx = Math.abs(rx)
        let ryy = Math.abs(ry)
        if (rxx === 0 || ryy === 0 || (x1 === x2 && y1 === y2)) {
          poly.push(p)
          pos = p
          continue
        }
        const phi = (rot * Math.PI) / 180
        const cos = Math.cos(phi)
        const sin = Math.sin(phi)
        const dx = (x1 - x2) / 2
        const dy = (y1 - y2) / 2
        const x1p = cos * dx + sin * dy
        const y1p = -sin * dx + cos * dy
        const lambda = (x1p * x1p) / (rxx * rxx) + (y1p * y1p) / (ryy * ryy)
        if (lambda > 1) {
          rxx *= Math.sqrt(lambda)
          ryy *= Math.sqrt(lambda)
        }
        const num = rxx * rxx * ryy * ryy - rxx * rxx * y1p * y1p - ryy * ryy * x1p * x1p
        const den = rxx * rxx * y1p * y1p + ryy * ryy * x1p * x1p
        let rad = den ? Math.sqrt(Math.max(0, num / den)) : 0
        if (laf === sf) rad = -rad
        const cxp = (rad * rxx * y1p) / ryy
        const cyp = (-rad * ryy * x1p) / rxx
        const cx = cos * cxp - sin * cyp + (x1 + x2) / 2
        const cy = sin * cxp + cos * cyp + (y1 + y2) / 2
        const th1 = Math.atan2((y1p - cyp) / ryy, (x1p - cxp) / rxx)
        const th2 = Math.atan2((-y1p - cyp) / ryy, (-x1p - cxp) / rxx)
        let dth = th2 - th1
        if (!sf && dth > 0) dth -= 2 * Math.PI
        else if (sf && dth < 0) dth += 2 * Math.PI
        const segs = Math.max(2, Math.ceil(Math.abs(dth) / (Math.PI / 2)))
        for (let k = 0; k < segs; k++) {
          const a1 = th1 + (dth * k) / segs
          const a2 = th1 + (dth * (k + 1)) / segs
          const alpha = (4 / 3) * Math.tan((a2 - a1) / 4)
          const p0k = [cx + rxx * Math.cos(a1), cy + ryy * Math.sin(a1)]
          const p3k = [cx + rxx * Math.cos(a2), cy + ryy * Math.sin(a2)]
          const p1k = [p0k[0] - alpha * rxx * Math.sin(a1), p0k[1] + alpha * ryy * Math.cos(a1)]
          const p2k = [p3k[0] + alpha * rxx * Math.sin(a2), p3k[1] - alpha * ryy * Math.cos(a2)]
          for (const pt of cubicToPoly(p0k, p1k, p2k, p3k)) poly.push(pt)
        }
        pos = p
      }
    } else if (c === 'Z') {
      closePoly()
      pos = start
    }
  }
  closePoly()
  return polys
}

// 鲸鱼在图标中的放置区域（保持 24:17.66 原比例，居中偏上）
const WHALE_X0 = 0.106
const WHALE_X1 = 0.894
const WHALE_Y0 = 0.10
const WHALE_Y1 = 0.68

// 扫描线（even-odd）填充生成鲸鱼 mask（M×M，1=在鲸鱼内）
function buildWhaleMask(M) {
  const mask = new Uint8Array(M * M)
  const polys = WHALE_PATH ? parsePath(WHALE_PATH) : []
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of polys) {
    for (const [x, y] of p) {
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  const vw = maxX - minX || 1
  const vh = maxY - minY || 1
  for (let my = 0; my < M; my++) {
    // viewBox y 对应 mask 行中心
    const vY = minY + ((my + 0.5) / M) * vh
    // 交点收集（viewBox 坐标，带方向：上跨 +1 / 下跨 -1）
    const xs = []
    for (const p of polys) {
      const n = p.length
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const y1 = p[j][1]
        const y2 = p[i][1]
        if ((y1 <= vY && y2 > vY) || (y2 <= vY && y1 > vY)) {
          const t = (vY - y1) / (y2 - y1)
          xs.push([p[j][0] + t * (p[i][0] - p[j][0]), y2 > y1 ? 1 : -1])
        }
      }
    }
    xs.sort((a, b) => a[0] - b[0])
    // nonzero 绕数填充
    let wn = 0
    let startX = null
    for (const [x, dir] of xs) {
      const before = wn
      wn += dir
      if (before === 0 && wn !== 0) startX = x
      else if (before !== 0 && wn === 0 && startX !== null) {
        const toMx = v => Math.round(((v - minX) / vw) * (M - 1))
        const xa = Math.max(0, toMx(startX))
        const xb = Math.min(M - 1, toMx(x))
        for (let mx = xa; mx <= xb; mx++) mask[my * M + mx] = 1
        startX = null
      }
    }
  }
  return { mask, M }
}

const WHALE_MASK = buildWhaleMask(1024)

function isWhale(x, y) {
  if (x < WHALE_X0 || x > WHALE_X1 || y < WHALE_Y0 || y > WHALE_Y1) return false
  const M = WHALE_MASK.M
  const mx = Math.min(M - 1, Math.max(0, Math.round(((x - WHALE_X0) / (WHALE_X1 - WHALE_X0)) * (M - 1))))
  const my = Math.min(M - 1, Math.max(0, Math.round(((y - WHALE_Y0) / (WHALE_Y1 - WHALE_Y0)) * (M - 1))))
  return WHALE_MASK.mask[my * M + mx] === 1
}

// ---------------------------------------------------------------------------
// ZAT 文字：几何粗体（线段骨架 + 距离场，笔画圆头、边缘抗锯齿）
// ---------------------------------------------------------------------------
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t))
}

// 字母骨架（字母局部坐标 0..1，y 向下）
const LETTERS = {
  Z: [
    [[0, 0.08], [1, 0.08]],
    [[1, 0.08], [0, 0.92]],
    [[0, 0.92], [1, 0.92]],
  ],
  A: [
    [[0.16, 0.96], [0.5, 0.04]],
    [[0.84, 0.96], [0.5, 0.04]],
    [[0.22, 0.60], [0.78, 0.60]],
  ],
  T: [
    [[0, 0.08], [1, 0.08]],
    [[0.5, 0.08], [0.5, 1]],
  ],
}

const TEXT_W = 0.152 // 字母宽（归一化）
const TEXT_H = 0.155 // 字母高
const TEXT_GAP = 0.045 // 字间距
const TEXT_Y0 = 0.755 // 文字顶部
const TEXT_STROKE = 0.044 // 笔画粗
const TEXT_AA = 0.006 // 抗锯齿半宽

function textCoverage(x, y) {
  const half = TEXT_STROKE / 2
  if (y < TEXT_Y0 - half - TEXT_AA || y > TEXT_Y0 + TEXT_H + half + TEXT_AA) return 0
  const total = TEXT_W * 3 + TEXT_GAP * 2
  const x0 = 0.5 - total / 2
  const names = ['Z', 'A', 'T']
  let best = Infinity
  for (let i = 0; i < 3; i++) {
    const lx0 = x0 + i * (TEXT_W + TEXT_GAP)
    if (x < lx0 - half - TEXT_AA || x > lx0 + TEXT_W + half + TEXT_AA) continue
    const u = (x - lx0) / TEXT_W
    const v = (y - TEXT_Y0) / TEXT_H
    for (const [a, b] of LETTERS[names[i]]) {
      const d = segDist(u, v, a[0], a[1], b[0], b[1]) * TEXT_H
      if (d < best) best = d
    }
  }
  if (best >= half + TEXT_AA) return 0
  if (best <= half - TEXT_AA) return 1
  return (half + TEXT_AA - best) / (TEXT_AA * 2)
}

// ---------------------------------------------------------------------------
// 合成
// ---------------------------------------------------------------------------
function sampleColor(x, y) {
  if (!insideRoundRect(x, y)) return null

  const t = Math.max(0, Math.min(1, (x + y) / 2))
  const rgb = mixColor(BLUE_DEEP, BLUE_LIGHT, t)

  // 左上角一点柔光
  const hl = Math.max(0, 1 - Math.hypot(x - 0.18, y - 0.14) / 0.55)
  const lighten = hl * 0.14

  let r = Math.min(255, Math.round(rgb[0] + 255 * lighten))
  let g = Math.min(255, Math.round(rgb[1] + 255 * lighten))
  let b = Math.min(255, Math.round(rgb[2] + 255 * lighten))

  if (isWhale(x, y)) {
    r = 255
    g = 255
    b = 255
  }

  // ZAT 文字叠加在已算好的底色/鲸鱼之上（白 → 渐变蓝）
  const tc = textCoverage(x, y)
  if (tc > 0) {
    r = r + (255 - r) * tc
    g = g + (255 - g) * tc
    b = b + (255 - b) * tc
  }

  return [r, g, b, 255]
}

function render() {
  const rgba = Buffer.alloc(SIZE * SIZE * 4)
  const offset = SS / 2

  for (let py = 0; py < SIZE; py++) {
    for (let px = 0; px < SIZE; px++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px * SS + sx + offset) / GRID
          const y = (py * SS + sy + offset) / GRID
          const c = sampleColor(x, y)
          if (c) {
            r += c[0] * c[3]
            g += c[1] * c[3]
            b += c[2] * c[3]
            a += c[3]
          }
        }
      }

      const n = SS * SS
      const idx = (py * SIZE + px) * 4
      rgba[idx] = a > 0 ? Math.round(r / a) : 0
      rgba[idx + 1] = a > 0 ? Math.round(g / a) : 0
      rgba[idx + 2] = a > 0 ? Math.round(b / a) : 0
      rgba[idx + 3] = Math.round(a / n)
    }
  }

  return encodePng(SIZE, SIZE, rgba)
}

const root = path.join(__dirname, '..')
const assetsDir = path.join(root, 'assets')
fs.mkdirSync(assetsDir, { recursive: true })
const out = path.join(assetsDir, 'icon.png')
fs.writeFileSync(out, render())
console.log(`Icon written: ${out}`)
