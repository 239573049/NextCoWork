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
- macOS：DMG 和 ZIP（`.dmg`、`.zip`）

也可以从 GitHub Actions 手动运行该工作流来验证三平台构建；手动运行只上传 Actions artifacts，不会创建 Release。当前构建不依赖代码签名，Windows 安装程序和 macOS 安装包都会正常生成并上传。macOS 用户首次打开未签名应用时，按系统提示在“系统设置 → 隐私与安全性”中允许打开即可。
