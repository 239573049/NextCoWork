/**
 * Skill 扫描 —— 照搬 Claude Code 的目录约定。
 *
 * ```
 * <userData>/skills/<name>/SKILL.md          全局
 * <workspaceRoot>/.nextcowork/skills/<name>/SKILL.md   项目(同名时项目胜出)
 * ```
 *
 * ★ 为什么是**目录**而不是单文件:Skill 常常要带脚本、模板、参考资料
 * (「照着 template.md 写」「跑一下 scripts/check.py」),而子代理定义不带资产,
 * 所以那边是 `agents/<name>.md` 单文件。这个不对称是 CC 的实际形状,照搬。
 *
 * ## 这里的每一条校验都对应一种「静默失败」
 *
 * 加载器的职责是**判定有效性**并把无效的理由说出来。解析器
 * (`frontmatter.ts`)永不 throw、也从不判断有效性 —— 那两件事分在两处,
 * 是因为「这个 YAML 能不能读」和「这条 Skill 能不能用」是两个问题:
 * 一份语法完全正确、却没有 `description` 的 SKILL.md,解析得漂漂亮亮,
 * 但它进了目录之后模型根本不知道什么时候该调它。
 */
import type { Skill, SkillScope } from '../../../shared/domain/skill'
import { SKILL_BODY_MAX, SKILL_NAME_RE } from '../../../shared/domain/skill'
import { fmList, fmString, parseFrontmatter } from '../frontmatter'
import type { KernelFs } from '../host'
import { PathEscapeError, resolveInWorkspace } from '../tool/path-guard'
import { clampWithEllipsis, stripControlChars } from '../text'

/**
 * 描述的字符上限。★ 和 CC 对齐,也和「目录里每条只占一行」这个设计一致 ——
 * 描述是**唯一**进系统提示词的部分,它长成什么样,提示词就贵成什么样。
 */
export const SKILL_DESCRIPTION_MAX = 1024

/** SKILL.md 读进内存的字节上限。正文本身还会再被 `SKILL_BODY_MAX` 截一次。 */
const SKILL_FILE_MAX_BYTES = 256 * 1024

/** 一次扫描最多认多少条。防一个被塞了几千个目录的 skills/ 把启动拖住。 */
const MAX_SKILLS = 200

/** 目录名 —— 和 CC 一致 */
export const SKILLS_DIR = 'skills'
export const PROJECT_SKILLS_PREFIX = '.nextcowork'

export type { SkillScope }

export interface SkillDiagnostic {
  /** 出问题的那个路径,给用户看的 */
  path: string
  message: string
}

export interface SkillScanResult {
  skills: Skill[]
  diagnostics: SkillDiagnostic[]
}

export interface SkillScanInput {
  fs: KernelFs
  /** `<userData>/skills`。空串 = 跳过全局这一层。 */
  globalRoot: string
  /** `<workspaceRoot>/.nextcowork/skills`。空串 = 没有工作区。 */
  projectRoot: string
}

/**
 * 扫两层目录,产出一张 Skill 表。
 *
 * ★ **永不 throw。**目录不存在、权限不足、某个 SKILL.md 是坏的 —— 全部变成
 * `diagnostics` 里的一行。一次扫描因为某台机器上一个坏文件而整体失败的话,
 * 用户看到的是「所有 Skill 都不见了」,而真正坏掉的只有一条。
 */
export async function scanSkills(input: SkillScanInput): Promise<SkillScanResult> {
  const diagnostics: SkillDiagnostic[] = []
  const byName = new Map<string, Skill>()

  // ★ 顺序即优先级:全局先进,项目后进覆盖同名。反过来写,项目里那条
  //   「这个仓库要用我们自己的提交规范」的 Skill 就永远压不过全局那条。
  for (const scope of ['global', 'project'] as const) {
    const root = scope === 'global' ? input.globalRoot : input.projectRoot
    if (root === '') continue
    await scanOneRoot(input.fs, root, scope, byName, diagnostics)
  }

  return { skills: [...byName.values()], diagnostics }
}

