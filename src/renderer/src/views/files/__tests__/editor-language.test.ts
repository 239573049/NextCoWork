import { describe, expect, it } from 'vitest'
import { languageForPath, pathForFence } from '../editor-language'

describe('workspace editor language selection', () => {
  it.each([
    ['src/App.tsx', 'TSX'], ['src/main.ts', 'TypeScript'], ['app.jsx', 'JSX'],
    ['script.mjs', 'JavaScript'], ['tool.py', 'Python'], ['main.go', 'Go'],
    ['main.rs', 'Rust'], ['Main.java', 'Java'], ['App.cs', 'C#'],
    ['main.cpp', 'C++'], ['styles.css', 'CSS'], ['index.html', 'HTML'],
    ['package.json', 'JSON'], ['config.yml', 'YAML'], ['README.MD', 'Markdown'],
    ['.env.local', 'Shell'], ['.zshrc', 'Shell'], ['build.zsh', 'Shell'],
    ['Dockerfile.dev', 'Dockerfile'], ['Containerfile', 'Dockerfile']
  ])('selects %s as %s', (path, name) => {
    expect(languageForPath(path)?.name).toBe(name)
  })

  it('leaves unknown text files editable without assigning a parser', () => {
    expect(languageForPath('notes.unknown-extension')).toBeNull()
    expect(languageForPath('LICENSE')).toBeNull()
  })

  it.each([['javascript', 'JavaScript'], ['ts', 'TypeScript'], ['python', 'Python'], ['bash', 'Shell'], ['tsx', 'TSX']])('recognizes fenced language %s', (label, name) => {
    expect(languageForPath(pathForFence(label))?.name).toBe(name)
  })
})
