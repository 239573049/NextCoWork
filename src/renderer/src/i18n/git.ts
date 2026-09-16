/**
 * Git 管理面板的文案。
 *
 * 单独一个文件而不是往 `index.tsx` 那几千行里塞 —— 照 `extensions.ts` / `ssh.ts` 的先例。
 *
 * ★ `feature.git` / `view.feature.git` 也放在这儿:侧边栏那一格和外层 Tab 标题
 *   都走 `t(\`feature.${f}\`)` 这样的模板字面量,键不在表里的话运行时才暴露成
 *   一个显示出 `feature.git` 原文的按钮。和面板正文放在一起,加功能时不会漏。
 *
 * ★ **四种「开不出来」各有各的话。** 合并成一句「Git 不可用」等于把「这是个 SSH
 *   工作区」和「你没装 git」说成同一件事,而这两者用户要做的事完全不同。
 */

/**
 * 带参数的文案那一个入参类型。★ 必须显式标出来:这个文件没有 `Messages` 的
 * 上下文(它在 `index.tsx` 里),不标的话参数会被推断成 implicit any,
 * spread 进 `ZH` 时整张表都不再匹配 `Messages`。
 */
type Params = Record<string, string | number>

export const gitZh = {
  'feature.git': 'Git',
  'view.feature.git': 'Git',

  'git.title': 'Git',
  'git.description': '管理当前工作区的仓库',
  'git.close': '关闭 Git 面板',
  'git.refresh': '刷新',
  'git.loading': '正在读取仓库…',

  // ── 四种开不出来 ──
  'git.unavailable.remote-workspace': '远程工作区暂不支持 Git 管理',
  'git.unavailable.remote-workspaceHint': 'Git 命令跑在本机,对 SSH 上的目录无从谈起。请在远程终端里操作。',
  'git.unavailable.workspace-unavailable': '读不到工作区目录',
  'git.unavailable.workspace-unavailableHint': '目录可能已被删除、移走,或所在磁盘没有挂载。',
  'git.unavailable.git-missing': '没有找到 git',
  'git.unavailable.not-a-repository': '这个目录不是 Git 仓库',
  'git.unavailable.not-a-repositoryHint': '在终端里执行 git init,或者打开一个已有的仓库。',
  'git.noWorkspace': '还没有打开工作区',
  'git.noWorkspaceHint': '打开一个本地工作区之后,这里显示它的 Git 状态。',

  // ── 分支 ──
  'git.branch': '分支',
  'git.branchDetached': '游离 HEAD',
  'git.branchUnborn': '尚无提交',
  'git.switchBranch': '切换分支',
  'git.newBranch': '新建分支',
  'git.newBranchName': '分支名',
  'git.newBranchPlaceholder': '例如 feature/git-panel',
  'git.newBranchCheckout': '创建后切换过去',
  'git.create': '创建',
  'git.ahead': ({ count }: Params) => `领先 ${String(count)} 个提交`,
  'git.behind': ({ count }: Params) => `落后 ${String(count)} 个提交`,
  'git.noUpstream': '未设置上游',
  'git.pull': '拉取',
  'git.push': '推送',

  // ── 改动列表 ──
  'git.staged': '暂存区',
  'git.unstaged': '未暂存',
  'git.untracked': '未跟踪',
  'git.conflicted': '冲突',
  'git.conflictedHint': '先解决冲突再暂存',
  // 状态字母的 tooltip —— 字母取自 git status 的那一列
  'git.status.modified': '已修改',
  'git.status.added': '新增',
  'git.status.deleted': '已删除',
  'git.status.renamed': '已重命名',
  'git.status.copied': '复制自另一个文件',
  'git.status.typeChanged': '类型变了(文件 / 符号链接)',
  'git.status.untracked': '未跟踪',
  'git.stage': '暂存',
  'git.unstage': '取消暂存',
  'git.stageAll': '全部暂存',
  'git.unstageAll': '全部取消',
  'git.clean': '没有改动',
  'git.cleanHint': '工作区是干净的。',
  'git.filesTruncated': ({ count }: Params) => `改动太多,只显示前 ${String(count)} 个文件`,
  'git.renamedFrom': ({ from }: Params) => `重命名自 ${from}`,

  // ── 提交 ──
  'git.commitMessage': '提交信息',
  'git.commitPlaceholder': '这次改动做了什么',
  'git.commit': '提交',
  'git.commitDone': ({ hash }: Params) => `已提交 ${hash}`,
  'git.nothingStaged': '暂存区是空的',

  // ── AI 写提交信息 ──
  'git.aiGenerate': 'AI 生成提交信息',
  'git.aiGenerating': '正在生成…',
  'git.aiNoModel': '还没配默认模型,先去设置里选一个',
  'git.aiTimeout': '生成超时了,再试一次',
  'git.aiFailed': '生成失败,再试一次',
  'git.aiUnparsable': '模型没给出可用的提交信息',
  'git.aiTruncated': '模型的回答被截断了,再试一次',

  // ── diff / 历史 ──
  'git.tab.changes': '改动',
  'git.tab.history': '历史',
  'git.selectFile': '选一个文件查看改动',
  'git.diffBinary': '二进制文件,没有可显示的文本改动',
  'git.diffTruncated': '改动过大,以下内容已被截断',
  'git.diffLinesTruncated': ({ shown, total }: Params) =>
    `只显示了前 ${String(shown)} 行,共 ${String(total)} 行`,
  'git.diffEmpty': '这个文件没有文本改动',
  'git.noCommits': '还没有提交',
  'git.historyOf': '提交历史',

  // ── 失败 ──
  'git.operationFailed': '操作失败',
  'git.invalidBranch': '分支名不合法',
  'git.invalidPath': '文件路径不合法',
  'git.detachedPush': '当前是游离 HEAD,没有可推送的分支',
  'git.emptyMessage': '提交信息不能为空'
}

