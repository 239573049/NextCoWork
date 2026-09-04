/**
 * 服务层的地基 —— 协议 §9:组件**不直接引用频道字符串**,只调 services/*。
 *
 * 这一层做两件事:
 * 1. 拆信封。IpcResult 的 ok/error 分支在这里收敛成「返回值 or 抛出 AgentError」,
 *    调用点不必每次写 `if (!r.ok)`。
 * 2. 保证退订。`on()` 的返回值直接就是 useEffect 的 cleanup。
 */
import type { AgentError } from '../../../shared/agent/error'
import type {
  EventChannel,
  InvokeChannel,
  InvokeReq,
  InvokeRes,
  IpcEventMap,
  IpcResult,
  IpcSendMap,
  SendChannel,
  Unsubscribe
} from '../../../shared/ipc/contract'

/** 带着 §4.11 那套 code 分类的异常。UI 据 code 决定跳设置页 / 提示 compact / 重试。 */
export class AgentErrorException extends Error {
  constructor(readonly error: AgentError) {
    super(error.message)
    this.name = 'AgentErrorException'
  }
}

const bridge = (): Window['nextcowork'] => {
  const api = window.nextcowork
  if (!api) {
    // preload 没挂上(contextIsolation 被关、或 preload 打包失败)。
    // 早点大声挂掉,好过后面每个调用点收到一个 undefined。
    throw new Error('preload 桥未就绪:window.nextcowork 不存在')
  }
  return api
}

/** 失败时抛 AgentErrorException。绝大多数调用点用这个。 */
export async function invoke<K extends InvokeChannel>(
  channel: K,
  req: InvokeReq<K>
): Promise<InvokeRes<K>> {
  const r = await bridge().invoke(channel, req)
  if (!r.ok) throw new AgentErrorException(r.error)
  return r.data
}

/** 需要自己处理错误分支时用这个(比如「测试连接」这类失败也是正常结果的场景)。 */
export function tryInvoke<K extends InvokeChannel>(
  channel: K,
  req: InvokeReq<K>
): Promise<IpcResult<InvokeRes<K>>> {
  return bridge().invoke(channel, req)
}

export function send<K extends SendChannel>(channel: K, payload: IpcSendMap[K]): void {
  bridge().send(channel, payload)
}

/** ★ 返回值必须被 useEffect 的清理阶段调用,否则 HMR 会叠加监听器(方案 §3 规则 4)。 */
export function on<K extends EventChannel>(
  channel: K,
  cb: (payload: IpcEventMap[K]) => void
): Unsubscribe {
  return bridge().on(channel, cb)
}

export const versions = (): Window['nextcowork']['versions'] => bridge().versions
