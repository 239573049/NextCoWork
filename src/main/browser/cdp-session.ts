/*
 * Small CDP client shared by Electron webviews and Playwright headless pages.
 *
 * The automation script runs in an isolated world: page JavaScript cannot replace the ref map
 * and silently redirect a later Agent click. Navigation destroys that world, which also gives
 * stale refs their fail-closed behavior without a renderer-side observer.
 */

export interface CdpTransport {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>
  close(): Promise<void>
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

function isDestroyedContextError(err: unknown): boolean {
  const message = errorMessage(err).toLowerCase()
  return message.includes('execution context') || message.includes('cannot find context') || message.includes('context was destroyed')
}

export class CdpPageSession {
  private executionContextId: number | null = null

  constructor(private readonly transport: CdpTransport) {}

  invalidateContext(): void {
    this.executionContextId = null
  }

  send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return this.transport.send(method, params)
  }

  async evaluate<T>(expression: string): Promise<T> {
    try {
      return await this.evaluateInCurrentWorld<T>(expression)
    } catch (err) {
      if (!isDestroyedContextError(err)) throw err
      this.invalidateContext()
      return this.evaluateInCurrentWorld<T>(expression)
    }
  }

  async close(): Promise<void> {
    this.executionContextId = null
    await this.transport.close()
  }

  private async evaluateInCurrentWorld<T>(expression: string): Promise<T> {
    const contextId = await this.contextId()
    const raw = record(await this.transport.send('Runtime.evaluate', {
      expression,
      contextId,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true
    }))
    const exception = record(raw?.exceptionDetails)
    if (exception !== null) {
      const detail = record(exception.exception)
      const description = detail?.description
      const text = exception.text
      throw new Error(
        typeof description === 'string'
          ? description
          : typeof text === 'string'
            ? text
            : 'Browser page evaluation failed.'
      )
    }
    const result = record(raw?.result)
    return result?.value as T
  }

  private async contextId(): Promise<number> {
    if (this.executionContextId !== null) return this.executionContextId
    const frameTree = record(await this.transport.send('Page.getFrameTree'))
    const frame = record(record(frameTree?.frameTree)?.frame)
    const frameId = frame?.id
    if (typeof frameId !== 'string' || frameId === '') {
      throw new Error('The browser page has no main frame.')
    }
    const world = record(await this.transport.send('Page.createIsolatedWorld', {
      frameId,
      worldName: '__nextcowork_browser_automation__',
      grantUniveralAccess: false
    }))
    const id = world?.executionContextId
    if (typeof id !== 'number' || !Number.isInteger(id)) {
      throw new Error('Unable to create the browser automation world.')
    }
    this.executionContextId = id
    return id
  }
}
