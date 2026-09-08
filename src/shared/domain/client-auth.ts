export interface ClientAuthUser {
  id: string
  username?: string | null
  email?: string | null
  displayName?: string | null
  avatarUrl?: string | null
  wallet?: { currency: string; availableBalance: number; cashBalance: number; giftBalance: number; totalConsumed: number } | null
}

export interface ClientAuthState {
  mode: 'undecided' | 'offline' | 'authenticated'
  user: ClientAuthUser | null
  expiresAt: number | null
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
