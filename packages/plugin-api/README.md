# @aidotnet/plugin-api

NextCoWork 插件的类型声明。**零运行时代码** —— 这个包里只有一份 `nextcowork.d.ts`。

```bash
npm i -D @aidotnet/plugin-api
```

```ts
import * as ncw from 'nextcowork'

export function activate(context: ncw.ExtensionContext): void {
  context.subscriptions.push(
    ncw.commands.registerCommand('acme.hello', () => ncw.window.showMessage('info', 'acme.demo.hello'))
  )
}
```

打包时把 `nextcowork` 标成 **external**(和 VS Code 的 `vscode` 一样);
运行期由宿主经 import map 注入实现。`@aidotnet/plugin-cli` 已经替你配好了。

## 这份声明是能力上界的一部分

没在 `nextcowork.d.ts` 里出现的 API,运行期会被白名单挡在第一道门外。
所以一个编译通过的插件不会遇到「这个方法不存在」。

反过来:**清单里没声明的能力,类型对了也会被拒**。类型系统管不了「用户批没批」。
�
