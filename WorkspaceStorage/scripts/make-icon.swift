// Génère AppIcon.icns : swift scripts/make-icon.swift <dossier de sortie>
import AppKit

let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "."
let iconset = out + "/AppIcon.iconset"
try? FileManager.default.createDirectory(atPath: iconset, withIntermediateDirectories: true)

func render(_ px: Int) -> Data {
    let s = CGFloat(px)
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8,
                               samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                               bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let inset = s * 0.09
    let rect = NSRect(x: inset, y: inset, width: s - 2 * inset, height: s - 2 * inset)
    let bg = NSBezierPath(roundedRect: rect, xRadius: s * 0.19, yRadius: s * 0.19)
    NSGradient(colors: [NSColor(red: 0.14, green: 0.18, blue: 0.32, alpha: 1),
                        NSColor(red: 0.08, green: 0.10, blue: 0.18, alpha: 1)])!.draw(in: bg, angle: -90)
    // Anneau segmenté façon graphique de répartition
    let center = NSPoint(x: s / 2, y: s / 2)
    let radius = s * 0.27
    let segments: [(CGFloat, NSColor)] = [
        (0.42, NSColor(red: 0.86, green: 0.25, blue: 0.42, alpha: 1)),
        (0.25, NSColor(red: 0.36, green: 0.55, blue: 0.93, alpha: 1)),
        (0.18, NSColor(red: 0.94, green: 0.45, blue: 0.24, alpha: 1)),
        (0.15, NSColor(red: 0.95, green: 0.72, blue: 0.20, alpha: 1)),
    ]
    var start: CGFloat = 90
    for (part, color) in segments {
        let end = start - part * 360
        let p = NSBezierPath()
        p.appendArc(withCenter: center, radius: radius, startAngle: start - 2, endAngle: end + 2, clockwise: true)
        p.lineWidth = s * 0.11
        color.setStroke()
        p.stroke()
        start = end
    }
    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])!
}

for (name, px) in [("16x16", 16), ("16x16@2x", 32), ("32x32", 32), ("32x32@2x", 64), ("128x128", 128),
                   ("128x128@2x", 256), ("256x256", 256), ("256x256@2x", 512), ("512x512", 512), ("512x512@2x", 1024)] {
    try! render(px).write(to: URL(fileURLWithPath: "\(iconset)/icon_\(name).png"))
}
