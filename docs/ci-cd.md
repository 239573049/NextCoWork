# GitHub CI/CD

每次向 `main` 推送代码或提交 Pull Request 时，`CI` 工作流会在 Ubuntu runner 上执行类型检查、Lint 和全部测试。

创建并推送版本 tag 即可构建并发布桌面安装包：

```bash
git tag v0.1.0
git push origin v0.1.0
```

`Build desktop releases` 会分别在 Windows、Ubuntu 和 macOS runner 上构建 electron-builder 已配置的目标格式，然后把产物上传到同一个 GitHub Release：

- Windows：NSIS 安装程序（`.exe`）
- Ubuntu：AppImage（`.AppImage`）
- macOS：Apple Silicon（arm64）和 Intel（x64）各自生成 DMG 和 ZIP（`.dmg`、`.zip`）

发布工作流会先校验构建产物、创建 GitHub Release，再把 Windows EXE、Linux AppImage 和两种架构的 macOS DMG 原始上传到 `https://nextco.work/api/client/updates/upload`，供客户端更新服务下载。请在 GitHub 仓库配置名为 `CLIENT_UPLOAD_TOKEN` 的 Actions Secret，并让它与服务端 `ClientUpdates__UploadToken` 完全一致。macOS ZIP 只上传到 GitHub Release，因为更新服务每个目标只登记一个安装文件。

也可以从已构建的 `dist/` 目录手动补传：

```bash
CLIENT_UPLOAD_TOKEN=... npm run release:upload -- --version 0.1.3 --require-all
```

脚本默认使用 `https://nextco.work`，支持 `--base-url`、`--dir`、`--channel`、`--notes`、`--ignore-duplicates` 和 `--dry-run`；上传前会计算 SHA-256，服务端还会再次校验。工作流开启了 `--ignore-duplicates`，重复运行同一 tag 时已登记的目标会被安全跳过。

也可以从 GitHub Actions 手动运行该工作流来验证三平台构建；手动运行只上传 Actions artifacts，不会创建 Release。当前构建不依赖代码签名，Windows 安装程序和 macOS 安装包都会正常生成并上传。macOS 用户首次打开未签名应用时，按系统提示在“系统设置 → 隐私与安全性”中允许打开即可。
