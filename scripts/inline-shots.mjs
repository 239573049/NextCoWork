/**
 * 把 docs/design-review.html 里的相对图片引用换成 data URI,产出一个自包含的单文件。
 *
 * 源文件用相对路径引 `shots/*.png`,是为了在本地浏览器里直接双击就能看;
 * 而发布出去的那份必须自包含 —— 托管页不会带着 docs/shots 目录一起走。
 *
 * 两份都留着:改内容改源文件,发布前跑一次这个脚本。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(root, 'docs', 'design-review.html')
const out = process.argv[2] ?? '/tmp/nextcowork-design-review.html'

let html = readFileSync(src, 'utf8')
let count = 0

html = html.replace(/src="(shots\/[^"]+\.png)"/g, (_m, rel) => {
  const bytes = readFileSync(join(root, 'docs', rel))
  count += 1
  return `src="data:image/png;base64,${bytes.toString('base64')}"`
})

writeFileSync(out, html)
console.log(`内联 ${count} 张图 · ${(html.length / 1024).toFixed(0)}K · ${out}`)
