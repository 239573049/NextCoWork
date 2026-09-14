import { describe, expect, it } from 'vitest'
import { applyDraft, fileFromForm, formFromFile, unknownTools, validateAgentForm } from './agent-form'

const base = {
  name: 'reviewer',
  description: '审查刚写完的代码',
  prompt: '你是一个代码审查者。',
  model: '',
  color: '',
  permissionMode: '',
  toolsMode: 'all' as const,
  tools: [] as string[]
}

describe('子代理表单映射', () => {
  it('不认识的键原样带回文件', () => {
    // ★ 这条是整个文件存在的理由:从 Claude Code 粘过来的定义里常有本应用
    //   不认识的键,编辑一次把它抹掉是那种当场看不出、以后想不起来的损坏。
    const fm = { name: 'reviewer', description: '旧描述', 'x-team': 'infra', hooks: ['a'] }
    const form = formFromFile('reviewer', fm, '正文')
    const out = fileFromForm({ ...form, description: '新描述' }, fm)
    expect(out.frontmatter['x-team']).toBe('infra')
    expect(out.frontmatter.hooks).toEqual(['a'])
    expect(out.frontmatter.description).toBe('新描述')
  })

  it('「默认全部」删掉 tools 键,而不是写一张全表', () => {
    // 写全表的话,以后新增一个工具这条子代理拿不到 —— 而用户选的是「默认全部」。
    const out = fileFromForm({ ...base, toolsMode: 'all', tools: ['Read'] }, { tools: ['Read'] })
    expect('tools' in out.frontmatter).toBe(false)
  })

  it('空值删键,不写空值', () => {
    const out = fileFromForm(base, { model: 'gpt-5', color: 'blue', permissionMode: 'readonly' })
    expect('model' in out.frontmatter).toBe(false)
    expect('color' in out.frontmatter).toBe(false)
    expect('permissionMode' in out.frontmatter).toBe(false)
  })

  it('name 对齐到文件名,免得加载器报「两个名字不一致」', () => {
    const out = fileFromForm({ ...base, name: 'renamed' }, { name: 'reviewer' })
    expect(out.frontmatter.name).toBe('renamed')
  })

  it('往返一趟内容不变', () => {
    const fm = { name: 'reviewer', description: '描述', tools: ['Read', 'Grep'], model: 'sonnet', color: 'blue' }
    const form = formFromFile('reviewer', fm, '正文')
    expect(form.toolsMode).toBe('custom')
    expect(form.color).toBe('blue')
    const out = fileFromForm(form, fm)
    expect(out.frontmatter).toEqual(fm)
    expect(out.body).toBe('正文')
  })

  it('认不出的颜色当作没标', () => {
    expect(formFromFile('a', { color: 'chartreuse' }, 'x').color).toBe('')
  })

  it('白名单外的工具留着,只是复选格勾不出来', () => {
    const form = formFromFile('a', { tools: ['Read', 'mcp__github__search'] }, 'x')
    expect(unknownTools(form)).toEqual(['mcp__github__search'])
    expect(fileFromForm(form, {}).frontmatter.tools).toEqual(['Read', 'mcp__github__search'])
  })
})

describe('子代理表单校验', () => {
  it('名字必须合法', () => {
    expect(validateAgentForm({ ...base, name: 'Code Reviewer' })).toBe('ext.error.agentBadName')
    expect(validateAgentForm({ ...base, name: '' })).toBe('ext.error.agentBadName')
  })

  it('描述和正文都不能空', () => {
    expect(validateAgentForm({ ...base, description: ' ' })).toBe('ext.error.agentNeedsDescription')
    expect(validateAgentForm({ ...base, prompt: '' })).toBe('ext.error.emptyBody')
  })

  it('选了自定义却一个工具都没勾 —— 那正是加载器作废整条的形状', () => {
    expect(validateAgentForm({ ...base, toolsMode: 'custom', tools: [] })).toBe('ext.error.agentNoTools')
    expect(validateAgentForm({ ...base, toolsMode: 'custom', tools: ['Read'] })).toBeNull()
  })

  it('填齐了就放行', () => {
    expect(validateAgentForm(base)).toBeNull()
  })
})

describe('把生成结果并进表单', () => {
  it('草稿没给 tools 就回到「默认全部」', () => {
    const next = applyDraft({ ...base, toolsMode: 'custom', tools: ['Read'] }, {
      name: 'a11y-reviewer',
      description: '审查可访问性',
      prompt: '你负责…'
    })
    expect(next.toolsMode).toBe('all')
    expect(next.name).toBe('a11y-reviewer')
  })

  it('草稿给了 tools 就切到自定义', () => {
    const next = applyDraft(base, {
      name: 'a',
      description: 'b',
      prompt: 'c',
      tools: ['Read', 'Grep'],
      color: 'cyan'
    })
    expect(next.toolsMode).toBe('custom')
    expect(next.tools).toEqual(['Read', 'Grep'])
    expect(next.color).toBe('cyan')
  })

  it('作用域之外的东西不动 —— 权限档位是安全决定,不由生成器定', () => {
    const next = applyDraft({ ...base, permissionMode: 'readonly' }, { name: 'a', description: 'b', prompt: 'c' })
    expect(next.permissionMode).toBe('readonly')
  })
})
