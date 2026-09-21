/**
 * 内置工具卡片的文案表(折叠态标题 / 右侧摘要 / 兜底标题)。
 *
 * 为了满足「一切用户可见文案走 i18n」这条硬规矩而建:原先这些句子硬编码在
 * `shared/domain/tool-presenter.ts` 的注册表里,英文界面下工具卡片也全是中文。
 * 那边的注册表现在只产出 key + 参数,由本表给出两种语言的句子;
 * `index.tsx` 在模块加载时把 `translate` 注入回注册表,切语言自动生效。
 *
 * ★ `Record<PresenterCopyKey, …>` 是完整性检查:shared 那边新增一个 key
 * 而这里漏翻,**编译期**就挂;两张表也都会被 spread 进 ZH/EN,所以
 * `translate()` 对它们生效,i18n 的键一致性测试顺带覆盖。
 *
 * ★ 带 `{target}` 的条目必须处理 target 为空串:流式中途参数还没到齐时,
 * 注册表会传空串进来,要退化成「读取…」这类进行时短语,而不是残缺的句子。
 * 参数名与注册表约定一致:target / count / code / days / time。
 */
import type { PresenterCopyKey } from '../../../shared/domain/tool-presenter'
import type { MessageValue } from './index'

type Params = Record<string, string | number>

/** 标题条目的统一形状:「动词 + 目标」,目标缺失时补省略号(按语言各自给)。 */
const verbTitle = (verb: string): MessageValue => ({ target }: Params) => {
  const t = typeof target === 'string' && target !== '' ? target : ''
  return t === '' ? `${verb}…` : `${verb} ${t}`
}

// 星期以数字串传入('135',0=周日…6=周六,与 Date.prototype.getDay() 同值域)
const WEEKDAY_ZH = ['日', '一', '二', '三', '四', '五', '六']
const WEEKDAY_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const weekdayZh = (days: string): string =>
  days.split('').map((d) => WEEKDAY_ZH[Number(d)] ?? '').join('')

const weekdayEn = (days: string): string =>
  days.split('').map((d) => WEEKDAY_EN[Number(d)] ?? '').filter((name) => name !== '').join(', ')

export const toolPresenterZh: Record<PresenterCopyKey, MessageValue> = {
  'chat.tool.title.read': verbTitle('读取'),
  'chat.tool.title.ls': verbTitle('列目录'),
  'chat.tool.title.write': verbTitle('写入'),
  'chat.tool.title.edit': verbTitle('编辑'),
  'chat.tool.title.glob': verbTitle('查找'),
  'chat.tool.title.grep': verbTitle('搜索'),
  'chat.tool.title.bash': verbTitle('执行'),
  'chat.tool.title.bashOutput': verbTitle('读后台输出'),
  'chat.tool.title.killShell': verbTitle('停止后台命令'),
  'chat.tool.title.webFetch': verbTitle('抓取'),
  'chat.tool.title.webSearch': verbTitle('搜索网络'),
  'chat.tool.title.skill': verbTitle('技能'),
  'chat.tool.title.task': verbTitle('子代理'),
  'chat.tool.title.taskWithDesc': ({ target }: Params) => `子代理:${String(target ?? '')}`,
  'chat.tool.title.scheduleCreate': verbTitle('新建定时任务'),
  'chat.tool.title.scheduleUpdate': verbTitle('修改定时任务'),
  'chat.tool.title.scheduleDelete': verbTitle('删除定时任务'),
  'chat.tool.title.todo': '更新任务清单',
  'chat.tool.title.scheduleList': '查看定时任务',
  'chat.tool.title.askUser': '向你提问',
  'chat.tool.title.proposeGoal': '提议完成条件',
  'chat.tool.title.planReview': '提交计划待审',
  // target 是模型写的 snake_case 标识(已去下划线),属领域值,原样拼进来
  'chat.tool.title.widget': verbTitle('画图'),
  'chat.tool.title.readMe': '加载可视化规范',
  'chat.tool.fallback': '工具调用',
  'chat.tool.summary.lines': '{count} 行',
  'chat.tool.summary.items': '{count} 项',
  'chat.tool.summary.files': '{count} 个文件',
  'chat.tool.summary.matches': '{count} 处',
  'chat.tool.summary.results': '{count} 条',
  'chat.tool.summary.outputLines': '{count} 行输出',
  'chat.tool.summary.createdLines': '新建 {count} 行',
  'chat.tool.summary.created': '新建',
  'chat.tool.summary.replaced': '替换 {count} 处',
  'chat.tool.summary.exitCode': '退出码 {code}',
  'chat.tool.summary.noOutput': '无输出',
  'chat.tool.summary.running': '运行中',
  'chat.tool.summary.stopped': '已停止',
  'chat.tool.summary.tasks': '{count} 条',
  'chat.tool.summary.questions': '{count} 道题',
  'chat.tool.summary.scheduleDaily': '每天 {time}',
  'chat.tool.summary.scheduleWeekly': ({ days, time }: Params) =>
    `周${weekdayZh(String(days ?? ''))} ${String(time ?? '')}`
}

