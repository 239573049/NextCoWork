import { createContext, useContext, type ComponentType, type ReactNode } from 'react'
import type { TranslationKey } from '../../i18n'
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
  /**
   * 打开文件引用之前的预检：`null` = 打得开，否则返回**一个 i18n key**，
   * 由链接自己翻出来画在它旁边 —— 文件系统错误码是宿主的词汇，markdown 这一层不认识它们。
   *
   * 缺省表示不预检、直接开：只有宿主知道「这个路径存不存在」，
   * 而 reusable 的解析与渲染组件不该自己去摸磁盘。
   */
  checkFile?: (path: string) => Promise<TranslationKey | null>
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
