/**
 * 内置工具清单 —— 「注册了哪些内置工具」的唯一出处。
 *
 * 名字全部照搬 Claude Code(`Read` / `Write` / `Edit` / `LS` / `Glob` / `Grep` …),
 * 理由见 `fs.ts` 的文件头。
 *
 * ★ **`echoTool` 必须留在第一位。**
 *
 * `src/main/kernel/upstream/demo.ts:318` 拿 `tools[0]` 按名字调用,并按 `echo`
 * 的入参构造调用。顺序一变,演示上游就改去调 `Read`,而它构造的入参对不上 ——
 * `agent-run.test.ts` 里那条 `'演示值:text'` 会以**完全看不出根因**的方式挂掉:
 * 报错停在断言上,而真正的原因在另一个文件的数组顺序里。
 * `index.test.ts` 有一条用例专门钉住这一点,失败信息里写明了它保护谁。
 */
import type { ToolRegistration } from '../registry'
import { bashTool } from './bash'
import { echoTool } from './echo'
import { editTool, lsTool, readTool, writeTool } from './fs'
import { globTool, grepTool } from './search'
import { skillTool } from './skill'
import { taskTool } from './task'
import { todoWriteTool } from './todo'
import { webFetchTool } from './web'
import { webSearchTool } from './web-search'
import { browserTools } from './browser'
import { askUserTool } from './interaction'
import { enterPlanModeTool, exitPlanModeTool, planUpdateTool } from './plan'

export function builtinTools(): ToolRegistration[] {
  return [
    // ★ 第一位是 echo,别动 —— 见上面的说明
    echoTool,
    readTool,
    writeTool,
    editTool,
    lsTool,
    globTool,
    grepTool,
    bashTool,
    todoWriteTool,
    webFetchTool,
    skillTool,
    webSearchTool,
    askUserTool,
    enterPlanModeTool,
    planUpdateTool,
    exitPlanModeTool,
    ...browserTools,
    /*
      ★ `Task` 是唯一一个**每次现造**的内置工具:它的 description 里逐字带着
      当前可用的子代理清单(照搬 CC),而那份清单会随目录重扫而变。
      `runtime.ts` 在每次 run 之前会用新的清单再 `register()` 一次 ——
      注册表按 internalId 幂等替换且保住 externalName,所以历史转录不会失配。
    */
    taskTool()
  ]
}

export { bashTool } from './bash'
export { echoTool } from './echo'
export { editTool, lsTool, readTool, writeTool } from './fs'
export { globTool, grepTool } from './search'
export { skillTool } from './skill'
export { taskTool } from './task'
export { todoWriteTool } from './todo'
export { webFetchTool } from './web'
export { webSearchTool } from './web-search'
export { browserTools } from './browser'
