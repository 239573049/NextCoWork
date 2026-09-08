/**
 * `mergeSettings` 的用例里,最重要的是「兄弟属性还在」那一条 ——
 * 它就是主进程原来那句「浅合并够用」的反例,也是这个函数存在的全部理由。
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_PROXY } from '../proxy'
import { DEFAULT_CUSTOM_SEED } from '../theme'
import {
  DEFAULT_SETTINGS,
  PERSONALIZATION_MAX,
  mergeSettings,
  type AppSettings
} from '../settings'

const base = (): AppSettings => structuredClone(DEFAULT_SETTINGS)

describe('mergeSettings', () => {
  it('快捷键缺席时回退默认值，并允许单独更新', () => {
    const legacy = structuredClone(DEFAULT_SETTINGS) as Partial<AppSettings>
    delete legacy.shortcuts
    expect(mergeSettings(DEFAULT_SETTINGS, legacy).shortcuts).toEqual({ openSettings: 'CmdOrCtrl+,' })
    expect(mergeSettings(base(), { shortcuts: { openSettings: 'CmdOrCtrl+K' } }).shortcuts.openSettings).toBe('CmdOrCtrl+K')
  })

  it('拒绝空快捷键，避免设置后无法打开设置', () => {
    expect(mergeSettings(base(), { shortcuts: { openSettings: '  ' } }).shortcuts.openSettings).toBe('CmdOrCtrl+,')
  })
  it('旧设置缺少 data 时自动补默认本地备份设置', () => {
    const legacy = structuredClone(DEFAULT_SETTINGS) as Partial<AppSettings>
    delete legacy.data
    const restored = mergeSettings(DEFAULT_SETTINGS, legacy)
    expect(restored.data).toEqual({ backupDirectory: null, backupFrequency: 'manual' })
  })

  it('data 深合并：改频率不丢目录，改目录不丢频率', () => {
    let settings = mergeSettings(base(), { data: { backupDirectory: '/tmp/ncw-backups' } })
    settings = mergeSettings(settings, { data: { backupFrequency: 'weekly' } })
    expect(settings.data).toEqual({
      backupDirectory: '/tmp/ncw-backups',
      backupFrequency: 'weekly'
    })
  })

  it('损坏的 data 字段逐项回退，不让旧设置把页面变成 undefined', () => {
    const settings = mergeSettings(base(), {
      data: {
        backupDirectory: 42,
        backupFrequency: 'hourly'
      } as unknown as AppSettings['data']
    })
    expect(settings.data).toEqual(DEFAULT_SETTINGS.data)
  })

  it('嵌套块只给一个属性时,兄弟属性保留', () => {
    const s = mergeSettings(base(), { gateway: { preferredPort: 19837 } })
    expect(s.gateway).toEqual({ enabled: false, preferredPort: 19837, failover: false })
  })

  it('同一块里连续两次单属性写入不互相覆盖', () => {
    // 这正是浅合并下会退化的那条路径:两次写都基于同一份旧值
    let s = base()
    s = mergeSettings(s, { notifications: { taskComplete: false } })
    s = mergeSettings(s, { notifications: { planApproval: false } })
    expect(s.notifications).toEqual({
      taskComplete: false,
      permissionApproval: true,
      planApproval: false
    })
  })

  it('六个嵌套块都走深合并', () => {
    const s = mergeSettings(base(), {
      subagent: { globalLimit: 8 },
      proxy: { host: '127.0.0.1', port: 7890 }
    })
    expect(s.subagent).toEqual({ model: '', perSessionLimit: 4, globalLimit: 8 })
    // 只给了两段,另外六段是缺省值 —— 这一条钉的就是「兄弟属性还在」
    expect(s.proxy).toEqual({
      ...DEFAULT_PROXY,
      host: '127.0.0.1',
      port: 7890
    })
  })

  it('顶层标量整个覆盖', () => {
    const s = mergeSettings(base(), { theme: 'light', defaultPermissionMode: 'ask' })
    expect(s.theme).toBe('light')
    expect(s.defaultPermissionMode).toBe('ask')
    expect(s.locale).toBe('zh-CN')
  })

  it('空 patch 是恒等', () => {
    expect(mergeSettings(base(), {})).toEqual(DEFAULT_SETTINGS)
  })

  it('不改动入参 —— 返回的嵌套块也不与入参共享引用', () => {
    const current = base()
    const next = mergeSettings(current, { gateway: { enabled: true } })
    expect(current.gateway.enabled).toBe(false)
    next.subagent.perSessionLimit = 99
    expect(current.subagent.perSessionLimit).toBe(4)
  })
})

/**
 * 主题那两块单拎出来:它们是「主题」页上**紧挨着的两组控件**,
 * 而这一页正是最容易连点的一页(挑一张卡、再挑一个渲染方式、再重掷一次随机)。
 */
