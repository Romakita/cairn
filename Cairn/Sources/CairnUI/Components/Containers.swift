import SwiftUI

// Conteneurs à la Codex (voir DESIGN.md) : cartes, lignes de réglages, titres et bandeaux.

/// Carte arrondie avec bordure légère, sans ombre (comme les panneaux de réglages de Codex).
public struct Card<Content: View>: View {
    var padding: CGFloat = 18
    /// S'étire en hauteur (cartes d'une même rangée, rangée en `fixedSize` vertical).
    var fill = false
    var content: Content

    public init(padding: CGFloat = 18, fill: Bool = false, @ViewBuilder content: () -> Content) {
        self.padding = padding
        self.fill = fill
        self.content = content()
    }

    public var body: some View {
        content
            .padding(padding)
            .frame(maxWidth: .infinity, maxHeight: fill ? .infinity : nil, alignment: .topLeading)
            .background(Palette.content, in: RoundedRectangle(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).stroke(Palette.border))
    }
}

/// Ligne de réglage : titre, description grise, contrôle à droite. À placer dans une `Card(padding: 0)`,
/// séparée de la suivante par `RowDivider()`.
public struct SettingsRow<Trailing: View>: View {
    var icon: String?
    let title: String
    var subtitle: String?
    var monospaced = false
    var trailing: Trailing

    public init(icon: String? = nil, title: String, subtitle: String? = nil, monospaced: Bool = false,
                @ViewBuilder trailing: () -> Trailing) {
        self.icon = icon
        self.title = title
        self.subtitle = subtitle
        self.monospaced = monospaced
        self.trailing = trailing()
    }

    public var body: some View {
        HStack(spacing: 14) {
            if let icon { IconTile(systemName: icon) }
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.system(size: 14, weight: .regular, design: monospaced ? .monospaced : .default))
                    .foregroundStyle(Palette.text).lineLimit(1).truncationMode(.middle)
                if let subtitle {
                    Text(subtitle).font(.system(size: 13)).foregroundStyle(Palette.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 12)
            trailing
        }
        .padding(.horizontal, 16).padding(.vertical, 13)
    }
}

/// Séparateur entre deux lignes d'une carte, en retrait des bords comme dans Codex.
public struct RowDivider: View {
    public init() {}
    public var body: some View { Rectangle().fill(Palette.border).frame(height: 1).padding(.horizontal, 16) }
}

/// Titre de section au-dessus d'une carte (« Autorisations », « Général » dans les réglages de Codex).
public struct SectionTitle: View {
    let title: String

    public init(title: String) { self.title = title }

    public var body: some View {
        Text(title).font(.system(size: 15, weight: .medium)).foregroundStyle(Palette.text)
            .padding(.top, 14).padding(.bottom, 2)
    }
}

/// Bas de carte gris (plateau sous la zone de saisie de Codex), pour ajouter un élément à une liste.
public struct CardTray<Content: View>: View {
    var content: Content

    public init(@ViewBuilder content: () -> Content) { self.content = content() }

    public var body: some View {
        HStack(spacing: 10) { content }
            .padding(.horizontal, 14).padding(.vertical, 12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Palette.sidebar, in: UnevenRoundedRectangle(bottomLeadingRadius: 16, bottomTrailingRadius: 16))
            .overlay(alignment: .top) { Rectangle().fill(Palette.border).frame(height: 1) }
    }
}

/// Bandeau d'information ou d'alerte.
public struct Banner<Trailing: View>: View {
    let icon: String
    let text: String
    var tone = Palette.Tone.warning
    var trailing: Trailing

    public init(icon: String, text: String, tone: Palette.Tone = .warning, @ViewBuilder trailing: () -> Trailing) {
        self.icon = icon
        self.text = text
        self.tone = tone
        self.trailing = trailing()
    }

    public var body: some View {
        HStack(spacing: 12) {
            Icon(icon, size: 17)
            Text(text).font(.system(size: 13.5)).fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 8)
            trailing
        }
        .foregroundStyle(Palette.foreground(tone))
        .padding(.horizontal, 16).padding(.vertical, 11)
        .background(Palette.background(tone), in: RoundedRectangle(cornerRadius: 14))
    }
}

extension Banner where Trailing == EmptyView {
    public init(icon: String, text: String, tone: Palette.Tone = .warning) {
        self.init(icon: icon, text: text, tone: tone) { EmptyView() }
    }
}
