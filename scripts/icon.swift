import AppKit

let destination = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: true)
let sizes: [(Int, String)] = [(16,"16x16"),(32,"16x16@2x"),(32,"32x32"),(64,"32x32@2x"),(128,"128x128"),(256,"128x128@2x"),(256,"256x256"),(512,"256x256@2x"),(512,"512x512"),(1024,"512x512@2x")]
for (pixels, name) in sizes {
    guard let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0), let context = NSGraphicsContext(bitmapImageRep: bitmap) else { fatalError("Cannot allocate icon") }
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = context
    context.cgContext.scaleBy(x: CGFloat(pixels)/1024, y: CGFloat(pixels)/1024)
    let base = NSBezierPath(roundedRect: NSRect(x: 32, y: 32, width: 960, height: 960), xRadius: 218, yRadius: 218)
    NSGradient(starting: NSColor(red: 0.97, green: 0.96, blue: 0.92, alpha: 1), ending: NSColor(red: 0.89, green: 0.91, blue: 0.86, alpha: 1))!.draw(in: base, angle: -90)
    let shadow = NSShadow(); shadow.shadowColor = NSColor.black.withAlphaComponent(0.10); shadow.shadowOffset = NSSize(width: 0, height: -14); shadow.shadowBlurRadius = 28
    NSGraphicsContext.saveGraphicsState(); shadow.set()
    NSColor(red: 0.998, green: 0.994, blue: 0.975, alpha: 1).setFill()
    NSBezierPath(roundedRect: NSRect(x: 240, y: 178, width: 544, height: 668), xRadius: 42, yRadius: 42).fill()
    NSGraphicsContext.restoreGraphicsState()
    NSColor(red: 0.15, green: 0.32, blue: 0.27, alpha: 1).setFill()
    NSBezierPath(roundedRect: NSRect(x: 322, y: 680, width: 280, height: 36), xRadius: 18, yRadius: 18).fill()
    NSColor(red: 0.67, green: 0.72, blue: 0.65, alpha: 1).setFill()
    for (y, width) in [(596.0, 374.0), (514.0, 300.0), (432.0, 184.0)] {
        NSBezierPath(roundedRect: NSRect(x: 322, y: y, width: width, height: 22), xRadius: 11, yRadius: 11).fill()
    }
    NSColor(red: 0.21, green: 0.43, blue: 0.35, alpha: 1).setFill()
    let mark = NSBezierPath()
    mark.move(to: NSPoint(x: 586, y: 227)); mark.line(to: NSPoint(x: 632, y: 227)); mark.line(to: NSPoint(x: 693, y: 312)); mark.line(to: NSPoint(x: 754, y: 227)); mark.line(to: NSPoint(x: 800, y: 227)); mark.line(to: NSPoint(x: 717, y: 344)); mark.line(to: NSPoint(x: 793, y: 450)); mark.line(to: NSPoint(x: 746, y: 450)); mark.line(to: NSPoint(x: 693, y: 375)); mark.line(to: NSPoint(x: 640, y: 450)); mark.line(to: NSPoint(x: 593, y: 450)); mark.line(to: NSPoint(x: 669, y: 344)); mark.close(); mark.fill()
    NSGraphicsContext.restoreGraphicsState()
    guard let data = bitmap.representation(using: .png, properties: [:]) else { fatalError("PNG encode failed") }
    try data.write(to: destination.appendingPathComponent("icon_\(name).png"))
}
