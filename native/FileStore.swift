import Foundation
import UniformTypeIdentifiers

enum TyporaXError: LocalizedError {
    case invalid(String)
    var errorDescription: String? { if case .invalid(let message) = self { return message }; return nil }
}

/// Files are admitted by the native picker, OS open events, or a selected workspace.
/// Keeping the read bytes lets a save refuse external edits instead of overwriting them.
final class FileStore {
    private var selectedFiles = Set<String>()
    private var selectedFolders = Set<String>()
    private var readVersions: [String: Data] = [:]
    private let defaults: UserDefaults
    init(defaults: UserDefaults = .standard) { self.defaults = defaults }
    let maximumDocumentBytes = 32 * 1024 * 1024
    let maximumImageBytes = 20 * 1024 * 1024

    func canonical(_ url: URL) -> URL { url.standardizedFileURL.resolvingSymlinksInPath() }

    func admitFile(_ url: URL) {
        let path = canonical(url).path
        selectedFiles.insert(path)
        persistAdmission(path, key: "authorizedFilePaths")
    }
    func admitFolder(_ url: URL) {
        let path = canonical(url).path
        selectedFolders.insert(path)
        persistAdmission(path, key: "authorizedFolderPaths")
    }
    private func persistAdmission(_ path: String, key: String) {
        var paths = defaults.stringArray(forKey: key) ?? []
        paths.removeAll { $0 == path }; paths.append(path)
        defaults.set(Array(paths.suffix(100)), forKey: key)
    }

    func isAdmitted(_ url: URL) -> Bool {
        let path = canonical(url).path
        return selectedFiles.contains(path) || selectedFolders.contains { path.hasPrefix($0 + "/") }
    }

    func document(_ input: URL) throws -> [String: Any] {
        let url = canonical(input)
        guard isAdmitted(url) else { throw TyporaXError.invalid("请先通过“打开文件”或“打开文件夹”授权此文件。") }
        let data = try boundedData(url, limit: maximumDocumentBytes)
        guard let text = String(data: data, encoding: .utf8) else { throw TyporaXError.invalid("该文件不是 UTF-8 文本。请先转换编码后再打开。") }
        readVersions[url.path] = data
        defaults.set(url.path, forKey: "lastDocumentPath")
        return ["id": url.path, "path": url.path, "name": url.lastPathComponent, "content": text]
    }

