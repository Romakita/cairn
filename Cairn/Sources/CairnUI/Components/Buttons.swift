import SwiftUI

/// Boutons à la Codex : principal (noir), secondaire (gris plein, sans bordure) ou bordé (blanc).
public struct PillButtonStyle: ButtonStyle {
    public enum Kind: CaseIterable { case primary, secondary, outline, danger }
    public var kind = Kind.secondary
    public var primary: Bool { kind == .primary }

    public init(kind: Kind = .secondary) { self.kind = kind }

    public func makeBody(configuration: Configuration) -> some View {
        PillButtonBody(kind: kind, pressed: configuration.isPressed) { configuration.label }
    }
}

private struct PillButtonBody<Label: View>: View {
    let kind: PillButtonStyle.Kind
    let pressed: Bool
    @ViewBuilder var label: Label
    @Environment(\.isEnabled) private var enabled
    @ViewState private var hover = false

    var body: some View {
        label
            .font(.system(size: 13.5, weight: .regular))
            .foregroundStyle(kind == .primary ? Palette.primaryButtonText : (kind == .danger ? Color.white : Palette.text))
            .padding(.horizontal, 14).frame(minHeight: 32)
            .background(fill, in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(kind == .outline ? Palette.fieldBorder : .clear))
            .opacity(enabled ? (pressed ? 0.8 : 1) : 0.4)
            .contentShape(RoundedRectangle(cornerRadius: 10))
            .onHover { hover = $0 }
    }

    var fill: Color {
        switch kind {
        case .primary: Palette.primaryButton.opacity(hover && enabled ? 0.85 : 1)
        case .secondary: hover && enabled ? Palette.fieldPressed : Palette.field
        case .outline: hover && enabled ? Palette.rowHover : Palette.content
        case .danger: Color(light: 0xDC2626, dark: 0xB91C1C).opacity(hover && enabled ? 0.85 : 1)
        }
    }
}

extension ButtonStyle where Self == PillButtonStyle {
    public static var pill: PillButtonStyle { PillButtonStyle() }
    public static var pillPrimary: PillButtonStyle { PillButtonStyle(kind: .primary) }
    public static var pillOutline: PillButtonStyle { PillButtonStyle(kind: .outline) }
    /// Action destructive confirmée (suppression).
    public static var pillDanger: PillButtonStyle { PillButtonStyle(kind: .danger) }
}

/// Icône « … » d'un menu, au style des boutons icône de Codex (sans fond, fond gris au survol).
public struct MoreIcon: View {
    @ViewState private var hover = false

    public init() {}

    public var body: some View {
        Icon("ellipsis", size: 16)
            .foregroundStyle(hover ? Palette.text : Palette.secondary)
            .frame(width: 32, height: 32)
            .background(hover ? Palette.field : .clear, in: RoundedRectangle(cornerRadius: 10))
            .contentShape(Rectangle())
            .onHover { hover = $0 }
    }
}

/// Bouton icône discret (corbeille des listes de Codex).
public struct IconButton: View {
    let systemName: String
    let label: String
    let action: () -> Void
    @ViewState private var hover = false

    public init(systemName: String, label: String, action: @escaping () -> Void) {
        self.systemName = systemName
        self.label = label
        self.action = action
    }

    public var body: some View {
        Button(action: action) {
            Icon(systemName, size: 16)
                .foregroundStyle(hover ? Palette.text : Palette.secondary)
                .frame(width: 28, height: 28)
                .background(hover ? Palette.field : .clear, in: RoundedRectangle(cornerRadius: 8))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hover = $0 }
        .help(label)
        .accessibilityLabel(label)
    }
}
