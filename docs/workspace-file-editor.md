# 工作区文件预览、编辑与管理

右侧文件树负责导航；点击文件后沿用现有 `openPath` 行为，在右侧工作台打开文件标签。同一工作区、同一路径不会重复打开同类标签。`doc` 和 `preview` 标签现在共享真实的文件视图。

## 使用方式

- 点击文本或代码文件直接进入源码编辑，支持行号、语法高亮、Tab 缩进、撤销/重做、搜索/替换以及保存。
- Markdown 默认显示渲染预览，可切换到源码模式编辑，再切回预览查看尚未保存的内容。支持标题、列表、任务列表、引用、代码块、表格、链接和工作区相对图片。
- 图片直接预览；二进制、非 UTF-8 文本或超过大小限制的文件显示说明，并提供系统文件管理器定位入口。
- 使用保存按钮或 `Cmd/Ctrl + S` 保存。切换标签、面板或工作区会保留当前进程内的草稿；未保存文件显示状态和标签圆点。
- 关闭文件/工作区、重新读取文件，以及重命名、移动、删除受影响路径前，提供保存、放弃或取消选项。保存失败或版本冲突会保留草稿。
- 文件树工具栏提供新建文件/文件夹；每行操作菜单提供新建子项、重命名、复制、移动、删除和定位。复制/移动输入完整的工作区相对目标路径，目标父目录必须已存在。
- 删除有二次确认并移入系统回收站。成功操作会刷新文件列表；重命名/移动会更新已打开标签、草稿和目录展开路径，删除会关闭相关标签。

## 关键实现

| 路径 | 职责 |
| --- | --- |
| `src/renderer/src/views/files/DocumentView.tsx` | 文件类型分流、模式切换、加载/保存/错误状态、快捷保存 |
| `src/renderer/src/views/files/CodeEditor.tsx` | CodeMirror 编辑器与主题、本地化、按需语言加载 |
| `src/renderer/src/views/files/MarkdownPreview.tsx` | 文件预览适配，共用 Agent Markdown 组件与工作区链接策略 |
| `src/renderer/src/views/files/markdown-links.ts` | Markdown 路径归一化与协议过滤 |
| `src/renderer/src/stores/documents.ts` | 按工作区/路径隔离草稿、保存快照、读写竞态、确认状态 |
| `src/renderer/src/views/files/DocumentDialogs.tsx` | 全局未保存确认与窗口关闭提醒 |
| `src/renderer/src/views/files/FilesView.tsx` | 文件树、操作菜单、加载重试和刷新 |
| `src/renderer/src/views/files/FileOperationDialog.tsx` | 文件管理输入与危险操作确认 |
| `src/renderer/src/views/files/file-operations.ts` | 文件管理输入校验与请求转换 |
| `src/renderer/src/services/workspace-files.ts` | 类型化 IPC 服务、错误翻译映射、标签同步、刷新通知 |
| `src/renderer/src/stores/tabs.ts` | 文件/目录移动与删除后的标签路径同步 |
| `src/main/ipc/workspace-files.ts` | 受围栏保护的磁盘操作、读取限制、原子保存、回收站 |
| `src/shared/domain/workspace-file.ts` | 文件结果、请求、错误标识与大小限制 |
| `src/shared/ipc/contract.ts`、`src/main/ipc/index.ts` | IPC 类型契约、白名单及处理器注册 |
| `src/renderer/src/i18n/{documents,editor,files}.ts` | 中英文文案，由 `i18n/index.tsx` 合并进两份 catalog |

`AppShell.tsx` 挂载全局确认界面并保护标签关闭；`InnerTabBar.tsx` 显示草稿标记；`Panels.tsx` 传递工作区标识；`views/registry.tsx` 将原文档/预览占位接到 `DocumentView`。

## IPC 约定

所有 `path` / `destination` 都是工作区相对路径。工作区根由主进程根据已登记的 `workspaceId` 查找，渲染层不能指定任意磁盘根目录。

