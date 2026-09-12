/**
 * 「结果未知」必须和别的失败区别对待。
 *
 * ★ `exists` / `invalid-path` / `conflict` 都意味着服务器上什么都没变,面板照原样显示
 * 就是对的。而连接是在**请求已经发出之后**断的那种失败(`result-unknown`),操作可能
 * 已经在服务器上生效了 —— rename 也许成功了,文件树里却还挂着旧名字。提示语写的是
 * 「请先检查服务器状态」,而用户唯一用来检查的就是这个面板,它自己得先重读。
 *
 * 这条分支原先根本不存在:catch 里只 setOperationError,任何失败都一视同仁。
 */
import { describe, expect, it } from 'vitest'
import type { AgentError } from '../../../../shared/agent/error'
import { AgentErrorException } from '../ipc'
import { isResultUnknown, workspaceFileErrorKey } from '../workspace-files'

const ipcError = (error: Partial<AgentError>): AgentErrorException =>
  new AgentErrorException({ code: 'tool_failed', message: '', retryable: false, ...error } as AgentError)

describe('result-unknown 与其它失败的分界', () => {
  it('断线中途的失败要求重读服务器', () => {
    const error = ipcError({ environmentCode: 'result-unknown' })
    expect(isResultUnknown(error)).toBe(true)
    expect(workspaceFileErrorKey(error)).toBe('environment.error.result-unknown')
  })

  /**
   * ★ `disconnected` 是「压根没发出去」,和 `result-unknown` 的区别正是这条码存在的理由。
   * 把它也当成未知会让每一次断线都触发一次注定失败的重读,把已经画出来的树打成错误行。
   */
  it.each(['disconnected', 'conflict', 'approval-required'] as const)(
    '%s 不触发重读', (code) => {
      expect(isResultUnknown(ipcError({ environmentCode: code }))).toBe(false)
    }
  )

  it.each(['workspace_file:exists', 'workspace_file:invalid-path', 'workspace_file:conflict'])(
    '普通文件错误 %s 不触发重读', (message) => {
      expect(isResultUnknown(new Error(message))).toBe(false)
    }
  )

  /** 非 Error 的东西(被 reject 的字符串、undefined)不能把判定炸掉 */
  it.each([undefined, null, 'result-unknown', { environmentCode: 'result-unknown' }])(
    '非异常输入 %s 判否而不是抛', (value) => {
      expect(isResultUnknown(value)).toBe(false)
    }
  )
})
