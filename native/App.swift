import AppKit
import WebKit
import UniformTypeIdentifiers

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    let files: FileStore
    let isolatedSession: Bool
    // Tests inject only native dialog results; file operations and bridge dispatch remain production code.
    var selectionProvider: ((String) -> URL?)?
    var closeChoiceProvider: (() -> NSApplication.ModalResponse)?
    var readyObserver: (() -> Void)?
    var bootstrapObserver: (() -> Void)?
    var windowClosedObserver: (() -> Void)?
    var failureObserver: ((String) -> Void)?
    var initialScripts: [String] = []
    var dirty = false
    var closeAllowed = false
    var pendingQuit = false
    var webReady = false
    var pendingDocuments: [[String: Any]] = []
    var pendingCommands: [String] = []
    var pdfJobs: [UUID: PDFExportJob] = [:]
    let markdownTypes: [UTType] = [.plainText, UTType(filenameExtension: "md") ?? .plainText, UTType(filenameExtension: "markdown") ?? .plainText]

    init(defaults: UserDefaults = .standard, isolatedSession: Bool = false) {
        files = FileStore(defaults: defaults)
        self.isolatedSession = isolatedSession
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        makeMenus()
        let configuration = WKWebViewConfiguration()
        configuration.userContentController.add(self, name: "typorax")
        if CommandLine.arguments.contains("--web-smoke-test") {
            let capture = "window.__nativeSmokeErrors=[];addEventListener('error',e=>window.__nativeSmokeErrors.push(e.message));addEventListener('unhandledrejection',e=>window.__nativeSmokeErrors.push(String(e.reason)));"
            configuration.userContentController.addUserScript(WKUserScript(source: capture, injectionTime: .atDocumentStart, forMainFrameOnly: true))
            DispatchQueue.main.asyncAfter(deadline: .now() + 20) { fputs("TyporaX WebKit smoke test: TIMEOUT\n", stderr); exit(1) }
        }
        configuration.websiteDataStore = isolatedSession ? .nonPersistent() : .default()
        for script in initialScripts {
            configuration.userContentController.addUserScript(WKUserScript(source: script, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        // The offline application bundle has no arbitrary local-file access.
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.setValue(false, forKey: "drawsBackground")
        if #available(macOS 13.3, *) { webView.isInspectable = true }
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1240, height: 820), styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
        window.title = "TyporaX"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.backgroundColor = NSColor(red: 0.98, green: 0.97, blue: 0.95, alpha: 1)
        window.minSize = NSSize(width: 760, height: 540)
        window.delegate = self
        window.isReleasedWhenClosed = false
        if !isolatedSession { window.setFrameAutosaveName("TyporaXMainWindow") }
        window.contentView = webView
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        guard let webRoot = Bundle.main.resourceURL?.appendingPathComponent("web"), FileManager.default.fileExists(atPath: webRoot.appendingPathComponent("index.html").path) else {
            showError("应用资源缺失。请重新运行构建脚本。")
            return
        }
        webView.loadFileURL(webRoot.appendingPathComponent("index.html"), allowingReadAccessTo: webRoot)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { !isolatedSession }
    func windowWillClose(_ notification: Notification) { windowClosedObserver?() }

    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls {
            do {
                files.admitFile(url)
                let doc = try files.document(url)
                if webReady { deliverDocument(doc) } else { pendingDocuments.append(doc) }
            } catch { showError(error.localizedDescription) }
        }
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        if closeAllowed || !dirty { return true }
        return requestClose(quit: false)
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if closeAllowed || !dirty { return .terminateNow }
        return requestClose(quit: true) ? .terminateNow : .terminateCancel
    }

    private func requestClose(quit: Bool) -> Bool {
        let alert = NSAlert()
        alert.messageText = "保存尚未保存的更改？"
        alert.informativeText = "当前有文档尚未保存到文件。你可以保存全部文档后退出。"
        alert.addButton(withTitle: "保存")
        alert.addButton(withTitle: "取消")
        alert.addButton(withTitle: "不保存")
        switch closeChoiceProvider?() ?? alert.runModal() {
        case .alertFirstButtonReturn:
            pendingQuit = quit
            command("saveAndClose")
            return false
        case .alertThirdButtonReturn:
            closeAllowed = true
            return true
        default: return false
        }
    }

    func makeMenus() {
        let bar = NSMenu()
        let applicationItem = NSMenuItem()
        let applicationMenu = NSMenu()
        applicationMenu.addItem(withTitle: "关于 TyporaX", action: #selector(about), keyEquivalent: "").target = self
        applicationMenu.addItem(.separator())
        applicationMenu.addItem(withTitle: "隐藏TyporaX", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let hideOthers = applicationMenu.addItem(withTitle: "隐藏其他", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        applicationMenu.addItem(withTitle: "显示全部", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        applicationMenu.addItem(.separator())
        applicationMenu.addItem(withTitle: "退出TyporaX", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        applicationItem.submenu = applicationMenu
        bar.addItem(applicationItem)
        let file = addMenu("文件", to: bar)
        addCommand("新建文档", "new", "n", to: file)
        addCommand("打开文件…", "open", "o", to: file)
        addCommand("打开文件夹…", "openFolder", "o", modifiers: [.command, .shift], to: file)
        file.addItem(.separator())
        addCommand("保存", "save", "s", to: file)
        addCommand("另存为…", "saveAs", "s", modifiers: [.command, .shift], to: file)
        file.addItem(.separator())
        addCommand("导出 HTML…", "exportHTML", "", to: file)
        addCommand("导出 PDF…", "exportPDF", "p", to: file)
        file.addItem(.separator())
        file.addItem(withTitle: "关闭窗口", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        let edit = addMenu("编辑", to: bar)
        edit.addItem(withTitle: "撤销", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = edit.addItem(withTitle: "重做", action: Selector(("redo:")), keyEquivalent: "z"); redo.keyEquivalentModifierMask = [.command, .shift]
        edit.addItem(.separator())
        edit.addItem(withTitle: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "复制", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        edit.addItem(.separator())
        addCommand("查找与替换", "find", "f", to: edit)
        let view = addMenu("显示", to: bar)
        addCommand("切换源码模式", "source", "/", to: view)
        addCommand("专注模式", "focus", "f", modifiers: [.command, .shift], to: view)
        addCommand("切换明暗主题", "theme", "d", modifiers: [.command, .shift], to: view)
        view.addItem(.separator())
        let fullscreen = view.addItem(withTitle: "进入全屏幕", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f"); fullscreen.keyEquivalentModifierMask = [.command, .control]
        let help = addMenu("帮助", to: bar)
        addCommand("使用指南", "shortcuts", "", to: help)
        NSApp.mainMenu = bar
        NSApp.servicesMenu = NSMenu()
    }

    func addMenu(_ title: String, to parent: NSMenu) -> NSMenu {
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        let submenu = NSMenu(title: title); item.submenu = submenu; parent.addItem(item)
        return submenu
    }

    func addCommand(_ title: String, _ value: String, _ key: String, modifiers: NSEvent.ModifierFlags = [.command], to menu: NSMenu) {
        let item = NSMenuItem(title: title, action: #selector(menuCommand(_:)), keyEquivalent: key)
        item.target = self; item.representedObject = value; item.keyEquivalentModifierMask = modifiers
        menu.addItem(item)
    }

    @objc func menuCommand(_ sender: NSMenuItem) { if let value = sender.representedObject as? String { command(value) } }
    @objc func about() {
        NSApp.orderFrontStandardAboutPanel(options: [.applicationName: "TyporaX", .applicationVersion: "1.0.0", .version: "1", .credits: NSAttributedString(string: "离线、免费的 Markdown 写作空间\n独立实现 · MIT 开源许可\n编辑内核：Tiptap / ProseMirror\nhttps://github.com/riba2534/typorax\n独立项目，与 Typora 无关联")])
    }

    func command(_ value: String) {
        guard webReady else { pendingCommands.append(value); return }
        if let encoded = jsonString(value) { webView.evaluateJavaScript("window.__typoraxCommand && window.__typoraxCommand(\(encoded))", completionHandler: nil) }
    }

    func deliverDocument(_ doc: [String: Any]) {
        if let encoded = jsonString(doc) { webView.evaluateJavaScript("window.__typoraxOpenDocument && window.__typoraxOpenDocument(\(encoded))", completionHandler: nil) }
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) { webReady = false }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard CommandLine.arguments.contains("--web-smoke-test") else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
            webView.evaluateJavaScript("JSON.stringify({title:document.title,text:document.body.innerText.slice(0,600),editor:!!document.querySelector('[contenteditable=true]'),bridge:typeof window.__typoraxResolve,errors:window.__nativeSmokeErrors||[]})") { value, error in
                if let output = value as? String {
                    print(output)
                    if let bytes = output.data(using: .utf8), let result = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any], result["editor"] as? Bool == true, result["bridge"] as? String == "function", (result["errors"] as? [String] ?? []).isEmpty, self.webReady {
                        print("TyporaX WebKit smoke test: PASS"); exit(0)
                    }
                }
                fputs("TyporaX WebKit smoke test: FAIL \(error?.localizedDescription ?? "editor/bridge unavailable")\n", stderr); exit(1)
            }
        }
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { showError(error.localizedDescription) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { showError(error.localizedDescription) }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        showError("编辑器进程已停止。你的最近草稿会在重新打开应用时恢复。请重新启动TyporaX。")
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        if navigationAction.navigationType == .linkActivated, ["https", "http", "mailto"].contains(url.scheme?.lowercased() ?? "") {
            NSWorkspace.shared.open(url); decisionHandler(.cancel); return
        }
        if url.isFileURL, let root = Bundle.main.resourceURL?.appendingPathComponent("web").standardizedFileURL.path, url.standardizedFileURL.path == root + "/index.html" {
            decisionHandler(.allow); return
        }
        decisionHandler(.cancel)
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url, ["https", "http", "mailto"].contains(url.scheme?.lowercased() ?? "") { NSWorkspace.shared.open(url) }
        return nil
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert(); alert.messageText = "TyporaX"; alert.informativeText = message; alert.addButton(withTitle: "好")
        alert.beginSheetModal(for: window) { _ in completionHandler() }
    }
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert(); alert.messageText = "TyporaX"; alert.informativeText = message
        alert.addButton(withTitle: "确定"); alert.addButton(withTitle: "取消")
        alert.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn) }
    }
    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let alert = NSAlert(); alert.messageText = prompt
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 360, height: 24)); field.stringValue = defaultText ?? ""
        alert.accessoryView = field; alert.addButton(withTitle: "确定"); alert.addButton(withTitle: "取消")
        alert.window.initialFirstResponder = field
        alert.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn ? field.stringValue : nil) }
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, message.webView === webView,
              let source = message.frameInfo.request.url, source.isFileURL,
              let root = Bundle.main.resourceURL?.appendingPathComponent("web/index.html"),
              source.standardizedFileURL.path == root.standardizedFileURL.path,
              let body = message.body as? [String: Any], let id = body["id"], let method = body["method"] as? String else { return }
        let params = body["params"] as? [String: Any] ?? [:]
        let respond: (Any) -> Void = { result in self.resolve(id: id, result: result) }
        let fail: (Error) -> Void = { error in self.resolve(id: id, error: error.localizedDescription) }
        do {
            switch method {
            case "bootstrap":
                webReady = false
                var state = files.bootstrap()
                var documents = state["documents"] as? [[String: Any]] ?? []
                state["activePath"] = pendingDocuments.last?["path"] ?? NSNull()
                for document in pendingDocuments {
                    if !documents.contains(where: { $0["path"] as? String == document["path"] as? String }) { documents.append(document) }
                }
                state["documents"] = documents
                pendingDocuments = []
                respond(state)
                bootstrapObserver?()
            case "ready":
                webReady = true
                respond(["ok": true])
                let documents = pendingDocuments; pendingDocuments = []
                let commands = pendingCommands; pendingCommands = []
                documents.forEach(deliverDocument)
                commands.forEach(command)
                readyObserver?()
            case "openFile":
                let panel = NSOpenPanel(); panel.allowedContentTypes = markdownTypes; panel.canChooseDirectories = false; panel.allowsMultipleSelection = false
                panel.message = "选择 Markdown 或纯文本文件"
                chooseURL("openFile", panel: panel) { url in
                    guard let url else { respond(NSNull()); return }
                    do { self.files.admitFile(url); respond(try self.files.document(url)) } catch { fail(error) }
                }
            case "openFolder":
                let panel = NSOpenPanel(); panel.canChooseFiles = false; panel.canChooseDirectories = true; panel.allowsMultipleSelection = false
                panel.message = "选择你的 Markdown 文稿文件夹"
                chooseURL("openFolder", panel: panel) { url in
                    guard let url else { respond(NSNull()); return }
                    do { self.files.admitFolder(url); respond(try self.files.folder(url)) } catch { fail(error) }
                }
            case "readFile":
                let path = try requiredString(params, "path"); respond(try files.document(URL(fileURLWithPath: path)))
            case "refreshFolder":
                let path = try requiredString(params, "path"); respond(try files.folder(URL(fileURLWithPath: path)))
            case "saveFile":
                let content = try requiredString(params, "content", emptyAllowed: true)
                if let path = params["path"] as? String, !path.isEmpty, params["saveAs"] as? Bool != true {
                    respond(try files.save(URL(fileURLWithPath: path), content: content))
                } else {
                    let panel = NSSavePanel(); panel.allowedContentTypes = [UTType(filenameExtension: "md") ?? .plainText]; panel.canCreateDirectories = true
                    panel.nameFieldStringValue = safeName(params["name"] as? String ?? "未命名.md", extension: "md")
                    if let oldPath = params["path"] as? String { panel.directoryURL = URL(fileURLWithPath: oldPath).deletingLastPathComponent() }
                    chooseURL("saveFile", panel: panel) { url in
                        guard let url else { respond(NSNull()); return }
                        do { respond(try self.files.save(url, content: content, pickerAuthorized: true)) } catch { fail(error) }
                    }
                }
            case "exportHTML":
                let html = try requiredString(params, "html", emptyAllowed: true)
                let panel = NSSavePanel(); panel.allowedContentTypes = [.html]; panel.canCreateDirectories = true
                panel.nameFieldStringValue = safeName(params["name"] as? String ?? "文稿", extension: "html")
                chooseURL("exportHTML", panel: panel) { url in
                    guard let url else { respond(NSNull()); return }
                    do { try self.files.export(url, content: html); respond(["path": url.path]) } catch { fail(error) }
                }
            case "exportPDF":
                let html = try requiredString(params, "html")
                let panel = NSSavePanel(); panel.allowedContentTypes = [.pdf]; panel.canCreateDirectories = true
                panel.nameFieldStringValue = safeName(params["name"] as? String ?? "文稿", extension: "pdf")
                chooseURL("exportPDF", panel: panel) { url in
                    guard let url else { respond(NSNull()); return }
                    let jobId = UUID()
                    let job = PDFExportJob(html: html, output: url) { result in
                        self.pdfJobs.removeValue(forKey: jobId)
                        switch result { case .success: respond(["path": url.path]); case .failure(let error): fail(error) }
                    }
                    self.pdfJobs[jobId] = job; job.start()
                }
            case "chooseImage":
                let panel = NSOpenPanel(); panel.allowedContentTypes = [.png, .jpeg, .gif, .bmp, UTType(filenameExtension: "webp") ?? .image]; panel.canChooseDirectories = false
                panel.message = "插入图片（以自包含形式保存在 Markdown 中）"
                chooseURL("chooseImage", panel: panel) { url in
                    guard let url else { respond(NSNull()); return }
                    do { respond(try self.files.image(url)) } catch { fail(error) }
                }
            case "resolveImage":
                respond(try files.resolveImage(path: requiredString(params, "path"), documentPath: requiredString(params, "documentPath")))
            case "setDirty":
                dirty = params["dirty"] as? Bool ?? false
                window.isDocumentEdited = dirty
                if let name = params["name"] as? String { window.title = "\(name) — TyporaX" }
                respond(["ok": true])
            case "revealFile":
                let url = URL(fileURLWithPath: try requiredString(params, "path"))
                guard files.isAdmitted(url) else { throw TyporaXError.invalid("此路径未获授权。") }
                NSWorkspace.shared.activateFileViewerSelecting([url]); respond(["ok": true])
            case "closeConfirmed":
                guard !dirty else { throw TyporaXError.invalid("文档仍有未保存的更改，请保存后再关闭。") }
                dirty = false; closeAllowed = true; respond(["ok": true])
                DispatchQueue.main.async { if self.pendingQuit { NSApp.terminate(nil) } else { self.window.performClose(nil) } }
            default: throw TyporaXError.invalid("未知操作：\(method)")
            }
        } catch { fail(error) }
    }

    private func chooseURL(_ operation: String, panel: NSSavePanel, completion: @escaping (URL?) -> Void) {
        if let provider = selectionProvider { completion(provider(operation)); return }
        panel.beginSheetModal(for: window) { response in completion(response == .OK ? panel.url : nil) }
    }

    func requiredString(_ params: [String: Any], _ name: String, emptyAllowed: Bool = false) throws -> String {
        guard let value = params[name] as? String, emptyAllowed || !value.isEmpty else { throw TyporaXError.invalid("缺少参数：\(name)") }
        return value
    }

    func safeName(_ input: String, extension ext: String) -> String {
        let stem = URL(fileURLWithPath: input).deletingPathExtension().lastPathComponent
        return (stem.isEmpty ? "文稿" : stem) + "." + ext
    }

    func resolve(id: Any, result: Any = NSNull(), error: String? = nil) {
        var payload: [String: Any] = ["id": id]
        if let error = error { payload["error"] = error } else { payload["result"] = result }
        guard let encoded = jsonString(payload) else { return }
        webView.evaluateJavaScript("window.__typoraxResolve && window.__typoraxResolve(\(encoded))", completionHandler: nil)
    }

    func showError(_ message: String) {
        if let observer = failureObserver { observer(message); return }
        let alert = NSAlert(); alert.alertStyle = .warning; alert.messageText = "TyporaX"; alert.informativeText = message
        alert.addButton(withTitle: "好"); alert.runModal()
    }
}

func jsonString(_ value: Any) -> String? {
    guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed, .sortedKeys]), let text = String(data: data, encoding: .utf8) else { return nil }
    return text.replacingOccurrences(of: "\u{2028}", with: "\\u2028").replacingOccurrences(of: "\u{2029}", with: "\\u2029")
}

