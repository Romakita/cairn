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
    // Trois pierres empilées : le cairn.
    let stones: [(CGFloat, CGFloat, CGFloat)] = [(0.30, 0.66, 0.15), (0.48, 0.48, 0.13), (0.64, 0.30, 0.11)]
    for (cy, w, h) in stones {
        let r = NSRect(x: s * (0.5 - w / 2), y: s * cy - s * h / 2, width: s * w, height: s * h)
        let p = NSBezierPath(ovalIn: r)
        NSColor(red: 0.95, green: 0.95, blue: 0.97, alpha: 1).setFill()
        p.fill()
    }
    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])!
}

for (name, px) in [("16x16", 16), ("16x16@2x", 32), ("32x32", 32), ("32x32@2x", 64), ("128x128", 128),
                   ("128x128@2x", 256), ("256x256", 256), ("256x256@2x", 512), ("512x512", 512), ("512x512@2x", 1024)] {
    try! render(px).write(to: URL(fileURLWithPath: "\(iconset)/icon_\(name).png"))
}
