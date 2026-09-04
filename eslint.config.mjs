import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['out/**', 'dist/**', 'node_modules/**'] },
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
     * `scripts/` 下是跑在**宿主 Node** 里的一次性工具(端到端冒烟等),不在任何
     * tsconfig 的 include 里,所以 `no-undef` 这条规则真的会生效 ——
     * src 下的 .ts 由 typescript-eslint 关掉了它,那边靠 tsc 查符号。
     *
     * 不引 `globals` 包:这里要的就这几个,列出来比多一个依赖清楚。
     */
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        WebSocket: 'readonly',
        JSON: 'readonly',
        Buffer: 'readonly'
      }
    }
  }
)
