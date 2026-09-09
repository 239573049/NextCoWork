import { DEFAULT_THEME_STUDIO, type AppSettings, type ThemeStudioSettings } from './settings'
import {
  COLOR_THEMES, DEFAULT_COLOR_THEME_ID, DEFAULT_CUSTOM_SEED, IMAGE_THEMES,
  THEME_TOKENS, contrastRatio, hslToHex, hexToHsl, resolveImageTheme, tokensOf,
  type Appearance, type ImageTheme, type ThemeProfile, type ThemeTokens, type ThemeToken,
  type ThemeWallpaper, type ThemeSurfaceConfig
} from './theme'

export const PROFILE_VERSION = 1
export const DEFAULT_PROFILE_ID = 'builtin-default'
export const SURFACE_REGIONS = ['window', 'chrome', 'sidebar', 'canvas', 'rightPanel', 'bottomPanel', 'content'] as const
export const DEFAULT_SURFACES: ThemeSurfaceConfig = Object.fromEntries(SURFACE_REGIONS.map((key) => [key, {
  opacity: key === 'canvas' ? .35 : key === 'window' ? .7 : key === 'content' ? 1 : .88,
  mask: key === 'canvas' ? .15 : .28,
  solid: key === 'content', wallpaper: key === 'canvas' ? 1 : .55, blur: key !== 'canvas'
}])) as unknown as ThemeSurfaceConfig

export function createThemeProfile(id: string, name: string, now = Date.now()): ThemeProfile {
  return {
    id, name, version: PROFILE_VERSION, wallpaper: null,
    palette: { source: 'auto', seed: DEFAULT_CUSTOM_SEED, tokens: {}, base: { id: DEFAULT_COLOR_THEME_ID, seed: 0, custom: DEFAULT_CUSTOM_SEED } },
    surfaces: structuredClone(DEFAULT_SURFACES),
    typography: { uiFont: 'system', codeFont: 'system-mono', scale: 'standard', weight: 'standard' },
    motion: { level: 'standard' }, readability: { guardrails: true, allowLowContrast: false, textContrast: 'auto' },
    createdAt: now, updatedAt: now
  }
}

export function wallpaperFor(assetId: string): ThemeWallpaper {
  return { assetId, thumbnailAssetId: assetId, fit: 'cover', position: { x: 50, y: 50 }, scale: 1,
    brightness: 1, saturation: 1, blur: 0, opacity: .55, animation: 'auto', render: 'overlay',
    scope: 'desktop', positioning: 'viewport', crop: 'original' }
}

export function builtinProfiles(): ThemeProfile[] {
  const standard = { ...createThemeProfile(DEFAULT_PROFILE_ID, '', 0), builtin: true }
  return [standard, ...COLOR_THEMES.filter((c) => c.id !== DEFAULT_COLOR_THEME_ID).map((c) => ({
    ...createThemeProfile(`builtin-color-${c.id}`, c.name, 0), builtin: true,
    palette: { ...standard.palette, base: { id: c.id, seed: 0, custom: DEFAULT_CUSTOM_SEED } }
  })), ...IMAGE_THEMES.map((image) => ({
    ...createThemeProfile(`builtin-image-${image.id}`, image.name, 0), builtin: true,
    wallpaper: wallpaperFor(image.id), palette: { source: 'auto' as const, seed: image.seed, tokens: {} }
  }))]
}

/** The image record may be unavailable; its stored seed still produces the same palette. */
export function migrateThemeProfile(settings: AppSettings, images: readonly ImageTheme[], id = 'migrated-theme'): ThemeProfile {
  const studio = settings.themeStudio ?? DEFAULT_THEME_STUDIO
  const image = resolveImageTheme(studio.wallpaperAssetId ?? settings.imageTheme.id, images)
  const p = createThemeProfile(id, studio.name, 0)
  p.palette = { source: 'auto', seed: image?.seed ?? settings.colorTheme.custom, tokens: { ...studio.overrides }, base: { ...settings.colorTheme } }
  if (image !== null) p.wallpaper = { ...wallpaperFor(image.id), render: settings.imageTheme.render ?? studio.render,
    opacity: studio.opacity, blur: studio.render === 'blur' ? studio.blur : 0, brightness: studio.brightness,
    saturation: studio.saturation, position: { x: studio.positionX, y: studio.positionY } }
  p.surfaces.sidebar.opacity = studio.sidebarOpacity
  p.surfaces.rightPanel.opacity = p.surfaces.bottomPanel.opacity = studio.panelOpacity
  for (const region of SURFACE_REGIONS) p.surfaces[region].mask = studio.mask
  p.typography.uiFont = studio.uiFont
  p.typography.scale = studio.uiScale
  p.motion.level = studio.motion
  p.readability.guardrails = studio.guardrails
  return p
}

