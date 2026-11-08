// Génère AppIcon.icns : swift scripts/make-icon.swift <dossier de sortie>
// Un cairn de pierres galets, ombrées, posé sur une crête au crépuscule.
import AppKit

let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "."
let iconset = out + "/AppIcon.iconset"
try? FileManager.default.createDirectory(atPath: iconset, withIntermediateDirectories: true)

func rgb(_ hex: UInt32, _ a: CGFloat = 1) -> NSColor {
    NSColor(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255, alpha: a)
}

/// Courbe fermée et lisse (Catmull-Rom) passant par les points.
func smoothClosed(_ pts: [NSPoint]) -> NSBezierPath {
    let p = NSBezierPath()
    let n = pts.count
    p.move(to: pts[0])
    for i in 0..<n {
        let p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n]
        p.curve(to: p2,
                controlPoint1: NSPoint(x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6),
                controlPoint2: NSPoint(x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6))
    }
    p.close()
    return p
}

/// Galet : ellipse déformée (dessous plus plat), légèrement inclinée.
func stone(cx: CGFloat, cy: CGFloat, w: CGFloat, h: CGFloat, tilt: CGFloat, bumps: [CGFloat]) -> NSBezierPath {
    let n = bumps.count
    var pts: [NSPoint] = []
    for i in 0..<n {
        let a = CGFloat(i) / CGFloat(n) * 2 * .pi
        var x = cos(a) * w / 2 * bumps[i], y = sin(a) * h / 2 * bumps[i]
        if y < 0 { y *= 0.78 } // assise plus plate
        let r = tilt * .pi / 180
        (x, y) = (x * cos(r) - y * sin(r), x * sin(r) + y * cos(r))
        pts.append(NSPoint(x: cx + x, y: cy + y))
    }
    return smoothClosed(pts)
}

