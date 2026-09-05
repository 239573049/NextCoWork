import { LanguageDescription } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { classHighlighter, highlightTree } from '@lezer/highlight'

export interface CodeSpan { from: number; to: number; className: string }

/** Reuse editor grammars, but render static, selectable code instead of mounting editors. */
export async function highlightCode(code: string, language: string): Promise<CodeSpan[]> {
  if (code.length > 100_000 || !language) return []
  const description = LanguageDescription.matchLanguageName(languages, language, false)
    ?? LanguageDescription.matchFilename(languages, `snippet.${language}`)
  if (!description) return []
  const support = await description.load()
  const spans: CodeSpan[] = []
  highlightTree(support.language.parser.parse(code), classHighlighter, (from, to, className) => {
    spans.push({ from, to, className })
  })
  return spans
}
