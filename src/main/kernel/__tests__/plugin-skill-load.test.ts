/**
 * **插件贡献的 Skill** 的扫描。
 *
 * 和 `skill-load.test.ts` 同一套做法:真临时目录、不打桩 fs、每条用例同时断言
 * 「这条进没进来」和「用户能不能知道原因」。分成两个文件是因为它们的**输入形状
 * 不同** —— 那边是「一个含若干条的根」,这边是「清单点名的一条条绝对目录」,
 * 混在一起会让每条用例都要先交代自己属于哪一种。
 *
 * 这里钉的是四条「坏了不会报错」的不变式:
 *
 * 1. 插件层的优先级**最低**(用户自己写的同名 skill 永远说了算);
 * 2. 两个插件撞名时结果**确定**,且有人被告知;
 * 3. SSH 会话里带资产的插件 skill 要被判成 `client-assets`;
 * 4. 包外的软链读不到。
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { nodeHost } from '../host'
import type { PluginSkillRoot, SkillScanResult } from '../skill/load'
import { currentPluginSkillRoots, scanSkills, setPluginSkillRootsProvider } from '../skill/load'

const fs = nodeHost().fs

let root = ''
let globalRoot = ''
let projectRoot = ''
let pluginsRoot = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nextcowork-plugin-skill-'))
  globalRoot = join(root, 'global', 'skills')
  projectRoot = join(root, 'project', '.nextcowork', 'skills')
  pluginsRoot = join(root, 'plugins')
  mkdirSync(globalRoot, { recursive: true })
  mkdirSync(projectRoot, { recursive: true })
  mkdirSync(pluginsRoot, { recursive: true })
})

afterEach(() => {
  // ★ 模块级注册表要清掉,否则污染下一个文件(AGENTS.md §13)
  setPluginSkillRootsProvider(null)
  rmSync(root, { recursive: true, force: true })
})

const md = (description: string | null, body = '照着这个做。'): string =>
  `---\n${description === null ? '' : `description: ${description}\n`}---\n${body}\n`

/** 在某一层里放一条 Skill。 */
function put(scopeRoot: string, dir: string, content: string): void {
  mkdirSync(join(scopeRoot, dir), { recursive: true })
  writeFileSync(join(scopeRoot, dir, 'SKILL.md'), content)
}

/**
 * 造一个插件包,并返回它对这条 skill 的贡献声明。
 * 目录形状和真实安装后完全一致:`<plugins>/<id>/skills/<name>/SKILL.md`。
 */
function contribute(pluginId: string, name: string, content: string): PluginSkillRoot {
  const dir = join(pluginsRoot, pluginId, 'skills', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), content)
  return { pluginId, dir }
}

const scan = (pluginRoots: readonly PluginSkillRoot[]): Promise<SkillScanResult> =>
  scanSkills({ fs, globalRoot, projectRoot, pluginRoots })

const said = (r: SkillScanResult, needle: string): boolean =>
  r.diagnostics.some((d) => d.message.includes(needle))

describe('插件贡献的 Skill 进目录', () => {
  it('读到清单点名的那个目录,并记下是哪个插件带来的', async () => {
    const result = await scan([contribute('acme.pdf', 'pdf-tools', md('Work with PDFs'))])

    const skill = result.skills.find((s) => s.name === 'pdf-tools')
    expect(skill).toBeDefined()
    expect(skill?.description).toBe('Work with PDFs')
    expect(skill?.scope).toBe('plugin')
    expect(skill?.source.kind).toBe('plugin')
    // ★ pluginId 是界面藏掉卸载按钮、以及详情页反查的依据
    expect(skill?.source.pluginId).toBe('acme.pdf')
  })

  it('★ source.path 是**绝对**路径 —— Skill 工具要把它交给模型', async () => {
    /*
      插件 skill 的正文几乎一定会引用同目录下的东西(「跑一下 scripts/check.py」),
      而那个目录模型猜不到。路径要是相对的,模型会把它当成工作区相对路径去读。

      ★ 这里**不**拿 `contribution.dir` 逐字比:扫描器走 `resolveInWorkspace`,
      它会 realpath(那是软链逃逸检查的实现手段),而 macOS 的临时目录
      `/var/...` realpath 之后是 `/private/var/...`。逐字比的话这条用例只在
      macOS 上挂,而它想钉的根本不是这件事。
    */
    const contribution = contribute('acme.pdf', 'pdf-tools', md('Work with PDFs'))
    const result = await scan([contribution])

    const path = result.skills.find((s) => s.name === 'pdf-tools')?.source.path ?? ''
    expect(isAbsolute(path)).toBe(true)
    expect(path.endsWith(join('skills', 'pdf-tools', 'SKILL.md'))).toBe(true)
  })

  it('没有 pluginRoots 时一条插件 skill 都没有(留空 = 没有,不是「去查一下」)', async () => {
    const result = await scanSkills({ fs, globalRoot, projectRoot })
    expect(result.skills).toHaveLength(0)
  })
})

describe('优先级:插件最低', () => {
  it('★★ 用户自己的全局同名 Skill 压过插件那条', async () => {
    /*
      需求:插件提供的是一个合理默认,用户自己写的永远说了算。反过来的话,
      用户在 skills/ 里放一条同名的覆盖规则会毫无反应,而界面上两条都在,
      没有任何地方解释谁生效。
    */
    put(globalRoot, 'commit-style', md('用户自己的规范'))
    const result = await scan([contribute('acme.git', 'commit-style', md('插件自带的规范'))])

    const hit = result.skills.find((s) => s.name === 'commit-style')
    expect(hit?.description).toBe('用户自己的规范')
    expect(hit?.scope).toBe('global')
    expect(hit?.source.pluginId).toBeUndefined()
  })

  it('★ 项目级同名同样压过插件那条', async () => {
    put(projectRoot, 'commit-style', md('这个仓库的规范'))
    const result = await scan([contribute('acme.git', 'commit-style', md('插件自带的规范'))])

    expect(result.skills.find((s) => s.name === 'commit-style')?.scope).toBe('project')
  })
})

