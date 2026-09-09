import { create } from 'zustand'
import type { ThemeProfile } from '../../../shared/domain/theme'
import { listProfiles } from '../services/theme'

interface ThemeProfileStore {
  profiles: ThemeProfile[]
  draft: ThemeProfile | null
  baseline: string
  fullPreview: boolean
  load: () => Promise<void>
  edit: (profile: ThemeProfile) => void
  update: (profile: ThemeProfile) => void
  discard: () => void
}
export const useThemeProfiles = create<ThemeProfileStore>((set) => ({
  profiles: [], draft: null, baseline: '', fullPreview: false,
  load: async () => set({ profiles: await listProfiles() }),
  edit: (profile) => set({ draft: structuredClone(profile), baseline: JSON.stringify(profile), fullPreview: false }),
  update: (profile) => set({ draft: profile }),
  discard: () => set({ draft: null, baseline: '', fullPreview: false })
}))
export function themeDraftDirty(): boolean {
  const s = useThemeProfiles.getState()
  return s.draft !== null && JSON.stringify(s.draft) !== s.baseline
}