export const gitEn = {
  'feature.git': 'Git',
  'view.feature.git': 'Git',

  'git.title': 'Git',
  'git.description': 'Manage the current workspace repository',
  'git.close': 'Close the Git panel',
  'git.refresh': 'Refresh',
  'git.loading': 'Reading repository…',

  'git.unavailable.remote-workspace': 'Git management is not available for remote workspaces',
  'git.unavailable.remote-workspaceHint': 'Git runs on this machine, so it cannot reach a directory over SSH. Use a remote terminal instead.',
  'git.unavailable.workspace-unavailable': 'The workspace directory cannot be read',
  'git.unavailable.workspace-unavailableHint': 'It may have been deleted or moved, or its disk is not mounted.',
  'git.unavailable.git-missing': 'git was not found',
  'git.unavailable.not-a-repository': 'This directory is not a Git repository',
  'git.unavailable.not-a-repositoryHint': 'Run git init in a terminal, or open an existing repository.',
  'git.noWorkspace': 'No workspace is open',
  'git.noWorkspaceHint': 'Open a local workspace to see its Git status here.',

  'git.branch': 'Branch',
  'git.branchDetached': 'Detached HEAD',
  'git.branchUnborn': 'No commits yet',
  'git.switchBranch': 'Switch branch',
  'git.newBranch': 'New branch',
  'git.newBranchName': 'Branch name',
  'git.newBranchPlaceholder': 'e.g. feature/git-panel',
  'git.newBranchCheckout': 'Switch to it after creating',
  'git.create': 'Create',
  'git.ahead': ({ count }: Params) => `${String(count)} ahead`,
  'git.behind': ({ count }: Params) => `${String(count)} behind`,
  'git.noUpstream': 'No upstream set',
  'git.pull': 'Pull',
  'git.push': 'Push',

  'git.staged': 'Staged',
  'git.unstaged': 'Changes',
  'git.untracked': 'Untracked',
  'git.conflicted': 'Conflicted',
  'git.conflictedHint': 'Resolve the conflict before staging',
  'git.status.modified': 'Modified',
  'git.status.added': 'Added',
  'git.status.deleted': 'Deleted',
  'git.status.renamed': 'Renamed',
  'git.status.copied': 'Copied from another file',
  'git.status.typeChanged': 'Type changed (file / symlink)',
  'git.status.untracked': 'Untracked',
  'git.stage': 'Stage',
  'git.unstage': 'Unstage',
  'git.stageAll': 'Stage all',
  'git.unstageAll': 'Unstage all',
  'git.clean': 'No changes',
  'git.cleanHint': 'The working tree is clean.',
  'git.filesTruncated': ({ count }: Params) => `Too many changes — showing the first ${String(count)} files`,
  'git.renamedFrom': ({ from }: Params) => `Renamed from ${from}`,

  'git.commitMessage': 'Commit message',
  'git.commitPlaceholder': 'What does this change do?',
  'git.commit': 'Commit',
  'git.commitDone': ({ hash }: Params) => `Committed ${hash}`,
  'git.nothingStaged': 'Nothing is staged',

  'git.aiGenerate': 'Write a commit message with AI',
  'git.aiGenerating': 'Generating…',
  'git.aiNoModel': 'No default model is configured — pick one in Settings first',
  'git.aiTimeout': 'Generation timed out — try again',
  'git.aiFailed': 'Generation failed — try again',
  'git.aiUnparsable': 'The model did not return a usable commit message',
  'git.aiTruncated': 'The model\u2019s reply was cut off — try again',

  'git.tab.changes': 'Changes',
  'git.tab.history': 'History',
  'git.selectFile': 'Select a file to see its changes',
  'git.diffBinary': 'Binary file — no text changes to show',
  'git.diffTruncated': 'The change is large; the content below is truncated',
  'git.diffLinesTruncated': ({ shown, total }: Params) =>
    `Showing the first ${String(shown)} of ${String(total)} lines`,
  'git.diffEmpty': 'This file has no text changes',
  'git.noCommits': 'No commits yet',
  'git.historyOf': 'Commit history',

  'git.operationFailed': 'The operation failed',
  'git.invalidBranch': 'Invalid branch name',
  'git.invalidPath': 'Invalid file path',
  'git.detachedPush': 'HEAD is detached — there is no branch to push',
  'git.emptyMessage': 'The commit message cannot be empty'
}
