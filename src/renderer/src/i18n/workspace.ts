/**
 * 需求：工作区管理——外层 Tab 条「+」菜单里每个工作区都能直接改名/改默认模型/
 * 删除记录，而不必先切进去再双击标签改名（改名以外的项此前完全没有入口）。
 * 这个域此前不存在，按 §6.3 新建独立文件，不往 index.tsx 那三千行里堆。
 */
export const workspaceZh = {
  'workspace.edit': '编辑工作区',
  'workspace.name': '工作区名称',
  'workspace.nameHint': '支持中英文、数字、空格、连字符和下划线',
  'workspace.path': '路径',
  'workspace.defaultModel': '工作区默认模型',
  'workspace.defaultModelHint': '用于此工作区新对话的模型和思考强度。',
  'workspace.thinkingLevel': '思考强度',
  'workspace.delete': '删除工作区',
  'workspace.deleteConfirm': '从列表中移除“{name}”？磁盘上的文件不会被删除。',
  'workspace.deleteFailed': '删除失败，请重试',
  'workspace.saveFailed': '保存失败，请重试',
}

export const workspaceEn: Record<keyof typeof workspaceZh, string> = {
  'workspace.edit': 'Edit workspace',
  'workspace.name': 'Workspace name',
  'workspace.nameHint': 'Supports Chinese, English, digits, spaces, hyphens and underscores',
  'workspace.path': 'Path',
  'workspace.defaultModel': 'Workspace default model',
  'workspace.defaultModelHint': 'Used for new conversations in this workspace: the model and thinking level.',
  'workspace.thinkingLevel': 'Thinking level',
  'workspace.delete': 'Delete workspace',
  'workspace.deleteConfirm': 'Remove “{name}” from the list? Files on disk will not be deleted.',
  'workspace.deleteFailed': 'Delete failed, please try again',
  'workspace.saveFailed': 'Save failed, please try again',
}