describe('mergeSettings · 主题', () => {
  /**
   * ★ 这一条就是 `imageTheme.id` 写成可空**字段**、而不是把整块写成可空的理由。
   * 整块可空的话 patch 类型会退化成「整个给」,于是这里第二次写会带着
   * 第一次写之前的 `render` 一起盖回去 —— 表现是「我明明切了覆盖色,
   * 换了张图它自己变回模糊了」。
   */
  it('选图与渲染方式互不覆盖', () => {
    let s = base()
    s = mergeSettings(s, { imageTheme: { render: 'overlay' } })
    s = mergeSettings(s, { imageTheme: { id: 'terracotta' } })
    expect(s.imageTheme).toEqual({ id: 'terracotta', render: 'overlay' })
  })

  /** 取消选图是 `id: null`,不是把这一块整个抹掉 —— 渲染方式要留着 */
  it('取消选图保留渲染方式', () => {
    let s = mergeSettings(base(), { imageTheme: { id: 'terracotta', render: 'overlay' } })
    s = mergeSettings(s, { imageTheme: { id: null } })
    expect(s.imageTheme).toEqual({ id: null, render: 'overlay' })
  })

  /** 重掷「随机」只动 seed;id 还得是 `random`,否则下一次重掷就掷不动了 */
  it('重掷随机只动 seed', () => {
    const s = mergeSettings(base(), { colorTheme: { id: 'random', seed: 1 } })
    const again = mergeSettings(s, { colorTheme: { seed: 2 } })
    expect(again.colorTheme).toEqual({ id: 'random', seed: 2, custom: DEFAULT_CUSTOM_SEED })
  })

  /**
   * ★ 「随机」的种子和「自定义」的颜色住在同一块里,而这两栏是同一处界面上
   * 紧挨着的两个控件 —— 掷一次随机就把用户挑的那个色抹掉的话,
   * 切回「自定义」会发现颜色变了,而中间他什么都没碰过。
   */
  it('重掷随机不动自定义色,反过来也一样', () => {
    let s = mergeSettings(base(), { colorTheme: { id: 'custom', custom: '#c04a2b' } })
    s = mergeSettings(s, { colorTheme: { id: 'random', seed: 9 } })
    expect(s.colorTheme.custom).toBe('#c04a2b')
    s = mergeSettings(s, { colorTheme: { id: 'custom', custom: '#5b7fa8' } })
    expect(s.colorTheme.seed).toBe(9)
  })

  /**
   * ★ 老库里这一块只有 `{ id, seed }`。`repo.getSettings` 走的是
   * `mergeSettings(DEFAULT_SETTINGS, 磁盘上那份)`,所以缺席的字段自动落到默认值 ——
   * 「自定义」这一栏不需要写迁移代码,但这条路必须有用例钉着:
   * 落不到默认值的话,`custom` 会是 `undefined`,而 `specFromSeed(undefined)`
   * 吐出来的是一整套 `#NaNNaNNaN`。
   */
  it('老设置里没有 custom 时补上默认值', () => {
    const legacy = { id: 'opulent', seed: 3 }
    const s = mergeSettings(DEFAULT_SETTINGS, { colorTheme: legacy })
    expect(s.colorTheme).toEqual({ id: 'opulent', seed: 3, custom: DEFAULT_CUSTOM_SEED })
  })

  /**
   * 外观模式与颜色是**两件事**:切深浅不该把用户选的那套颜色主题带走。
   * (`tokensOf` 拿 appearance 去 `BASE[appearance]` 里取基准表,颜色主题是另一个入参。)
   */
  it('切外观模式不动颜色主题', () => {
    const s = mergeSettings(base(), { colorTheme: { id: 'opulent' } })
    expect(mergeSettings(s, { theme: 'dark' }).colorTheme.id).toBe('opulent')
  })
})

/**
 * 代理那一块从 `{enabled,url}` 拆成八段(`proxy.ts` 的文件头解释了为什么)。
 * 拆开之后有两件事必须钉住,它们的失败症状都很难从界面上倒推回来。
 */
describe('mergeSettings · 代理', () => {
  /**
   * ★ 旧库里存着的是 `{enabled, url}`。用户升上来时那条 `url` 会**作为 patch**
   * 走进 `mergeSettings`(`repo.getSettings` 就是拿整行 JSON 当 patch 合的),
   * 所以迁移必须在这里发生,而不是在某个一次性的启动脚本里。
   */
  it('旧库里的 url 被拆成 scheme/host/port', () => {
    const legacy = { url: 'http://127.0.0.1:7890', enabled: true } as unknown as Partial<
      AppSettings['proxy']
    >
    const s = mergeSettings(base(), { proxy: legacy })
    expect(s.proxy.mode).toBe('manual')
    expect(s.proxy.scheme).toBe('http')
    expect(s.proxy.host).toBe('127.0.0.1')
    expect(s.proxy.port).toBe(7890)
    expect(s.proxy.enabled).toBe(true)
  })

  /**
   * ★ 这一条防的是一个具体的坏体验:表单里改了地址,一松手它又变回旧值。
   * 迁移只在 host / mode 都没给的时候才动手 —— 一旦用户填了新地址,
   * 旧 url 就再没有发言权了。
   */
  it('用户填了新地址时,旧 url 不再覆盖它', () => {
    const patch = { url: 'http://127.0.0.1:7890', host: '10.0.0.1' } as unknown as Partial<
      AppSettings['proxy']
    >
    expect(mergeSettings(base(), { proxy: patch }).proxy.host).toBe('10.0.0.1')
  })

  it('只改一个开关不动其余七段', () => {
    let s = mergeSettings(base(), { proxy: { mode: 'manual', host: 'p.example', port: 1080 } })
    s = mergeSettings(s, { proxy: { enabled: true } })
    expect(s.proxy.host).toBe('p.example')
    expect(s.proxy.port).toBe(1080)
    expect(s.proxy.mode).toBe('manual')
  })
})

