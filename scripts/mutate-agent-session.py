#!/usr/bin/env python3
"""变异测试 —— 验证 agent-session.test.ts 真的钉住了 agent-session.ts 的设计决策。

每个变异体对应源码注释里声称「不能省」的一条。变异体存活 = 那条注释没有测试撑腰。
"""
import subprocess, sys, shutil, os

SRC = 'src/main/kernel/agent-session.ts'
TEST = 'src/main/kernel/__tests__/agent-session.test.ts'
BAK = '/tmp/agent-session.ts.bak'

# (编号, 说明, [(find, replace), ...])
MUTANTS = [
    ('M1', 'executeAll 只在成功路径提交(去掉 finally 的效果)', [
        ('if (parts.length > 0) {', 'if (parts.length > 0 && !this.handle.signal.aborted) {')]),
    ('M2', '中断收尾不补 tool_result', [
        ('if (orphans.length > 0) {', 'if (false) {')]),
    ('M3', '中断收尾不提交半截回复', [
        ('if (acc !== null) this.commitAssistant(acc.finalize().parts)',
         'if (false) this.commitAssistant([])')]),
    ('M4', '补的 tool_result 不发 tool_end', [
        ("this.handle.emit({ type: 'tool_end', callId: o.callId, output, isError: true })", 'void o')]),
    ('M5', 'run 的 catch 不看 handle.signal.aborted', [
        ('if (isAbortError(err) || this.handle.signal.aborted) {', 'if (isAbortError(err)) {')]),
    ('M6', 'context_usage 改到请求之后才发', [
        ('    this.handle.emit({ type: \'context_usage\', ...usage })\n\n    const acc = new BlockAccumulator()',
         '    const acc = new BlockAccumulator()'),
        ('    this.pending = null\n\n    const { parts, calls } = acc.finalize()',
         '    this.pending = null\n    this.handle.emit({ type: \'context_usage\', ...usage })\n\n    const { parts, calls } = acc.finalize()')]),
    ('M7', 'plan 模式不过滤写工具', [
        ("readOnlyOnly: this.req.mode === 'plan'", 'readOnlyOnly: false')]),
    ('M8', '无条件截断工具输出(抹掉工具自己的标记)', [
        ('      result.output.content.length > MAX_TOOL_OUTPUT_CHARS\n        ? truncateToolOutput(result.output.content)\n        : result.output',
         '      truncateToolOutput(result.output.content)')]),
    ('M9', 'allow_edited 用原入参执行', [
        ("const input = decision.kind === 'allow_edited' ? decision.input : call.input",
         'const input = call.input')]),
    ('M10', '工具里的中断被伪装成工具失败', [
        ('if (isAbortError(err)) throw err', 'if (false) throw err')]),
    ('M11', '提交空 parts 的助手消息', [
        ('if (parts.length === 0) return', 'if (false) return')]),
    ('M12', '空 input 也追加一条用户消息', [
        ('if (req.input.length > 0) {', 'if (true) {')]),
    ('M13', 'stopReason=tool_use 就继续循环,不看有没有已闭合的调用', [
        ("if (stopReason !== 'tool_use' || calls.length === 0) {", "if (stopReason !== 'tool_use') {")]),
    ('M14', '轮次耗尽算正常结束', [
        ("    this.handle.finish(\n      'error',\n      agentError('unknown', `已达到最大轮次上限",
         "    this.handle.finish(\n      'done',\n      agentError('unknown', `已达到最大轮次上限")]),
    ('M15', '按实时注册表解析工具名,不按本轮快照', [
        ('const tool = tools.get(call.name)',
         'const tool = this.deps.tools.resolveByExternalName(call.name)')]),
    ('M16', '流式错误不进转录', [
        ("if (streamError !== undefined) parts.push({ type: 'error', error: streamError })",
         "if (false) parts.push({ type: 'error', error: streamError })")]),
    ('M17', '流式错误当成正常结束', [
        ("this.handle.finish('error', streamError)", "this.handle.finish('done')")]),
    ('M18', '工具错误不发 tool_end', [
        ("    this.handle.emit({ type: 'tool_end', callId, output, isError: true })\n    return { type: 'tool_result', callId, output, isError: true }",
         "    return { type: 'tool_result', callId, output, isError: true }")]),
    ('M19', '参数非法时不把原文回给模型', [
        ('${call.raw}', "${'(略)'}")]),
    ('M20', '拒绝理由被丢掉', [
        ("decision.reason ?? '用户拒绝了这次工具调用。'", "'用户拒绝了这次工具调用。'")]),
    ('M21', '不发 tool_start', [
        ("this.handle.emit({ type: 'tool_start', callId, toolName: tool.externalName, input: call.input })",
         'void tool')]),
    ('M22', '工具拿到的不是 run 的 signal', [
        ('      signal: this.handle.signal,', '      signal: new AbortController().signal,')]),
    ('M23', '请求体里带上 execute 闭包', [
        ('const infos: ToolInfo[] = advertised.map(({ execute: _execute, ...info }) => info)',
         'const infos: ToolInfo[] = advertised as unknown as ToolInfo[]')]),
    ('M24', '别名查不到时兜底 maxOutputTokens 为 0', [
        ('const FALLBACK_MAX_OUTPUT = 8192', 'const FALLBACK_MAX_OUTPUT = 0')]),
    ('M25', 'pending 从不设置(中断时救不回半截回复)', [
        ('    this.pending = acc\n', '    void acc\n')]),
    ('M26', '一轮结束后不清空 pending(中断时重复提交)', [
        ('    this.pending = null\n\n    const { parts, calls } = acc.finalize()',
         '\n    const { parts, calls } = acc.finalize()')]),
    ('M27', 'tool_start 用 internalId 而不是 externalName', [
        ('toolName: tool.externalName', 'toolName: tool.internalId')]),
]

def main():
    shutil.copy(SRC, BAK)
    original = open(SRC, encoding='utf-8').read()
    survived, caught, broken = [], [], []
    try:
        for mid, desc, edits in MUTANTS:
            src = original
            ok = True
            for find, repl in edits:
                n = src.count(find)
                if n != 1:
                    print(f'{mid} ⚠️  变异定义失效:模式出现 {n} 次 —— {find[:60]!r}')
                    broken.append(mid); ok = False; break
                src = src.replace(find, repl)
            if not ok:
                continue
            open(SRC, 'w', encoding='utf-8').write(src)
            r = subprocess.run(['npx', 'vitest', 'run', TEST, '--reporter=dot'],
                               capture_output=True, text=True,
                               env={**os.environ, 'ELECTRON_RUN_AS_NODE': ''})
            if r.returncode == 0:
                print(f'{mid} 存活 ❌  {desc}')
                survived.append((mid, desc))
            else:
                print(f'{mid} 被杀 ✅  {desc}')
                caught.append(mid)
    finally:
        shutil.copy(BAK, SRC)

    total = len(MUTANTS)
    print(f'\n杀死 {len(caught)}/{total - len(broken)} 个有效变异体'
          + (f',{len(broken)} 个变异定义失效' if broken else ''))
    if survived:
        print('\n存活的变异体 —— 这些设计决策没有测试撑腰:')
        for mid, desc in survived:
            print(f'  {mid}  {desc}')
    return 1 if survived or broken else 0

sys.exit(main())
