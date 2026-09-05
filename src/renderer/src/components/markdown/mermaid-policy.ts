/**
 * Mermaid's strict mode disables scripts, but image shapes still create Image()
 * during layout. Keep resource/configuration syntax out of automatic rendering.
 * Unsupported diagrams remain available as their original, copyable source.
 */
export function canRenderMermaid(source: string): boolean {
  if (source.length > 50_000) return false
  // Decode escapes before inspecting keys and CSS functions (JSON/YAML and CSS).
  const normalized = source.replace(/\\u([a-f\d]{4})|\\([a-f\d]{1,6})\s?/gi, (_match, unicode: string | undefined, css: string | undefined) => {
    const point = Number.parseInt(unicode ?? css ?? '', 16)
    return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : ''
  }).replace(/\\(?:\r\n|[\r\n])/g, '').replace(/\\(.)/g, '$1').replace(/\/\*[\s\S]*?\*\//g, '')
  return !/(?:^|\n)\s*---(?:\s|$)|%%\s*\{|["']?\bimg["']?\s*:|\burl\s*\(|@import\b|@font-face\b|<(?!br\s*\/?>)[a-z!/]/i.test(normalized)
}
