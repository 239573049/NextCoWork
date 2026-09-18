/**
 * 工具入参 JSON 的前缀解析器。
 *
 * 上游把 `tool_call_delta` 作为任意字符串片段发送；转录层会把它们累积起来，
 * 但直到 `tool_call_end` 前都不一定是合法 JSON。卡片需要更早读到已经出现的字段，
 * 所以这里把“合法 JSON 的任意前缀”投影成当前可展示的值。
 *
 * ★ 这不是内核参数校验器：最终执行仍以 `ToolCallAccumulator` 的原生 `JSON.parse`
 * 结果为准。这里遇到畸形输入只返回 `undefined`，绝不修正后拿去执行工具。
 */

const INVALID = Symbol('invalid partial JSON')
const MISSING = Symbol('missing partial JSON value')
const MAX_DEPTH = 128
/** 大入参继续增长时固定预览这一段，避免每个流式帧重扫几十万字符。 */
export const MAX_PARTIAL_JSON_CHARS = 64 * 1024

type ParsedValue = { value: unknown; complete: boolean }
type ParseResult = ParsedValue | typeof INVALID | typeof MISSING
type ParsedString = { value: string; complete: boolean }

function isWhitespace(char: string | undefined): boolean {
  return char === ' ' || char === '\n' || char === '\r' || char === '\t'
}

function isDigit(char: string | undefined): boolean {
  return char !== undefined && char >= '0' && char <= '9'
}

function isHex(char: string | undefined): boolean {
  return char !== undefined && /^[0-9a-fA-F]$/.test(char)
}

/** `__proto__` 也必须只是 JSON 数据，不能触发对象原型 setter。 */
function setProperty(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true
  })
}

class PartialJsonParser {
  private offset = 0

  constructor(private readonly source: string) {}

  parse(): unknown | undefined {
    this.skipWhitespace()
    const result = this.parseValue(0)
    if (result === INVALID || result === MISSING) return undefined

    if (result.complete) this.skipWhitespace()
    return this.offset === this.source.length ? result.value : undefined
  }

  private parseValue(depth: number): ParseResult {
    this.skipWhitespace()
    const char = this.source[this.offset]
    if (char === undefined) return MISSING
    if (depth > MAX_DEPTH) return INVALID

    switch (char) {
      case '{':
        return this.parseObject(depth)
      case '[':
        return this.parseArray(depth)
      case '"':
        return this.parseString()
      case 't':
        return this.parseLiteral('true', true)
      case 'f':
        return this.parseLiteral('false', false)
      case 'n':
        return this.parseLiteral('null', null)
      default:
        return char === '-' || isDigit(char) ? this.parseNumber() : INVALID
    }
  }

  private parseObject(depth: number): ParseResult {
    this.offset += 1
    const value: Record<string, unknown> = {}
    this.skipWhitespace()
    if (this.source[this.offset] === '}') {
      this.offset += 1
      return { value, complete: true }
    }

    while (this.offset < this.source.length) {
      if (this.source[this.offset] !== '"') return INVALID
      const key = this.parseString()
      if (key === INVALID) return INVALID
      if (!key.complete) return { value, complete: false }

      this.skipWhitespace()
      if (this.offset === this.source.length) return { value, complete: false }
      if (this.source[this.offset] !== ':') return INVALID
      this.offset += 1

      const item = this.parseValue(depth + 1)
      if (item === INVALID) return INVALID
      if (item === MISSING) return { value, complete: false }
      setProperty(value, key.value, item.value)
      if (!item.complete) return { value, complete: false }

      this.skipWhitespace()
      const separator = this.source[this.offset]
      if (separator === undefined) return { value, complete: false }
      if (separator === '}') {
        this.offset += 1
        return { value, complete: true }
      }
      if (separator !== ',') return INVALID
      this.offset += 1
      this.skipWhitespace()
    }

    return { value, complete: false }
  }

