import CairnCore
import SwiftUI

// Composants du design de Cairn (inspiré de la disposition de Codex : rail, barre latérale, pilules, cartes).

/// Bouton carré du rail de navigation.
struct RailButton: View {
    let icon: String
    let label: String
    let selected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: icon)
                .font(.system(size: 17, weight: .regular))
                .frame(width: 40, height: 40)
                .foregroundStyle(selected ? Palette.text : Palette.secondary)
                .background(selected ? Palette.railSelected : .clear, in: RoundedRectangle(cornerRadius: 10))
                .shadow(color: .black.opacity(selected ? 0.06 : 0), radius: 1, y: 1)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(label)
        .accessibilityLabel(label)
    }
}

/// Titre de section de la barre latérale.
struct SidebarHeader: View {
    let title: String
    var body: some View {
        Text(title)
            .font(.system(size: 12, weight: .medium))
            .foregroundStyle(Palette.secondary)
            .padding(.horizontal, 8).padding(.top, 14).padding(.bottom, 4)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Ligne de la barre latérale : icône, libellé, information à droite.
struct SidebarRow: View {
    var icon: String?
    var dot: Color?
    let title: String
    var meta: String?
    var selected = false
    var action: (() -> Void)?

    var body: some View {
        let row = HStack(spacing: 10) {
            if let dot { Circle().fill(dot).frame(width: 8, height: 8) }
            if let icon { Image(systemName: icon).font(.system(size: 13)).frame(width: 16) }
            Text(title).lineLimit(1).truncationMode(.middle)
            Spacer(minLength: 4)
            if let meta { Text(meta).font(.system(size: 12)).foregroundStyle(Palette.secondary).monospacedDigit() }
        }
        .font(.system(size: 13.5))
        .foregroundStyle(Palette.text)
        .padding(.horizontal, 8).padding(.vertical, 7)
        .background(selected ? Palette.rowSelected : .clear, in: RoundedRectangle(cornerRadius: 8))
        .contentShape(Rectangle())

        if let action {
            Button(action: action) { row }.buttonStyle(.plain)
        } else {
            row
        }
    }
}

/// Sélecteur segmenté en forme de pilule, centré en haut de la zone de contenu.
struct PillPicker<Value: Hashable>: View {
    let options: [(Value, String)]
    @Binding var selection: Value

    var body: some View {
        HStack(spacing: 2) {
            ForEach(options.indices, id: \.self) { i in
                let (value, title) = options[i]
                let on = value == selection
                Button { selection = value } label: {
                    Text(title)
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(on ? Palette.text : Palette.tertiary)
                        .padding(.horizontal, 18).padding(.vertical, 7)
                        .background(on ? Palette.content : .clear, in: Capsule())
                        .shadow(color: .black.opacity(on ? 0.08 : 0), radius: 1, y: 1)
                        .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(on ? .isSelected : [])
            }
        }
        .padding(4)
        .background(Palette.field, in: Capsule())
    }
}

/// Carte arrondie avec bordure légère.
struct Card<Content: View>: View {
    var padding: CGFloat = 18
    @ViewBuilder var content: Content

    var body: some View {
        content
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Palette.content, in: RoundedRectangle(cornerRadius: 18))
            .overlay(RoundedRectangle(cornerRadius: 18).stroke(Palette.border))
            .shadow(color: .black.opacity(0.04), radius: 2, y: 1)
    }
}

/// Bouton en pilule : principal (plein) ou secondaire (bordé).
struct PillButtonStyle: ButtonStyle {
    var primary = false
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 13, weight: .medium))
            .foregroundStyle(primary ? Palette.primaryButtonText : Palette.text)
            .padding(.horizontal, 14).frame(minHeight: 34)
            .background(primary ? Palette.primaryButton : Palette.content, in: Capsule())
            .overlay(Capsule().stroke(primary ? .clear : Palette.border))
            .opacity(configuration.isPressed ? 0.75 : 1)
            .contentShape(Capsule())
    }
}

extension ButtonStyle where Self == PillButtonStyle {
    static var pill: PillButtonStyle { PillButtonStyle() }
    static var pillPrimary: PillButtonStyle { PillButtonStyle(primary: true) }
}

/// Petite étiquette colorée.
struct Badge: View {
    let text: String
    var tone = Palette.Tone.neutral
    var body: some View {
        Text(text)
            .font(.system(size: 11, weight: .semibold))
            .padding(.horizontal, 8).padding(.vertical, 3)
            .foregroundStyle(Palette.foreground(tone))
            .background(Palette.background(tone), in: Capsule())
    }
}

/// Bandeau d'information ou d'alerte.
struct Banner<Trailing: View>: View {
    let icon: String
    let text: String
    var tone = Palette.Tone.warning
    @ViewBuilder var trailing: Trailing

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: icon)
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
    init(icon: String, text: String, tone: Palette.Tone = .warning) {
        self.init(icon: icon, text: text, tone: tone) { EmptyView() }
    }
}

/// Barre de remplissage horizontale.
struct FillBar: View {
    let fraction: Double
    var color: Color = Palette.accent
    var body: some View {
        GeometryReader { g in
            ZStack(alignment: .leading) {
                Capsule().fill(Palette.field)
                Capsule().fill(color).frame(width: max(4, g.size.width * min(max(fraction, 0), 1)))
            }
        }
        .frame(height: 8)
    }
}

/// Logo de Cairn : trois pierres empilées.
struct CairnLogo: View {
    var size: CGFloat = 22
    var body: some View {
        Canvas { ctx, s in
            let w = s.width
            let stones: [(CGFloat, CGFloat, CGFloat)] = [(0.77, 0.62, 0.22), (0.53, 0.45, 0.19), (0.30, 0.27, 0.16)]
            for (cy, rw, rh) in stones {
                let rect = CGRect(x: w * (0.5 - rw / 2), y: w * cy - w * rh / 2, width: w * rw, height: w * rh)
                ctx.stroke(Path(ellipseIn: rect), with: .color(Palette.text), lineWidth: max(1.2, w / 14))
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}
