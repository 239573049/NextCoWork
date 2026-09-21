/**
 * 奖励中心（邀请好友）的文案。
 *
 * 需求：账户菜单里的「邀请好友」从「跳浏览器」改成应用内的全屏浮层，浮层里的
 * 每一句话都要能跟着语言切换。照 `usage.ts` / `git.ts` 的先例单独建文件，
 * 不再往 `index.tsx` 那三千行里堆（§6.3）。
 *
 * ★ `rewardsEn` **不要**标 `Record<keyof typeof rewardsZh, string>` —— 带插值的
 * 条目值是函数不是 string，标了整张表都不匹配。zh/en 的键对齐由
 * `index.test.ts` 逐键比对守着。
 *
 * 不翻译的东西：邀请码、邀请链接、币种代码（`USD` 来自接口，是领域值，§6.5）、
 * 好友名（服务端已打码的原样显示）。
 */

/**
 * 带参数文案的入参类型。★ 必须显式标出来：这个文件拿不到 `index.tsx` 里
 * `Messages` 的上下文，不标的话参数是 implicit any，spread 进 `ZH` 时整张表都不再匹配。
 */
type Params = Record<string, string | number>

export const rewardsZh = {
  'rewards.title': '奖励中心',
  'rewards.close': '关闭奖励中心',
  'rewards.refresh': '刷新',
  'rewards.bannerEyebrow': '好东西，和朋友分享',
  'rewards.bannerTitle': '邀请新用户，一起获得更多。',
  'rewards.bannerArtAlt': '两张叠放的卡片插画',
  /** 活动开着、且双方都有奖励时的那一行。金额由调用方格式化好再传进来。 */
  'rewards.bannerReward': ({ inviter, invitee }: Params) =>
    `每邀请一位好友，你得 ${inviter}，好友得 ${invitee}`,
  'rewards.bannerRewardInviterOnly': ({ inviter }: Params) => `每邀请一位好友，你得 ${inviter}`,
  'rewards.bannerRewardInviteeOnly': ({ invitee }: Params) => `你的好友注册即得 ${invitee}`,
  /** 活动开着但平台还没配金额 —— 不能编一个数出来，只说规则。 */
  'rewards.bannerRewardUnset': '奖励金额由平台配置，开奖后会显示在这里',
  'rewards.bannerDisabled': '活动暂时还没开始',
  'rewards.qualifyHint': ({ calls }: Params) => `好友完成 ${calls} 次计费调用后，双方奖励到账`,
  'rewards.giftValidDays': ({ days }: Params) => `奖励额度有效期 ${days} 天`,
  'rewards.giftNeverExpires': '奖励额度永不过期',

  'rewards.inviteLink': '邀请链接',
  'rewards.inviteCode': '邀请码',
  'rewards.copyLink': '复制链接',
  'rewards.copyCode': '复制邀请码',
  'rewards.copied': '已复制到剪贴板',
  'rewards.copyFailed': '复制失败，请重试',
  'rewards.openInBrowser': '在浏览器中打开',

  'rewards.statTotal': '累计邀请',
  'rewards.statRewarded': '已发放',
  'rewards.statPending': '待达标',
  'rewards.statEarned': '累计获得',
  'rewards.statPeople': ({ count }: Params) => `${count} 人`,

  'rewards.tasksTitle': '奖励任务',
  'rewards.tasksEmpty': '暂无奖励任务',
  'rewards.colTask': '任务',
  'rewards.colProgress': '进度',
  'rewards.colReward': '奖励',

  'rewards.invitesTitle': '邀请记录',
  'rewards.invitesEmpty': '暂无邀请记录',
  'rewards.colFriend': '好友',
  'rewards.colInviteStatus': '邀请状态',
  'rewards.colFriendReward': '好友奖励',
  'rewards.colInviteTime': '邀请时间',

  'rewards.rewardsTitle': '奖励记录',
  'rewards.rewardsEmpty': '暂无奖励记录',
  'rewards.colRewardSource': '来源',
  'rewards.colRewardAmount': '金额',
  'rewards.colRewardRemaining': '剩余',
  'rewards.colRewardTime': '到账时间',

  'rewards.status.Pending': '待达标',
  'rewards.status.Qualified': '待发放',
  'rewards.status.Rewarded': '已发放',
  'rewards.status.Rejected': '已拒绝',
  'rewards.status.Expired': '已过期',
  'rewards.side.inviter': '邀请好友',
  'rewards.side.invitee': '接受邀请',
  'rewards.revoked': '已撤销',
  'rewards.expiresAt': ({ date }: Params) => `${date} 过期`,
  'rewards.neverExpires': '不过期',

  'rewards.loading': '正在加载奖励信息…',
  'rewards.unavailable.signed-out': '登录后即可查看你的邀请奖励。',
  'rewards.unavailable.unsupported': '当前服务端还没有开放奖励中心，请稍后再试或到网页端查看。',
  'rewards.unavailable.network': '奖励信息加载失败，请检查网络后重试。'
}

