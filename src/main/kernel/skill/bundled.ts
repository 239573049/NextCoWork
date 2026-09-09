import { cpSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, type Dirent } from 'node:fs'
import { join } from 'node:path'
import { SKILL_NAME_RE } from '../../../shared/domain/skill'
import type { SkillDiagnostic } from './load'

/** Install missing bundled packages before IPC exposes the global Skill list. */
export function installBundledSkills(bundledRoot: string, globalRoot: string): SkillDiagnostic[] {
  const diagnostics: SkillDiagnostic[] = []
  let entries: Dirent[]
  try {
    entries = readdirSync(bundledRoot, { withFileTypes: true })
  } catch (error) {
    return [{ path: bundledRoot, message: errorMessage(error) }]
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !SKILL_NAME_RE.test(entry.name)) continue
    const source = join(bundledRoot, entry.name)
    const target = join(globalRoot, entry.name)
    let staging: string | undefined
    try {
      // Preserve the entire installed package, including user edits and symlinks.
      if (lstatSync(target, { throwIfNoEntry: false })) continue
      if (!lstatSync(join(source, 'SKILL.md'), { throwIfNoEntry: false })?.isFile()) {
        diagnostics.push({ path: source, message: 'Bundled Skill is missing SKILL.md' })
        continue
      }

      mkdirSync(globalRoot, { recursive: true })
      staging = mkdtempSync(join(globalRoot, `.bundled-${entry.name}-`))
      const stagedPackage = join(staging, entry.name)
      cpSync(source, stagedPackage, { recursive: true, force: false, errorOnExist: true })
      // Keep incomplete copies out of discovery and on the same filesystem for rename.
      renameSync(stagedPackage, target)
    } catch (error) {
      diagnostics.push({ path: target, message: errorMessage(error) })
    } finally {
      if (staging !== undefined) {
        try {
          rmSync(staging, { recursive: true, force: true })
        } catch (error) {
          diagnostics.push({ path: staging, message: errorMessage(error) })
        }
      }
    }
  }

  return diagnostics
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
