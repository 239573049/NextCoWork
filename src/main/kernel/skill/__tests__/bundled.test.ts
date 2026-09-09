import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { installBundledSkills } from '../bundled'
import { scanSkills } from '../load'
import { nodeHost } from '../../host'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(): { source: string; target: string } {
  const root = mkdtempSync(join(tmpdir(), 'nextcowork-bundled-'))
  roots.push(root)
  return { source: join(root, 'skills'), target: join(root, 'global', 'skills') }
}

describe('installBundledSkills', () => {
  it('installs the shipped Skill Creator as a discoverable global Skill', async () => {
    const { target } = fixture()
    const source = join(import.meta.dirname, '../../../../../resources/skills')

    expect(installBundledSkills(source, target)).toEqual([])
    expect(installBundledSkills(source, target)).toEqual([])
    const result = await scanSkills({ fs: nodeHost().fs, globalRoot: target, projectRoot: '' })

    expect(result.diagnostics).toEqual([])
    expect(result.skills).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'skills-creator',
        name: 'skills-creator',
        scope: 'global',
        source: expect.objectContaining({ path: expect.stringContaining('/skills/skills-creator/SKILL.md') })
      })
    ]))
  })

  it('copies a complete package and its resources', () => {
    const { source, target } = fixture()
    mkdirSync(join(source, 'example', 'references'), { recursive: true })
    writeFileSync(join(source, 'example', 'SKILL.md'), '---\nname: example\ndescription: d\n---\nbody')
    writeFileSync(join(source, 'example', 'references', 'guide.md'), 'guide')

    expect(installBundledSkills(source, target)).toEqual([])
    expect(readFileSync(join(target, 'example', 'SKILL.md'), 'utf8')).toBe(
      readFileSync(join(source, 'example', 'SKILL.md'), 'utf8')
    )
    expect(readFileSync(join(target, 'example', 'references', 'guide.md'), 'utf8')).toBe('guide')
    expect(readdirSync(target)).toEqual(['example'])
  })

  it('keeps an existing global package unchanged', () => {
    const { source, target } = fixture()
    mkdirSync(join(source, 'example'), { recursive: true })
    mkdirSync(join(target, 'example'), { recursive: true })
    writeFileSync(join(source, 'example', 'SKILL.md'), 'new')
    writeFileSync(join(target, 'example', 'SKILL.md'), 'user version')

    expect(installBundledSkills(source, target)).toEqual([])
    expect(readFileSync(join(target, 'example', 'SKILL.md'), 'utf8')).toBe('user version')
  })

  it('reports an incomplete bundled package without creating it', () => {
    const { source, target } = fixture()
    mkdirSync(join(source, 'broken'), { recursive: true })

    const diagnostics = installBundledSkills(source, target)
    expect(diagnostics[0]?.path).toContain('broken')
    expect(existsSync(join(target, 'broken'))).toBe(false)
  })

  it('returns installation failures as diagnostics so startup can continue', () => {
    const { source, target } = fixture()
    mkdirSync(join(source, 'example'), { recursive: true })
    writeFileSync(join(source, 'example', 'SKILL.md'), 'body')
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, 'existing file')

    expect(installBundledSkills(source, target)).toEqual([
      expect.objectContaining({ path: join(target, 'example'), message: expect.any(String) })
    ])
    expect(readFileSync(target, 'utf8')).toBe('existing file')
  })
})