async function scanOneRoot(
  fs: KernelFs,
  root: string,
  scope: SkillScope,
  out: Map<string, Skill>,
  diagnostics: SkillDiagnostic[]
): Promise<void> {
  let entries: Array<{ name: string; isDir: boolean }>
  try {
    if (!(await fs.exists(root))) return // 没有 skills 目录是常态,不是错误
    entries = await fs.readDir(root)
  } catch (err) {
    diagnostics.push({ path: root, message: `读不了这个目录:${msg(err)}` })
    return
  }

  for (const e of entries) {
    if (!e.isDir) continue
    if (out.size >= MAX_SKILLS) {
      diagnostics.push({ path: root, message: `Skill 数量超过 ${String(MAX_SKILLS)} 条,其余未加载` })
      return
    }
    /*
      ★ 目录名先过 `SKILL_NAME_RE`。这不只是「规范一下命名」:名字会进
      系统提示词、会被模型原样当成 `skill` 工具的入参,而一个叫
      `../../etc` 或者带换行的目录名两样都能搞坏。
    */
    if (!SKILL_NAME_RE.test(e.name)) {
      diagnostics.push({ path: `${root}/${e.name}`, message: `目录名不合法,已跳过` })
      continue
    }

    let dir: string
    try {
      /*
        ★ 这一步挡的是软链逃逸:`~/.nextcowork/skills/evil -> /` 之后,
        「扫描 skills 目录」就变成了「扫描整个磁盘」。`resolveInWorkspace`
        会 realpath 之后做包含判断,所以逃出去的目录在这里就死了。
      */
      dir = resolveInWorkspace(root, e.name)
    } catch (err) {
      if (err instanceof PathEscapeError) {
        diagnostics.push({ path: `${root}/${e.name}`, message: '这个目录指向了 skills 之外,已跳过' })
        continue
      }
      diagnostics.push({ path: `${root}/${e.name}`, message: msg(err) })
      continue
    }

    const file = `${dir}/SKILL.md`
    const loaded = await loadOne(fs, file, e.name, scope, diagnostics)
    if (loaded !== null) out.set(loaded.name, loaded)
  }
}

async function loadOne(
  fs: KernelFs,
  file: string,
  dirName: string,
  scope: SkillScope,
  diagnostics: SkillDiagnostic[]
): Promise<Skill | null> {
  let raw: string
  try {
    if (!(await fs.exists(file))) {
      diagnostics.push({ path: file, message: '这个目录里没有 SKILL.md,已跳过' })
      return null
    }
    const bytes = await fs.readFileBytes(file, SKILL_FILE_MAX_BYTES)
    raw = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  } catch (err) {
    diagnostics.push({ path: file, message: `读不了这个文件:${msg(err)}` })
    return null
  }

  const fm = parseFrontmatter(raw)
  for (const s of fm.skipped) diagnostics.push({ path: file, message: s })

  /*
    ★ frontmatter 里的 name 胜过目录名,但**不一致时要说一声**。
    不说的话,用户把目录改名之后会发现 `/old-name` 还在,而目录里明明写着新名字。
  */
  const declared = fmString(fm, 'name')
  const name = declared ?? dirName
  if (declared !== undefined && declared !== dirName) {
    diagnostics.push({
      path: file,
      message: `frontmatter 里的 name "${declared}" 和目录名 "${dirName}" 不一致,以 name 为准`
    })
  }
  if (!SKILL_NAME_RE.test(name)) {
    diagnostics.push({ path: file, message: `name "${name}" 不合法,这条 Skill 已作废` })
    return null
  }

  /*
    ★ 缺 description 就整条作废,而不是拿名字凑一个。
    渐进披露里,描述是模型**唯一**的判断依据 —— 目录里只有名字的话,
    模型要么永远不调它,要么见什么都调它。两种都比「这条没装上」更糟。
  */
  const description = fmString(fm, 'description')
  if (description === undefined) {
    diagnostics.push({
      path: file,
      message: 'frontmatter 里缺 description —— 没有描述,模型无从判断什么时候该用它,这条 Skill 已作废'
    })
    return null
  }

  const body = clampWithEllipsis(stripControlChars(fm.body).trim(), SKILL_BODY_MAX)
  if (body === '') {
    diagnostics.push({ path: file, message: '正文是空的,这条 Skill 已作废' })
    return null
  }

  return {
    // ★ id 就是 name:同名时项目覆盖全局,所以两条永远不会共存,
    //   再造一个 `<scope>:<name>` 的 id 只会让工作区的启用清单在
    //   「项目里新增了一条同名 Skill」之后突然失配。
    id: name,
    name,
    description: clampWithEllipsis(description, SKILL_DESCRIPTION_MAX),
    category: fmString(fm, 'category') ?? '未分类',
    source: { kind: 'folder', path: file },
    scope,
    globalEnabled: true,
    frontmatter: {
      ...(fmString(fm, 'model') !== undefined ? { model: fmString(fm, 'model') } : {}),
      // `allowed-tools` 是 CC 的写法;`allowedTools` 是有人会顺手写的那个变体
      ...(allowedTools(fm) !== undefined ? { allowedTools: allowedTools(fm) } : {})
    },
    body
  }
}

function allowedTools(fm: ReturnType<typeof parseFrontmatter>): string[] | undefined {
  return fmList(fm, 'allowed-tools') ?? fmList(fm, 'allowedTools')
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export const SKILL_LIMITS = { SKILL_DESCRIPTION_MAX, SKILL_FILE_MAX_BYTES, MAX_SKILLS } as const