export const toolPresenterEn: Record<PresenterCopyKey, MessageValue> = {
  'chat.tool.title.read': verbTitle('Reading'),
  'chat.tool.title.ls': verbTitle('Listing'),
  'chat.tool.title.write': verbTitle('Writing'),
  'chat.tool.title.edit': verbTitle('Editing'),
  'chat.tool.title.glob': verbTitle('Finding'),
  'chat.tool.title.grep': verbTitle('Searching'),
  'chat.tool.title.bash': verbTitle('Running'),
  'chat.tool.title.bashOutput': verbTitle('Reading output'),
  'chat.tool.title.killShell': verbTitle('Stopping'),
  'chat.tool.title.webFetch': verbTitle('Fetching'),
  'chat.tool.title.webSearch': verbTitle('Web search'),
  'chat.tool.title.skill': verbTitle('Skill'),
  'chat.tool.title.task': verbTitle('Subagent'),
  'chat.tool.title.taskWithDesc': ({ target }: Params) => `Subagent: ${String(target ?? '')}`,
  'chat.tool.title.scheduleCreate': verbTitle('New scheduled task'),
  'chat.tool.title.scheduleUpdate': verbTitle('Editing scheduled task'),
  'chat.tool.title.scheduleDelete': verbTitle('Deleting scheduled task'),
  'chat.tool.title.todo': 'Update todo list',
  'chat.tool.title.scheduleList': 'View scheduled tasks',
  'chat.tool.title.askUser': 'Asking you',
  'chat.tool.title.proposeGoal': 'Proposing a goal',
  'chat.tool.title.planReview': 'Submitting the plan',
  'chat.tool.title.widget': verbTitle('Visualizing'),
  'chat.tool.title.readMe': 'Loading visual guidelines',
  'chat.tool.fallback': 'Tool call',
  'chat.tool.summary.lines': '{count} lines',
  'chat.tool.summary.items': '{count} items',
  'chat.tool.summary.files': '{count} files',
  'chat.tool.summary.matches': '{count} matches',
  'chat.tool.summary.results': '{count} results',
  'chat.tool.summary.outputLines': '{count} lines of output',
  'chat.tool.summary.createdLines': 'Created {count} lines',
  'chat.tool.summary.created': 'Created',
  'chat.tool.summary.replaced': ({ count }: Params) =>
    count === 1 ? '1 replacement' : `${String(count)} replacements`,
  'chat.tool.summary.exitCode': 'Exit code {code}',
  'chat.tool.summary.noOutput': 'No output',
  'chat.tool.summary.running': 'Running',
  'chat.tool.summary.stopped': 'Stopped',
  'chat.tool.summary.tasks': '{count} tasks',
  'chat.tool.summary.questions': ({ count }: Params) =>
    count === 1 ? '1 question' : `${String(count)} questions`,
  'chat.tool.summary.scheduleDaily': 'Daily at {time}',
  'chat.tool.summary.scheduleWeekly': ({ days, time }: Params) =>
    `${weekdayEn(String(days ?? ''))} ${String(time ?? '')}`
}
