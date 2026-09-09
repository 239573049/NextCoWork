import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../settings'
import { IMAGE_THEMES } from '../theme'
import { contrastWarnings, createThemeProfile, isThemeProfile, migrateThemeProfile, resolveProfile } from '../theme-profile'

describe('theme profiles', () => {
  it('round trips the versioned profile shape and rejects unsafe records', () => {
    const profile = createThemeProfile('theme_test', 'Test')
    expect(isThemeProfile(JSON.parse(JSON.stringify(profile)))).toBe(true)
    expect(isThemeProfile({ ...profile, id: '../escape' })).toBe(false)
    expect(isThemeProfile({ ...profile, version: 99 })).toBe(false)
  })

  it('migrates legacy settings and keeps image seed plus overrides', () => {
    const settings = { ...DEFAULT_SETTINGS, imageTheme: { id: IMAGE_THEMES[0]!.id, render: 'overlay' as const }, themeStudio: { ...DEFAULT_SETTINGS.themeStudio, wallpaperAssetId: IMAGE_THEMES[0]!.id, overrides: { accent: '#ff00aa' } } }
    const profile = migrateThemeProfile(settings, IMAGE_THEMES)
    expect(profile.wallpaper?.assetId).toBe(IMAGE_THEMES[0]!.id)
    expect(profile.wallpaper?.render).toBe('overlay')
    expect(profile.palette.tokens.accent).toBe('#ff00aa')
  })

  it('reports and protects low contrast manual colors', () => {
    const profile = createThemeProfile('theme_contrast', 'Contrast')
    profile.palette.tokens = { fg: '#777777', 'fg-muted': '#777777', accent: '#777777', 'accent-fg': '#777777' }
    const result = resolveProfile(profile, 'light')
    expect(result.protected).toBe(true)
    expect(contrastWarnings(result.tokens).length).toBe(0)
  })
})
