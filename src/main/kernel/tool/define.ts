/**
 * `defineTool` —— 每个工具都要做的三件事,收口成一处。
 *
 * 1. **导出 JSON Schema**:用 zod 写一遍,`z.toJSONSchema` 导出给模型。
 *    手写 JSON Schema 会和实际的解析逻辑分叉 —— 而那种分叉的症状是
 *    「模型按 schema 传了参,工具说参数不对」。
 * 2. **校验模型的入参**:`input` 是 `unknown`,它由模型生成,可以是任何东西。
 * 3. **异常不外泄**:工具抛出的错误变成 `tool_failed` 型的工具结果**进转录并继续循环**
 *    (方案 §4.11),而不是把整个 run 打死。用户会看到「工具失败了,模型换个方式再试」,
 *    而不是「对话突然消失」。
 *
 * ★ 唯一的例外是中断:它必须原样抛出去,由 session 的中断收尾统一处理(§4.8 第 4 件),
 * 否则中断会被伪装成一个普通的工具失败,模型看到后还会**继续往下跑**。
 */
import { z } from 'zod'
import type { JsonSchema, ToolResult, ToolSource } from '../../../shared/agent/tool'
import { toolFail } from '../../../shared/agent/tool'
import { isAbortError } from '../abort'
import type { ToolContext, ToolRegistration } from './registry'

export interface ToolSpec<S extends z.ZodType> {
  internalId: string
  description: string
  schema: S
  /** 决定 plan 模式可用性 + 将来的并行调度资格 */
  readOnly: boolean
  /** 决定权限档位(§4.5 那张 5 行表的入参之一) */
  destructive: boolean
  source?: ToolSource
  run(input: z.output<S>, ctx: ToolContext): Promise<ToolResult>
}

/** `$schema` 对上游没有意义,但每次请求都要为它付 token */
function toJsonSchema(schema: z.ZodType): JsonSchema {
  const { $schema: _dropped, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>
  return rest as JsonSchema
}

/** zod 的 issue 列表压成一行模型读得懂的话 —— 它要靠这句话决定怎么重试 */
function explain(err: z.ZodError): string {
  return err.issues
    .map((i) => {
      const path = i.path.join('.')
      return path === '' ? i.message : `${path}: ${i.message}`
    })
    .join('; ')
}

export function defineTool<S extends z.ZodType>(spec: ToolSpec<S>): ToolRegistration {
  return {
    internalId: spec.internalId,
    description: spec.description,
    inputSchema: toJsonSchema(spec.schema),
    readOnly: spec.readOnly,
    destructive: spec.destructive,
    source: spec.source ?? { kind: 'builtin' },

    async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = spec.schema.safeParse(input)
      if (!parsed.success) {
        return toolFail(`参数不合法 —— ${explain(parsed.error)}`)
      }
      try {
        return await spec.run(parsed.data, ctx)
      } catch (err) {
        // ★ 中断原样抛出,不伪装成工具失败
        if (isAbortError(err)) throw err
        const msg = err instanceof Error ? err.message : String(err)
        return toolFail(`工具执行失败:${msg}`)
      }
    }
  }
}