    func folder(_ input: URL) throws -> [String: Any] {
        let url = canonical(input)
        guard selectedFolders.contains(url.path) else { throw TyporaXError.invalid("此文件夹未获授权。") }
        guard let enumerator = FileManager.default.enumerator(at: url, includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey], options: [.skipsHiddenFiles, .skipsPackageDescendants]) else {
            throw TyporaXError.invalid("无法读取所选文件夹。")
        }
        var files: [[String: String]] = []
        var examined = 0
        var truncated = false
        let allowed = Set(["md", "markdown", "mdown", "mkd", "txt"])
        for case let child as URL in enumerator {
            examined += 1
            if examined > 20000 || files.count >= 2000 { truncated = true; break }
            let values = try? child.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
            if values?.isSymbolicLink == true { enumerator.skipDescendants(); continue }
            if values?.isDirectory == true {
                if ["node_modules", "dist", "build", "vendor"].contains(child.lastPathComponent) { enumerator.skipDescendants() }
                continue
            }
            guard allowed.contains(child.pathExtension.lowercased()), isAdmitted(child) else { continue }
            let resolved = canonical(child)
            files.append(["path": resolved.path, "name": resolved.lastPathComponent, "relativePath": String(resolved.path.dropFirst(url.path.count + 1))])
        }
        files.sort { ($0["relativePath"] ?? "").localizedStandardCompare($1["relativePath"] ?? "") == .orderedAscending }
        defaults.set(url.path, forKey: "lastFolderPath")
        return ["path": url.path, "name": url.lastPathComponent, "files": files, "truncated": truncated]
    }

    func bootstrap() -> [String: Any] {
        // Store originally resolved paths, not the targets of a later replacement symlink.
        for path in defaults.stringArray(forKey: "authorizedFilePaths") ?? [] where path.hasPrefix("/") { selectedFiles.insert(path) }
        for path in defaults.stringArray(forKey: "authorizedFolderPaths") ?? [] where path.hasPrefix("/") { selectedFolders.insert(path) }
        var documents: [[String: Any]] = []
        var workspace: [String: Any]? = nil
        if let folderPath = defaults.string(forKey: "lastFolderPath"), FileManager.default.fileExists(atPath: folderPath) {
            let url = URL(fileURLWithPath: folderPath)
            workspace = try? folder(url)
        }
        if let path = defaults.string(forKey: "lastDocumentPath"), FileManager.default.fileExists(atPath: path) {
            let url = URL(fileURLWithPath: path)
            if let doc = try? document(url) { documents.append(doc) }
        }
        return ["documents": documents, "folder": workspace as Any? ?? NSNull()]
    }

    func save(_ input: URL, content: String, pickerAuthorized: Bool = false) throws -> [String: String] {
        let url = canonical(input)
        guard pickerAuthorized || isAdmitted(url) else { throw TyporaXError.invalid("请使用“另存为”选择保存位置。") }
        let exists = FileManager.default.fileExists(atPath: url.path)
        if exists && !pickerAuthorized {
            guard let previous = readVersions[url.path] else { throw TyporaXError.invalid("文件未在本次会话中读取，请重新打开或使用“另存为”。") }
            let current = try boundedData(url, limit: maximumDocumentBytes)
            guard current == previous else { throw TyporaXError.invalid("文件已被其他程序修改。为保护外部修改，本次保存已取消；请另存为或重新打开。") }
        }
        let bytes = Data(content.utf8)
        guard bytes.count <= maximumDocumentBytes else { throw TyporaXError.invalid("文稿过大，当前支持最大 \(maximumDocumentBytes / 1024 / 1024) MiB；请拆分文稿或减少内嵌图片。") }
        try bytes.write(to: url, options: .atomic)
        admitFile(url)
        readVersions[url.path] = bytes
        defaults.set(url.path, forKey: "lastDocumentPath")
        return ["path": url.path, "name": url.lastPathComponent]
    }

    func export(_ url: URL, content: String) throws { try Data(content.utf8).write(to: url, options: .atomic) }

    func image(_ input: URL) throws -> [String: String] {
        let url = canonical(input)
        let mime: String
        switch url.pathExtension.lowercased() {
        case "png": mime = "image/png"
        case "jpg", "jpeg": mime = "image/jpeg"
        case "gif": mime = "image/gif"
        case "webp": mime = "image/webp"
        case "bmp": mime = "image/bmp"
        default: throw TyporaXError.invalid("请选择 PNG、JPEG、GIF、WebP 或 BMP 图片。")
        }
        let bytes = try boundedData(url, limit: maximumImageBytes)
        let dataURL = "data:\(mime);base64,\(bytes.base64EncodedString())"
        return ["url": dataURL, "markdownPath": dataURL]
    }

    func resolveImage(path: String, documentPath: String) throws -> [String: String] {
        let documentURL = canonical(URL(fileURLWithPath: documentPath))
        guard isAdmitted(documentURL) else { throw TyporaXError.invalid("文档未获授权。") }
        let directory = documentURL.deletingLastPathComponent()
        let candidate: URL
        if path.hasPrefix("file://"), let url = URL(string: path) { candidate = canonical(url) }
        else if path.hasPrefix("/") { candidate = canonical(URL(fileURLWithPath: path)) }
        else { candidate = canonical(directory.appendingPathComponent(path.removingPercentEncoding ?? path)) }
        guard candidate.path.hasPrefix(directory.path + "/") else { throw TyporaXError.invalid("相对图片必须位于当前文档文件夹内。") }
        return try image(candidate)
    }

    private func boundedData(_ url: URL, limit: Int) throws -> Data {
        let values = try url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
        guard values.isRegularFile == true else { throw TyporaXError.invalid("请选择普通文件。") }
        guard (values.fileSize ?? limit + 1) <= limit else { throw TyporaXError.invalid("文件过大，当前支持最大 \(limit / 1024 / 1024) MiB。") }
        let data = try Data(contentsOf: url)
        guard data.count <= limit else { throw TyporaXError.invalid("读取期间文件大小超出限制。") }
        return data
    }
}
