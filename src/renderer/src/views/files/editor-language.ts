import { LanguageDescription } from '@codemirror/language'
import { languages } from '@codemirror/language-data'

/** Metadata stays small; the actual parser is loaded only when its file is opened. */
export function languageForPath(path: string): LanguageDescription | null {
  const filename = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
  const lower = filename.toLowerCase()
  if (/^(?:\.env(?:\..+)?|\.bashrc|\.zshrc|\.bash_profile|\.profile)$/.test(lower) || lower.endsWith('.zsh')) {
    return LanguageDescription.matchLanguageName(languages, 'Shell', false)
  }
  if (/^(?:dockerfile|containerfile)(?:\..+)?$/.test(lower)) {
    return LanguageDescription.matchLanguageName(languages, 'Dockerfile', false)
  }
  if (lower.endsWith('.mdx')) {
    return LanguageDescription.matchLanguageName(languages, 'Markdown', false)
  }
  return LanguageDescription.matchFilename(languages, filename)
    ?? LanguageDescription.matchFilename(languages, lower)
}

/** Fenced Markdown labels accept both language names and familiar extensions. */
export function pathForFence(language: string): string {
  const description = LanguageDescription.matchLanguageName(languages, language, false)
    ?? languageForPath(`snippet.${language}`)
  return `snippet.${description?.extensions[0] ?? language}`
}
