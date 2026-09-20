/**
 * 状态栏统计 —— 纯函数。
 *
 * ## 词数怎么数(CJK 感知)
 *
 * 拉丁词按空白切,中日韩按**字**计 —— 一句中文在拉丁词法下只会被算成
 * 「1 个词」,对写中文文档的人完全没有参考价值。这里的口径:
 *   words = 连续的 [\p{L}\p{N}'] 西文词 + 每一个 CJK 字符各计一词。
 * 阅读时长按中文 ~300 字/分钟、混排取 250 词/分钟的常用近似。
 */

const CJK = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u
const WORD = /[\p{L}\p{N}']+/gu

export interface DocStats {
  words: number
  chars: number
  lines: number
  readMinutes: number
}

export function computeStats(source: string): DocStats {
  let words = 0
  const matches = source.match(WORD) ?? []
  for (const word of matches) {
    if (CJK.test(word)) {
      // 混排词(如「GPT-4模型」):CJK 部分逐字计,非 CJK 前后段各计一词
      let run = ''
      let latinRuns = 0
      for (const ch of word) {
        if (CJK.test(ch)) {
          words += 1
          if (run !== '') { latinRuns += 1; run = '' }
        } else {
          run += ch
        }
      }
      if (run !== '') latinRuns += 1
      words += latinRuns
    } else {
      words += 1
    }
  }
  const lines = source.length === 0 ? 1 : source.split('\n').length
  return {
    words,
    chars: source.length,
    lines,
    // 上限 9999:一份 20 万词的导出稿没必要显示「阅读 667 分钟」
    readMinutes: Math.min(9999, Math.max(1, Math.round(words / 250)))
  }
}
