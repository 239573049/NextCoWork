/** 对话右侧回合导航的可见文案与无障碍名称。 */
type Params = Record<string, string | number>

export const chatNavigationZh = {
  'chat.navigation.label': '对话轮次导航',
  'chat.navigation.untitled': '附件消息',
  'chat.navigation.item': ({ index, total, title }: Params) =>
    `跳转到第 ${index} 轮，共 ${total} 轮：${title}`
}

export const chatNavigationEn = {
  'chat.navigation.label': 'Conversation turn navigation',
  'chat.navigation.untitled': 'Attachment message',
  'chat.navigation.item': ({ index, total, title }: Params) =>
    `Go to turn ${index} of ${total}: ${title}`
}
