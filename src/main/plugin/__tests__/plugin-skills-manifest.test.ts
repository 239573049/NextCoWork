/**
 * 插件贡献 Skill 这条路上的**清单校验**与**目录推导**。
 *
 * 分三段,对应三个不同的失败会在什么时候被发现:
 * 解析时(清单形状)、安装时(包里缺文件)、启用时(交给扫描器的是哪几个目录)。
 * 三段都漏掉的话,失败会推迟到「用户装上了、模型却看不见那条 skill」。
 */
import { describe, expect, it } from 'vitest'
import { SKILL_CONTRIBUTION_DIR, parsePluginManifest } from '../../../shared/plugin/manifest'

/** 一份能过校验的最小清单,`contributes.skills` 由调用方给。 */
function manifestWith(skills: unknown): Record<string, unknown> {
  return {
    publisher: 'acme',
    name: 'demo',
    displayName: 'Demo',
    description: 'demo plugin',
    version: '1.0.0',
    engines: { nextcowork: '^0.3.0' },
    main: './dist/extension.js',
    contributes: { skills }
  }
}

function errorsFor(skills: unknown): string[] {
  const result = parsePluginManifest(manifestWith(skills))
  return result.ok ? [] : result.errors.filter((e) => e.field === 'contributes.skills').map((e) => e.message)
}

describe('contributes.skills 的形状', () => {
  it('`skills/<name>` 通过', () => {
    const result = parsePluginManifest(manifestWith([{ path: 'skills/pdf-tools' }]))
    expect(result.ok, result.ok ? '' : JSON.stringify(result.errors)).toBe(true)
    if (!result.ok) return
    expect(result.manifest.contributes.skills).toEqual([{ path: 'skills/pdf-tools' }])
  })

  it('★★ 放在别的目录下要拒 —— 打包器只拷 skills/,那种声明发布之后会凭空消失', () => {
    /*
      这是整条链上最隐蔽的一种失败:作者本机一切正常(目录真的在),
      而 `plugin-cli package` 只复制固定的那几个目录,于是发布出去的 ZIP 里
      根本没有它。用户装上之后少一条 skill,作者复现不出来。
    */
    expect(errorsFor([{ path: 'my-stuff/pdf-tools' }]).length).toBeGreaterThan(0)
    expect(errorsFor([{ path: 'assets/skills/pdf-tools' }]).length).toBeGreaterThan(0)
  })

  it('★ `skills` 本身要拒 —— 那样 SKILL.md 会比扫描约定少一层,扫出来 0 条且零报错', () => {
    expect(errorsFor([{ path: SKILL_CONTRIBUTION_DIR }]).length).toBeGreaterThan(0)
  })

  it('★ 再深一层也拒 —— 「目录名」是名字的回落值,允许 a/b/c 之后取哪一段就没人记得住了', () => {
    expect(errorsFor([{ path: 'skills/group/pdf-tools' }]).length).toBeGreaterThan(0)
  })

  it('★ 目录名要过 Skill 的名字规则 —— 它原样进系统提示词,也原样当工具入参', () => {
    expect(errorsFor([{ path: 'skills/Bad_Name' }]).length).toBeGreaterThan(0)
    expect(errorsFor([{ path: 'skills/-leading' }]).length).toBeGreaterThan(0)
  })

  it('路径穿越照旧拒', () => {
    expect(errorsFor([{ path: '../../etc/skills/x' }]).length).toBeGreaterThan(0)
    expect(errorsFor([{ path: '/abs/skills/x' }]).length).toBeGreaterThan(0)
  })

  it('★ 错误信息要说清「为什么」,不是只说「非法」', () => {
    // 作者看到的下一步动作必须在这句话里 —— 否则他只能猜
    expect(errorsFor([{ path: 'my-stuff/x' }]).join(' ')).toContain(SKILL_CONTRIBUTION_DIR)
  })

  it('不声明 skills 的插件照常通过(绝大多数插件不带 skill)', () => {
    const result = parsePluginManifest(manifestWith(undefined))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.manifest.contributes.skills).toEqual([])
  })
})
