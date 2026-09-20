/**
 * Agent 的 shell —— 服务层(组件不碰频道字符串,协议 §9)。
 *
 * 需求:工具卡片上那颗停止按钮只想掐掉**这一条**命令。它和 `abortRun`
 * (停整轮)是两条不同的意图,所以也不放进 `services/agent.ts` —— 放在一起的话,
 * 下一个人很容易顺手在停止按钮上改调 `abortRun`,而那会把模型写到一半的回复
 * 一起停掉,且没有任何报错。
 */
import { invoke } from './ipc'

/**
 * 停掉某次工具调用正在跑的命令。
 *
 * 返回 `false` = 它已经不在跑了(点击与收尾撞在同一刻)。**这不是错误**,
 * 调用方不必提示:用户要的结果已经达成。
 */
export function stopToolCall(runId: string, callId: string): Promise<boolean> {
  return invoke('shell:stopToolCall', { runId, callId })
}
