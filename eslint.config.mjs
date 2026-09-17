import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  /*
    `dist/**` 只挡得住仓库根那一个。示例插件的构建产物在
    `examples/<id>/dist/` 下 —— 那里面是 esbuild 打出来的 8MB bundle,
    让 lint 去读它既没有意义,又会因为「浏览器全局在 Node 配置里没定义」
    刷出几十条假报错。
  */
  { ignores: ['out/**', 'dist/**', 'examples/*/dist/**', 'node_modules/**', 'packages/*/template/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn'
    }
  },
  {
    /**
     * `resources/*.cjs` 是**原样拷贝进安装包**的手写 CommonJS 资源,
     * 目前只有插件宿主窗口的 preload(见那个文件的头:它是安全边界,
     * 应该能被逐行读完,所以不打包)。它跑在 Electron 的沙箱 preload 环境里,
     * `require('electron')` 是那个环境**唯一**允许的 require —— 不是遗留写法。
     */
    files: ['resources/**/*.cjs'],
    languageOptions: {
      globals: { require: 'readonly', module: 'readonly', console: 'readonly' }
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off'
    }
  },
  {
    /**
     * `scripts/` 下是跑在**宿主 Node** 里的一次性工具(端到端冒烟等),不在任何
     * tsconfig 的 include 里,所以 `no-undef` 这条规则真的会生效 ——
     * src 下的 .ts 由 typescript-eslint 关掉了它,那边靠 tsc 查符号。
     *
     * 不引 `globals` 包:这里要的就这几个,列出来比多一个依赖清楚。
     */
    files: ['scripts/**/*.mjs', 'packages/**/*.mjs', 'examples/**/*.mjs', '*.config.js', '*.config.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        WebSocket: 'readonly',
        JSON: 'readonly',
        URL: 'readonly',
        Buffer: 'readonly',
        FormData: 'readonly',
        Blob: 'readonly'
      }
    }
  },
  {
    /**
     * 各个包下面的 `template` 目录是**生成给别人的**源码,不是本仓库的源码:
     * 它 import 的 `nextcowork` 在这里根本不存在(那是宿主在运行期注入的),
     * 而里面的 `__PUBLISHER__` 之类占位符也不是合法标识符。
     * 让它进 lint 只会产生一堆必须被忽略的报错。
     */
    ignores: ['packages/*/template/**']
  }
)
