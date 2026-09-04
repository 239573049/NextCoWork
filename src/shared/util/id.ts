/**
 * ULID —— 主进程与渲染层共用的 id 生成器。
 *
 * 为什么不是 UUID v4:ULID **按时间字典序排序**。消息、run、Tab 都是时序数据,
 * 有序 id 意味着 SQLite 主键索引不会随机写入、`ORDER BY id` 就是时间序、
 * 日志里一眼能看出先后。26 个字符,Crockford base32(无 I/L/O/U,不会看错)。
 *
 * ★ 渲染层用它 mint runId ——「订阅在前、启动在后」的前提是渲染层能自己造出
 * runId 而不必等 invoke 返回(方案 §3 规则 2)。
 */

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const TIME_LEN = 10
const RANDOM_LEN = 16

let lastTime = 0
let lastRandom: number[] = []

function randomBytes(n: number): number[] {
  const buf = new Uint8Array(n)
  crypto.getRandomValues(buf)
  return Array.from(buf, (b) => b % 32)
}

function encodeTime(now: number): string {
  let out = ''
  let t = now
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    out = ENCODING[t % 32] + out
    t = Math.floor(t / 32)
  }
  return out
}

/** 同一毫秒内递增随机部分,保证严格单调 —— 否则同毫秒生成的两个 id 排序不确定 */
function bumpRandom(prev: number[]): number[] {
  const next = [...prev]
  for (let i = next.length - 1; i >= 0; i--) {
    const v = next[i] ?? 0
    if (v < 31) {
      next[i] = v + 1
      return next
    }
    next[i] = 0
  }
  // 32^16 次进位才会到这儿,实际到不了;真到了就重新随机
  return randomBytes(RANDOM_LEN)
}

export function ulid(now = Date.now()): string {
  if (now === lastTime) {
    lastRandom = bumpRandom(lastRandom)
  } else {
    lastTime = now
    lastRandom = randomBytes(RANDOM_LEN)
  }
  return encodeTime(now) + lastRandom.map((v) => ENCODING[v]).join('')
}

/** 带前缀的可读 id,给调试用:`ws_01J8…`。前缀不进排序键。 */
export function prefixedId(prefix: string): string {
  return `${prefix}_${ulid()}`
}
