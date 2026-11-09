import AppKit
import SwiftUI

// Menu déroulant à la Codex (« Ajouter ⌄ ») : panneau blanc arrondi, ombré, lignes icône + texte, séparateurs.
// Remplace le menu natif de macOS (petit, aux couleurs système) dans toute l'app.

/// Élément d'un `PopupMenu`.
public enum PopupMenuEntry {
    case item(icon: String? = nil, title: String, checked: Bool = false, destructive: Bool = false, disabled: Bool = false,
              help: String? = nil, action: () -> Void)
    case divider
}

/// Contenu du panneau (aussi rendu par `Snapshot` et le catalogue).
public struct PopupMenuContent: View {
    let entries: [PopupMenuEntry]
    var minWidth: CGFloat = 200
    let dismiss: () -> Void

    public init(entries: [PopupMenuEntry], minWidth: CGFloat = 200, dismiss: @escaping () -> Void) {
        self.entries = entries
        self.minWidth = minWidth
        self.dismiss = dismiss
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(entries.indices, id: \.self) { i in
                switch entries[i] {
                case .divider:
                    Rectangle().fill(Palette.border).frame(height: 1).padding(.horizontal, 10).padding(.vertical, 5)
                case let .item(icon, title, checked, destructive, disabled, help, action):
                    PopupMenuRow(icon: icon, title: title, checked: checked, destructive: destructive, hasIcons: hasIcons) {
                        dismiss()
                        action()
                    }
                    .disabled(disabled)
                    .help(help ?? "")
                }
            }
        }
        .padding(6)
        .frame(minWidth: minWidth, alignment: .leading)
        .fixedSize()
        .background(Palette.content, in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(Palette.border))
    }

    /// Une colonne d'icônes dès qu'un élément en a une (titres alignés).
    var hasIcons: Bool {
        entries.contains { if case let .item(icon, _, checked, _, _, _, _) = $0 { icon != nil || checked } else { false } }
    }
}

private struct PopupMenuRow: View {
    let icon: String?
    let title: String
    let checked: Bool
    let destructive: Bool
    let hasIcons: Bool
    let action: () -> Void
    @Environment(\.isEnabled) private var enabled
    @ViewState private var hover = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                if hasIcons {
                    Group {
                        if let icon = checked ? "checkmark" : icon { Icon(icon, size: 16) } else { Color.clear }
                    }
                    .frame(width: 18, height: 18)
                }
                Text(title).font(.system(size: 14)).lineLimit(1).fixedSize()
                Spacer(minLength: 0)
            }
            .foregroundStyle(destructive ? Palette.foreground(.danger) : Palette.text)
            .padding(.horizontal, 10).frame(minHeight: 34)
            .background(hover && enabled ? Palette.rowHover : .clear, in: RoundedRectangle(cornerRadius: 8))
            .opacity(enabled ? 1 : 0.4)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hover = $0 }
    }
}

/// Bouton qui ouvre un `PopupMenu` sous lui, aligné sur son bord droit (`trailing`) ou gauche.
public struct PopupMenuButton<Label: View>: View {
    let entries: () -> [PopupMenuEntry]
    var alignment: HorizontalAlignment = .trailing
    var minWidth: CGFloat = 200
    var label: Label
    @ViewState private var anchor = PopupAnchor()

    public init(entries: @escaping () -> [PopupMenuEntry], alignment: HorizontalAlignment = .trailing, minWidth: CGFloat = 200,
                @ViewBuilder label: () -> Label) {
        self.entries = entries
        self.alignment = alignment
        self.minWidth = minWidth
        self.label = label()
    }

    public var body: some View {
        Button { PopupMenuPanel.show(entries(), from: anchor.view, alignment: alignment, minWidth: minWidth) } label: { label }
            .buttonStyle(.plain)
            .background(AnchorView(anchor: anchor))
    }
}

/// Vue AppKit sous le bouton : sert à placer le panneau en coordonnées d'écran.
final class PopupAnchor { weak var view: NSView? }

private struct AnchorView: NSViewRepresentable {
    let anchor: PopupAnchor
    func makeNSView(context: Context) -> NSView { let v = NSView(); anchor.view = v; return v }
    func updateNSView(_ nsView: NSView, context: Context) { anchor.view = nsView }
}

/// Panneau flottant sans bordure : se ferme au clic à côté, sur Échap ou quand l'app passe au second plan.
@MainActor
final class PopupMenuPanel: NSPanel {
    private static var current: PopupMenuPanel?
    private var monitors: [Any] = []
    private var observers: [NSObjectProtocol] = []

    override var canBecomeKey: Bool { true }

    static func show(_ entries: [PopupMenuEntry], from anchor: NSView?, alignment: HorizontalAlignment, minWidth: CGFloat) {
        current?.close()
        guard let anchor, let window = anchor.window else { return }
        let panel = PopupMenuPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.level = .popUpMenu
        panel.appearance = window.effectiveAppearance
        panel.isReleasedWhenClosed = false
        let host = NSHostingView(rootView: PopupMenuContent(entries: entries, minWidth: minWidth) { [weak panel] in panel?.close() })
        panel.contentView = host
        let size = host.fittingSize

        // Sous le bouton (6 pt d'écart), sinon au-dessus ; jamais hors de l'écran.
        let button = window.convertToScreen(anchor.convert(anchor.bounds, to: nil))
        let screen = (window.screen ?? NSScreen.main)?.visibleFrame ?? .infinite
        var x = alignment == .leading ? button.minX : button.maxX - size.width
        x = min(max(x, screen.minX + 8), screen.maxX - size.width - 8)
        var y = button.minY - 6 - size.height
        if y < screen.minY + 8 { y = button.maxY + 6 }
        panel.setFrame(NSRect(x: x, y: y, width: size.width, height: size.height), display: true)
        panel.makeKeyAndOrderFront(nil)
        panel.installMonitors()
        current = panel
    }

    private func installMonitors() {
        let outside: (NSEvent) -> Bool = { [weak self] e in e.window !== self }
        if let m = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .keyDown], handler: { [weak self] e in
            if e.type == .keyDown {
                guard e.keyCode == 53 else { return e } // Échap
                self?.close()
                return nil
            }
            if outside(e) { self?.close() }
            return e
        }) { monitors.append(m) }
        if let m = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown], handler: { [weak self] _ in
            MainActor.assumeIsolated { self?.close() }
        }) { monitors.append(m) }
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: NSApplication.didResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.close() }
        })
    }

    override func close() {
        monitors.forEach(NSEvent.removeMonitor)
        observers.forEach(NotificationCenter.default.removeObserver)
        monitors = []
        observers = []
        if Self.current === self { Self.current = nil }
        super.close()
    }
}
