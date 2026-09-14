/**
 * 「一句话都没聊」时的占用归因。
 *
 * ★ 这条通道存在的全部理由是**时机**:一个挂满 MCP 的工作区在发第一条消息之前
 * 就已经少掉半个窗口,而那个数只有在发第一条之前看见才是可行动的。所以这里量的
 * 不是算得准不准(那是 `context-assembler.test.ts` 的事),而是**空会话到底有没有数**。
 *
 * ★ 另一半是它**不许做什么**:不重扫技能目录、不去连 MCP、不租工作区环境。
 * 那三件事各自都会动全局单例或者起子进程,而这条通道是用户每点开一次上下文菜单
 * 就被调一次的。这里用「只喂只读入口」的方式把它钉住 —— 哪天有人在实现里加了
 * `refreshSkills` 或 `prepareWorkspaceMcp`,runtime 的 mock 里没有那两个导出,
 * 当场就是 import 失败,而不是悄悄多出一堆子进程。
 */
import { describe, expect, it, vi } from 'vitest'
import type { ContextSegmentKind } from '../../../shared/agent/context-management'
import { ToolRegistry } from '../../kernel/tool/registry'

const mocks = vi.hoisted(() => ({
  workspace: undefined as unknown,
  history: [] as unknown[],
  mcp: undefined as unknown,
  instructions: '' as string | Error
}))

const tools = new ToolRegistry()
tools.register({
  internalId: 'Read',
  description: '读一个文件'.repeat(10),
  parameters: { type: 'object', properties: {} },
  source: { kind: 'builtin' },
  execute: async () => ({ content: '' })
} as never)

const mcpTools = new ToolRegistry()
mcpTools.register({
  internalId: 'mcp__github__pr',
  description: '列出 PR'.repeat(50),
  parameters: { type: 'object', properties: {} },
  source: { kind: 'mcp', serverId: 'github' },
  execute: async () => ({ content: '' })
} as never)

vi.mock('electron', () => ({ dialog: {} }))
vi.mock('../../runtime', () => ({
  getTools: () => tools,
  connectedWorkspaceMcpTools: () => mocks.mcp,
  loadInstructions: async () => { if (mocks.instructions instanceof Error) throw mocks.instructions; return mocks.instructions },
  getHost: () => ({ clock: { now: () => 0 }, platform: { os: 'darwin', arch: 'arm64', shell: 'zsh' } }),
  getRouter: () => ({ resolveModel: () => ({ contextWindow: 200_000, maxOutputTokens: 8192, capabilities: { thinking: false } }) })
}))
vi.mock('../../state/store', () => ({
  store: {
    getWorkspace: () => mocks.workspace,
    getHistory: () => mocks.history,
    getSettings: () => ({}),
    getDisabledSkillIds: () => []
  }
}))
vi.mock('../../kernel/agent/registry', () => ({ agentRegistry: () => ({ list: () => [] }) }))
vi.mock('../../kernel/skill/registry', () => ({ skillRegistry: () => ({ list: () => [] }) }))

const { previewContext } = await import('../context')

const req = {
  sessionId: '',
  workspaceId: 'w1',
  model: 'sonnet',
  mode: 'normal',
  thinking: 'off',
  permissionMode: 'default',
  webSearch: false
} as never

function reset(): void {
  mocks.workspace = { id: 'w1', rootPath: '/w', environment: undefined }
  mocks.history = []
  mocks.mcp = undefined
  mocks.instructions = ''
}

function shareOf(segments: readonly { kind: ContextSegmentKind; tokens: number }[], kind: ContextSegmentKind): number {
  return segments.find((s) => s.kind === kind)?.tokens ?? 0
}

describe('context:preview · 空会话也要有数', () => {
  it('一条消息都没有时照样给出归因,且各档之和恒等于 used', async () => {
    reset()
    const preview = await previewContext(req)
    expect(preview, '工作区存在就必须有结果').toBeDefined()
    expect(preview!.used, '系统提示词和工具定义本来就占地方').toBeGreaterThan(0)
    expect(preview!.segments.reduce((n, s) => n + s.tokens, 0)).toBe(preview!.used)
    /*
      `messages` 不是 0 而是一条**占位空消息**的开销(几个 token,见 `previewContext`
      里那段注释)—— 不写死那个数字,只钉住它必须小到可以忽略:一旦有人把占位
      消息换成带内容的东西,这一行会先叫起来。
    */
    expect(shareOf(preview!.segments, 'messages')).toBeLessThan(
      shareOf(preview!.segments, 'system') / 10
    )
    expect(shareOf(preview!.segments, 'tools-builtin')).toBeGreaterThan(0)
  })

  it('已经连上的 MCP 落进 tools-mcp,没连上就是 0', async () => {
    reset()
    const without = await previewContext(req)
    reset()
    mocks.mcp = mcpTools
    const withMcp = await previewContext(req)
    expect(shareOf(without!.segments, 'tools-mcp'), '没连上时不许凭空编一个数').toBe(0)
    expect(shareOf(withMcp!.segments, 'tools-mcp')).toBeGreaterThan(0)
    expect(withMcp!.used).toBeGreaterThan(without!.used)
  })

  it('AGENTS.md 算进 instructions 档', async () => {
    reset()
    mocks.instructions = '这个仓库的提交信息一律用中文。'.repeat(20)
    const preview = await previewContext(req)
    expect(shareOf(preview!.segments, 'instructions')).toBeGreaterThan(0)
    expect(preview!.segments.reduce((n, s) => n + s.tokens, 0)).toBe(preview!.used)
  })

  it('读不到 AGENTS.md 不算失败 —— 少一档说明远好过整张卡打不开', async () => {
    reset()
    // 远程工作区没连上时 `loadInstructions` 会抛,而那不该让这张卡消失
    mocks.instructions = new Error('disconnected')
    const preview = await previewContext(req)
    expect(preview, '一次读文件失败不该把整个预览拖没').toBeDefined()
    expect(shareOf(preview!.segments, 'tools-builtin')).toBeGreaterThan(0)
  })

  it('工作区不存在时返回 undefined,而不是一份全 0 的假归因', async () => {
    reset()
    mocks.workspace = undefined
    await expect(previewContext(req)).resolves.toBeUndefined()
  })
})