  private parseArray(depth: number): ParseResult {
    this.offset += 1
    const value: unknown[] = []
    this.skipWhitespace()
    if (this.source[this.offset] === ']') {
      this.offset += 1
      return { value, complete: true }
    }

    while (this.offset < this.source.length) {
      const item = this.parseValue(depth + 1)
      if (item === INVALID) return INVALID
      if (item === MISSING) return { value, complete: false }
      value.push(item.value)
      if (!item.complete) return { value, complete: false }

      this.skipWhitespace()
      const separator = this.source[this.offset]
      if (separator === undefined) return { value, complete: false }
      if (separator === ']') {
        this.offset += 1
        return { value, complete: true }
      }
      if (separator !== ',') return INVALID
      this.offset += 1
      this.skipWhitespace()
    }

    return { value, complete: false }
  }

  private parseString(): ParsedString | typeof INVALID {
    this.offset += 1
    let value = ''

    while (this.offset < this.source.length) {
      const char = this.source[this.offset]
      this.offset += 1
      if (char === '"') return { value, complete: true }
      if (char === undefined) break
      if (char.charCodeAt(0) < 0x20) return INVALID
      if (char !== '\\') {
        value += char
        continue
      }

      const escaped = this.source[this.offset]
      if (escaped === undefined) return { value, complete: false }
      this.offset += 1
      switch (escaped) {
        case '"':
          value += '"'
          break
        case '\\':
          value += '\\'
          break
        case '/':
          value += '/'
          break
        case 'b':
          value += '\b'
          break
        case 'f':
          value += '\f'
          break
        case 'n':
          value += '\n'
          break
        case 'r':
          value += '\r'
          break
        case 't':
          value += '\t'
          break
        case 'u': {
          const start = this.offset
          while (this.offset - start < 4 && isHex(this.source[this.offset])) this.offset += 1
          if (this.offset - start < 4) {
            return this.offset === this.source.length ? { value, complete: false } : INVALID
          }
          value += String.fromCharCode(Number.parseInt(this.source.slice(start, this.offset), 16))
          break
        }
        default:
          return INVALID
      }
    }

    return { value, complete: false }
  }

  private parseLiteral(literal: 'true' | 'false' | 'null', value: boolean | null): ParseResult {
    const remaining = this.source.length - this.offset
    const length = Math.min(literal.length, remaining)
    if (this.source.slice(this.offset, this.offset + length) !== literal.slice(0, length)) return INVALID
    this.offset += length
    return length === literal.length ? { value, complete: true } : MISSING
  }

  private parseNumber(): ParseResult {
    const start = this.offset
    if (this.source[this.offset] === '-') this.offset += 1
    if (this.offset === this.source.length) return MISSING

    if (this.source[this.offset] === '0') {
      this.offset += 1
      if (isDigit(this.source[this.offset])) return INVALID
    } else {
      if (!isDigit(this.source[this.offset])) return INVALID
      while (isDigit(this.source[this.offset])) this.offset += 1
    }
    let stableEnd = this.offset

    if (this.source[this.offset] === '.') {
      this.offset += 1
      const fractionStart = this.offset
      while (isDigit(this.source[this.offset])) this.offset += 1
      if (this.offset === fractionStart) {
        return this.offset === this.source.length
          ? { value: Number(this.source.slice(start, stableEnd)), complete: false }
          : INVALID
      }
      stableEnd = this.offset
    }

    const exponent = this.source[this.offset]
    if (exponent === 'e' || exponent === 'E') {
      this.offset += 1
      const sign = this.source[this.offset]
      if (sign === '+' || sign === '-') this.offset += 1
      const exponentStart = this.offset
      while (isDigit(this.source[this.offset])) this.offset += 1
      if (this.offset === exponentStart) {
        return this.offset === this.source.length
          ? { value: Number(this.source.slice(start, stableEnd)), complete: false }
          : INVALID
      }
    }

    return { value: Number(this.source.slice(start, this.offset)), complete: true }
  }

  private skipWhitespace(): void {
    while (isWhitespace(this.source[this.offset])) this.offset += 1
  }
}

/**
 * 返回完整 JSON，或一个合法 JSON 前缀中目前已经可展示的部分。
 * 空输入、尚未形成值的字面量以及确定畸形的输入返回 `undefined`。
 */
export function parsePartialJson(source: string): unknown | undefined {
  if (source.trim() === '') return undefined
  return new PartialJsonParser(source).parse()
}
