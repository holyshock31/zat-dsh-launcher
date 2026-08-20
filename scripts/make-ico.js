'use strict'

/**
 * 从 assets/icon.png 生成标准多尺寸 assets/icon.ico（无第三方依赖）。
 * 条目：16/32/48（32-bit BGRA BMP，自下而上）+ 256（PNG 压缩条目）。
 * 用法：node scripts/make-ico.js
 */

const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

const root = path.join(__dirname, '..')
const pngFile = path.join(root, 'assets', 'icon.png')
const icoFile = path.join(root, 'assets', 'icon.ico')

// ---- 解码 PNG（仅支持 make-icon.js 产出的 filter=0 RGBA PNG） ----
function decodePng(file) {
  const buf = fs.readFileSync(file)
  let off = 8
  let w = 0
  let h = 0
  let colorType = 0
  const idat = []
  while (off < buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('ascii', off + 4, off + 8)
    const data = buf.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') {
      w = data.readUInt32BE(0)
      h = data.readUInt32BE(4)
      colorType = data[9]
    } else if (type === 'IDAT') {
      idat.push(data)
    }
    off += 12 + len
  }
  if (colorType !== 6) throw new Error(`unsupported colorType ${colorType}`)
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = w * 4
  const rgba = Buffer.alloc(w * h * 4)
  for (let y = 0; y < h; y++) {
    // filter 字节应为 0
    raw.copy(rgba, y * stride, y * (stride + 1) + 1, y * (stride + 1) + 1 + stride)
  }
  return { w, h, rgba }
}

// ---- alpha 感知缩放（box 采样，按 alpha 加权） ----
function scale(rgba, sw, sh, dw, dh) {
  const out = Buffer.alloc(dw * dh * 4)
  for (let dy = 0; dy < dh; dy++) {
    const y0 = (dy * sh) / dh
    const y1 = ((dy + 1) * sh) / dh
    for (let dx = 0; dx < dw; dx++) {
      const x0 = (dx * sw) / dw
      const x1 = ((dx + 1) * sw) / dw
      const steps = Math.max(1, Math.min(6, Math.ceil(Math.sqrt((x1 - x0) * (y1 - y0)) * 4)))
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let n = 0
      for (let i = 0; i < steps; i++) {
        const sy = y0 + ((i + 0.5) / steps) * (y1 - y0)
        for (let j = 0; j < steps; j++) {
          const sx = x0 + ((j + 0.5) / steps) * (x1 - x0)
          const px = Math.min(sw - 1, Math.floor(sx))
          const py = Math.min(sh - 1, Math.floor(sy))
          const o = (py * sw + px) * 4
          const al = rgba[o + 3] / 255
          r += rgba[o] * al
          g += rgba[o + 1] * al
          b += rgba[o + 2] * al
          a += al
          n++
        }
      }
      const o = (dy * dw + dx) * 4
      if (a > 0) {
        out[o] = Math.round(b / a) // B
        out[o + 1] = Math.round(g / a) // G
        out[o + 2] = Math.round(r / a) // R
        out[o + 3] = Math.round((a / n) * 255)
      } else {
        out[o] = 0
        out[o + 1] = 0
        out[o + 2] = 0
        out[o + 3] = 0
      }
    }
  }
  return out
}

// ---- 32-bit BGRA BMP 条目（自下而上） ----
function bmpEntry(rgba, size) {
  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0) // biSize
  header.writeInt32LE(size, 4) // biWidth
  header.writeInt32LE(size * 2, 8) // biHeight（XOR + AND）
  header.writeUInt16LE(1, 12) // biPlanes
  header.writeUInt16LE(32, 14) // biBitCount
  // biCompression=0, biSizeImage=0, 其余 0
  const pixels = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    rgba.copy(pixels, y * size * 4, (size - 1 - y) * size * 4, (size - y) * size * 4)
  }
  return Buffer.concat([header, pixels])
}

// ---- 组装 ICO ----
const src = decodePng(pngFile)
const sizes = [16, 32, 48]
const images = []
for (const s of sizes) {
  const rgba = scale(src.rgba, src.w, src.h, s, s)
  images.push({ size: s, data: bmpEntry(rgba, s) })
}
// 256x256 直接内嵌原 PNG
images.push({ size: 256, data: fs.readFileSync(pngFile) })

const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0) // reserved
header.writeUInt16LE(1, 2) // type: icon
header.writeUInt16LE(images.length, 4) // count

const entries = Buffer.alloc(images.length * 16)
let offset = 6 + images.length * 16
for (let i = 0; i < images.length; i++) {
  const e = entries.subarray(i * 16, (i + 1) * 16)
  const s = images[i].size
  e[0] = s >= 256 ? 0 : s // width（0 = 256）
  e[1] = s >= 256 ? 0 : s // height
  e[2] = 0 // colorCount
  e[3] = 0 // reserved
  e.writeUInt16LE(1, 4) // planes
  e.writeUInt16LE(32, 6) // bitCount
  e.writeUInt32LE(images[i].data.length, 8) // bytesInRes
  e.writeUInt32LE(offset, 12) // imageOffset
  offset += images[i].data.length
}

fs.writeFileSync(icoFile, Buffer.concat([header, entries, ...images.map(i => i.data)]))
console.log(`ICO written: ${icoFile} (${images.length} sizes: ${sizes.join('/')}/256)`)
