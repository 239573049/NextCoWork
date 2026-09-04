/**
 * 模型 / 供应商品牌图标 —— 直接用 lobehub 的 `@lobehub/icons-static-svg`。
 *
 * **为什么是 `icons-static-svg` 而不是 `@lobehub/icons`(React 版):**
 * React 版 peer-depends `@lobehub/ui@^5` + `antd@^6`,为了几个品牌字形把一整套
 * 组件库拖进来,会和我们手写的 Tailwind 设计系统正面打架。static-svg 是
 * **零依赖、零 peer**,只有 903 个 svg 文件。
 *
 * **为什么是 `?raw` 而不是 `?url` + `<img>`:**
 * lobehub 的单色图标全部 `fill="currentColor"` —— 这正是我们要的(图标跟着
 * 文字颜色走,深浅主题、hover、禁用态都不用各写一遍)。而 `<img src>` 里的 SVG
 * 是独立文档,**继承不到外部的 color**。所以必须内联。
 *
 * **关于 `dangerouslySetInnerHTML`:**
 * 注入的字符串全部来自**编译期常量** —— 下面 `MARK` 表里每一项都是
 * `import ... from '....svg?raw'`,由 Vite 在构建时读进 bundle。运行期输入
 * (`name`)只用来**挑选**是哪一个常量:`resolveBrand()` 的返回值域就是
 * `Brand`,而 `MARK` 是 `Record<Brand, string>`,不存在从运行期数据流进
 * 被注入字符串的路径。
 */
import { Sparkles } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '../../lib/cn'
import { resolveBrand, type Brand } from './brands'

import anthropic from '@lobehub/icons-static-svg/icons/anthropic.svg?raw'
import azure from '@lobehub/icons-static-svg/icons/azure.svg?raw'
import baichuan from '@lobehub/icons-static-svg/icons/baichuan.svg?raw'
import bedrock from '@lobehub/icons-static-svg/icons/bedrock.svg?raw'
import claude from '@lobehub/icons-static-svg/icons/claude.svg?raw'
import deepseek from '@lobehub/icons-static-svg/icons/deepseek.svg?raw'
import doubao from '@lobehub/icons-static-svg/icons/doubao.svg?raw'
import fireworks from '@lobehub/icons-static-svg/icons/fireworks.svg?raw'
import gemini from '@lobehub/icons-static-svg/icons/gemini.svg?raw'
import groq from '@lobehub/icons-static-svg/icons/groq.svg?raw'
import hunyuan from '@lobehub/icons-static-svg/icons/hunyuan.svg?raw'
import kimi from '@lobehub/icons-static-svg/icons/kimi.svg?raw'
import lmstudio from '@lobehub/icons-static-svg/icons/lmstudio.svg?raw'
import meta from '@lobehub/icons-static-svg/icons/meta.svg?raw'
import minimax from '@lobehub/icons-static-svg/icons/minimax.svg?raw'
import mistral from '@lobehub/icons-static-svg/icons/mistral.svg?raw'
import moonshot from '@lobehub/icons-static-svg/icons/moonshot.svg?raw'
import ollama from '@lobehub/icons-static-svg/icons/ollama.svg?raw'
import openai from '@lobehub/icons-static-svg/icons/openai.svg?raw'
import openrouter from '@lobehub/icons-static-svg/icons/openrouter.svg?raw'
import perplexity from '@lobehub/icons-static-svg/icons/perplexity.svg?raw'
import qwen from '@lobehub/icons-static-svg/icons/qwen.svg?raw'
import siliconcloud from '@lobehub/icons-static-svg/icons/siliconcloud.svg?raw'
import spark from '@lobehub/icons-static-svg/icons/spark.svg?raw'
import stepfun from '@lobehub/icons-static-svg/icons/stepfun.svg?raw'
import together from '@lobehub/icons-static-svg/icons/together.svg?raw'
import vertexai from '@lobehub/icons-static-svg/icons/vertexai.svg?raw'
import volcengine from '@lobehub/icons-static-svg/icons/volcengine.svg?raw'
import xai from '@lobehub/icons-static-svg/icons/xai.svg?raw'
import yi from '@lobehub/icons-static-svg/icons/yi.svg?raw'
import zhipu from '@lobehub/icons-static-svg/icons/zhipu.svg?raw'

/**
 * 静态列举而不是 `import.meta.glob` —— 全量 903 个图标是 1MB+,
 * 而我们真正认得的就这 31 个牌子(约 40KB)。
 *
 * 类型标成 `Record<Brand, string>`(不是 `as const` 反推),
 * 这样「在 brands.ts 加了一条规则却忘了在这里加导入」是**编译错误**,
 * 而不是运行时的一个空图标。
 */
const MARK: Record<Brand, string> = {
  anthropic, azure, baichuan, bedrock, claude, deepseek, doubao, fireworks,
  gemini, groq, hunyuan, kimi, lmstudio, meta, minimax, mistral, moonshot,
  ollama, openai, openrouter, perplexity, qwen, siliconcloud, spark, stepfun,
  together, vertexai, volcengine, xai, yi, zhipu
}

/**
 * @param name  供应商名或模型别名;传数组则按顺序试,**最具体的放前面**。
 * @param label 传了就作为无障碍名字暴露;不传则整个图标 `aria-hidden` ——
 *              图标旁边通常已经有同样内容的文字了,读屏读两遍是噪音。
 */
export function ProviderIcon({
  name,
  size = 16,
  label,
  className
}: {
  name: string | readonly (string | undefined)[]
  size?: number
  label?: string
  className?: string
}): ReactNode {
  const brand = resolveBrand(...(typeof name === 'string' ? [name] : name))
  const a11y =
    label === undefined
      ? { 'aria-hidden': true as const }
      : { role: 'img' as const, 'aria-label': label }

  if (brand === null) {
    return <Sparkles size={size} className={cn('shrink-0', className)} {...a11y} />
  }

  return (
    <span
      {...a11y}
      // lobehub 的 svg 是 width/height="1em",所以尺寸靠 font-size 给
      style={{ fontSize: `${size}px` }}
      className={cn('inline-flex shrink-0 items-center justify-center', className)}
      dangerouslySetInnerHTML={{ __html: MARK[brand] }}
    />
  )
}