final class PDFExportJob: NSObject, WKNavigationDelegate {
    let webView: WKWebView
    let html: String
    let output: URL
    let completion: (Result<Void, Error>) -> Void
    var finished = false

    init(html: String, output: URL, completion: @escaping (Result<Void, Error>) -> Void) {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = false
        webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 794, height: 1123), configuration: configuration)
        self.html = html; self.output = output; self.completion = completion
        super.init(); webView.navigationDelegate = self
    }

    func start() {
        webView.loadHTMLString(html, baseURL: nil)
        DispatchQueue.main.asyncAfter(deadline: .now() + 30) { [weak self] in self?.finish(.failure(TyporaXError.invalid("PDF 导出超时。"))) }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
            guard !self.finished else { return }
            let geometryScript = "JSON.stringify({height:Math.max(document.body.scrollHeight,document.documentElement.scrollHeight),breaks:Array.from(document.querySelectorAll('p,h1,h2,h3,h4,h5,h6,pre,table,blockquote,li,hr')).map(e=>e.getBoundingClientRect().bottom+scrollY)})"
            webView.evaluateJavaScript(geometryScript) { value, error in
                guard let string = value as? String, let data = string.data(using: .utf8), let geometry = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let height = geometry["height"] as? Double, height.isFinite, height > 0 else {
                    self.finish(.failure(error ?? TyporaXError.invalid("无法读取文稿尺寸。"))); return
                }
                guard height <= 200000 else { self.finish(.failure(TyporaXError.invalid("文稿超过单次 PDF 导出长度，请按章节导出。"))); return }
                let scale = (595.28 - 72) / 794.0
                let capacity = (841.89 - 72) / scale
                let candidates = (geometry["breaks"] as? [Double] ?? []).filter { $0.isFinite && $0 > 0 }.sorted()
                var slices: [CGRect] = []
                var top = 0.0
                while top < height - 0.5 {
                    var bottom = min(top + capacity, height)
                    if bottom < height, let natural = candidates.last(where: { $0 <= bottom && $0 > top + capacity * 0.60 }) { bottom = natural }
                    slices.append(CGRect(x: 0, y: top, width: 794, height: bottom - top))
                    top = bottom
                }
                self.capturePages(slices, index: 0, pages: [])
            }
        }
    }

    private func capturePages(_ slices: [CGRect], index: Int, pages: [Data]) {
        guard !finished else { return }
        if index == slices.count {
            do { try writePaginated(pages); finish(.success(())) }
            catch { finish(.failure(error)) }
            return
        }
        let configuration = WKPDFConfiguration(); configuration.rect = slices[index]
        webView.createPDF(configuration: configuration) { result in
            guard !self.finished else { return }
            switch result {
            case .success(let data): self.capturePages(slices, index: index + 1, pages: pages + [data])
            case .failure(let error): self.finish(.failure(error))
            }
        }
    }

    private func writePaginated(_ pages: [Data]) throws {
        var paper = CGRect(x: 0, y: 0, width: 595.28, height: 841.89)
        let margin: CGFloat = 36
        let outputBytes = NSMutableData()
        guard let consumer = CGDataConsumer(data: outputBytes), let context = CGContext(consumer: consumer, mediaBox: &paper, nil) else { throw TyporaXError.invalid("无法创建 PDF 输出。") }
        for source in pages {
            guard let provider = CGDataProvider(data: source as CFData), let document = CGPDFDocument(provider), let page = document.page(at: 1) else { throw TyporaXError.invalid("无法生成 PDF 内容。") }
            let bounds = page.getBoxRect(.mediaBox)
            guard bounds.width > 0, bounds.height > 0 else { throw TyporaXError.invalid("PDF 尺寸无效。") }
            let scale = (paper.width - margin * 2) / bounds.width
            context.beginPDFPage(nil)
            context.saveGState()
            context.clip(to: CGRect(x: margin, y: margin, width: paper.width - 2 * margin, height: paper.height - 2 * margin))
            context.translateBy(x: margin - bounds.minX * scale, y: paper.height - margin - bounds.maxY * scale)
            context.scaleBy(x: scale, y: scale)
            context.drawPDFPage(page)
            context.restoreGState()
            context.endPDFPage()
        }
        context.closePDF()
        try (outputBytes as Data).write(to: output, options: .atomic)
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { finish(.failure(error)) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { finish(.failure(error)) }
    func finish(_ result: Result<Void, Error>) { guard !finished else { return }; finished = true; completion(result) }
}
