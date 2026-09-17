# acme.excalidraw

NextCoWork 的 Excalidraw 白板插件 —— **纯第三方插件**,不走任何内置路径。

```
「+」菜单 → 新建绘图
   ↓
drawings/drawing.excalidraw  ← 新建文件(重名自动递增)
   ↓
一个标签页 = 一个 .excalidraw 文件,标签里是画布
```

## 构建与安装

```bash
npm install
npm run package          # → acme.excalidraw-0.1.0.zip
```

在 NextCoWork 里:**扩展 › 插件 › 安装插件**,选那个 ZIP(或直接选这个目录)。
启用时会要求批准 `workspace.read` 与 `workspace.write` —— 它要读写你画的那些文件。

开发时用 `npm run build` 后选**目录**安装,改完重新点一次启用即可。

## 两个进程,一条窄通道

| 部分 | 跑在哪 | 干什么 |
|---|---|---|
| `src/extension.ts` | 隐藏的插件宿主窗口 | 新建文件、请宿主开 Tab。**不碰画布** |
| `view/main.tsx` | 主窗口的 `ncw-plugin://` iframe | 画布本体。只和宿主 postMessage |

画布与宿主之间只有三句话:

```
──ncw:doc:ready──▶   我起来了,把文件给我
◀──ncw:doc:open───   给你:{ path, data }
──ncw:doc:save───▶   存这份:{ data }
```

★ **报文里没有路径。** 写哪个文件由宿主按 Tab 绑定决定,画布说了不算 ——
于是这条通道的能力上界正好是「它自己那个文件」。画布是第三方代码,
它说不出「写 `../../.ssh/id_rsa`」这句话。

## 为什么字体要打进包里

`ncw-plugin://` 的 CSP 里 `connect-src` 不给外网,`script-src` 只给 `'self'`
—— 从 CDN 取一个字节都不行。所以 Excalidraw 的 209 个 woff2 子集原样复制进包,
`window.EXCALIDRAW_ASSET_PATH` 指向包内,取字体走的仍是 `ncw-plugin://` 协议。

代价是包有 15MB(上限 20MB)。去掉 `fonts/Xiaolai`(12MB)能压到 2MB 以内,
代价是图里的中文不再是手写体,退化成系统字体。

## 保存时机

`onChange` 在拖动期间每帧都触发,所以这里攒 800ms 再存一次,
并且**内容没变就不写** —— 只是平移缩放看一眼的话,文件 mtime 不该变
(那会让 Agent 误判「这个文件刚被改过」)。

关标签页时由宿主的脏状态挽留兜底,`pagehide` 再冲一次。
