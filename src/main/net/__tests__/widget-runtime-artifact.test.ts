/**
 * 外壳运行时的**真产物**形状。
 *
 * 这个文件存在的唯一理由是踩过一次的坑:那份运行时由 main 段的第二个入口
 * 打包,而 iframe 只被下发 `/index.html` 与 `/runtime.js` 两个地址 ——
 * 于是产物必须是**自包含**的。当时 `runtime.ts` 按值 import 了
 * `shared/domain/widget`(main 入口也要用它),rollup 顺手把它提成一个
 * **两个入口共用、文件名带哈希**的 chunk,产物的第一行于是变成
 * `require("./widget-qsN_xeJ0.js")`:
 *
 * - 那个文件 iframe 永远取不到(协议不服务它);
 * - 而且它是 **CJS** —— 浏览器里连 `require` 都没有。
 *
 * ★ 这次改动**构建完全成功**,界面上只是 widget 一片空白。所以这里把
 * "产物里不许有 require / 裸 import" 钉成断言:谁把那个 import 改回去,
 * 这条会在开发机上直接红。
 *
 * ★ `skipIf`:产物不进版本库(dev / build 前才生成),而 CI 跑的是
 * typecheck + lint + test,不跑构建 —— 硬要求它存在的话,CI 会在一个与它
 * 无关的环节上红。同 `plugin-runtime-serving.test.ts` 的处理。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ARTIFACT = join(process.cwd(), 'out', 'main', 'widgetShell.js')
const built = existsSync(ARTIFACT)

describe.skipIf(!built)('已构建的 widget 外壳运行时', () => {
  const source = built ? readFileSync(ARTIFACT, 'utf8') : ''

  it('★ 自包含 —— 不许出现 require / 裸 import(见文件头)', () => {
    expect(source).not.toMatch(/\brequire\s*\(/)
    // 相对 import 同样不行:那意味着有别的文件要一起下发
    expect(source).not.toMatch(/(?:^|[;\s])(?:import|export)\b/)
  })

  it('五个消息名都在,且与 shared/domain/widget 逐字一致', () => {
    for (const name of [
      'ncw:widget:content',
      'ncw:widget:theme',
      'ncw:widget:loading',
      'ncw:widget:ready',
      'ncw:widget:height'
    ]) {
      expect(source).toContain(name)
    }
  })

  it('里面没有 node 内置模块的痕迹 —— 它跑在浏览器里', () => {
    expect(source).not.toContain('node:')
    expect(source).not.toContain('__dirname')
  })
})
