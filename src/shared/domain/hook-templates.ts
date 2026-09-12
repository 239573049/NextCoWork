/**
 * 钩子模板 —— 新建弹层里那个「从模板」下拉。
 *
 * ## 为什么是模板，不是「出厂就启用」
 *
 * 项目里已经有两个内置资源（`BUILTIN_COMMANDS` 的 `/init`、`GENERAL_PURPOSE`
 * 子代理），但它们和钩子有一条本质区别：**那两个是纯数据（提示词），
 * 钩子执行本机命令。**
 *
 * 1. **信任**：用户装了应用，结果他机器上开始跑我们写的 shell —— 哪怕内容无害，
 *    这件事本身就该由他点头。
 * 2. **多半会失败**：我们不知道他机器上有没有 prettier / osascript / python3。
 *    出厂钩子失败会常驻在 `hooks:diagnostics` 的红条里，而一条长期亮着的警告
 *    等于没有警告 —— 真正的失败从此没人看。
 * 3. **本仓库就是反例**：这个项目没有 prettier 配置，一条「写完自动格式化」的
 *    出厂钩子在这里是净损害。
 *
 * 所以：选中模板只**填充表单**，用户可改、可「试运行」，确认后才保存。
 *
 * ## 两条写模板时必须守住的规矩
 *
 * ★ **matcher 一律用裸工具名**（`Bash` 而不是 `Bash(rm:*)`）。前缀规则带着一条
 *   shell 接续符的保护，那是给「放行」设计的（不命中就不放行，偏保守）；用在
 *   拦截上方向正好反了 —— `rm -rf / && echo ok` 会直接绕过去。判断留给脚本做。
 *   （`hasWeakBlockingMatcher` 会对这种写法出警告，模板自己不该踩。）
 *
 * ★ **判断逻辑用 `python3` 读 stdin**，不用 `jq`：macOS 自带 python3，而 jq 要另装。
 *   纯 shell 的 `grep -q '"toolInternalId":"Bash"'` 也可行（集成测试里验证过），
 *   但取 `toolInput` 的嵌套字段还是 python 稳。
 */
import type { HookEvent } from './hook'

export interface HookTemplate {
  /** 也是 i18n key 的后缀：`hooks.template.<id>.name` / `.description`。 */
  id: string
  event: HookEvent
  /** 缺省 = 每次都触发。★ 阻断型模板必须是裸工具名，见文件头。 */
  matcher?: string
  command: string
  timeoutSeconds: number
  /** 只在这个平台上有意义；UI 据此标注。 */
  platform?: 'darwin'
}

/** 从 stdin 那行 JSON 里取一个 `toolInput` 字段。模板共用这一小段。 */
const readToolInput = (field: string): string =>
  `python3 -c 'import json,sys; print((json.load(sys.stdin).get("toolInput") or {}).get("${field}",""))'`

export const HOOK_TEMPLATES: readonly HookTemplate[] = [
  {
    id: 'danger-guard',
    event: 'PreToolUse',
    matcher: 'Bash',
    timeoutSeconds: 5,
    // 模式匹配在脚本里做，不在 matcher 里 —— 理由见文件头那条。
    command: `python3 -c '
import json, sys
cmd = (json.load(sys.stdin).get("toolInput") or {}).get("command", "")
patterns = ["rm -rf /", "rm -rf ~", "rm -rf *", "git push --force", "git push -f",
            "git reset --hard", "DROP TABLE", "DROP DATABASE", "mkfs", "> /dev/sd",
            "chmod -R 777 /", ":(){ :|:& };:"]
hit = next((p for p in patterns if p in cmd), None)
if hit:
    sys.stderr.write("命中危险模式 %s —— 这条命令被钩子拦下了" % hit)
    sys.exit(2)
'`
  },
  {
    id: 'protect-secrets',
    event: 'PreToolUse',
    matcher: 'Write',
    timeoutSeconds: 5,
    command: `python3 -c '
import json, os, sys
p = (json.load(sys.stdin).get("toolInput") or {}).get("file_path", "")
name = os.path.basename(p)
blocked = name in (".env", ".env.local", ".env.production", "id_rsa", "id_ed25519",
                   ".npmrc", ".netrc", "credentials") or name.endswith((".pem", ".key", ".p12"))
if blocked or "/.ssh/" in p or "/.aws/" in p or "/.gnupg/" in p:
    sys.stderr.write("这是凭证类文件，钩子拒绝了写入：%s" % p)
    sys.exit(2)
'`
  },
  {
    id: 'notify-done',
    event: 'Stop',
    timeoutSeconds: 10,
    platform: 'darwin',
    // `|| true`：通知权限被拒时 osascript 会非零退出，而那不该记成钩子失败。
    command: `osascript -e 'display notification "一轮运行结束" with title "NextCoWork"' 2>/dev/null || true`
  },
  {
    id: 'inject-branch',
    event: 'UserPromptSubmit',
    timeoutSeconds: 5,
    // 不在 git 仓库里就什么都不输出 —— 没有 additionalContext，等于这条没发生。
    command: `git branch --show-current 2>/dev/null | sed 's/^/当前 git 分支：/'`
  },
  {
    id: 'format-after-write',
    event: 'PostToolUse',
    matcher: 'Write',
    timeoutSeconds: 30,
    /*
      ★ 骨架给全，真正那条命令**留给用户填**。
      不预置 `npx prettier --write` 是因为：格式化工具、配置、甚至该不该格式化，
      每个仓库都不一样 —— 这个仓库本身就没有 prettier 配置，裸跑会改坏风格。
      猜错的代价是「模型写完的文件被悄悄改了」，比不做这件事糟得多。
    */
    command: `FILE=$(${readToolInput('file_path')})
[ -z "$FILE" ] && exit 0

# ↓ 换成你项目自己的格式化命令，例如：
# npx prettier --write "$FILE"
# cargo fmt -- "$FILE"
true`
  }
]

export function findHookTemplate(id: string): HookTemplate | undefined {
  return HOOK_TEMPLATES.find((t) => t.id === id)
}
