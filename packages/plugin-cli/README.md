# @aidotnet/plugin-cli

```bash
npx nextcowork-plugin build      # src/extension.ts → dist/extension.js(nextcowork 标 external)
npx nextcowork-plugin package    # 打成 <publisher>.<name>-<version>.zip
npx nextcowork-plugin publish    # 校验 → 上传 → 提交审核(需要 --token)
npx nextcowork-plugin dev        # 监听 src/,改一行就重新构建
```

## 它不替你校验清单

校验已经在两处存在:客户端装载时、服务端上传时。这里再写第三份一定会分叉,
而分叉的症状是「本地说没问题、传上去被拒」——最消耗耐心的一种失败。
`publish` 调用的是服务端的 `/api/plugins/validate`,你看到的就是审核会看到的。
