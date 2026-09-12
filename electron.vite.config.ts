import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import type { Plugin } from 'vite'

/**
 * ★ electron-vite 5 的 `vite:isolate-entries` 插件在 stdout **不是 TTY** 时崩:
 * 它无条件调 `process.stdout.moveCursor()` 去擦一行进度,而这几个方法只在
 * TTY 上才存在。真终端里看不出来,CI、`npm run e2e`、任何把输出重定向到文件的
 * 调用都会挂在 `process.stdout.moveCursor is not a function` 上 ——
 * 而报错文案完全不提 TTY,看起来像 preload 打包坏了。
 *
 * 补三个空实现。只在缺席时定义,所以真 TTY 下的行为一个字节都没变。
 * 这比在每个调用点套 `script -q /dev/null` 伪终端可靠:忘一次就是一次假失败。
 */
function shimNonTtyCursor(): void {
  const out = process.stdout as unknown as Record<string, unknown>
  if (typeof out['moveCursor'] !== 'function') out['moveCursor'] = () => true
  if (typeof out['clearLine'] !== 'function') out['clearLine'] = () => true
  if (typeof out['cursorTo'] !== 'function') out['cursorTo'] = () => true
}
shimNonTtyCursor()

/**
 * index.html 里写死的是**生产用的严格 CSP**;dev 下 react-refresh 会注入内联
 * <script>、HMR 要连 ws://localhost —— 严格 CSP 会把它们全挡掉。
 *
 * 这里在 dev 时整段替换成放宽版。故意做成「替换」而不是「注入」:
 * 插件哪天没生效,留在页面里的就是严格版,失败方向朝安全那边倒。
 */
function cspDevPlugin(): Plugin {
  const DEV_CSP = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    /*
      ★ `ncw:` 必须显式列出,**`*` 覆盖不到它**。CSP 的 `*` 通配符只匹配
      网络 scheme(http/https/ws/ftp),自定义 scheme 一律要点名。
      所以这行看着已经很宽,少了 `ncw:` 照样把附件图全挡掉。
    */
    'img-src * data: blob: ncw:',
    "media-src 'self' ncw:",
    "font-src 'self' data:",
    "connect-src 'self' ncw: ws://localhost:* http://localhost:* ws://127.0.0.1:* http://127.0.0.1:*",
    "object-src 'none'",
    "base-uri 'none'"
  ].join('; ')

  return {
    name: 'nextcowork:csp-dev',
    apply: 'serve',
    transformIndexHtml(html: string) {
      return html.replace(
        /<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>/,
        `<meta http-equiv="Content-Security-Policy" content="${DEV_CSP}" />`
      )
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@main': resolve('src/main')
      }
    },
    build: {
      rollupOptions: {
        input: { index: resolve('src/main/entry.ts') },
        output: { chunkFileNames: '[name]-[hash].js' }
      }
    }
  },

  preload: {
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    },
    build: {
      // ★ 沙箱化 preload 无法 require 多文件,必须完整打包成单文件。
      // isolatedEntries 是 electron-vite 5 为 Electron sandbox 提供的前提开关。
      isolatedEntries: true,
      externalizeDeps: false,
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') }
      }
    }
  },

  renderer: {
    root: 'src/renderer',
    plugins: [react(), tailwindcss(), cspDevPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@renderer': resolve('src/renderer/src')
      },
      /*
       * ★ @lobehub/streamdown 声明 katex ^0.18,仓库其余部分(rehype-katex /
       * remark-math / mermaid)统一在 0.16,npm 因此在 streamdown 下嵌套了第二份。
       * 两份 katex 各 ~590K 源码,不去重就都进 renderer bundle。
       *
       * streamdown 只用 katex 的 `renderToString` 做「尾部公式能不能渲染」的
       * 布尔探测(latex.ts `isLastFormulaRenderable`),渲染结果直接丢弃 ——
       * 不产出任何进入 DOM 的 markup,所以降到 0.16 不存在 markup 与
       * katex.min.css 版本错配的风险,这正是能安全 dedupe 的前提。
       */
      dedupe: ['katex']
    },
    build: {
      rollupOptions: {
        input: { index: resolve('src/renderer/index.html') }
      }
    }
  }
})
