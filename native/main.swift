import AppKit
import Foundation
import CoreGraphics
import PDFKit

if CommandLine.arguments.contains("--self-test") {
    do {
        try runFileStoreTests()
        print("TyporaX native file tests: PASS")
        exit(0)
    } catch {
        fputs("TyporaX native file tests: FAIL: \(error.localizedDescription)\n", stderr)
        exit(1)
    }
}

let application = NSApplication.shared
var pdfTestJob: PDFExportJob?
if CommandLine.arguments.contains("--pdf-self-test") {
    application.setActivationPolicy(.prohibited)
    let output = FileManager.default.temporaryDirectory.appendingPathComponent("typorax-pdf-test-" + UUID().uuidString + ".pdf")
    let paragraphs = (1...90).map { "<p>Paragraph \($0): Offline Markdown export — 中文文稿。</p>" }.joined()
    let html = "<!doctype html><html><head><meta charset='utf-8'><style>body{font:14px Helvetica;line-height:1.7}h1{font-size:30px}</style></head><body><h1>TyporaX PDF Test</h1>" + paragraphs + "</body></html>"
    pdfTestJob = PDFExportJob(html: html, output: output) { result in
        defer { try? FileManager.default.removeItem(at: output) }
        switch result {
        case .success:
            guard let pdf = CGPDFDocument(output as CFURL), pdf.numberOfPages >= 2 else { fputs("TyporaX PDF test: FAIL (invalid or unpaginated PDF)\n", stderr); exit(1) }
            guard let parsed = PDFDocument(url: output), let text = parsed.string,
                  text.contains("TyporaX PDF Test"),
                  (1...90).allSatisfy({ text.components(separatedBy: "Paragraph \($0):").count == 2 }) else {
                fputs("TyporaX PDF test: FAIL (missing or duplicated text)\n", stderr)
                try? FileManager.default.removeItem(at: output)
                exit(1)
            }
            print("TyporaX PDF test: PASS (\(pdf.numberOfPages) pages, searchable text through paragraph 90)")
            try? FileManager.default.removeItem(at: output)
            exit(0)
        case .failure(let error):
            fputs("TyporaX PDF test: FAIL: \(error.localizedDescription)\n", stderr)
            try? FileManager.default.removeItem(at: output)
            exit(1)
        }
    }
    DispatchQueue.main.async { pdfTestJob?.start() }
    application.run()
} else {
    let delegate = AppDelegate()
    application.delegate = delegate
    application.setActivationPolicy(.regular)
    application.run()
}
