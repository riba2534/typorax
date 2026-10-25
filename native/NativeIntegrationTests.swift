import AppKit
import WebKit
import PDFKit

/// An in-process acceptance runner. Only the OS picker/confirmation results are simulated.
/// JavaScript uses the shipped editor's DOM handlers and the actual WKScriptMessage bridge.
@MainActor
final class NativeIntegrationTests {
    let root: URL
    let defaults: UserDefaults
    let suite: String
    let delegate: AppDelegate
    private var selections: [(String, URL?)] = []
    private var choices: [NSApplication.ModalResponse] = []
    private var failure: String?
    private var readyContinuation: CheckedContinuation<Void, Never>?
    private var started = false
    private var finished = false
    private var didClose = false
    private var steps = 0

    init() throws {
        root = FileManager.default.temporaryDirectory.resolvingSymlinksInPath().appendingPathComponent("typorax-integration-" + UUID().uuidString)
        suite = "com.riba2534.typorax.integration." + UUID().uuidString
        defaults = UserDefaults(suiteName: suite)!
        delegate = AppDelegate(defaults: defaults, isolatedSession: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try write("finder.md", "# Finder startup\n")
        try write("late.md", "# Finder during restoration\n")
        try write("opened.md", "# Opened file\n\nOriginal disk text.\n")
        try write("private.md", "Unauthorized text must not be exposed")
        try FileManager.default.createDirectory(at: url("workspace"), withIntermediateDirectories: true)
        try write("workspace/child.md", "# Workspace child\n")
        let png = Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=")!
        try png.write(to: url("workspace/pixel.png"))
        let draft: [String: Any] = ["documents": [["id": "restored-draft", "path": NSNull(), "name": "Recovered draft.md", "content": "Recovered draft text", "savedContent": "", "dirty": true]], "activeId": "restored-draft"]
        delegate.initialScripts = ["if(!localStorage.getItem('typorax.documents.v1'))localStorage.setItem('typorax.documents.v1',\(jsonString(jsonString(draft)!)!));window.__nativeIntegrationErrors=[];addEventListener('error',e=>window.__nativeIntegrationErrors.push(e.message));addEventListener('unhandledrejection',e=>window.__nativeIntegrationErrors.push(String(e.reason)));" ]
        delegate.selectionProvider = { [weak self] operation in
            guard let self else { return nil }
            guard !self.selections.isEmpty else { self.failure = "Unexpected system selection: \(operation)"; return nil }
            let (expected, selected) = self.selections.removeFirst()
            guard expected == operation else { self.failure = "Expected \(expected), received \(operation)"; return nil }
            if let selected, !selected.standardizedFileURL.resolvingSymlinksInPath().path.hasPrefix(self.root.standardizedFileURL.resolvingSymlinksInPath().path + "/") {
                self.failure = "Test attempted a selection outside its temporary directory"; return nil
            }
            return selected
        }
        delegate.closeChoiceProvider = { [weak self] in
            guard let self, !self.choices.isEmpty else { self?.failure = "Unexpected close confirmation"; return .alertSecondButtonReturn }
            return self.choices.removeFirst()
        }
        delegate.failureObserver = { [weak self] message in self?.finish(TyporaXError.invalid(message)) }
        delegate.windowClosedObserver = { [weak self] in self?.didClose = true }
        delegate.readyObserver = { [weak self] in
            guard let self else { return }
            if let continuation = self.readyContinuation { self.readyContinuation = nil; continuation.resume(); return }
            guard !self.started else { return }
            self.started = true
            Task { do { try await self.run(); self.finish(nil) } catch { self.finish(error) } }
        }
        // OS open events can precede construction of the application's window.
        delegate.application(NSApp, open: [url("finder.md")])
        delegate.command("theme")
    }

    func startTimeout() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 90) { [weak self] in self?.finish(TyporaXError.invalid("Integration test exceeded 90 seconds")) }
    }
    private func url(_ name: String) -> URL { root.appendingPathComponent(name) }
    private func write(_ name: String, _ value: String) throws { try Data(value.utf8).write(to: url(name), options: .atomic) }
    private func contents(_ name: String) throws -> String { try String(contentsOf: url(name), encoding: .utf8) }
    private func require(_ condition: Bool, _ message: String) throws {
        if let failure { throw TyporaXError.invalid(failure) }
        guard condition else { throw TyporaXError.invalid(message) }
    }
    private func pass(_ message: String) { steps += 1; print("  ✓ \(message)") }
    private func pick(_ method: String, _ name: String?) { selections.append((method, name.map(url))) }
    private func js(_ body: String, _ arguments: [String: Any] = [:]) async throws -> Any? {
        try await withCheckedThrowingContinuation { continuation in
            delegate.webView.callAsyncJavaScript(body, arguments: arguments, in: nil, in: .page) { result in
                continuation.resume(with: result.map { $0 as Any? })
            }
        }
    }
    private func until(_ label: String, _ predicate: () async throws -> Bool) async throws {
        let deadline = Date().addingTimeInterval(10)
        while Date() < deadline {
            if let failure { throw TyporaXError.invalid(failure) }
            if try await predicate() { return }
            try await Task.sleep(nanoseconds: 40_000_000)
        }
        let state = try? await js("return JSON.stringify({name:document.getElementById('document-name')?.textContent,toast:document.getElementById('toast')?.textContent,files:Array.from(document.querySelectorAll('.file-item')).map(e=>e.title)});")
        throw TyporaXError.invalid("Timed out: " + label + " — " + String(describing: state ?? nil))
    }
    private func visibleName(_ name: String) async throws {
        try await until("active document " + name) { try await self.js("return document.getElementById('document-name').textContent === name", ["name": name]) as? Bool == true }
    }
    private func click(_ selector: String) async throws {
        _ = try await js("const el=document.querySelector(selector);if(!el)throw Error('Missing control '+selector);el.click();", ["selector": selector])
    }
    private func menu(_ action: String) async throws { try await click("[data-action='\(action)']") }
    private func installRPCObserver() async throws {
        _ = try await js("""
        const original=window.__typoraxResolve;
        const waiting=new Map();
        window.__typoraxResolve=response=>{const item=waiting.get(response.id);if(item){waiting.delete(response.id);response.error?item.reject(Error(response.error)):item.resolve(response.result);}original(response);};
        window.__nativeCall=(method,params={})=>new Promise((resolve,reject)=>{const id='integration-'+crypto.randomUUID();waiting.set(id,{resolve,reject});window.webkit.messageHandlers.typorax.postMessage({id,method,params});setTimeout(()=>{if(waiting.delete(id))reject(Error('Bridge timeout: '+method));},5000);});
        """)
    }
    private func rpc(_ method: String, _ params: [String: Any] = [:]) async throws -> Any? {
        try await js("return await window.__nativeCall(method,params)", ["method": method, "params": params])
    }
    private func expectRPCFailure(_ method: String, _ params: [String: Any], contains message: String) async throws {
        let result = try await js("try{await window.__nativeCall(method,params);return '';}catch(error){return String(error.message);}", ["method": method, "params": params]) as? String ?? ""
        try require(result.contains(message), "Expected \(method) rejection containing \(message), received \(result)")
    }
    private func edit(_ text: String, source: Bool = false) async throws {
        if source {
            if try await js("return document.getElementById('source-editor').hidden") as? Bool == true { try await click("#toggle-source") }
        } else if try await js("return document.getElementById('editor').hidden") as? Bool == true { try await click("#toggle-source") }
        let selector = source ? "#source-editor .cm-content" : "#editor [contenteditable=true]"
        _ = try await js("""
        const el=document.querySelector(selector);el.focus();
        const range=document.createRange();range.selectNodeContents(el);
        const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
        if(!document.execCommand('insertText',false,text))throw Error('Browser editing command rejected');
        """, ["selector": selector, "text": text])
        let firstLine = String(text.split(whereSeparator: \.isNewline).first ?? "").prefix(20)
        try await until("editor content and native dirty state") {
            let matches = try await self.js("return document.querySelector(selector).textContent.includes(part)", ["selector": selector, "part": String(firstLine)]) as? Bool == true
            return self.delegate.dirty && matches
        }
    }
    private func waitFile(_ name: String, contains text: String) async throws {
        try await until("saved file " + name) { (try? self.contents(name).contains(text)) == true }
    }

    private func run() async throws {
        try await visibleName("finder.md")
        try await until("queued menu command after ready") { try await self.js("return document.documentElement.dataset.theme === 'dark'") as? Bool == true }
        try require(delegate.pendingDocuments.isEmpty && delegate.pendingCommands.isEmpty, "Startup queues were not drained")
        pass("Finder startup activePath wins over restored draft; menu waits for frontend ready")

        // Reload exercises a second real bootstrap; inject an OS open while restoration is in flight.
        delegate.bootstrapObserver = { [weak self] in
            guard let self else { return }
            self.delegate.application(NSApp, open: [self.url("late.md")])
            self.delegate.command("theme")
            if self.delegate.webReady || self.delegate.pendingDocuments.count != 1 { self.failure = "Open request escaped before ready" }
        }
        await withCheckedContinuation { continuation in
            readyContinuation = continuation
            delegate.webView.reload()
        }
        delegate.bootstrapObserver = nil
        try await visibleName("late.md")
        try await until("deferred menu after restoration") { try await self.js("return document.documentElement.dataset.theme === 'light'") as? Bool == true }
        pass("Finder open during bootstrap is deferred until ready, then becomes active")
        try await installRPCObserver()

        pick("openFile", "opened.md")
        try await click("#open-file")
        try await visibleName("opened.md")
        let opened = try await rpc("readFile", ["path": url("opened.md").path]) as? [String: Any]
        try require(opened?["content"] as? String == "# Opened file\n\nOriginal disk text.\n", "Native readFile changed UTF-8 bytes")
        pass("DOM Open action, picker result, native readFile and loaded editor agree")

        try await edit("Integration 中文 visual edit")
        try await click("[data-format='heading2']")
        try await menu("save")
        try await waitFile("opened.md", contains: "## Integration 中文 visual edit")
        try require(!delegate.window.isDocumentEdited || delegate.dirty, "Native dirty indicator diverged")
        pass("Real contenteditable edit and heading toolbar save Markdown to disk")

        let exactSource = "# Source edit\n\n- [x] preserved\n\n中文 source content.\n"
        try await edit(exactSource, source: true)
        try await menu("save")
        try await until("exact source bytes") { (try? self.contents("opened.md")) == exactSource }
        pass("CodeMirror DOM edit saves exact source bytes through production bridge")

        pick("saveFile", "copy.md")
        try await menu("saveAs")
        try await visibleName("copy.md")
        try await until("Save As copy bytes") { (try? self.contents("copy.md")) == exactSource }
        try require(try contents("opened.md") == exactSource, "Save As modified the original")
        pick("saveFile", nil)
        try await menu("saveAs")
        try await until("cancelled Save As handled") { self.selections.isEmpty }
        try await visibleName("copy.md")
        pick("saveFile", nil)
        let cancelled = try await rpc("saveFile", ["path": NSNull(), "content": "Do not save", "saveAs": true, "name": "cancelled.md"])
        try require(cancelled is NSNull || cancelled == nil, "Cancel must resolve null")
        pass("Save As creates a separate file; cancellation preserves active document")

        pick("openFolder", "workspace")
        try await click("#open-folder")
        try await until("workspace child listed") { try await self.js("return !!Array.from(document.querySelectorAll('.file-item')).find(e=>e.title===path)", ["path": self.url("workspace/child.md").path]) as? Bool == true }
        _ = try await js("Array.from(document.querySelectorAll('.file-item')).find(e=>e.title===path).click()", ["path": url("workspace/child.md").path])
        try await visibleName("child.md")
        try write("workspace/second.md", "# New workspace file\n")
        let refreshed = try await rpc("refreshFolder", ["path": url("workspace").path]) as? [String: Any]
        try require((refreshed?["files"] as? [[String: Any]])?.count == 2, "Folder refresh did not discover a new Markdown file")
        try await expectRPCFailure("readFile", ["path": url("private.md").path], contains: "授权")
        try await expectRPCFailure("saveFile", ["path": url("private.md").path, "content": "clobber"], contains: "另存为")
        try require(try contents("private.md") == "Unauthorized text must not be exposed", "Unauthorized save changed a file")
        pass("Workspace picker/list/read/refresh work; unselected read/write are rejected")

        try await click("#toggle-source") // Return the document to its visual editor before inserting an image.
        pick("chooseImage", "workspace/pixel.png")
        try await menu("insertImage")
        try await until("embedded image rendered") { try await self.js("const image=document.querySelector('#editor img[src^=\"data:image/png;base64,\"]');return image?.naturalWidth===1;") as? Bool == true }
        try await menu("save")
        try await waitFile("workspace/child.md", contains: "data:image/png;base64,")
        let image = try await rpc("resolveImage", ["path": "pixel.png", "documentPath": url("workspace/child.md").path]) as? [String: Any]
        try require((image?["url"] as? String)?.hasPrefix("data:image/png;base64,") == true, "Relative image resolution failed")
        try await expectRPCFailure("resolveImage", ["path": "../private.md", "documentPath": url("workspace/child.md").path], contains: "文件夹")
        pass("Image insertion renders and persists data URI; scoped local resolution rejects traversal")

        pick("exportHTML", "document.html")
        try await menu("exportHTML")
        try await waitFile("document.html", contains: "Workspace child")
        let html = try contents("document.html")
        try require(html.contains("data:image/png;base64,") && html.contains("<html"), "HTML export lost image or document structure")
        pick("exportPDF", "document.pdf")
        try await menu("exportPDF")
        try await until("PDF export completed") { FileManager.default.fileExists(atPath: self.url("document.pdf").path) && self.delegate.pdfJobs.isEmpty }
        let pdf = PDFDocument(url: url("document.pdf"))
        try require(pdf?.pageCount ?? 0 > 0 && pdf?.string?.contains("Workspace child") == true, "PDF export is not readable/searchable")
        pass("Editor HTML/PDF export reaches disk; HTML embeds image and PDF text is searchable")

        try await edit("Unsaved conflict draft", source: true)
        try write("workspace/child.md", "EXTERNAL CHANGE\n")
        try await menu("save")
        try await until("external conflict shown") { try await self.js("return document.getElementById('toast').textContent.includes('其他程序修改')") as? Bool == true }
        try require(try contents("workspace/child.md") == "EXTERNAL CHANGE\n", "External modification was overwritten")
        try require(delegate.dirty, "Conflict cleared unsaved state")
        try await expectRPCFailure("closeConfirmed", [:], contains: "未保存")
        try require(delegate.window.isVisible && !delegate.closeAllowed, "Dirty closeConfirmed closed the window")
        pass("External edits survive rejected save; dirty closeConfirmed cannot close window")

        pick("saveFile", "conflict-recovered.md")
        try await menu("saveAs")
        try await visibleName("conflict-recovered.md")
        try await waitFile("conflict-recovered.md", contains: "Unsaved conflict draft")
        try require(try contents("workspace/child.md") == "EXTERNAL CHANGE\n", "Recovery modified external file")

        try await click("#new-document")
        try await edit("First close draft", source: true)
        try await click("#new-document")
        try await edit("Second close draft", source: true)
        choices.append(.alertSecondButtonReturn)
        try require(!delegate.windowShouldClose(delegate.window), "Cancel allowed window closure")
        choices.append(.alertSecondButtonReturn)
        try require(delegate.applicationShouldTerminate(NSApp) == .terminateCancel, "Cancel allowed application termination")
        choices.append(.alertFirstButtonReturn)
        pick("saveFile", nil)
        try require(!delegate.windowShouldClose(delegate.window), "Save choice closed before persistence")
        try await until("cancelled close save") { self.selections.isEmpty }
        try require(delegate.window.isVisible && delegate.dirty && !delegate.closeAllowed, "Cancelling a save discarded drafts")
        pass("Window and quit Cancel preserve drafts; cancelling Save All leaves window open")

        // Restored draft plus both newly typed drafts must all reach disk before actual window close.
        pick("saveFile", "restored-saved.md")
        pick("saveFile", "first-close.md")
        pick("saveFile", "second-close.md")
        choices.append(.alertFirstButtonReturn)
        try require(!delegate.windowShouldClose(delegate.window), "Save All closed synchronously")
        try await until("window closes after all saves") { self.didClose }
        try require(try contents("restored-saved.md").contains("Recovered draft text"), "Restored draft was not saved")
        try require(try contents("first-close.md").contains("First close draft"), "First inactive draft was not saved")
        try require(try contents("second-close.md").contains("Second close draft"), "Second draft was not saved")
        try require(!delegate.dirty && delegate.closeAllowed && !delegate.window.isVisible, "Close did not finish cleanly")
        try require(delegate.applicationShouldTerminate(NSApp) == .terminateNow, "Clean application cannot terminate")
        try require(selections.isEmpty && choices.isEmpty, "Unconsumed simulated dialog results")
        let errors = try await js("return window.__nativeIntegrationErrors") as? [String] ?? []
        try require(errors.isEmpty, "Unhandled WebKit JavaScript errors: \(errors)")
        pass("Save All persists restored and inactive drafts before the production close actually happens")
    }

    private func finish(_ error: Error?) {
        guard !finished else { return }
        finished = true
        delegate.webView?.stopLoading()
        defaults.removePersistentDomain(forName: suite)
        do { try FileManager.default.removeItem(at: root) }
        catch { fputs("Integration test cleanup failed: \(error.localizedDescription)\n", stderr); exit(1) }
        if let error { fputs("TyporaX native integration: FAIL: \(error.localizedDescription)\n", stderr); exit(1) }
        print("TyporaX native integration: PASS (\(steps) acceptance groups; temporary files and isolated preferences removed)")
        print("Simulated: system picker and close-alert choices. Verified: shipped WebKit editor, native bridge, disk operations, PDF, and window closure.")
        exit(0)
    }
}
