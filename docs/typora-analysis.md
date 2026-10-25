# Typora 安装包分析与独立实现需求

分析日期：2026-10-26。目标是理解用户提供安装包的功能结构，为 TyporaX 的独立实现确定需求。

## 目标与证据

- 原始文件：用户提供的 `Typora.dmg`
- SHA-256：`6f376ef9a61f06470650d24c2e6478947a9a5dc4e30fe641ae266b06bd892451`
- 本次使用 REA 6.8.0 的 `inspect-artifact`、`inspect-plist`、`decode-interface-builder`；补充使用 `hdiutil imageinfo`、`file`、`otool -L`、`plutil` 和文件目录读取。
- 磁盘映像以只读方式挂载。没有执行 Typora，没有分析或修改授权逻辑，没有将其代码、主题、字体、图标或其他资源用于 TyporaX。

| 证据 | 内容 |
| --- | --- |
| `ev_e6b30ce544921643c63708ccc12f77d0eac680550c8cec6e06b93fb3a2eaa60e` | REA 安装包检查；记录于 `<分析临时目录>/dmg-evidence.json` |
| `ev_58dd4dca1728b62f8cdc2284de7bd0e475da2a7d17c6ce9c554fc07aae32aee3` | 上述检查引用的容器清单：851 个内容节点、898 个出现位置、684 个文件、208 个目录、6 个符号链接 |
| `ev_2a741eb877574241e80a14ff5cbd430bbf39780015ff611a8aba7e9a681a8c50` | REA `Info.plist` 解析；记录于 `<分析临时目录>/plist-evidence.json` |
| `ev_04ec321c63a01bfcc187d177e2be0e34fd3341b68c39eb0b4247c26b066c5a3a` | REA 对选定 `Document.nib`、`MainMenu.nib` 的界面归档解码；记录于 `<分析临时目录>/interface-selected-evidence.json` |

默认的整包界面解码先处理了 Sparkle 的多语言归档，达到 64 个文档上限，未覆盖应用主菜单。提高到 128 的请求被输入校验拒绝；随后仅把原始 `Info.plist`、`Document.nib`、`MainMenu.nib` 复制到临时分析目录 `<分析临时目录>/selected-resources.app`，使用同一工具解析选定资源。这些文件没有进入 TyporaX 的源码或发行包。

选定归档的 SHA-256：

- `Contents/Resources/Base.lproj/Document.nib`：`ddac815b752b4e3e8256ccb21174283897e81224d2ad1e8b9e693a4ac1112dd9`
- `Contents/Resources/Base.lproj/MainMenu.nib`：`fdccfd93b4457a125be58c401ce72e13a9b3e21bf9a7b82c6ebf091d11f801f5`

这些 Evidence ID 来自本次本地 REA 会话。分析 JSON 与原安装包不纳入公开仓库；复核时应以相同 SHA-256 的安装包重新执行对应命令，或取得上述分析产物。

## 已观察到的结构

| 项目 | 观察 |
| --- | --- |
| 声明版本 | `Info.plist`：Typora 1.14.15，build 7789，bundle ID `abnerworks.Typora`。这是包内声明，不等于独立验证发行来源。 |
| 主机平台 | `Info.plist` 声明 macOS 12.0 起；`file` 检查主程序为 x86_64 与 arm64 双架构 Mach-O。 |
| 文档关联 | 声明 Markdown、纯文本的编辑器角色，以及目录查看角色。关联扩展含 `.md`、`.markdown`、`.txt` 等。 |
| 本地宿主 | `otool -L` 观察到 Cocoa、AppKit、WebKit、PDFKit、QuickLookUI 等系统依赖；包内包含 Sparkle 更新框架。 |
| 编辑器资源 | `Contents/Resources/TypeMark/` 下存在 HTML、JavaScript、CSS；`Document.nib` 解码含 `DocWebView`、`TyWindowController` 类名。 |
| 辅助库资源 | 文件清单包含 CodeMirror 模式、MathJax4、Mermaid 相关文件。文件存在仅说明打包了这些资源。 |
| 主题与语言 | 文件清单含多个主题目录及中英文等语言资源。未复制或采用这些主题资产。 |

由系统依赖、界面归档与网页资源共同推断，该 macOS 构建采用原生文档/窗口宿主结合网页编辑界面的结构。检查范围内没有 Electron Framework 或 ASAR；不能由此断言其他平台的 Typora 使用相同架构。

## 可观察的功能需求

以下需求来自 `Contents/Resources/zh-Hans.lproj/Menu.strings` 中的菜单条目，以及已解码的 `MainMenu.nib` 连接。菜单存在和目标动作连接不证明该功能运行时一定成功，也不揭示内部算法。

| 功能组 | 观察到的入口 | TyporaX 独立实现的适用方向 |
| --- | --- | --- |
| 文档生命周期 | 打开、新建、保存、保存全部、另存为、最近文件、打开目录 | 本地 Markdown 文件打开与保存、目录浏览、未保存提示、草稿恢复 |
| 编辑模式 | 源代码模式，动作连接 `toggleSourceMode:` | 可视编辑与 Markdown 源码切换，以 Markdown 作为持久化格式 |
| Markdown 格式 | 标题、粗体、斜体、代码块、引用、列表、任务列表、链接、图片 | 键盘输入规则和格式工具栏；使用独立开源编辑器实现 |
| 表格 | 插入、删除、行列增删与移动 | 可视化表格编辑和 Markdown 序列化 |
| 内容导航 | 文件树、文档列表、大纲、可折叠大纲 | 文件侧栏、标题大纲与点击定位 |
| 写作环境 | 专注模式、打字机模式、主题、字数统计 | 专注布局、跟随光标、独立配色主题与中文/英文统计 |
| 查找 | 查找、上一个/下一个、查找替换 | 文内查找与替换，不覆盖文件时静默改写原文 |
| 输出 | 导出、复制为 HTML、打印 | HTML 导出与系统打印/PDF；不宣称覆盖原软件的全部转换格式 |
| 扩展语法 | 行内/块数学公式、脚注、HTML 内容、图表资源 | 作为额外兼容项单独验证，不能由菜单存在推断完整支持范围 |

可核对的菜单连接还包括 `saveDocument:`、`showSearchPanel:`、`showReplacePanel:`、`toggleOutlinePanel:`、`toggleFocusMode:`、`toggleTypeWriterMode:`、`toggleWordCountPopover:` 与 `printFile:`。这些仅用作功能入口证据，没有提取原二进制的实现。

## 未验证范围与实现边界

- 没有启动目标程序，因此未观察实际编辑光标行为、IME 输入、实时预览、保存策略、撤销栈、导出质量、网络行为或运行时性能。
- REA 解码的 `MainMenu.nib` 层次完整；`Document.nib` 的层次标为不完整。未识别的私有归档字段、动态控件、约束和像素布局仍未知。
- 本次没有进行原生函数反编译，也没有解包并复用商业编辑器代码；这份报告用于需求观察，TyporaX 使用独立实现。
- “独立免费 Markdown 编辑器”不等于原产品全部功能、插件、格式与细节的逐项兼容；TyporaX 的可用能力以实际实现和测试结果为准。
