import { execFileSync } from 'node:child_process'
import path from 'node:path'

/**
 * electron-builder afterPack hook.
 *
 * CI builds macOS artifacts without a Developer ID certificate
 * (`CSC_IDENTITY_AUTO_DISCOVERY=false`), so the packaged `.app` has no code
 * signature at all. On Apple Silicon, macOS requires every executable to
 * carry at least an ad-hoc signature; a fully unsigned arm64 app downloaded
 * from a browser (and therefore quarantined) fails Gatekeeper's integrity
 * check with "App is damaged and can't be opened" instead of the milder
 * "unidentified developer" prompt. Ad-hoc signing here keeps that milder,
 * dismissible prompt without requiring a paid Apple Developer certificate.
 */
export default async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  const entitlements = path.join(context.packager.projectDir, 'build/entitlements.mac.plist')
  // The Electron.app framework tree ships nested items (PkgInfo files,
  // "Versions/Current" symlinks) carrying a `com.apple.FinderInfo` xattr.
  // codesign refuses to sign anything under a path with that xattr present,
  // and `xattr -cr` alone does not reliably strip it from every nested entry,
  // so clear each path individually first.
  execFileSync(`find "${appPath}" -print0 | xargs -0 xattr -c`, { shell: true, stdio: 'inherit' })
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', '--entitlements', entitlements, appPath], {
    stdio: 'inherit',
  })
}