| 频道 | 请求 | 返回数据 |
| --- | --- | --- |
| `workspace:readFile` | `{ workspaceId, path }` | `WorkspaceFile` |
| `workspace:writeFile` | `{ workspaceId, path, content, revision }` | `WorkspaceTextFile`（含新 revision） |
| `workspace:mutateFile` | `{ workspaceId, operation, path, destination? }` | `{ path, destination? }` |
| `workspace:revealFile` | `{ workspaceId, path }` | `void`；该频道允许 `path: ''` 定位工作区根 |

`operation` 取 `create-file`、`create-directory`、`rename`、`move`、`copy`、`delete`。后三种涉及目标的操作使用完整相对路径 `destination`，始终拒绝覆盖已有目标。

```ts
type WorkspaceFile = { path: string; size: number; revision: string } & (
  | { kind: 'text'; content: string }
  | { kind: 'image'; mime: string; dataUrl: string }
  | { kind: 'binary'; reason: 'unsupported' | 'too-large' | 'encoding' }
)
```

使用项目原有 `IpcResult` 信封。文件错误返回 `error.code: 'tool_failed'`、`error.message: 'workspace_file:<reason>'`。这是机器标识，不直接显示；服务层映射为 `document.error.*` 的本地化文案。

保存携带读取时的 SHA-256 内容摘要；磁盘内容变化时返回 `conflict`，不覆盖外部修改。写入采用同目录临时文件加原子替换。渲染层保存的是提交时快照，保存请求期间新输入的内容继续作为未保存草稿保留。UTF-8 BOM、常见换行和编辑范围外的混合换行保留。

成功写入/管理操作会派发渲染窗口内的 `workspace-files-changed` 事件，包含 `{ workspaceId, operation, path, destination? }`；文件树据此刷新已展开目录。这不是磁盘监听器：外部工具的修改通过手动刷新/重新读取查看，保存时始终进行冲突校验。

## 依赖与范围

新增四个直接依赖，沿用项目把渲染层依赖放在 `devDependencies`、打包进前端产物的方式：

- `@uiw/react-codemirror`：成熟的 React 编辑器封装，用于编辑、选区、撤销、快捷键与行号。
- `@codemirror/language-data`：文件类型识别与按需语言解析器。
- `react-markdown`：将 Markdown 渲染为 React 节点，不执行原始 HTML。
- `remark-gfm`：补充表格、任务列表等常用 GFM 语法。

项目原先没有对应编辑器或 Markdown 渲染组件。语言解析器按需加载；不额外引入 Monaco、编辑器框架或 UI 组件库。`package-lock.json` 与 `bun.lock` 同步记录新增依赖。

文本上限 2 MiB，图片上限 16 MiB；复制上限 10,000 项或 256 MiB。非 UTF-8 文本不会被猜测编码后覆盖。图片支持 PNG/JPEG/GIF/WebP/AVIF/BMP/ICO/SVG；无法解码时显示错误。Markdown 外部 HTTP(S) 链接走现有系统浏览器服务；相对图片通过受保护的文件读取接口加载。外部网络图片默认显示占位，用户点击后才加载且不发送 Referer。原始 HTML 和危险协议不执行。Markdown 的共享组件、公式、图表和内容策略见 [Agent Markdown](./agent-markdown.md)。

当前草稿保留在渲染进程内存，不提供崩溃后的草稿恢复。普通关闭提供提醒；强制结束进程不会触发窗口关闭流程。

## 验证

运行 `npm run build` 完成前后端类型检查及生产构建，`npm test` 运行完整测试套件。新增测试覆盖后端文件分类/限制/越界/符号链接/版本冲突/原子保存/文件管理、草稿隔离与并发保存、混合换行、读取期间移动、Markdown 安全渲染、语言识别和文件操作路径校验。

`node scripts/workspace-files-qa.mjs` 使用隔离的临时工作区启动生产构建，通过真实 Electron 窗口验证预览、编辑、保存、草稿提醒、文件管理和双语界面，保留截图和测试结果。

本次验证：生产构建通过；111 个测试文件全部通过，2509 项测试通过、1 项跳过；新增实现与测试文件的 ESLint 通过。真实 Electron 验收 14/14 场景通过，未捕获的 renderer 异常为 0，包括关闭窗口时取消保留草稿、保存并继续后落盘和关闭窗口。
