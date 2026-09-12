import { describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { HOOK_TEMPLATES, findHookTemplate, type HookTemplate } from '../../../../../shared/domain/hook-templates'
import { templateToDraft, validateHook, warnHook, type HookDraft } from './hook-form'

/**
 * 钩子模板。
 *
 * ★ 这里有**两类**断言，第二类才是重点：
 *
 *   1. 静态：能通过表单校验、不触发弱 matcher 警告、id 唯一。
 *   2. **真的跑一遍**：模板是要在用户机器上执行的 shell —— 一个引号写错、
 *      一处缩进不对，用户选了模板、点保存、然后什么也不会发生（失败不阻断，
 *      只进诊断）。静态检查一个字都看不出来。
 *
 * POSIX only：模板里的 `python3` / `osascript` 在 Windows 上是另一套。
 */
const posix = process.platform !== 'win32'

const draftOf = (id: string): HookDraft => {
  const tpl = findHookTemplate(id)
  if (tpl === undefined) throw new Error(`没有这个模板：${id}`)
  return {
    event: tpl.event,
    matcher: tpl.matcher ?? '',
    command: tpl.command,
    timeoutSeconds: tpl.timeoutSeconds,
    description: '',
    enabled: true
  }
}

/** 把一行 payload 喂给模板命令，拿回 exit code 和输出。 */
function runTemplate(id: string, payload: unknown): Promise<{ code: number | null; out: string; err: string }> {
  const tpl = findHookTemplate(id)
  if (tpl === undefined) throw new Error(`没有这个模板：${id}`)
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', tpl.command], { stdio: 'pipe' })
    let out = ''
    let err = ''
    child.stdout.on('data', (b) => { out += String(b) })
    child.stderr.on('data', (b) => { err += String(b) })
    child.on('close', (code) => resolve({ code, out: out.trim(), err: err.trim() }))
    child.stdin.on('error', () => {})
    child.stdin.write(`${JSON.stringify(payload)}\n`)
    child.stdin.end()
  })
}

describe('模板 · 静态', () => {
  it('id 不重复', () => {
    const ids = HOOK_TEMPLATES.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('每个模板都能通过表单校验 —— 选了模板却存不下去是最蠢的失败', () => {
    for (const tpl of HOOK_TEMPLATES) {
      expect(validateHook(draftOf(tpl.id)), tpl.id).toBeNull()
    }
  })

  it('★ 阻断型模板不用前缀 matcher —— 那条保护是给「放行」设计的，方向反了', () => {
    for (const tpl of HOOK_TEMPLATES) {
      expect(warnHook(draftOf(tpl.id)), tpl.id).toBeNull()
    }
  })

  it('阻断型模板的 matcher 是裸工具名', () => {
    expect(findHookTemplate('danger-guard')?.matcher).toBe('Bash')
    expect(findHookTemplate('protect-secrets')?.matcher).toBe('Write')
  })
})

describe.skipIf(!posix)('模板 · 真的跑一遍', () => {
  const preTool = (input: unknown): unknown => ({
    event: 'PreToolUse', sessionId: 's', runId: 'r', workspaceRoot: process.cwd(),
    scope: 'project', toolName: 'X', toolInternalId: 'X', toolInput: input
  })

  describe('danger-guard', () => {
    it('★ 危险命令 exit 2 并给出理由', async () => {
      const r = await runTemplate('danger-guard', preTool({ command: 'rm -rf / --no-preserve-root' }))
      expect(r.code).toBe(2)
      expect(r.err).toContain('rm -rf /')
    })

    it('★ 用接续符也躲不掉 —— 这正是不用前缀 matcher 的理由', async () => {
      const r = await runTemplate('danger-guard', preTool({ command: 'echo hi && git push --force' }))
      expect(r.code).toBe(2)
    })

    it('正常命令放行', async () => {
      const r = await runTemplate('danger-guard', preTool({ command: 'git status' }))
      expect(r.code).toBe(0)
      expect(r.out).toBe('')
    })

    it('没有 toolInput 也不炸', async () => {
      expect((await runTemplate('danger-guard', preTool(null))).code).toBe(0)
    })
  })

  describe('protect-secrets', () => {
    it.each([
      ['/repo/.env', '.env'],
      ['/repo/config/.env.production', '.env.production'],
      ['/home/me/.ssh/config', '.ssh 目录'],
      ['/repo/server.pem', '.pem'],
      ['/home/me/.aws/credentials', '.aws 目录']
    ])('拦下 %s', async (path) => {
      const r = await runTemplate('protect-secrets', preTool({ file_path: path }))
      expect(r.code).toBe(2)
      expect(r.err).toContain(path)
    })

    it.each(['/repo/src/index.ts', '/repo/README.md', '/repo/.envrc.example'])('放行 %s', async (path) => {
      expect((await runTemplate('protect-secrets', preTool({ file_path: path }))).code).toBe(0)
    })
  })

  describe('inject-branch', () => {
    it('在 git 仓库里输出分支名', async () => {
      const r = await runTemplate('inject-branch', { event: 'UserPromptSubmit' })
      expect(r.code).toBe(0)
      // 这个仓库本身就是 git 仓库；detached HEAD 时输出为空也算通过
      if (r.out !== '') expect(r.out).toMatch(/^当前 git 分支：/)
    })
  })

  describe('format-after-write', () => {
    it('★ 骨架能跑通且什么也不做 —— 用户填进自己的命令之前不该有副作用', async () => {
      const r = await runTemplate('format-after-write', {
        event: 'PostToolUse', toolInput: { file_path: '/tmp/x.ts' }
      })
      expect(r.code).toBe(0)
      expect(r.out).toBe('')
    })

    it('没有 file_path 时提前退出', async () => {
      const r = await runTemplate('format-after-write', { event: 'PostToolUse', toolInput: {} })
      expect(r.code).toBe(0)
    })
  })
})

describe('templateToDraft', () => {
  it('★ 五个字段一个都不能漏 —— 漏掉 matcher 的话，一条本该只管 Bash 的钩子会对每次工具调用都触发', () => {
    const tpl = findHookTemplate('danger-guard')
    expect(tpl).toBeDefined()
    expect(templateToDraft(tpl as HookTemplate, '说明')).toEqual({
      event: 'PreToolUse',
      matcher: 'Bash',
      command: tpl?.command,
      timeoutSeconds: 5,
      description: '说明',
      enabled: true
    })
  })

  it('没有 matcher 的模板填成空串（= 每次都触发），不是 undefined', () => {
    const tpl = findHookTemplate('notify-done')
    expect(templateToDraft(tpl as HookTemplate, '').matcher).toBe('')
  })

  it('产出的草稿本身就是合法的 —— 选完模板应当能直接保存', () => {
    for (const tpl of HOOK_TEMPLATES) {
      expect(validateHook(templateToDraft(tpl, 'x')), tpl.id).toBeNull()
    }
  })
})
