/// <reference types="vite/client" />

/**
 * 渲染层的 Vite 环境类型。
 *
 * 存在的唯一理由是 `?raw` 后缀导入(`ProviderIcon` 用它内联 lobehub 的品牌 SVG)——
 * 没有这一行,`import x from '....svg?raw'` 过不了 typecheck。
 */
