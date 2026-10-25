# 发布流程

## 本机验收在先

1. 完成实现和修复，同步 README、截图、兼容性说明与 CHANGELOG。
2. 保持 package.json 与 native/Info.plist 的版本一致；依赖变化后更新 lockfile 和第三方声明。
3. 在 Mac 上运行 `npm run verify:local`，确认所有用例通过，检查生成的应用和安装包。存在失败时先修复，不提交或推送。
4. 检查 diff 和生成物，确认没有用户文档、凭据或临时路径后，再提交和推送。

## 标签和安装包

本机验证完成后，给经过验证的提交创建与版本一致的标签，例如 `v1.0.0`。

```bash
git tag -a v1.0.0 -m "TyporaX 1.0.0"
git push origin v1.0.0
```

Release 工作流使用 macOS ARM runner，重新执行完整验收，生成 DMG 和 SHA256SUMS。所有检查成功后，才会创建 GitHub Release 并上传文件。标签版本与包版本不一致会停止发布。

本地手工打包使用 `npm run package:mac`，产物在 `build/`。当前使用 ad-hoc 签名，不包含 Apple Developer ID 公证；不要在发布说明中宣称已公证。

每次发布说明需写清功能、系统和架构范围、验证结果及已知限制。签名与校验只能证明产物完整性，不能代替编辑和文件生命周期的功能测试。