/** Downgrade compatibility only. New UI and renderer consume the independent profile. */
export function legacyStudioOf(p: ThemeProfile): ThemeStudioSettings {
  return { ...DEFAULT_THEME_STUDIO, name: p.name, wallpaperAssetId: p.wallpaper?.assetId ?? null,
    render: p.wallpaper?.render ?? 'blur', opacity: p.wallpaper?.opacity ?? .55, blur: p.wallpaper?.blur ?? 44,
    brightness: p.wallpaper?.brightness ?? 1, saturation: p.wallpaper?.saturation ?? 1,
    positionX: p.wallpaper?.position.x ?? 50, positionY: p.wallpaper?.position.y ?? 50,
    sidebarOpacity: p.surfaces.sidebar.opacity, panelOpacity: p.surfaces.rightPanel.opacity,
    mask: p.surfaces.canvas.mask, uiFont: p.typography.uiFont, uiScale: p.typography.scale,
    motion: p.motion.level, guardrails: p.readability.guardrails, overrides: p.palette.tokens }
}

const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const oneOf = (v: unknown, values: readonly string[]): boolean => typeof v === 'string' && values.includes(v)
const number = (v: unknown, min: number, max: number): boolean => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max
const hex = (v: unknown): boolean => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v)
const id = (v: unknown): boolean => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(v)
const overrides = (v: unknown): boolean => record(v) && Object.entries(v).every(([k, c]) => THEME_TOKENS.includes(k as ThemeToken) && hex(c))

/** Validate both untrusted IPC payloads and each disk record, without dropping the whole library. */
export function isThemeProfile(v: unknown): v is ThemeProfile {
  if (!record(v) || !id(v.id) || typeof v.name !== 'string' || v.name.length > 80 || v.version !== PROFILE_VERSION ||
      !number(v.createdAt, 0, Number.MAX_SAFE_INTEGER) || !number(v.updatedAt, 0, Number.MAX_SAFE_INTEGER) ||
      (v.builtin !== undefined && typeof v.builtin !== 'boolean')) return false
  const w = v.wallpaper
  if (w !== null && (!record(w) || !id(w.assetId) || (w.thumbnailAssetId !== undefined && w.thumbnailAssetId !== w.assetId) ||
      !oneOf(w.fit, ['cover', 'contain']) || !record(w.position) || !number(w.position.x, 0, 100) || !number(w.position.y, 0, 100) ||
      !number(w.scale, 1, 3) || !number(w.brightness, .2, 2) || !number(w.saturation, 0, 2) || !number(w.blur, 0, 80) ||
      !number(w.opacity, 0, 1) || !oneOf(w.animation, ['auto', 'static']) || !oneOf(w.render, ['blur', 'overlay']) ||
      !oneOf(w.scope, ['desktop', 'workspace']) || !oneOf(w.positioning, ['viewport', 'region']) || !oneOf(w.crop, ['original', '16:9', '4:3', '1:1']))) return false
  const p = v.palette
  if (!record(p) || !oneOf(p.source, ['auto', 'manual']) || !hex(p.seed) || !overrides(p.tokens) ||
      (p.light !== undefined && !overrides(p.light)) || (p.dark !== undefined && !overrides(p.dark))) return false
  if (p.base !== undefined && (!record(p.base) || !id(p.base.id) || !number(p.base.seed, 0, Number.MAX_SAFE_INTEGER) || !hex(p.base.custom))) return false
  if (!record(v.surfaces)) return false
  for (const region of SURFACE_REGIONS) {
    const s = v.surfaces[region]
    if (!record(s) || !number(s.opacity, 0, 1) || !number(s.mask, 0, 1) || !number(s.wallpaper, 0, 1) || typeof s.solid !== 'boolean' || typeof s.blur !== 'boolean') return false
  }
  const t = v.typography, m = v.motion, r = v.readability
  return record(t) && oneOf(t.uiFont, ['system', 'system-rounded', 'system-serif']) && t.codeFont === 'system-mono' &&
    oneOf(t.scale, ['small', 'standard', 'large']) && oneOf(t.weight, ['standard', 'compact', 'comfortable']) &&
    record(m) && oneOf(m.level, ['standard', 'soft', 'reduced', 'off']) && record(r) && typeof r.guardrails === 'boolean' &&
    typeof r.allowLowContrast === 'boolean' && oneOf(r.textContrast, ['auto', 'strict', 'relaxed'])
}

