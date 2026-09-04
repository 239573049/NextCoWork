/**
 * 从 PNG 里裁一块出来另存 —— 对着参考图比图标、比间距时用。
 *
 * 解码复用 pick-color.mjs;编码是手写的最小 PNG(IHDR + IDAT + IEND,
 * 全部走 filter 0),因为只是为了看,不需要压缩率。
 *
 *   node scripts/crop.mjs <src.png> <x>,<y>,<w>,<h> <out.png> [放大倍数]
 */
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'
import { decode } from './pick-color.mjs'

const CRC = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return (buf) => {
    let c = -1
    for (const b of buf) c = t[(c ^ b) & 0xff] ^ (c >>> 8)
    return (c ^ -1) >>> 0
  }
})()

function chunk(type, body) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(body.length)
  const tb = Buffer.concat([Buffer.from(type, 'ascii'), body])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(CRC(tb))
  return Buffer.concat([len, tb, crc])
}

export function encodeRgb(width, height, rgb) {
  const raw = Buffer.alloc(height * (width * 3 + 1))
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0
    rgb.copy(raw, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2 // truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

export function crop(img, x0, y0, w, h, scale = 1) {
  const W = w * scale
  const H = h * scale
  const out = Buffer.alloc(W * H * 3)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const sx = Math.min(img.width - 1, x0 + Math.floor(x / scale))
      const sy = Math.min(img.height - 1, y0 + Math.floor(y / scale))
      const s = sy * img.stride + sx * img.bpp
      const d = (y * W + x) * 3
      out[d] = img.out[s]
      out[d + 1] = img.out[s + 1]
      out[d + 2] = img.out[s + 2]
    }
  }
  return { width: W, height: H, rgb: out }
}

// 直接跑才走 CLI —— 同 pick-color.mjs,留着给别的脚本 import
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [src, box, dest, scale = '1'] = process.argv.slice(2)
  const [x, y, w, h] = box.split(',').map(Number)
  const c = crop(decode(src), x, y, w, h, Number(scale))
  writeFileSync(dest, encodeRgb(c.width, c.height, c.rgb))
  console.log(`${dest}  ${c.width}x${c.height}`)
}