func render(_ px: Int) -> Data {
    let s = CGFloat(px)
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8,
                               samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                               bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let small = px <= 32 // aux petites tailles : pas de paysage, pierres plus grosses

    // Fond : carré arrondi façon macOS, ciel du crépuscule.
    let inset = s * 0.098
    let rect = NSRect(x: inset, y: inset, width: s - 2 * inset, height: s - 2 * inset)
    let bg = NSBezierPath(roundedRect: rect, xRadius: s * 0.185, yRadius: s * 0.185)
    NSGraphicsContext.saveGraphicsState()
    let drop = NSShadow()
    drop.shadowColor = rgb(0x000000, 0.35)
    drop.shadowOffset = NSSize(width: 0, height: -s * 0.012)
    drop.shadowBlurRadius = s * 0.025
    drop.set()
    rgb(0x1B2440).setFill()
    bg.fill()
    NSGraphicsContext.restoreGraphicsState()

    NSGraphicsContext.saveGraphicsState()
    bg.addClip()
    NSGradient(colors: [rgb(0x1A2547), rgb(0x34407A), rgb(0x8A5A86), rgb(0xE79A6B)],
               atLocations: [0, 0.45, 0.78, 1], colorSpace: .sRGB)!.draw(in: rect, angle: -90)
    // Lueur du soleil couché derrière le cairn.
    NSGradient(colors: [rgb(0xFFD29A, 0.55), rgb(0xFFD29A, 0)])!
        .draw(fromCenter: NSPoint(x: s * 0.5, y: s * 0.36), radius: 0,
              toCenter: NSPoint(x: s * 0.5, y: s * 0.36), radius: s * 0.42, options: [])

    if !small {
        // Quelques étoiles.
        for (x, y, r, a) in [(0.22, 0.80, 0.006, 0.8), (0.34, 0.72, 0.004, 0.6), (0.71, 0.82, 0.005, 0.75),
                             (0.80, 0.70, 0.0035, 0.55), (0.62, 0.76, 0.003, 0.5), (0.17, 0.66, 0.003, 0.45)] {
            rgb(0xFFF6E6, a).setFill()
            NSBezierPath(ovalIn: NSRect(x: s * (x - r), y: s * (y - r), width: s * 2 * r, height: s * 2 * r)).fill()
        }
        // Montagnes lointaines, en deux plans.
        func ridge(_ pts: [(CGFloat, CGFloat)], _ color: NSColor) {
            let p = NSBezierPath()
            p.move(to: NSPoint(x: 0, y: 0))
            for (x, y) in pts { p.line(to: NSPoint(x: s * x, y: s * y)) }
            p.line(to: NSPoint(x: s, y: 0))
            p.close()
            color.setFill()
            p.fill()
        }
        ridge([(0, 0.40), (0.16, 0.47), (0.27, 0.42), (0.40, 0.52), (0.52, 0.44), (0.66, 0.50),
               (0.80, 0.43), (0.92, 0.48), (1, 0.44)], rgb(0x5B4A7A, 0.85))
        ridge([(0, 0.30), (0.12, 0.36), (0.24, 0.31), (0.36, 0.37), (0.50, 0.30), (0.64, 0.35),
               (0.78, 0.29), (0.90, 0.34), (1, 0.31)], rgb(0x3A3360, 0.95))
    }
    // Crête au premier plan.
    let ground = NSBezierPath()
    ground.move(to: NSPoint(x: 0, y: 0))
    ground.line(to: NSPoint(x: 0, y: s * 0.22))
    ground.curve(to: NSPoint(x: s, y: s * 0.20), controlPoint1: NSPoint(x: s * 0.35, y: s * 0.30),
                 controlPoint2: NSPoint(x: s * 0.70, y: s * 0.27))
    ground.line(to: NSPoint(x: s, y: 0))
    ground.close()
    NSGradient(colors: [rgb(0x231F3F), rgb(0x14132A)])!.draw(in: ground, angle: -90)

    // Le cairn : du bas vers le haut (cx, cy, largeur, hauteur, inclinaison, déformations).
    let k: CGFloat = small ? 1.12 : 1
    let stones: [(CGFloat, CGFloat, CGFloat, CGFloat, CGFloat, [CGFloat])] = [
        (0.495, 0.290, 0.46, 0.165, -3, [1.00, 0.93, 1.06, 1.02, 0.94, 1.00, 1.05, 0.96]),
        (0.530, 0.420, 0.34, 0.140, 7, [0.95, 1.06, 0.97, 1.05, 1.00, 0.93, 1.04, 1.00]),
        (0.470, 0.530, 0.26, 0.118, -8, [1.06, 0.95, 1.02, 0.94, 1.05, 1.00, 0.95, 1.03]),
        (0.515, 0.625, 0.18, 0.096, 10, [1.00, 1.06, 0.94, 1.02, 0.97, 1.05, 1.00, 0.94]),
        (0.495, 0.703, 0.11, 0.076, -6, [0.96, 1.02, 1.06, 0.97, 1.00, 0.95, 1.04, 1.00]),
    ]
    let tones: [(UInt32, UInt32)] = [(0xD9D2C5, 0x8E857A), (0xE6DED2, 0x9B9184), (0xEFE8DC, 0xA59B8D),
                                     (0xF5EFE5, 0xB0A697), (0xFBF7F0, 0xBDB3A4)]
    for (i, st) in stones.enumerated() {
        let (cx, cy, w, h, tilt, bumps) = st
        let ycen = small ? 0.5 + (cy - 0.48) * k : cy
        let p = stone(cx: s * cx, cy: s * ycen, w: s * w * k, h: s * h * k, tilt: tilt, bumps: bumps)
        // Ombre portée sur la pierre du dessous.
        NSGraphicsContext.saveGraphicsState()
        let sh = NSShadow()
        sh.shadowColor = rgb(0x0B0A1A, 0.45)
        sh.shadowOffset = NSSize(width: 0, height: -s * 0.010)
        sh.shadowBlurRadius = s * 0.018
        sh.set()
        rgb(tones[i].1).setFill()
        p.fill()
        NSGraphicsContext.restoreGraphicsState()
        // Modelé : lumière chaude en haut à gauche, ombre en bas.
        NSGradient(colors: [rgb(tones[i].0), rgb(tones[i].1)])!.draw(in: p, angle: -70)
        NSGraphicsContext.saveGraphicsState()
        p.addClip()
        let b = p.bounds
        NSGradient(colors: [rgb(0xFFFFFF, 0.55), rgb(0xFFFFFF, 0)])!
            .draw(fromCenter: NSPoint(x: b.minX + b.width * 0.35, y: b.maxY - b.height * 0.18), radius: 0,
                  toCenter: NSPoint(x: b.minX + b.width * 0.35, y: b.maxY - b.height * 0.18),
                  radius: b.width * 0.35, options: [])
        // Reflet du couchant sur le flanc droit.
        NSGradient(colors: [rgb(0xF2A774, 0), rgb(0xF2A774, 0.35)])!.draw(in: b, angle: 0)
        NSGraphicsContext.restoreGraphicsState()
    }
    NSGraphicsContext.restoreGraphicsState()

    // Liseré clair sur le bord du fond.
    rgb(0xFFFFFF, 0.10).setStroke()
    bg.lineWidth = max(1, s * 0.004)
    bg.stroke()

    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])!
}

for (name, px) in [("16x16", 16), ("16x16@2x", 32), ("32x32", 32), ("32x32@2x", 64), ("128x128", 128),
                   ("128x128@2x", 256), ("256x256", 256), ("256x256@2x", 512), ("512x512", 512), ("512x512@2x", 1024)] {
    try! render(px).write(to: URL(fileURLWithPath: "\(iconset)/icon_\(name).png"))
}
