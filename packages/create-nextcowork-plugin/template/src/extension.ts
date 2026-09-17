/**
 * Hello world —— 一个插件的最小骨架。
 *
 * 三件事各演示一遍,它们覆盖了插件系统的三条主要通道:
 *
 * 1. `registerCommand` —— 菜单 / 命令面板 / 快捷键都按命令 id 分发;
 * 2. `storage`         —— 唯一需要声明的能力(清单里的 `permissions`);
 * 3. `showMessage`     —— 传的是 **l10n key**,不是句子。
 *
 * ★ 第 3 条是最容易写错的一条:往这里传一个中文字符串,它会原样显示,
 *   而且切到英文之后还是中文。宿主拿 key 去查 `l10n/` 里那两份 bundle。
 */
import * as ncw from 'nextcowork'

export function activate(context: ncw.ExtensionContext): void {
  let count = 0

  context.subscriptions.push(
    ncw.commands.registerCommand('__PUBLISHER__.__NAME__.hello', async () => {
      count += 1
      // 存的是这台机器上的计数;换一个工作区仍然是同一份。
      await ncw.storage.global.set('greetings', String(count))
      // ★ key,不是句子。参数经宿主插值。
      await ncw.window.showMessage('info', 'plugin.__PUBLISHER__.__NAME__.greeted', { count })
    })
  )

  /*
    状态栏那一格同样是 key。它每 30 秒才可能变一次,而状态栏是全应用最显眼的
    一块常驻文字 —— 不要往这里写会晃动的内容。
  */
  void ncw.window.setStatusBarItem('counter', 'plugin.__PUBLISHER__.__NAME__.ready')
}

export function deactivate(): void {
  // `context.subscriptions` 里的东西宿主会统一 dispose,这里只收自己另外开的。
}
