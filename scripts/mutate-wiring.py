#!/usr/bin/env python3
"""变异测试 —— 验证 agent-run.test.ts 真的钉住了「接线」这一步。

这一步(方案 §12 步骤 4 的收尾:把假发射器换成真 session)与前面几步不同:
它几乎**没有算法**,只有装配。而装配错误恰恰是最容易在测试里蒙混过关的一类 ——
一份只断言「跑完了、没报错」的测试,在别名不翻译、工具没注册、
宿主没装上、甚至驱动根本没换的情况下,统统是绿的。

所以这里的变异体几乎全是「少接一根线」:
- runtime 的四个单例各自漏装一个;
- `startRun` 的默认驱动没换成真 session;
- seed 的两半各漏一半。

带 `W` 前缀。跑法与另外两份一致:`python3 scripts/mutate-wiring.py`
"""
import subprocess, sys, shutil, os

TEST = 'src/main/ipc/__tests__/agent-run.test.ts'
# 泵测试必须一起跑:好几个变异体(尤其是 W1 换掉默认驱动)会让**两份**测试
# 同时变红,而只跑一份就看不出「假发射器退居夹具」这件事是双向钉住的。
PUMP_TEST = 'src/main/ipc/__tests__/agent-pump.test.ts'
# store 的三条不变式(W12–W14)由它钉住 —— 漏了它,那三个变异体会「存活」,
# 而那是**跑法**的漏,不是测试的漏。这个坑值得写下来:变异测试报出来的存活,
# 第一件事永远是先确认「能杀它的那份测试真的在这一轮里跑了」。
STORE_TEST = 'src/main/state/__tests__/store.test.ts'
TESTS = [TEST, PUMP_TEST, STORE_TEST]

RUNTIME = 'src/main/runtime.ts'
IPC = 'src/main/ipc/agent.ts'
STORE = 'src/main/state/store.ts'

# (编号, 文件, 说明, [(find, replace), ...])
MUTANTS = [
    # ── 默认驱动:这一步的全部内容 ──────────────────────────────────
    ('W1', IPC, '默认驱动仍是假发射器(整步没做,而泵测试照样全绿)', [
        ('driver: RunDriver = runAgent', 'driver: RunDriver = runFake'),
        ("import { runAgent } from '../runtime'",
         "import { runAgent } from '../runtime'\nimport { runFake } from '../kernel/fake-emitter'")]),
    ('W2', IPC, '压根不启动驱动(run 建了但没人跑,UI 永远转圈)', [
        ('void driver(handle, req)', 'void 0')]),
    ('W3', IPC, '先启动后订阅(方案 §3 规则 2:首批事件推给空订阅集)', [
        ('  windows.subscribe(runTopic(req.runId), ctx.sender)\n\n  const handle = runs.create(req)\n'
         '  pumps.set(req.runId, new RunPump(handle))\n\n  void driver(handle, req)',
         '  const handle = runs.create(req)\n  pumps.set(req.runId, new RunPump(handle))\n'
         '  void driver(handle, req)\n\n  windows.subscribe(runTopic(req.runId), ctx.sender)')]),

    # ── runtime 的装配 ─────────────────────────────────────────────
    ('W4', RUNTIME, 'session 不给工具(模型永远没有工具可调)', [
        ('tools: getTools(),', 'tools: new ToolRegistry(),')]),
    ('W5', RUNTIME, 'installHost 之后路由器不重建(装了新宿主也不生效)', [
        ('  host = h\n', '  host = h\n  if (false)\n')]),
    ('W6', RUNTIME, 'getTools 不注册内置工具', [
        ('for (const reg of builtinTools()) tools.register(reg)', 'void builtinTools()')]),
    ('W7', RUNTIME, 'getRouter 不先 seed(provider 表是空的 → no_healthy_provider)', [
        ('export function getRouter(): UpstreamRouter {\n  seed()',
         'export function getRouter(): UpstreamRouter {')]),
    ('W8', RUNTIME, 'seed 不写别名表(alias 解析不出上游模型名)', [
        ('for (const alias of DEMO_ALIASES) store.putAlias(alias)', 'void DEMO_ALIASES')]),
    ('W9', RUNTIME, 'seed 不写 provider 表', [
        ('store.putProvider(DEMO_PROVIDER)', 'void DEMO_PROVIDER')]),
    ('W10', RUNTIME, '全新安装不把 defaultModel 指向演示上游(首屏模型选择器是空的)', [
        ("store.updateSettings({ defaultModel: DEMO_ALIAS })", 'void DEMO_ALIAS')]),
    ('W11', RUNTIME, 'defaultModel 无条件覆盖(用户选的模型每次启动被顶掉)', [
        ("if (store.getSettings().defaultModel === '') {", 'if (true) {')]),

    # ── 别名表的主键:(providerId, alias) 而不是 alias ────────────────
    ('W12', STORE, '别名表用 alias 做主键(同一 alias 的第二个 provider 顶掉第一个,'
                   '而这正是故障切换存在的前提)', [
        ('const aliasKey = (providerId: string, alias: string): string =>\n'
         '  `${providerId}${KEY_SEP}${alias}`',
         'const aliasKey = (_providerId: string, alias: string): string => alias')]),
    ('W13', STORE, '删 provider 不连带删它的别名(留下指向不存在 provider 的别名)', [
        ('for (const [k, a] of aliases) if (a.providerId === id) aliases.delete(k)', 'void 0')]),
    ('W14', STORE, 'provider 列表不按 priority 排(故障切换顺序随插入顺序漂移)', [
        ('.sort((a, b) => a.priority - b.priority)', '')]),
]


def main():
    files = sorted({f for _, f, _, _ in MUTANTS})
    backups = {f: f'/tmp/mutate-wiring-{f.replace("/", "_")}.bak' for f in files}
    originals = {f: open(f, encoding='utf-8').read() for f in files}
    for f in files:
        shutil.copy(f, backups[f])

    survived, caught, broken = [], [], []
    try:
        for mid, path, desc, edits in MUTANTS:
            src = originals[path]
            ok = True
            for find, repl in edits:
                n = src.count(find)
                if n != 1:
                    print(f'{mid} ⚠️  变异定义失效:模式出现 {n} 次 —— {find[:60]!r}')
                    broken.append(mid)
                    ok = False
                    break
                src = src.replace(find, repl)
            if not ok:
                continue
            open(path, 'w', encoding='utf-8').write(src)
            r = subprocess.run(['npx', 'vitest', 'run', *TESTS, '--reporter=dot'],
                               capture_output=True, text=True,
                               env={**os.environ, 'ELECTRON_RUN_AS_NODE': ''})
            open(path, 'w', encoding='utf-8').write(originals[path])
            if r.returncode == 0:
                print(f'{mid} 存活 ❌  [{os.path.basename(path)}] {desc}')
                survived.append((mid, path, desc))
            else:
                print(f'{mid} 被杀 ✅  [{os.path.basename(path)}] {desc}')
                caught.append(mid)
    finally:
        for f in files:
            shutil.copy(backups[f], f)

    total = len(MUTANTS)
    print(f'\n杀死 {len(caught)}/{total - len(broken)} 个有效变异体'
          + (f',{len(broken)} 个变异定义失效' if broken else ''))
    if survived:
        print('\n存活的变异体 —— 这些接线没有测试撑腰:')
        for mid, path, desc in survived:
            print(f'  {mid}  [{path}] {desc}')
    return 1 if survived or broken else 0


sys.exit(main())
