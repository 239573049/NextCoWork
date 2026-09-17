/**
 * Excalidraw 插件的**逻辑侧** —— 跑在隐藏的插件宿主窗口里。
 *
 * ## 它只做两件事
 *
 * 1. 注册 `excalidraw.new`:挑一个不重名的文件名 → 写一份空场景 → 请宿主开 Tab;
 * 2. 注册 `excalidraw.editor` 这个 viewType,好让 `.excalidraw` 文件认得到它。
 *
 * ## 它**不碰画布**
 *
 * 画布在另一个进程里(主窗口的 `ncw-plugin://` iframe),两边不通消息。
 * 文件的读写由宿主按 Tab 绑定代劳(见 `view/main.tsx` 的文档通道),
 * 所以这里写完初始文件之后就再也不参与了。
 *
 * ★ 这个分工是**故意的**:画布每几百毫秒就要存一次,让它绕一圈
 * iframe → 逻辑侧 → 主进程,等于给每次落笔加两跳 IPC;而逻辑侧除了转发
 * 什么也做不了。宿主直接按绑定代写,少一跳,而且路径不经过第三方代码。
 */
import * as ncw from 'nextcowork'

/** 新建文件的落点。★ 不写在工作区根上 —— 根目录是用户的项目,不是白板的收纳盒。 */
const DRAWINGS_DIR = 'drawings'

/** Excalidraw 认的空场景。`type`/`version`/`source` 三样缺一个它就当成损坏文件。 */
const EMPTY_SCENE = JSON.stringify(
  {
    type: 'excalidraw',
    version: 2,
    source: 'nextcowork-plugin:acme.excalidraw',
    elements: [],
    appState: { viewBackgroundColor: '#ffffff' },
    files: {}
  },
  null,
  2
)

export function activate(context: ncw.ExtensionContext): void {
  context.subscriptions.push(
    ncw.commands.registerCommand('excalidraw.new', async () => {
      const path = await nextFreePath()
      await ncw.workspace.fs.writeFile(path, EMPTY_SCENE)
      await ncw.tabs.openCustomEditor('excalidraw.editor', path)
    })
  )
}

export function deactivate(): void {
  /* 没有常驻资源:命令由 subscriptions 收,画布不归这一侧管 */
}

/**
 * 找一个还没被占用的文件名:`新建绘图.excalidraw`、`新建绘图 2.excalidraw`……
 *
 * ★ 用 `stat` 逐个试而不是先列目录:列目录要读权限覆盖整个 `drawings/`,
 * 而这里只需要回答「这一个名字占了没」。
 *
 * ★ 上限 200:一个卡在「全都占用」的循环会让点一次菜单挂住整个命令超时。
 * 到顶之后退回时间戳 —— 它一定不重名,只是名字不好看。
 */
async function nextFreePath(): Promise<string> {
  const base = 'drawing'
  for (let i = 1; i <= 200; i += 1) {
    const path = `${DRAWINGS_DIR}/${base}${i === 1 ? '' : ` ${String(i)}`}.excalidraw`
    const stat = await ncw.workspace.fs.stat(path)
    if (stat.kind === 'missing') return path
  }
  return `${DRAWINGS_DIR}/${base}-${String(Date.now())}.excalidraw`
}