export interface ContrastWarning { token: ThemeToken; background: ThemeToken; ratio: number; target: number }
const TEXT_BACKGROUNDS: ThemeToken[] = ['canvas', 'surface', 'chrome', 'surface-raised', 'surface-input', 'surface-field', 'surface-sunken', 'tint', 'tint-hover', 'tint-strong']
export function contrastWarnings(tokens: ThemeTokens, target = 4.5): ContrastWarning[] {
  const pairs: [ThemeToken, ThemeToken, number][] = [
    ...(['fg', 'fg-muted'] as const).flatMap((token): [ThemeToken, ThemeToken, number][] => TEXT_BACKGROUNDS.map((bg) => [token, bg, target])),
    ['accent-fg', 'accent', target], ['icon', 'surface', 3], ['accent', 'canvas', 3], ['border', 'surface-input', 3]
  ]
  return pairs.flatMap(([token, background, minimum]) => {
    const ratio = contrastRatio(tokens[token], tokens[background])
    return ratio + .01 < minimum ? [{ token, background, ratio, target: minimum }] : []
  })
}

function fitColor(color: string, backgrounds: string[], target: number): string | null {
  if (backgrounds.every((b) => contrastRatio(color, b) >= target)) return color
  const hsl = hexToHsl(color)
  for (let delta = 1; delta <= 100; delta++) {
    for (const l of [hsl.l - delta, hsl.l + delta]) {
      if (l < 0 || l > 100) continue
      const candidate = hslToHex({ ...hsl, l })
      if (backgrounds.every((b) => contrastRatio(candidate, b) >= target)) return candidate
    }
  }
  return ['#000000', '#ffffff'].find((c) => backgrounds.every((b) => contrastRatio(c, b) >= target)) ?? null
}

export function resolveProfile(p: ThemeProfile, appearance: Appearance): { tokens: ThemeTokens; warnings: ContrastWarning[]; protected: boolean } {
  const base = tokensOf(appearance, p.palette.base ?? { id: 'custom', custom: p.palette.seed },
    p.wallpaper ? { seed: p.palette.seed } : null)
  const tokens = { ...base, ...p.palette.tokens, ...p.palette[appearance] }
  const target = p.readability.textContrast === 'strict' ? 7 : p.readability.textContrast === 'relaxed' && p.readability.allowLowContrast ? 3 : 4.5
  const protect = p.readability.guardrails && !p.readability.allowLowContrast
  if (protect) {
    for (const key of ['fg', 'fg-muted'] as const) {
      if (fitColor(tokens[key], TEXT_BACKGROUNDS.map((b) => tokens[b]), target) === null) {
        // Opposite extreme manual surfaces cannot share a readable foreground.
        for (const bg of TEXT_BACKGROUNDS) tokens[bg] = base[bg]
      }
      tokens[key] = fitColor(tokens[key], TEXT_BACKGROUNDS.map((b) => tokens[b]), target) ?? (appearance === 'dark' ? '#ffffff' : '#000000')
    }
    tokens.accent = fitColor(tokens.accent, [tokens.canvas], 3) ?? base.accent
    tokens['accent-fg'] = fitColor(tokens['accent-fg'], [tokens.accent], target) ?? '#ffffff'
    tokens.icon = fitColor(tokens.icon, [tokens.surface], 3) ?? tokens.fg
    tokens.border = fitColor(tokens.border, [tokens['surface-input']], 3) ?? tokens['fg-muted']
  }
  return { tokens, warnings: contrastWarnings(tokens, target), protected: protect }
}
