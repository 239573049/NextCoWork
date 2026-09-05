import { createContext, useContext, type ComponentType, type ReactNode } from 'react'
import type { MarkdownTarget } from './links'

/** Code renderers receive data, never executable instructions or host capabilities. */
export interface MarkdownCodeProps {
  code: string
  language: string
  meta?: string
  streaming: boolean
}

export interface MarkdownEnvironment {
  resolveLink?: (reference: string) => MarkdownTarget
  onOpenFile?: (path: string, fragment: string) => void | Promise<void>
  onOpenExternal?: (url: string) => void | Promise<void>
  onCopyCode?: (code: string) => Promise<void>
  loadImage?: (path: string) => Promise<string>
  /** External images require a deliberate user action by default. */
  externalImages?: 'prompt' | 'block'
  codeRenderers?: Readonly<Record<string, ComponentType<MarkdownCodeProps>>>
}

const MarkdownContext = createContext<MarkdownEnvironment>({})

export function MarkdownProvider({ value, children }: { value: MarkdownEnvironment; children: ReactNode }): ReactNode {
  return <MarkdownContext.Provider value={value}>{children}</MarkdownContext.Provider>
}

export function useMarkdownEnvironment(): MarkdownEnvironment {
  return useContext(MarkdownContext)
}
