# acme.note-editor —— 用 React 写插件界面(不自带 React)

这个示例只为一件事存在:证明**插件可以用 React 写界面,而且不打包 React、
不重画控件、不写一行样式**。

## 和老做法的对照

`examples/acme.excalidraw` 是同一类东西的老写法。两者的差别不在代码风格上:

| | acme.excalidraw(老) | 这里 |
|---|---|---|
| React | `devDependencies` 一份,打进 bundle | 宿主经 import map 下发,**external** |
| 控件 | 自己写 `<button className="…">`,照宿主的样子调 | `import { Button } from 'nextcowork/ui'` |
| 样式 | 自己写 `<style>`,手动读 `--ncw-*` | 宿主随 HTML 注入 `/__ui.css`,**不用引** |
| 文档通道 | 手写 `addEventListener('message')` + 比对 origin | `onDocument` / `saveDocument` / `setDirty` |
| 主题 | 自己声明 `__ncwTheme` 全局、接 `ncw:theme` | 控件自己跟着走 |
| `node_modules` | 有(react、react-dom、画布库) | **没有** |
| 视图产物 | 一个 bundle + 若干 chunk | `dist/view/editor.js` = **1.3 KB** |

## 跑起来

```bash
node build.mjs          # 不需要 npm install:这个包零依赖
```

然后在「扩展 › 插件 › 安装插件」里选这个目录,新建一个 `.note` 文件打开它。

## 三处值得看的地方

1. **`view/editor.tsx` 顶部的 import**。`nextcowork/ui` 与 `nextcowork/view`
   都是裸模块名,由宿主的 import map 解析。打包时它们是 external ——
   见 `build.mjs` 里的 `VIEW_EXTERNALS`,以及那里写的两种打进去之后的症状。

2. **`view/editor.html` 里什么都没有**。没有 CSP、没有 `<link>`、没有 importmap。
   三样都由协议 handler 在下发这份 HTML 时注入。

3. **`setDirty`**。宿主的「关 Tab 之前问一句」完全靠它。注释里写了不报的后果。

## 已知的坑(不是这个示例的问题,是当前能力的边界)

- **视图里没有 i18n**。插件的 `l10n/` 是给**清单**和宿主界面用的;视图 iframe
  是另一个文档,拿不到宿主的 `t()`。所以这个示例里的「保存 / 已保存」是写死的中文。
  多语言插件目前只能自己在视图里判 `document.documentElement.lang`。
- **视图不能独立成一个侧边栏面板**。能被打开的视图只有两种:绑定到文件的
  自定义编辑器(这里这种),和网址(`contributes.webApps`)。
  `contributes.views` 里 `location` 写 `sidebar`/`panel` 的能装上但打不开,
  插件详情页会给一条诊断说明。