/**
 * 个性化那三栏是**唯一**会被原样拼进系统提示词的设置(见
 * `main/kernel/context-assembler.ts` 的 `buildPersonalizationSection`),
 * 所以这一节守的不是「存得下」,是「存进去的东西有边界」。
 */
describe('mergeSettings · 个性化', () => {
  it('三栏深合并:改全局提示词不擦掉姓名', () => {
    let s = mergeSettings(base(), { personalization: { name: '张三' } })
    s = mergeSettings(s, { personalization: { instructions: '请用中文回答' } })
    expect(s.personalization).toEqual({
      name: '张三',
      background: '',
      instructions: '请用中文回答'
    })
  })

  it('★ 超长的值在**落库前**就被截断 —— 输入框的 maxLength 拦不住 IPC', () => {
    const s = mergeSettings(base(), {
      personalization: { instructions: 'x'.repeat(PERSONALIZATION_MAX.instructions + 500) }
    })
    expect(s.personalization.instructions).toHaveLength(PERSONALIZATION_MAX.instructions)
  })

  it('非字符串逐项回退,不让一个坏字段把整页变成 undefined', () => {
    const s = mergeSettings(base(), {
      personalization: { name: 42, background: null, instructions: '好的' } as unknown as
        AppSettings['personalization']
    })
    expect(s.personalization).toEqual({ name: '', background: '', instructions: '好的' })
  })

  it('旧库里缺这一块时补默认空值', () => {
    const legacy = structuredClone(DEFAULT_SETTINGS) as Partial<AppSettings>
    delete legacy.personalization
    const restored = mergeSettings(DEFAULT_SETTINGS, legacy)
    expect(restored.personalization).toEqual({ name: '', background: '', instructions: '' })
  })
})

/**
 * ★★ 「模型别名 + 供应商」三个配对必须**成对写**。
 *
 * 这一组是防**同一个 bug 在它自己的修复里复活**:只写别名、让旧 providerId
 * 留下来,得到的就是「新别名 + 旧供应商」—— 和用户报的「选了 Codex 却发给
 * RoutinAI」是同一个形状。三处里 `subagent` 最险,因为它走的是浅合并
 * (`{ ...next.subagent, ...patch.subagent }`),**默认行为恰恰就是保留旧值**。
 */
describe('mergeSettings 的模型配对', () => {
  const pinned = (): AppSettings => ({
    ...base(),
    defaultModel: 'shared', defaultModelProviderId: 'codex',
    permissionReviewerModel: 'shared', permissionReviewerModelProviderId: 'codex',
    subagent: { ...base().subagent, model: 'shared', modelProviderId: 'codex' }
  })

  it('★ 只给 defaultModel 时,旧的供应商被清掉而不是留下', () => {
    const next = mergeSettings(pinned(), { defaultModel: 'other' })
    expect(next.defaultModel).toBe('other')
    expect(next.defaultModelProviderId).toBeUndefined()
  })

  it('★ subagent 的浅合并不能把旧供应商漏下来', () => {
    const next = mergeSettings(pinned(), { subagent: { model: 'other' } })
    expect(next.subagent.model).toBe('other')
    expect(next.subagent.modelProviderId).toBeUndefined()
    // 兄弟属性照旧不受影响 —— 那是这个函数本来的职责
    expect(next.subagent.perSessionLimit).toBe(DEFAULT_SETTINGS.subagent.perSessionLimit)
  })

  it('★ 审核模型同理', () => {
    const next = mergeSettings(pinned(), { permissionReviewerModel: 'other' })
    expect(next.permissionReviewerModel).toBe('other')
    expect(next.permissionReviewerModelProviderId).toBeUndefined()
  })

  it('成对给出时两个都写进去', () => {
    const next = mergeSettings(pinned(), { defaultModel: 'other', defaultModelProviderId: 'routin' })
    expect(next).toMatchObject({ defaultModel: 'other', defaultModelProviderId: 'routin' })
  })

  it('没提到模型的 patch 不动这三对', () => {
    const next = mergeSettings(pinned(), { theme: 'dark' })
    expect(next.defaultModelProviderId).toBe('codex')
    expect(next.subagent.modelProviderId).toBe('codex')
    expect(next.permissionReviewerModelProviderId).toBe('codex')
  })
})
