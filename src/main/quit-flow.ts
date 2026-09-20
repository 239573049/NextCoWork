/**
 * 退出流程的状态机 —— macOS 上「退出」不是一个瞬间动作,而是两段。
 *
 * **第一段:只关窗。** 关窗会触发渲染层的 `beforeunload`
 * (`renderer/views/files/DocumentDialogs.tsx`),有未保存的改动时它会顶住这次
 * unload。这一刻**什么都还没被破坏**,所以整次退出原样作废即可:托盘还在、库还
 * 开着、后台服务都还在跑,应用照常可用。用户随后在应用自己的对话框里选了
 * 「保存 / 丢弃」,渲染层经 `app:quit` 重新请求退出 —— 那一轮里它的 `allowUnload`
 * 已经是 true,不会再被顶。
 *
 * **第二段:停服务 → 封库 → 真退出。** 入口是「窗口全关完了」(`window-all-closed`)。
 *
 * ★ **这个两段式是修一个僵尸进程换来的。** 原来两段都塞在 `before-quit` 里:
 * 先 `destroyTray()`、停掉所有后台服务、`closeDatabase({ final: true })` **封库**,
 * 最后才 `app.quit()`。而那次 `app.quit()` 撞上渲染层的 `beforeunload` 会被
 * Electron **整个取消**(实测:窗口拒绝 unload 时进程 3 秒后仍然活着),于是进程
 * 停在这样一个状态里:
 *
 *   · `isQuitting === true` —— 所有唤回路径直接 return,点 Dock、从启动台再点一次
 *     都没有任何反应;
 *   · 托盘已经销毁 —— 连「退出 NextCoWork」都没得点了;
 *   · 库已经封 —— 界面里任何写入都抛 `DatabaseClosedError`。
 *
 * 用户看到的就是「退出之后一直显示打开,点它没反应」,只能强杀。第二段改由
 * `window-all-closed` 驱动之后,「库已封但窗口还在」这个组合在结构上就不存在了:
 * 封库只可能发生在窗口已经全部销毁之后。
 *
 * ★ **第一段必须有兜底时限。** 渲染层卡住(死循环、GC 停顿)时 `win.close()` 永远
 * 不回来,`window-all-closed` 也就永远不来 —— 那又回到「进程退不掉」。到点直接
 * `destroy()`(不跑 beforeunload)并收尾:退出一旦开始,进程必须在有限时间内结束。
 *
 * 本模块只做判断,不 import electron —— 窗口、托盘、库、定时器都由调用方注入,
 * 于是「否决之后应用必须完全可用」「收尾只做一次」这类容易回归的性质可以直接单测。
 */

/** 第一段要关的那些窗口。只需要这三个方法,于是测试里给个假窗口就够。 */
export interface QuitWindow {
  isDestroyed(): boolean
  close(): void
  destroy(): void
}

export interface QuitFlowDeps {
  /** 此刻活着的窗口,含插件那几扇隐藏的宿主窗。 */
  windows(): readonly QuitWindow[]
  /** 同步停掉后台服务(自动同步 / 用量汇总 / 调度 / 登录刷新 / run / 终端)。 */
  stopBackground(): void
  /** 异步收尾(MCP / 插件 / 环境 / 浏览器)。最多等 `asyncDeadlineMs`。 */
  drainAsync(): Promise<unknown>
  destroyTray(): void
  sealDatabase(): void
  quit(): void
  /** 收尾自己抛了异常时的最后手段:进程必须走,不能留在半退出状态。 */
  exit(code: number): void
  /**
   * 第一段(关窗)的兜底时限。默认 6 秒 —— 和原来的 `before-quit` 兜底同一个量级,
   * 用户的观感是「点了退出,最多几秒钟窗口就没了」。
   */
  closeDeadlineMs?: number
  /** 第二段(异步收尾)的兜底时限,默认 6 秒。 */
  asyncDeadlineMs?: number
}

const DEFAULT_CLOSE_DEADLINE_MS = 6000
const DEFAULT_ASYNC_DEADLINE_MS = 6000

export class QuitFlow {
  /** 第一段进行中:窗口正在关,这一次 close 是退出的一部分。 */
  private quitting = false
  /** 第二段已完成(或正在做):此后 `before-quit` 一律放行,唤回一律不理会。 */
  private finished = false
  private deadline: NodeJS.Timeout | null = null

  constructor(private readonly deps: QuitFlowDeps) {}

