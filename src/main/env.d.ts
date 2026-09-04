/// <reference types="electron-vite/node" />

/**
 * 主进程的 Vite 环境类型。
 *
 * 存在的唯一理由是 `?asset` 后缀导入(`index.ts` / `tray.ts` 用它把
 * `resources/` 里的图标打进 out/,拿到一个 dev 与打包后都成立的运行时路径)——
 * 没有这一行,`import icon from '....png?asset'` 过不了 typecheck。
 */
