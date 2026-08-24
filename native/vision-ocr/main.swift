// vision-ocr — local OCR + PDF helper backed by Apple's Vision and PDFKit
// frameworks. Runs entirely on-device (no network).
//
// Part of the lossless-capture-brain-pipeline (Requirement 4), extended with
// native PDF support so poppler (Homebrew) is no longer required for the core
// capture pipeline.
//
// Modes:
//   vision-ocr <imagePath>
//     OCR one image. Prints JSON:
//       { "text": "...", "aggConfidence": 0.0-1.0,
//         "lines": [ { "text": "...", "confidence": 0.0-1.0,
//                      "bbox": [x, y, w, h] } ] }
//
//   vision-ocr pdf-text <pdfPath>
//     Extract the embedded text layer via PDFKit. Prints JSON:
//       { "text": "...", "pages": N }
//
//   vision-ocr pdf-rasterize <pdfPath> <outDir> [dpi]
//     Render each page to PNG (page-001.png, ...) via CoreGraphics for OCR of
//     scanned PDFs. Default 150 DPI. Prints JSON: { "pages": N }
//
// Exit codes: 0 success (even if zero text), 2 usage error, 3 input load
// failure, 4 processing failure. Errors also print a JSON object with an
// "error" field on stderr so the Node wrapper can surface a clear message.

import Foundation
import Vision
import CoreGraphics
import ImageIO
import PDFKit
import UniformTypeIdentifiers

func fail(_ code: Int32, _ message: String) -> Never {
    let obj: [String: Any] = ["error": message]
    if let data = try? JSONSerialization.data(withJSONObject: obj),
       let s = String(data: data, encoding: .utf8) {
        FileHandle.standardError.write((s + "\n").data(using: .utf8)!)
    }
    exit(code)
}

func printJSON(_ obj: [String: Any]) -> Never {
    if let data = try? JSONSerialization.data(withJSONObject: obj),
       let s = String(data: data, encoding: .utf8) {
        print(s)
        exit(0)
    }
    fail(4, "could not serialize output")
}

// ── Mode: image OCR (default, byte-compatible with the original helper) ──

func runImageOcr(_ imagePath: String) -> Never {
    guard let dataProvider = CGDataProvider(filename: imagePath),
          let source = CGImageSourceCreateWithDataProvider(dataProvider, nil),
          let cgImage = CGImageSourceCreateImageAtIndex(source, 0, nil)
    else {
        fail(3, "could not load image: \(imagePath)")
    }

    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true

    let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
    do {
        try handler.perform([request])
    } catch {
        fail(4, "recognition failed: \(error.localizedDescription)")
    }

    var lines: [[String: Any]] = []
    var confidences: [Float] = []
    var textParts: [String] = []

    if let observations = request.results {
        for obs in observations {
            guard let candidate = obs.topCandidates(1).first else { continue }
            let bb = obs.boundingBox // normalized (origin bottom-left)
            lines.append([
                "text": candidate.string,
                "confidence": candidate.confidence,
                "bbox": [bb.origin.x, bb.origin.y, bb.size.width, bb.size.height],
            ])
            confidences.append(candidate.confidence)
            textParts.append(candidate.string)
        }
    }

    let agg = confidences.isEmpty ? 0.0 : confidences.reduce(0, +) / Float(confidences.count)
    printJSON([
        "text": textParts.joined(separator: "\n"),
        "aggConfidence": agg,
        "lines": lines,
    ])
}

// ── Mode: pdf-text — embedded text layer via PDFKit ──

func runPdfText(_ pdfPath: String) -> Never {
    guard let doc = PDFDocument(url: URL(fileURLWithPath: pdfPath)) else {
        fail(3, "could not open PDF: \(pdfPath)")
    }
    if doc.isLocked {
        fail(4, "PDF is password protected: \(pdfPath)")
    }
    var parts: [String] = []
    for i in 0..<doc.pageCount {
        guard let page = doc.page(at: i) else { continue }
        if let s = page.string, !s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            parts.append(s)
        }
    }
    printJSON([
        "text": parts.joined(separator: "\n\n"),
        "pages": doc.pageCount,
    ])
}

// ── Mode: pdf-rasterize — pages to PNG via CoreGraphics (no AppKit) ──

func runPdfRasterize(_ pdfPath: String, _ outDir: String, dpi: Double) -> Never {
    guard let doc = CGPDFDocument(URL(fileURLWithPath: pdfPath) as CFURL) else {
        fail(3, "could not open PDF: \(pdfPath)")
    }
    if doc.isEncrypted && !doc.isUnlocked {
        fail(4, "PDF is password protected: \(pdfPath)")
    }
    do {
        try FileManager.default.createDirectory(atPath: outDir, withIntermediateDirectories: true)
    } catch {
        fail(3, "could not create output directory: \(outDir)")
    }

    let scale = dpi / 72.0
    var written = 0
    for pageNum in 1...max(doc.numberOfPages, 1) {
        guard let page = doc.page(at: pageNum) else { continue }
        let box = page.getBoxRect(.mediaBox)
        let width = Int((box.width * scale).rounded())
        let height = Int((box.height * scale).rounded())
        guard width > 0, height > 0,
              let ctx = CGContext(
                data: nil, width: width, height: height,
                bitsPerComponent: 8, bytesPerRow: 0,
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
              )
        else { continue }

        // White background, then the page scaled into the bitmap.
        ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: CGFloat(width), height: CGFloat(height)))
        ctx.saveGState()
        ctx.scaleBy(x: scale, y: scale)
        ctx.translateBy(x: -box.origin.x, y: -box.origin.y)
        ctx.drawPDFPage(page)
        ctx.restoreGState()

        guard let image = ctx.makeImage() else { continue }
        let name = String(format: "page-%03d.png", pageNum)
        let dest = URL(fileURLWithPath: outDir).appendingPathComponent(name)
        guard let sink = CGImageDestinationCreateWithURL(dest as CFURL, UTType.png.identifier as CFString, 1, nil) else { continue }
        CGImageDestinationAddImage(sink, image, nil)
        if CGImageDestinationFinalize(sink) { written += 1 }
    }
    if written == 0 {
        fail(4, "no pages rendered from: \(pdfPath)")
    }
    printJSON(["pages": written])
}

// ── Entry ──

let args = CommandLine.arguments
guard args.count >= 2 else {
    fail(2, "usage: vision-ocr <imagePath> | pdf-text <pdfPath> | pdf-rasterize <pdfPath> <outDir> [dpi]")
}

switch args[1] {
case "pdf-text":
    guard args.count >= 3 else { fail(2, "usage: vision-ocr pdf-text <pdfPath>") }
    runPdfText(args[2])
case "pdf-rasterize":
    guard args.count >= 4 else { fail(2, "usage: vision-ocr pdf-rasterize <pdfPath> <outDir> [dpi]") }
    let dpi = args.count >= 5 ? (Double(args[4]) ?? 150.0) : 150.0
    runPdfRasterize(args[2], args[3], dpi: min(max(dpi, 72), 300))
case let imagePath:
    runImageOcr(imagePath)
}