  /** 窗口的 `close` 处理器问它:这次关闭是退出流程要的,还是用户点了关闭按钮? */
  get inProgress(): boolean {
    return this.quitting
  }

  /** 收尾已经做完 —— 唤回路径和 `before-quit` 都据此让路。 */
  get done(): boolean {
    return this.finished
  }

  /**
   * 退出入口。`Cmd+Q`、托盘「退出」、以及任何一处 `app.quit()` 最终都落到这里。
   * 幂等:收尾完成后那一次 `app.quit()` 回过来时不重跑,只放行。
   */
  begin(): void {
    if (this.finished || this.quitting) return
    this.quitting = true
    const windows = this.deps.windows().filter((win) => !win.isDestroyed())
    // 没有窗口可关(全被销毁过、或这个平台本来就没有窗口)时不必等事件。
    if (windows.length === 0) {
      this.finish()
      return
    }
    this.deadline = setTimeout(() => this.forceClose(), this.deps.closeDeadlineMs ?? DEFAULT_CLOSE_DEADLINE_MS)
    for (const win of windows) win.close()
  }

  /**
   * 渲染层顶住了这次 unload —— 用户在「有未保存的改动」对话框上还没做决定。
   *
   * ★ **这里不能改成 `preventDefault()` 放行 unload**:那等于无视 `beforeunload`
   * 直接卸掉页面,用户的未保存改动会被静默丢弃。让否决生效、退出作废,才是
   * 既有语义(见文件头第一段)。
   */
  veto(): void {
    if (!this.quitting || this.finished) return
    this.clearDeadline()
    this.quitting = false
  }

  /**
   * 窗口全部关完了。只有第一段确实在跑时才收尾 —— 插件宿主窗自己销毁、
   * 或用户关掉了最后一个窗口时,这里什么都不该做(非 macOS 的 `app.quit()` 由
   * 调用方在那个分支里做)。
   */
  windowsClosed(): void {
    if (!this.quitting || this.finished) return
    this.finish()
  }

  /** 第一段到点还没关完:不再等渲染层,直接销毁窗口并收尾。 */
  private forceClose(): void {
    this.deadline = null
    for (const win of this.deps.windows()) {
      if (!win.isDestroyed()) win.destroy()
    }
    this.finish()
  }

  /**
   * 第二段。**只会跑一次** —— 这是不变式,不是优化:`sealDatabase()` 之后再有任何
   * 一步回头碰库都会抛 `DatabaseClosedError`。
   */
  private finish(): void {
    if (this.finished) return
    this.finished = true
    this.clearDeadline()
    this.deps.destroyTray()
    /*
      停服务与封库都**不许**把异常抛出去:能走到这里说明用户已经要退出了,
      此时任何一步失败都只剩「继续退出」一个正确方向 —— 抛出去就是又一个
      「进程还在、界面已死」的半退出状态(文件头那个僵尸)。
    */
    try {
      this.deps.stopBackground()
    } catch (err) {
      console.error('[quit] 停后台服务失败:', err)
    }
    /*
      ★ `sealed` 这个闸门不是防御性代码,它挡的是一个真实的竞态:**超时之后**
      drainAsync 才落地时,`.then()` 里那一发 seal() 会照跑第二遍 ——
      于是 `app.quit()` 在退出流程里被调第二次(第二次 before-quit 又走一遍
      `begin()`),而 `closeDatabase()` 也会被封第二次。
    */
    let sealed = false
    const seal = (): void => {
      if (sealed) return
      sealed = true
      try {
        this.deps.sealDatabase()
      } catch (err) {
        console.error('[quit] 封库失败:', err)
      }
      try {
        this.deps.quit()
      } catch (err) {
        console.error('[quit] app.quit() 失败,直接结束进程:', err)
        this.deps.exit(1)
      }
    }
    const timer = setTimeout(() => {
      console.error('[quit] 异步收尾超时,直接退出')
      seal()
    }, this.deps.asyncDeadlineMs ?? DEFAULT_ASYNC_DEADLINE_MS)
    void this.deps.drainAsync()
      .catch(() => undefined)
      .then(() => {
        // 正常路径上把兜底定时器撤掉;超时那一发已经走过,这里靠 `sealed` 让路。
        clearTimeout(timer)
        seal()
      })
  }

  private clearDeadline(): void {
    if (this.deadline === null) return
    clearTimeout(this.deadline)
    this.deadline = null
  }
}
