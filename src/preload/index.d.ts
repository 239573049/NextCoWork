/**
 * `window.nextcowork` 的类型跨到渲染层的**唯一机制**(方案 §11):
 * tsconfig.web.json 的 include 里点名了 `src/preload/*.d.ts`。
 * 删掉那条 include,渲染层就会退化成 any,而且不报错 —— 所以两边是绑在一起的。
 */
import type { NextCoWorkApi } from './index'

declare global {
  interface Window {
    nextcowork: NextCoWorkApi
  }
}

export {}
