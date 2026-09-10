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

发布工作流先校验 tag 与 `package.json` 版本一致，并从 `CHANGELOG.md` 提取对应版本的说明，创建草稿 Release。各平台构建后直接上传到同一个草稿，正式发布不再使用 Actions Artifact 存储配额。全部平台完成后，工作流下载并校验 6 个产物，公开 Release，再把安装包和 macOS ZIP 更新包上传到 `https://nextco.work/api/client/updates/upload`。请在 GitHub 仓库配置名为 `CLIENT_UPLOAD_TOKEN` 的 Actions Secret，并让它与服务端 `ClientUpdates__UploadToken` 完全一致。

GitHub Release 展示完整更新日志。更新服务的说明字段通过 HTTP 请求头传递，因此使用对应 Release 的链接，避免多行中文触发非法请求头错误。

也可以从已构建的 `dist/` 目录手动补传：

```bash
CLIENT_UPLOAD_TOKEN=... npm run release:upload -- --version 0.1.3 --require-all
```

脚本默认使用 `https://nextco.work`，支持 `--base-url`、`--dir`、`--channel`、`--notes`、`--ignore-duplicates` 和 `--dry-run`；上传前会计算 SHA-256，服务端还会再次校验。工作流开启了 `--ignore-duplicates`，重复运行同一 tag 时已登记的目标会被安全跳过。

也可以从 GitHub Actions 手动运行该工作流。`release_tag` 留空时只验证三平台构建，产物保存在 Actions Artifacts 1 天；填入已存在的版本 tag（例如 `v0.1.6`）时，会使用当前分支的工作流构建该 tag 指向的代码并发布，适合修复发布流程后补发，无需移动 tag：

```bash
gh workflow run release.yml --ref main -f release_tag=v0.1.6
```

构建或上传失败时，尚未公开的 Release 保持草稿，可重跑失败的 job；已经上传的同名资源会被替换。当前构建不依赖付费的 Apple Developer 证书或 Windows 签名证书，Windows 安装程序和 macOS 安装包都会正常生成并上传。macOS 安装包在打包阶段会自动做 ad-hoc 签名（`scripts/mac-adhoc-sign.mjs`），避免 Apple Silicon 上未签名 arm64 应用被 Gatekeeper 判定为“已损坏”；用户首次打开时仍会看到“未知开发者”提示，按系统提示在“系统设置 → 隐私与安全性”中允许打开即可。
