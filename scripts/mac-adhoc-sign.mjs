import { execFileSync } from 'node:child_process'
import path from 'node:path'

/**
 * electron-builder afterPack hook.
 *
 * CI builds macOS artifacts without a Developer ID certificate
 * (`CSC_IDENTITY_AUTO_DISCOVERY=false`), so the packaged `.app` would otherwise
 * have no code signature at all. On Apple Silicon a fully unsigned app that a
 * browser has quarantined fails Gatekeeper outright with "App is damaged"
 * instead of the milder, dismissible "unidentified developer" prompt.
 *
 * This hook only establishes the signature and entitlements. electron-builder
 * flips the Electron fuses *after* this runs, which rewrites bytes inside the
 * framework and invalidates whatever was signed here, so the final signature
 * comes from `electronFuses.resetAdHocDarwinSignature` in electron-builder.yml.
 * Both pieces are required: without this hook there are no entitlements for the
 * fuse step to preserve, and without that flag the app is killed at launch.
 */
export default async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  const entitlements = path.join(context.packager.projectDir, 'build/entitlements.mac.plist')
  // The Electron.app framework tree ships nested items (PkgInfo files,
  // "Versions/Current" symlinks) carrying a `com.apple.FinderInfo` xattr.
  // codesign refuses to sign anything under a path with that xattr present,
  // so we must remove all xattrs recursively before signing.
  execFileSync(`find "${appPath}" -print0 | xargs -0 xattr -d com.apple.FinderInfo 2>/dev/null || true`, { shell: true, stdio: 'inherit' })
  execFileSync(`find "${appPath}" -print0 | xargs -0 xattr -d com.apple.ResourceFork 2>/dev/null || true`, { shell: true, stdio: 'inherit' })
  execFileSync(`find "${appPath}" -print0 | xargs -0 xattr -c 2>/dev/null || true`, { shell: true, stdio: 'inherit' })
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', '--entitlements', entitlements, appPath], {
    stdio: 'inherit',
  })
}