describe('两个插件撞名', () => {
  it('★★ 先来的赢,而且后来那个的作者能知道发生了什么', async () => {
    /*
      不出诊断的话,后装的那个插件的 skill 会凭空消失,而两个插件页上都显示
      得好好的 —— 作者唯一能做的是逐个禁用来二分。
    */
    const result = await scan([
      contribute('acme.first', 'shared-name', md('第一个')),
      contribute('acme.second', 'shared-name', md('第二个'))
    ])

    expect(result.skills.filter((s) => s.name === 'shared-name')).toHaveLength(1)
    expect(result.skills.find((s) => s.name === 'shared-name')?.source.pluginId).toBe('acme.first')
    expect(said(result, 'acme.second')).toBe(true)
    expect(said(result, 'acme.first')).toBe(true)
  })
})

describe('坏包不拖垮整次扫描', () => {
  it('目录里没有 SKILL.md —— 跳过它,别的照常', async () => {
    const empty = join(pluginsRoot, 'acme.broken', 'skills', 'nothing')
    mkdirSync(empty, { recursive: true })
    const result = await scan([
      { pluginId: 'acme.broken', dir: empty },
      contribute('acme.good', 'works', md('Fine'))
    ])

    expect(result.skills.map((s) => s.name)).toEqual(['works'])
    expect(result.diagnostics.length).toBeGreaterThan(0)
  })

  it('★ 缺 description 的整条作废,并说明原因', async () => {
    const result = await scan([contribute('acme.pdf', 'no-desc', md(null))])

    expect(result.skills).toHaveLength(0)
    expect(said(result, 'description')).toBe(true)
  })

  it('★★ SKILL.md 是一条指向包外的软链 —— 读不到,且有诊断', async () => {
    /*
      ZIP 安装那条路已经拒了符号链接,但**目录安装**(开发时装本地目录)没有
      这道门。一条指向 ~/.ssh/id_rsa 的软链会被原样读进 skill 正文,
      而正文是要进模型上下文的。
    */
    const secret = join(root, 'secret.md')
    writeFileSync(secret, `---\ndescription: leaked\n---\n私钥内容\n`)
    const dir = join(pluginsRoot, 'acme.evil', 'skills', 'sneaky')
    mkdirSync(dir, { recursive: true })
    symlinkSync(secret, join(dir, 'SKILL.md'))

    const result = await scan([{ pluginId: 'acme.evil', dir }])

    expect(result.skills).toHaveLength(0)
    expect(result.diagnostics.length).toBeGreaterThan(0)
  })
})

describe('SSH 会话', () => {
  it('★★ 带资产的插件 Skill 在远端会话里判成 client-assets', async () => {
    /*
      插件包在**客户端**,而这一轮的命令跑在服务器上。不管它的话,模型会照着
      正文去跑一个只存在于用户笔记本上的 scripts/check.py —— 表现为一条
      「文件不存在」,而失败信息里那个路径看上去完全合理。

      这条曾经只管 global 作用域,加插件这一层时一起扩的。
    */
    const contribution = contribute('acme.pdf', 'with-assets', md('Has scripts'))
    writeFileSync(join(contribution.dir, 'check.py'), 'print(1)')

    const result = await scanSkills({
      fs,
      projectFs: fs, // 有 projectFs = 这一轮绑了远端
      globalRoot,
      projectRoot,
      pluginRoots: [contribution]
    })

    expect(result.skills.find((s) => s.name === 'with-assets')?.unavailableReason).toBe('client-assets')
  })

  it('纯文本的插件 Skill 在远端会话里照常可用', async () => {
    const result = await scanSkills({
      fs,
      projectFs: fs,
      globalRoot,
      projectRoot,
      pluginRoots: [contribute('acme.pdf', 'text-only', md('Just instructions'))]
    })

    expect(result.skills.find((s) => s.name === 'text-only')?.unavailableReason).toBeUndefined()
  })
})

describe('provider 注册', () => {
  it('没注册时返回空数组 —— 插件系统没起来时「没有」是正确答案,不是错误', () => {
    expect(currentPluginSkillRoots()).toEqual([])
  })

  it('★ provider 抛异常不能让所有 Skill 都扫不出来', async () => {
    /*
      同文件头那条「永不 throw」:插件管理器坏了,用户自己装的 skill 不该跟着
      一起消失 —— 那个症状会把排查引向完全错误的方向。
    */
    setPluginSkillRootsProvider(() => { throw new Error('manager is gone') })
    expect(currentPluginSkillRoots()).toEqual([])

    put(globalRoot, 'mine', md('用户自己的'))
    const result = await scan(currentPluginSkillRoots())
    expect(result.skills.map((s) => s.name)).toEqual(['mine'])
  })

  it('每次调用都重新问 —— 禁用插件之后下一轮就该没有了', () => {
    let live = [{ pluginId: 'acme.pdf', dir: join(pluginsRoot, 'acme.pdf', 'skills', 'x') }]
    setPluginSkillRootsProvider(() => live)
    expect(currentPluginSkillRoots()).toHaveLength(1)

    live = []
    expect(currentPluginSkillRoots()).toHaveLength(0)
  })
})
