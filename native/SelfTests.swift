import Foundation

func runFileStoreTests() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("typorax-native-test-" + UUID().uuidString)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    let suite = "com.riba2534.typorax.tests." + UUID().uuidString
    let defaults = UserDefaults(suiteName: suite)!
    defer { try? FileManager.default.removeItem(at: root); defaults.removePersistentDomain(forName: suite) }
    let store = FileStore(defaults: defaults)
    let doc = root.appendingPathComponent("article.md")
    try Data("# Original\n".utf8).write(to: doc)
    func assert(_ condition: Bool, _ message: String) throws { if !condition { throw TyporaXError.invalid(message) } }
    func expectFailure(_ label: String, _ operation: () throws -> Void) throws {
        var failed = false
        do { try operation() } catch { failed = true }
        try assert(failed, label)
    }
    try expectFailure("unselected document must be refused") { _ = try store.document(doc) }
    store.admitFile(doc)
    let original = try store.document(doc)
    try assert(original["content"] as? String == "# Original\n", "read must preserve UTF-8 content")
    _ = try store.save(doc, content: "# Saved\n你好，TyporaX")
    try assert(try String(contentsOf: doc, encoding: .utf8) == "# Saved\n你好，TyporaX", "atomic save must preserve content")
    try Data("# External edit\n".utf8).write(to: doc)
    try expectFailure("external modifications must be refused") { _ = try store.save(doc, content: "Overwrite") }
    try assert(try String(contentsOf: doc, encoding: .utf8) == "# External edit\n", "conflict must not change file bytes")
    let unknown = root.appendingPathComponent("unauthorized.md")
    try expectFailure("unselected save path must be refused") { _ = try store.save(unknown, content: "No") }
    _ = try store.save(unknown, content: "# Chosen by Save As", pickerAuthorized: true)
    try assert(FileManager.default.fileExists(atPath: unknown.path), "picker-authorized save must create file")
    try expectFailure("oversized document save must be refused") {
        _ = try store.save(unknown, content: String(repeating: "a", count: store.maximumDocumentBytes + 1))
    }
    try assert(try String(contentsOf: unknown, encoding: .utf8) == "# Chosen by Save As", "oversized save must preserve the original file")
    let workspace = root.appendingPathComponent("workspace")
    try FileManager.default.createDirectory(at: workspace, withIntermediateDirectories: true)
    let inside = workspace.appendingPathComponent("inside.md")
    try Data("inside".utf8).write(to: inside)
    try FileManager.default.createSymbolicLink(at: workspace.appendingPathComponent("escape.md"), withDestinationURL: doc)
    let second = FileStore(defaults: defaults); second.admitFolder(workspace)
    let insideDocument = try second.document(inside)
    try expectFailure("symlink escaping workspace must be refused") { _ = try second.document(workspace.appendingPathComponent("escape.md")) }
    let listing = try second.folder(workspace)
    try assert((listing["files"] as? [[String: String]])?.count == 1, "folder listing must skip symlinks")
    let listedFile = (listing["files"] as? [[String: String]])?.first
    try assert(listedFile?["path"] == insideDocument["path"] as? String, "folder entries and direct reads must share canonical path identity")
    try assert(listedFile?["relativePath"] == "inside.md", "folder display path must be relative to the canonical workspace")
    let invalid = workspace.appendingPathComponent("invalid.md"); try Data([0xff, 0xfe, 0xff]).write(to: invalid)
    try expectFailure("invalid UTF-8 must be refused") { _ = try second.document(invalid) }
    try expectFailure("image paths cannot escape document directory") { _ = try second.resolveImage(path: "../../private.png", documentPath: inside.path) }
    let pin = root.appendingPathComponent("pinned.md")
    let outside = root.appendingPathComponent("never-selected.md")
    try Data("pinned".utf8).write(to: pin)
    try Data("outside".utf8).write(to: outside)
    store.admitFile(pin)
    try FileManager.default.removeItem(at: pin)
    try FileManager.default.createSymbolicLink(at: pin, withDestinationURL: outside)
    let restored = FileStore(defaults: defaults)
    _ = restored.bootstrap()
    _ = try restored.document(doc)
    try expectFailure("persisted authorization must not follow replacement symlinks") { _ = try restored.document(pin) }
    print("  ✓ persisted authorization and replacement-symlink refusal")
    print("  ✓ file admission, UTF-8 read, atomic save, external-edit conflict, oversized save refusal")
    print("  ✓ Save As, folder admission and path identity, symlink escape, invalid encoding, image scope")
}
