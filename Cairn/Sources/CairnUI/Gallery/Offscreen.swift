import AppKit
import CairnCore
import SwiftUI

/// Rendu hors écran d'une vue SwiftUI en image, sans capture d'écran : la vue est posée dans une fenêtre sans
/// bordure jamais affichée, avec l'apparence (clair/sombre) et la langue forcées.
@MainActor
public enum Offscreen {
    /// Rend `view` à la taille donnée. Sans hauteur, la vue prend sa hauteur idéale pour la largeur donnée.
    /// `settle` laisse le temps aux tâches asynchrones de la vue (images, graphiques) de se terminer.
    public static func image<V: View>(_ view: V, width: CGFloat, height: CGFloat? = nil, dark: Bool,
                                      settle: TimeInterval = 0.6) -> NSBitmapImageRep? {
        let root = view.environment(\.locale, L10n.locale)
        let host = NSHostingView(rootView: AnyView(height == nil
            ? AnyView(root.frame(width: width).fixedSize(horizontal: false, vertical: true))
            : AnyView(root)))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: width, height: height ?? 100), styleMask: [.borderless],
                              backing: .buffered, defer: false)
        window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        window.contentView = host
        defer { window.contentView = nil }
        let size = CGSize(width: width, height: height ?? max(1, host.fittingSize.height))
        window.setContentSize(size)
        host.frame = NSRect(origin: .zero, size: size)
        host.layoutSubtreeIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(settle))
        host.layoutSubtreeIfNeeded()
        guard let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { return nil }
        host.cacheDisplay(in: host.bounds, to: rep)
        return rep
    }

    /// Rend `view` et l'écrit en PNG ; renvoie `false` si le rendu ou l'écriture échoue.
    @discardableResult
    public static func png<V: View>(_ view: V, width: CGFloat, height: CGFloat? = nil, dark: Bool, settle: TimeInterval = 0.6,
                                    to url: URL) -> Bool {
        guard let data = image(view, width: width, height: height, dark: dark, settle: settle)?
            .representation(using: .png, properties: [:]) else { return false }
        return (try? data.write(to: url)) != nil
    }
}

/// Cadre d'aperçu d'une story : marge, fond de l'app, largeur fixe.
public struct StoryCanvas: View {
    let story: Story
    let values: StoryValues?
    let width: CGFloat

    public init(story: Story, values: StoryValues? = nil, width: CGFloat? = nil) {
        self.story = story
        self.values = values
        self.width = width ?? story.width
    }

    public static let margin: CGFloat = 24

    public var body: some View {
        story.view(values)
            .frame(width: width, alignment: .leading)
            .padding(Self.margin)
            .background(Palette.content)
    }
}
