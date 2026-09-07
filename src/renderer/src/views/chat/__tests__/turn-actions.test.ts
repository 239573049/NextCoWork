import { describe, expect, it } from 'vitest'
import { exportFileName, exportMarkdown } from '../TurnActions'

describe('导出单轮为 Markdown', () => {
  it('带上提问,导出的文件才自洽 —— 只有答案的 md 看不出问的是什么', () => {
    expect(exportMarkdown('怎么跑测试？', '执行 `npm run test`。'))
      .toBe('> 怎么跑测试？\n\n执行 `npm run test`。\n')
  })

  it('多行提问逐行加引用前缀 —— 只给首行加,第二行会被当成正文', () => {
    expect(exportMarkdown('第一行\n第二行', '好的')).toBe('> 第一行\n> 第二行\n\n好的\n')
  })

  it('没有提问时只导出回复,不留一个空的引用块', () => {
    expect(exportMarkdown(undefined, '孤零零的回复')).toBe('孤零零的回复\n')
    expect(exportMarkdown('   ', '孤零零的回复')).toBe('孤零零的回复\n')
  })
})

describe('导出的建议文件名', () => {
  it('取首行,截到 40 字', () => {
    expect(exportFileName('如何配置代理')).toBe('如何配置代理.md')
    expect(exportFileName('a'.repeat(60))).toBe(`${'a'.repeat(40)}.md`)
  })

  it('换行先截掉 —— 提问常是多行的,整段塞进去会得到名字里带换行的文件', () => {
    expect(exportFileName('标题行\n后面还有很多内容')).toBe('标题行.md')
  })

  it('跳过开头的空行,而不是拿一个空标题去命名', () => {
    expect(exportFileName('\n\n  真正的标题  \n尾巴')).toBe('真正的标题.md')
  })

  it('整段都是空白时退回默认名', () => {
    expect(exportFileName('   \n  ')).toBe('reply.md')
  })
})
