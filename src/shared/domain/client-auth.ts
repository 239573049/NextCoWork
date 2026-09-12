export interface ClientAuthUser {
  id: string
  username?: string | null
  email?: string | null
  displayName?: string | null
  avatarUrl?: string | null
  wallet?: { currency: string; availableBalance: number; cashBalance: number; giftBalance: number; totalConsumed: number } | null
}

export interface ClientTeamOption {
  id: string
  name: string
  type: string
  role: string
  memberCount: number
  isSelected: boolean
}

export interface ClientAuthState {
  mode: 'undecided' | 'offline' | 'authenticated'
  user: ClientAuthUser | null
  expiresAt: number | null
  teams?: ClientTeamOption[]
  selectedTeamId?: string | null
  contextRequired?: boolean
}

export interface ClientUsageEntry {
  id: string
  at: string
  model?: string | null
  provider?: string | null
  inputTokens: number
  outputTokens: number
  cost?: number | null
  currency?: string | null
}
