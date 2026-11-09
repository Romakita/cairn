import AppKit
import CairnCore
import SwiftUI

/// Icône de Cairn : Lucide (SVG embarqué, teinté comme le texte) pour un nom de symbole SF de la table
/// `LucideIcons.map`, sinon le symbole SF. `size` est la boîte de l'icône en points.
public struct Icon: View {
    let name: String
    var size: CGFloat = 16

    public init(_ name: String, size: CGFloat = 16) {
        self.name = name
        self.size = size
    }

    public var body: some View {
        if let image = Self.image(name) {
            Image(nsImage: image)
                .renderingMode(.template)
                .resizable()
                .interpolation(.high)
                .scaledToFit()
                .frame(width: size, height: size)
        } else {
            Image(systemName: name)
                .font(.system(size: size * 0.8))
                .frame(width: size, height: size)
        }
    }

    @MainActor private static var cache: [String: NSImage] = [:]

    @MainActor public static func image(_ name: String) -> NSImage? {
        if let i = cache[name] { return i }
        guard let url = LucideIcons.url(symbol: name), let i = NSImage(contentsOf: url) else { return nil }
        i.isTemplate = true
        cache[name] = i
        return i
    }
}

/// Icône dans une tuile carrée bordée (icônes de plugins de Codex).
public struct IconTile: View {
    let systemName: String
    var size: CGFloat = 32

    public init(systemName: String, size: CGFloat = 32) {
        self.systemName = systemName
        self.size = size
    }

    public var body: some View {
        Icon(systemName, size: size * 0.52)
            .foregroundStyle(Palette.tertiary)
            .frame(width: size, height: size)
            .background(Palette.content, in: RoundedRectangle(cornerRadius: size * 0.28))
            .overlay(RoundedRectangle(cornerRadius: size * 0.28).stroke(Palette.border))
    }
}

/// Logo de Cairn : trois pierres empilées.
public struct CairnLogo: View {
    var size: CGFloat = 22
    var color: Color = Palette.text

    public init(size: CGFloat = 22, color: Color = Palette.text) {
        self.size = size
        self.color = color
    }

    public var body: some View {
        Canvas { ctx, s in
            let w = s.width
            let stones: [(CGFloat, CGFloat, CGFloat)] = [(0.77, 0.62, 0.22), (0.53, 0.45, 0.19), (0.30, 0.27, 0.16)]
            for (cy, rw, rh) in stones {
                let rect = CGRect(x: w * (0.5 - rw / 2), y: w * cy - w * rh / 2, width: w * rw, height: w * rh)
                ctx.stroke(Path(ellipseIn: rect), with: .color(color), lineWidth: max(1.2, w / 14))
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}
