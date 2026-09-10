/**
 * 内置命令 —— 写死在代码里的那几条。
 *
 * ★ 和 `agent/builtin.ts` 同一个理由:它们先进表、可以被同名文件覆盖,
 * 于是「至少有一条命令可用」是一条无条件成立的事实,而不是
 * 「取决于用户机器上有没有那个目录」。
 */
import type { CommandDefinition } from '../../../shared/domain/command'

/**
 * `/init` —— 深读一遍仓库,产出 `AGENTS.md`。
 *
 * ★ 提示词里**先规定「读什么」再规定「写什么」**。反过来(直接说
 * 「写一份 AGENTS.md」)时模型会凭项目名和几个文件名脑补一份通用模板 ——
 * 那种文件看起来完全正常,但里面每一条命令都是猜的。
 *
 * ★ 明确禁止写「显而易见的东西」。AGENTS.md 的读者是下一个 agent,
 * 它已经会读代码了;它需要的是**读代码看不出来的那些约定**。
 */
const INIT_PROMPT = `Analyze this repository in depth and then create or update \`AGENTS.md\` at the repository root.

## Step 1 — Investigate before writing

Do not guess. Gather evidence first:

1. Read the root manifests and configs: package.json / pyproject.toml / Cargo.toml / go.mod / pom.xml / *.csproj, lockfiles, tsconfig, linter and formatter configs, test runner configs, Dockerfile, CI workflows.
2. Determine the package manager from the lockfile that actually exists, and the exact build / test / lint / typecheck / dev commands from the scripts section and the CI workflow. Never invent a command you have not seen.
3. Map the directory layout and explain what each top-level directory is for. Identify the entry points.
4. Read a representative sample of real source files to learn the conventions actually in use: module boundaries, import style, naming, error handling, state management, testing style, i18n or logging layers.
5. Look for existing agent instructions to fold in and then supersede: AGENTS.md, CLAUDE.md, .cursorrules, .cursor/rules/, .github/copilot-instructions.md, CONTRIBUTING.md, README.md.

## Step 2 — Write AGENTS.md

Write for the next coding agent working in this repo, not for a human newcomer. Include only what cannot be inferred by reading a file or two:

- **Project overview** — what it is, in a few sentences.
- **Setup & commands** — verified install / dev / build / test / lint / typecheck commands, plus how to run a single test.
- **Architecture** — the directory map, the layers, and the boundaries that must not be crossed.
- **Conventions** — the non-obvious rules this codebase actually follows, with a short example where a rule is easy to get wrong.
- **Gotchas** — the traps: generated files that must not be edited by hand, required codegen steps, platform-specific behavior, anything that silently breaks.

Rules for the document itself:

- Be specific and short. Every line must change what an agent would do. Delete anything that would be true of any repository.
- Do not document obvious things ("use TypeScript types", "write clean code").
- Do not include a file-by-file listing.
- Keep it under roughly 200 lines.
- Match the primary written language already used in the repository's own documentation.
- If \`AGENTS.md\` already exists, preserve any rule that is still accurate, correct what is stale, and add what is missing — do not rewrite it from scratch.

## Step 3 — Report

After writing the file, summarize in a few bullets what you changed and list anything you could not verify.`

export const BUILTIN_COMMANDS: readonly CommandDefinition[] = [
  {
    name: 'init',
    // 用户看到的那行副标题由渲染层按 name 翻译;这条是兜底(测试与非 UI 调用)。
    description: 'Analyze the project and generate AGENTS.md',
    prompt: INIT_PROMPT,
    scope: 'builtin',
    source: ''
  }
]
