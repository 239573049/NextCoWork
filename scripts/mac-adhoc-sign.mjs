import { execFileSync } from 'node:child_process'
import path from 'node:path'

/** codesign 拒绝签名时对"脏"扩展属性的固定说法。 */
const DETRITUS = /resource fork, Finder information, or similar detritus/

/**
 * electron-builder 的 afterPack 钩子：翻转 Electron fuse，然后 ad-hoc 签名。
 *
 * CI 与本机都没有 Developer ID 证书（`security find-identity` 为空），electron-builder
 * 的签名步骤会整个跳过，所以包里唯一的签名就是这里打的。Apple Silicon 上一个完全没签名
 * 的 app 被浏览器加上隔离属性后会直接被 Gatekeeper 判成"已损坏"，而不是那个还能绕过的
 * "未验证的开发者"提示。
 *
 * 顺序是关键。electron-builder 的执行次序是 afterPack → 翻转 fuse → 签名，而翻转 fuse
 * 会重写 Electron Framework 内部的字节：先签名再翻转，签名必然作废，应用启动时读取 fuse
 * 就会被内核以 Code Signature Invalid 杀掉（崩溃栈停在 `IsRunAsNodeEnabled`）。所以这里
 * 自己先把 fuse 翻掉，再签名，让签名成为最后一步。
 *
 * electron-builder 随后还会用同一份配置再翻一次 fuse，写入的字节与这里完全一致，文件内容
 * 不变，签名因此依然成立。也正因为如此，electron-builder.yml 里的
 * `resetAdHocDarwinSignature` 必须保持 false：那个开关会让 fuse 步骤自己去 codesign，
 * 而那次调用不在我们控制内，无法处理下面这个扩展属性问题。
 */
export default async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  const { packager } = context
  const appPath = path.join(context.appOutDir, `${packager.appInfo.productFilename}.app`)
  const entitlements = path.join(packager.projectDir, 'build/entitlements.mac.plist')

  const fuses = packager.config.electronFuses
  if (fuses) {
    await packager.addElectronFuses(context, await packager.generateFuseConfig(fuses))
  }

  // 只要 com.apple.FinderInfo / com.apple.ResourceFork 出现在包内任意一项上，codesign 就
  // 拒绝工作。构建目录若位于 iCloud 同步范围内（本仓库在 Desktop 下即是），文件提供者会不断
  // 往目录上补盖 FinderInfo，清理与签名之间的空隙足够它再盖一次，所以要重试。
  let failure = null
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      execFileSync('xattr', ['-cr', appPath], { stdio: 'ignore' })
    } catch {
      // 清理是尽力而为，真正的判据是下面的 codesign。
    }
    try {
      execFileSync(
        'codesign',
        ['--force', '--deep', '--sign', '-', '--entitlements', entitlements, appPath],
        { stdio: ['ignore', 'inherit', 'pipe'] }
      )
      failure = null
      break
    } catch (error) {
      failure = error
      if (!DETRITUS.test(String(error.stderr ?? ''))) break
    }
  }
  if (failure) {
    process.stderr.write(String(failure.stderr ?? ''))
    throw failure
  }

  // 不看退出码就当签成功过太多次了，这里直接对产物断言。断言落在 Electron Framework 的
  // 二进制上：它正是 fuse 改写、继而让签名作废的那个文件，而且它是文件不是目录，不会被上面
  // 那个补盖 FinderInfo 的行为挡住。整包 `--deep` 校验在 iCloud 目录下几乎必然被挡，
  // 想跑请先把包 ditto 到同步范围之外。
  execFileSync(
    'codesign',
    [
      '--verify',
      '--strict',
      path.join(appPath, 'Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework')
    ],
    { stdio: 'inherit' }
  )
}
