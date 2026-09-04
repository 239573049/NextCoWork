/**
 * 从 PNG 里取指定坐标的颜色。参考实现的配色是**量出来的**,不是看出来的 ——
 * 深色那套 token 就是这么定的,浅色这套也一样。
 *
 * 只处理 8bit RGB/RGBA、非隔行的 PNG(截图工具的输出都是这个形状),
 * 够用就行,不引解码库。
 *
 *   node scripts/pick-color.mjs <png> <x>,<y>[:标签] ...           取单像素
 *   node scripts/pick-color.mjs <png> <x>,<y>,<w>,<h>[:标签] ...   取一块的主色直方图
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'

export function decode(file) {
  const buf = readFileSync(file)
  let pos = 8
  let width = 0
  let height = 0
  let color = 0
  const idat = []

  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    const body = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      const depth = body[8]
      color = body[9]
      if (depth !== 8 || (color !== 2 && color !== 6)) {
        throw new Error(`只支持 8bit RGB/RGBA,这张是 depth=${depth} colorType=${color}`)
      }
      if (body[12] !== 0) throw new Error('不支持隔行 PNG')
    } else if (type === 'IDAT') {
      idat.push(body)
    } else if (type === 'IEND') {
      break
    }
    pos += 12 + len
  }

  const bpp = color === 6 ? 4 : 3
  const stride = width * bpp
  const raw = inflateSync(Buffer.concat(idat))
  const out = Buffer.alloc(height * stride)

  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride)
    const cur = out.subarray(y * stride, (y + 1) * stride)
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride)
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0
      const b = prev[i]
      const c = i >= bpp ? prev[i - bpp] : 0
      let v = line[i]
      if (filter === 1) v += a
      else if (filter === 2) v += b
      else if (filter === 3) v += (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      cur[i] = v & 0xff
    }
  }
  return { width, height, bpp, stride, out }
}

// 直接跑才走 CLI —— 这个模块也被别的脚本 import 去做整图分析
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [file, ...points] = process.argv.slice(2)
  const img = decode(file)
  const hex = (n) => n.toString(16).padStart(2, '0')
  const at = (x, y) => {
    const i = y * img.stride + x * img.bpp
    return `#${hex(img.out[i])}${hex(img.out[i + 1])}${hex(img.out[i + 2])}`
  }

  console.log(`${file} · ${img.width}x${img.height}`)
  for (const spec of points) {
    const [coord, label] = spec.split(':')
    const n = coord.split(',').map(Number)

    if (n.length === 2) {
      console.log(`  ${coord.padEnd(18)} ${at(n[0], n[1])}  ${label ?? ''}`)
      continue
    }

    /*
      四个数 = 一块矩形,按出现次数排前三名。**面板底色必须这么取,不能取单像素** ——
      参考实现开了 macOS vibrancy,单像素采到的是「面板色 × 壁纸」的混合;直方图里
      壁纸纹理会散成一堆低频色,真正的面板色是唯一那个高占比的峰。

      所以第一名的占比就是这次采样可不可信的判据:低于 40% 说明这块根本不是纯色区
      (范围划到了文字、图标、渐变或者边界上),换个位置重采,别把第一名抄进 token。
    */
    const [x, y, w, h] = n
    const tally = new Map()
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) {
        const c = at(x + dx, y + dy)
        tally.set(c, (tally.get(c) ?? 0) + 1)
      }
    }
    const top = [...tally].sort((a, b) => b[1] - a[1]).slice(0, 3)
    const pct = (k) => `${((k / (w * h)) * 100).toFixed(1)}%`
    console.log(`  ${coord.padEnd(18)} ${top[0][0]} ${pct(top[0][1]).padStart(6)}  ${label ?? ''}`)
    for (const [c, k] of top.slice(1)) console.log(`  ${''.padEnd(18)} ${c} ${pct(k).padStart(6)}`)
  }
}