export const rewardsEn = {
  'rewards.title': 'Rewards',
  'rewards.close': 'Close rewards',
  'rewards.refresh': 'Refresh',
  'rewards.bannerEyebrow': 'Share something good',
  'rewards.bannerTitle': 'Invite a friend, gain more together.',
  'rewards.bannerArtAlt': 'Illustration of two stacked cards',
  'rewards.bannerReward': ({ inviter, invitee }: Params) =>
    `For every friend who joins, you get ${inviter} and they get ${invitee}`,
  'rewards.bannerRewardInviterOnly': ({ inviter }: Params) => `You get ${inviter} for every friend who joins`,
  'rewards.bannerRewardInviteeOnly': ({ invitee }: Params) => `Your friend gets ${invitee} on sign-up`,
  'rewards.bannerRewardUnset': 'Reward amounts are set by the platform and will appear here',
  'rewards.bannerDisabled': 'The programme has not started yet',
  'rewards.qualifyHint': ({ calls }: Params) =>
    `Both rewards land once your friend makes ${calls} billed call(s)`,
  'rewards.giftValidDays': ({ days }: Params) => `Reward credit is valid for ${days} days`,
  'rewards.giftNeverExpires': 'Reward credit never expires',

  'rewards.inviteLink': 'Invite link',
  'rewards.inviteCode': 'Invite code',
  'rewards.copyLink': 'Copy link',
  'rewards.copyCode': 'Copy code',
  'rewards.copied': 'Copied to clipboard',
  'rewards.copyFailed': 'Could not copy. Please try again.',
  'rewards.openInBrowser': 'Open in browser',

  'rewards.statTotal': 'Invited',
  'rewards.statRewarded': 'Rewarded',
  'rewards.statPending': 'Pending',
  'rewards.statEarned': 'Earned',
  'rewards.statPeople': ({ count }: Params) => `${count}`,

  'rewards.tasksTitle': 'Reward tasks',
  'rewards.tasksEmpty': 'No reward tasks yet',
  'rewards.colTask': 'Task',
  'rewards.colProgress': 'Progress',
  'rewards.colReward': 'Reward',

  'rewards.invitesTitle': 'Invites',
  'rewards.invitesEmpty': 'No invites yet',
  'rewards.colFriend': 'Friend',
  'rewards.colInviteStatus': 'Status',
  'rewards.colFriendReward': 'Your reward',
  'rewards.colInviteTime': 'Invited',

  'rewards.rewardsTitle': 'Reward history',
  'rewards.rewardsEmpty': 'No rewards yet',
  'rewards.colRewardSource': 'Source',
  'rewards.colRewardAmount': 'Amount',
  'rewards.colRewardRemaining': 'Remaining',
  'rewards.colRewardTime': 'Credited',

  'rewards.status.Pending': 'Pending',
  'rewards.status.Qualified': 'Qualified',
  'rewards.status.Rewarded': 'Rewarded',
  'rewards.status.Rejected': 'Rejected',
  'rewards.status.Expired': 'Expired',
  'rewards.side.inviter': 'Invited a friend',
  'rewards.side.invitee': 'Accepted an invite',
  'rewards.revoked': 'Revoked',
  'rewards.expiresAt': ({ date }: Params) => `Expires ${date}`,
  'rewards.neverExpires': 'No expiry',

  'rewards.loading': 'Loading your rewards…',
  'rewards.unavailable.signed-out': 'Sign in to see your invite rewards.',
  'rewards.unavailable.unsupported': 'This server does not serve rewards yet. Try again later or check the website.',
  'rewards.unavailable.network': 'Could not load your rewards. Check your connection and try again.'
}
