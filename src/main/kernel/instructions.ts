/**
 * `AGENTS.md` 加载器 —— 把「这一个仓库自己的规矩」搬进模型的上下文。
 *
 * 系统提示词只装得下「对所有会话都成立」的东西。而「这个仓库用 pnpm 不用 npm」
 * 「组件一律放 `src/renderer/src/views/`」「提交信息写中文」是**这一个仓库**的事实,
 * 今天模型只能靠读代码去猜,猜错的成本是一次返工。CC 用 `CLAUDE.md` 解决,
 * 我们用 `AGENTS.md`,只认这一个名字(不做 `CLAUDE.md` 回落)。
 *
 * ```
 * <appData>/AGENTS.md          全局:用户对所有项目的偏好
 * <workspaceRoot>/AGENTS.md   项目:这个仓库自己的规矩
 * ```
 *
 * ## 和 `skill/load.ts` 刻意不同的两处
 *
 * 1. **不建注册表单例。** `skillRegistry()` / `agentRegistry()` 是单例,是因为
 *    `Skill` / `Task` 工具要在运行期查它们。AGENTS.md 没有任何工具会查,
 *    它只在组装那一刻用一次 —— 一个返回字符串的 async 函数就够了。
 *    ★ 顺带躲掉一个已知问题:`skill/registry.ts` 那个单例没有 test reset 钩子,
 *    测试之间会串。不引入新单例就不需要解决它。
 * 2. **没有 frontmatter。** 这是纯 Markdown 正文,没有 `name` / `description`
 *    要解析,`parseFrontmatter` 不参与。
 *
 * ## 它是不可信输入
 *
 * clone 了别人的仓库,就等于把别人写的一段文字送进了**消息流** —— 比系统提示词
 * 还靠近生成点。所以三道防线一道不能少:削控制字符、中和 `<system-reminder>`
 * 标签(`kernel/untrusted.ts`)、限长。而真正的防线在权限层:AGENTS.md 里
 * 写什么都不能让一次工具调用跳过 `approve`。
 */
import type { KernelFs } from './host'
import { clampWithEllipsis, stripControlChars } from './text'
import { PathEscapeError, resolveInWorkspace } from './tool/path-guard'
import { neutralizeReminderTags } from './untrusted'

/** ★ 只认这一个名字。 */
export const INSTRUCTIONS_FILE = 'AGENTS.md'

/**
 * 拼接之后的字符上限。
 *
 * ★ 两层是**拼接**不是覆盖,所以预算按**和**算 —— 和 `scanSkills` 那种
 * 「同名时项目覆盖全局」不一样。项目规矩写到 32KB 就不是规矩了,是文档;
 * 而它每一轮都要重发。
 */
export const INSTRUCTIONS_MAX = 32 * 1024

/** 单份文件读进内存的字节上限。留出余量,好让「两份加起来超了」被上面那道截住。 */
const INSTRUCTIONS_FILE_MAX_BYTES = 64 * 1024

/** 两份都在时的分隔。★ 全局在前、项目在后 —— 后出现的离生成点更近,项目应当压过全局。 */
const SEPARATOR = '\n\n--- (project AGENTS.md — these win over the global ones above) ---\n\n'

export interface InstructionsDiagnostic {
  path: string
  message: string
}

export interface InstructionsScanInput {
  fs: KernelFs
  /** `<appData>`。空串 = 跳过全局这一层。 */
  globalRoot: string
  /** `<workspaceRoot>`。空串 = 没有工作区。 */
  projectRoot: string
}

export interface InstructionsScanResult {
  /** 已拼接、已消毒的正文。两份都没有时是空串。 */
  text: string
  diagnostics: InstructionsDiagnostic[]
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * 扫两层,产出一段正文。
 *
 * ★ **永不 throw** —— 理由和 `scanSkills` 一模一样:一份坏掉的 AGENTS.md
 * 不该让整次组装失败。读不了就记一行诊断,当它不存在。
 */
export async function scanInstructions(
  input: InstructionsScanInput
): Promise<InstructionsScanResult> {
  const diagnostics: InstructionsDiagnostic[] = []
  const chunks: string[] = []

  for (const root of [input.globalRoot, input.projectRoot]) {
    if (root === '') continue
    const text = await readOne(input.fs, root, diagnostics)
    if (text !== '') chunks.push(text)
  }

  return { text: clampWithEllipsis(chunks.join(SEPARATOR), INSTRUCTIONS_MAX), diagnostics }
}

async function readOne(
  fs: KernelFs,
  root: string,
  diagnostics: InstructionsDiagnostic[]
): Promise<string> {
  let file: string
  try {
    /*
      ★ 必须过围栏,不能 `join`。一条 `<workspaceRoot>/AGENTS.md -> ~/.ssh/id_rsa`
      的软链,配上「每一轮都把这份正文发给上游」,就是一次静默的密钥外泄。
      全局那层同样要过 —— userData 也可能被人放了软链进去。
    */
    file = resolveInWorkspace(root, INSTRUCTIONS_FILE)
  } catch (err) {
    if (err instanceof PathEscapeError) {
      // ★ 只说模型/用户自己给的那个名字,不回显目标路径 —— 那是逃逸想探的东西
      diagnostics.push({ path: `${root}/${INSTRUCTIONS_FILE}`, message: '它指向了目录之外,已跳过' })
      return ''
    }
    // 目录本身不存在时 realpath 会抛,这是常态(没建过 userData / 没有工作区)
    return ''
  }

  let raw: string
  try {
    if (!(await fs.exists(file))) return '' // 没有这个文件是常态,不是错误
    const bytes = await fs.readFileBytes(file, INSTRUCTIONS_FILE_MAX_BYTES)
    raw = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  } catch (err) {
    diagnostics.push({ path: file, message: `读不了这个文件:${msg(err)}` })
    return ''
  }

  return sanitizeInstructions(raw)
}

/**
 * 三道防线,顺序有意义:先削控制字符(ANSI 转义、NUL),再中和标签,
 * 最后由调用方按**总量**限长。
 *
 * ★ 单独导出,是因为 git 分支名与提交标题走的是同一条路径(它们同样来自
 * clone 来的仓库),而「同一个答案不该有两份」。
 */
export function sanitizeInstructions(raw: string): string {
  return neutralizeReminderTags(stripControlChars(raw)).trim()
}
