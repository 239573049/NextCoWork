#!/usr/bin/env python3
"""变异测试 —— 验证 demo.test.ts 真的钉住了内置演示上游的设计决策。

与 mutate-agent-session.py 的差别:**变异体可以落在别的文件上**。

demo.test.ts 的文件头声称自己是「换掉假发射器」的验收,跑的是整条链路
(encodeAnthropic → 假网络 → SseParser → decodeAnthropic → router → session)。
那个声称只有一种验法:去改**链路上别的文件**,看这份测试会不会响。
带 `X` 前缀的变异体就是干这个的 —— 它们证明这份测试是整条链路的回归网,
而不只是 demo.ts 自己的镜子。
"""
import subprocess, sys, shutil, os

TEST = 'src/main/kernel/upstream/__tests__/demo.test.ts'

DEMO = 'src/main/kernel/upstream/demo.ts'
SSE = 'src/main/kernel/upstream/sse.ts'
DECODE = 'src/main/kernel/upstream/decode/anthropic.ts'
ENCODE = 'src/main/kernel/upstream/encode/anthropic.ts'

# (编号, 文件, 说明, [(find, replace), ...])
MUTANTS = [
    # ── 校验:演示上游得和真上游一样挑剔 ──────────────────────────────
    ('D1', DEMO, '不扫孤儿 tool_use(§4.8 那条自伤就此隐形)', [
        ('if (orphans.length > 0) {', 'if (false) {')]),
    ('D2', DEMO, '最后一条消息里悬着的 tool_use 不算数', [
        ('if (awaiting.length > 0) {', 'if (false) {')]),
    ('D3', DEMO, '不查角色交替(放过 toAnthropicMessages 的合并 bug)', [
        ('if (i > 0 && role === prevRole) {', 'if (false) {')]),
    ('D4', DEMO, '空 text 块放行', [
        ("if ((str(blk, 'text') ?? '') === '') return bad(", 'if (false) return bad(')]),
    ('D5', DEMO, '没签名的 thinking 块放行', [
        ("if ((str(blk, 'signature') ?? '') === '') {", 'if (false) {')]),
    ('D6', DEMO, '不查 max_tokens > thinking 预算', [
        ('if (maxTokens <= budget) {', 'if (false) {')]),
    ('D7', DEMO, '空 content 放行', [
        ('if (content === undefined || content.length === 0) {', 'if (content === undefined) {')]),
    ('D8', DEMO, '无主 tool_result 放行', [
        ('if (!awaiting.includes(id)) {', 'if (false) {')]),
    ('D9', DEMO, '工具名不查 ^[a-zA-Z0-9_-]{1,64}$', [
        ('if (!EXTERNAL_NAME_RE.test(name)) {', 'if (false) {')]),
    ('D10', DEMO, '调用没下发的工具也放行', [
        ('if (advertised.size > 0 && !advertised.has(name)) {', 'if (false) {')]),
    ('D11', DEMO, '第一条不是 user 也放行', [
        ("if (i === 0 && role !== 'user') return bad('messages.0.role: 第一条必须是 user')",
         'void 0')]),

    # ── 剧本 ────────────────────────────────────────────────────────
    ('D12', DEMO, '拿到 tool_result 也不收工(dev 里每次发送都撞 MAX_TURNS)', [
        ('if (results.length > 0) {', 'if (false) {')]),

    # ── SSE 渲染:那些「刻意做得难看」的地方 ──────────────────────────
    ('D13', DEMO, '入参 JSON 一次发完,不切碎', [
        ('pieces(JSON.stringify(block.input), 11)', '[JSON.stringify(block.input)]')]),
    ('D14', DEMO, '签名只发一帧(decode 侧的累加逻辑就没被走到)', [
        ('pieces(block.signature, Math.ceil(block.signature.length / 2))', '[block.signature]')]),
    ('D25', DEMO, '文本一次发完,不切碎(dev 里没有流式滚动)', [
        ('pieces(block.text, 6)', '[block.text]')]),
    ('D21', DEMO, '不发心跳 ping(decode 的忽略分支永远走不到)', [
        ("sse += frame('ping', { type: 'ping' })", 'void 0')]),
    ('D26', DEMO, 'content_block_stop 的 index 写死 0', [
        ("sse += frame('content_block_stop', { type: 'content_block_stop', index })",
         "sse += frame('content_block_stop', { type: 'content_block_stop', index: 0 })")]),
    ('D20', DEMO, 'message_start 的模型名写死常量', [
        ("str(rec(body), 'model') ?? DEMO_MODEL", 'DEMO_MODEL')]),
    ('D22', DEMO, 'usage.input_tokens 恒为 0', [
        ('messages.length * 20', '0')]),

    # ── HTTP 层 ─────────────────────────────────────────────────────
    ('D16', DEMO, '缺 x-api-key 不给 401(UI 也就不会跳设置页)', [
        ("if ((headers.get('x-api-key') ?? '') === '') {", 'if (false) {')]),
    ('D17', DEMO, '缺 anthropic-version 不给 400', [
        ("if ((headers.get('anthropic-version') ?? '') === '') {", 'if (false) {')]),
    ('D18', DEMO, '路径拼错也照样应答(joinUpstreamUrl 的启发式就没人看着了)', [
        ("if (!new URL(url).pathname.endsWith('/v1/messages')) {", 'if (false) {')]),
    ('D19', DEMO, 'GET 也照样应答', [
        ("if (method !== 'POST') {", 'if (false) {')]),
    ('D23', DEMO, 'demoHost 劫持**所有** ref(真上游的密钥被顶掉)', [
        ('ref === DEMO_CREDENTIAL_REF ? DEMO_API_KEY : inner.get(ref)', 'DEMO_API_KEY')]),

    # ── 演示上游挂到真 host 上的那一层 ────────────────────────────────
    # 这三个的后果都不是「演示不好使」,而是**真上游收不到真请求** ——
    # 症状是填了真 key 也永远拿不到真答案,而 UI 上看起来一切正常。
    ('D27', DEMO, '按全局开关分派而不是按主机名(真上游也吃假回复)', [
        ('hostname === demoHostname ? demo(input, init) : real(input, init)',
         'demo(input, init)')]),
    ('D28', DEMO, 'urlOf 不认 Request 形态(整类请求漏给真 fetch)', [
        ('  return input.url', "  return ''")]),
    ('D29', DEMO, '拼坏的 URL 落到演示上游,而不是交给真 fetch 报错', [
        ("let hostname = ''", 'let hostname = demoHostname')]),

    # ── 中断 ────────────────────────────────────────────────────────
    ('D24', DEMO, '已中断的 signal 不先拦,照样发请求', [
        ('const signal = init?.signal ?? null\n    if (signal?.aborted === true) throw abortError()',
         'const signal = init?.signal ?? null\n    if (false) throw abortError()')]),
    ('D15', DEMO, '分片中断抛的不是 AbortError(降级成一个假的网络错误)', [
        ('async pull(controller) {\n      if (signal?.aborted === true) throw abortError()',
         "async pull(controller) {\n      if (signal?.aborted === true) throw new Error('中断')")]),

    # ── 链路上别的文件:证明这份测试是整条链路的回归网 ─────────────────
    ('X1', SSE, 'TextDecoder 不带 stream:true(跨块的中文字符碎成 U+FFFD)', [
        ('decoder.decode(value, { stream: true })', 'decoder.decode(value)')]),
    ('X2', DECODE, 'signature_delta 覆盖而不是累加', [
        ("signatures.set(index, (signatures.get(index) ?? '') + s)", 'signatures.set(index, s)')]),
    ('X3', ENCODE, 'thinking 开着时不抬高 max_tokens(上游直接 400)', [
        ('if (req.maxOutputTokens <= req.thinkingBudget) {', 'if (false) {')]),
]


def main():
    files = sorted({f for _, f, _, _ in MUTANTS})
    backups = {f: f'/tmp/mutate-demo-{f.replace("/", "_")}.bak' for f in files}
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
            r = subprocess.run(['npx', 'vitest', 'run', TEST, '--reporter=dot'],
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
        print('\n存活的变异体 —— 这些设计决策没有测试撑腰:')
        for mid, path, desc in survived:
            print(f'  {mid}  [{path}] {desc}')
    return 1 if survived or broken else 0


sys.exit(main())
