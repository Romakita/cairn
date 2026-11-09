import SwiftUI

// Navigation à la Codex (voir DESIGN.md) : rail, barre latérale, sélecteurs et onglets.

/// Bouton carré du rail de navigation : fond gris sans ombre quand actif (comme Codex), icônes ramenées
/// à une même boîte pour qu'elles aient toutes la même taille visuelle.
public struct RailButton: View {
    let icon: String
    let label: String
    let selected: Bool
    let action: () -> Void
    @ViewState private var hover = false

    public init(icon: String, label: String, selected: Bool, action: @escaping () -> Void) {
        self.icon = icon
        self.label = label
        self.selected = selected
        self.action = action
    }

    public var body: some View {
        Button(action: action) {
            Icon(icon, size: 20)
                .frame(width: 40, height: 40)
                .foregroundStyle(selected || hover ? Palette.text : Palette.secondary)
                .background(selected ? Palette.rowSelected : (hover ? Palette.rowHover : .clear), in: RoundedRectangle(cornerRadius: 10))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hover = $0 }
        .tooltip(label)
        .accessibilityLabel(label)
    }
}

/// Titre de section de la barre latérale.
public struct SidebarHeader: View {
    let title: String

    public init(title: String) { self.title = title }

    public var body: some View {
        Text(title)
            .font(.system(size: 12, weight: .medium))
            .foregroundStyle(Palette.secondary)
            .padding(.horizontal, 8).padding(.top, 14).padding(.bottom, 4)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Ligne de la barre latérale : icône, libellé, information à droite.
public struct SidebarRow: View {
    var icon: String?
    var dot: Color?
    let title: String
    var meta: String?
    var selected = false
    /// Sauvegarde en cours sur cet élément : anneau avec pourcentage, ou roue tant qu'il n'est pas connu.
    var busy = false
    var fraction: Double?
    var action: (() -> Void)?

    public init(icon: String? = nil, dot: Color? = nil, title: String, meta: String? = nil, selected: Bool = false,
                busy: Bool = false, fraction: Double? = nil, action: (() -> Void)? = nil) {
        self.icon = icon
        self.dot = dot
        self.title = title
        self.meta = meta
        self.selected = selected
        self.busy = busy
        self.fraction = fraction
        self.action = action
    }

    public var body: some View {
        let row = HStack(spacing: 10) {
            if let dot { Circle().fill(dot).frame(width: 8, height: 8) }
            if let icon { Icon(icon, size: 16) }
            Text(title).lineLimit(1).truncationMode(.middle)
            Spacer(minLength: 4)
            if busy {
                if let fraction {
                    HStack(spacing: 5) {
                        Text(verbatim: "\(Int(fraction * 100)) %").font(.system(size: 12)).foregroundStyle(Palette.secondary).monospacedDigit()
                        ZStack {
                            Circle().stroke(Palette.field, lineWidth: 2.5)
                            Circle().trim(from: 0, to: fraction)
                                .stroke(Palette.accent, style: StrokeStyle(lineWidth: 2.5, lineCap: .round)).rotationEffect(.degrees(-90))
                        }
                        .frame(width: 13, height: 13)
                    }
                } else {
                    ProgressView().controlSize(.mini)
                }
            } else if let meta {
                Text(meta).font(.system(size: 12)).foregroundStyle(Palette.secondary).monospacedDigit()
            }
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

/// Sélecteur segmenté à la Codex (bascule « Chat / Work ») : piste grise bordée, segments de même largeur,
/// libellés gris foncé, segment choisi blanc, ombré, qui glisse d'une option à l'autre. Pour les onglets d'une page
/// (accueil, analyse, git, outils) ; dans une carte ou un tableau, utiliser `TabBar`.
public struct PillPicker<Value: Hashable>: View {
    let options: [(Value, String)]
    @Binding var selection: Value
    @Namespace private var pill

    public init(options: [(Value, String)], selection: Binding<Value>) {
        self.options = options
        self._selection = selection
    }

    public var body: some View {
        HStack(spacing: 0) {
            ForEach(options.indices, id: \.self) { i in
                let (value, title) = options[i]
                let on = value == selection
                Button { withAnimation(.snappy(duration: 0.25)) { selection = value } } label: {
                    Text(title)
                        .font(.system(size: 14))
                        .foregroundStyle(on ? Palette.text : Palette.tertiary)
                        .lineLimit(1)
                        .padding(.horizontal, 22)
                        .frame(maxWidth: .infinity, minHeight: 32)
                        .background {
                            if on {
                                Capsule().fill(Palette.content)
                                    .overlay(Capsule().strokeBorder(Palette.border, lineWidth: 0.5))
                                    .shadow(color: .black.opacity(0.08), radius: 4, y: 1)
                                    .matchedGeometryEffect(id: "pill", in: pill)
                            }
                        }
                        .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(on ? .isSelected : [])
            }
        }
        .padding(3)
        .background(Palette.field, in: Capsule())
        .overlay(Capsule().strokeBorder(Palette.border.opacity(0.6), lineWidth: 0.5))
        .fixedSize()
    }
}

/// Groupe de boutons à la Codex (« Public  Personnel ») : texte gris sans conteneur, choix courant dans une pilule
/// grise. Pour un choix d'option dans une carte ou un tableau (rétention, fréquence) ; les onglets d'une page
/// utilisent `PillPicker`.
public struct TabBar<Value: Hashable>: View {
    let options: [(Value, String)]
    @Binding var selection: Value

    public init(options: [(Value, String)], selection: Binding<Value>) {
        self.options = options
        self._selection = selection
    }

    public var body: some View {
        HStack(spacing: 4) {
            ForEach(options.indices, id: \.self) { i in
                let (value, title) = options[i]
                TabChip(title: title, selected: value == selection) {
                    withAnimation(.easeOut(duration: 0.15)) { selection = value }
                }
            }
        }
    }
}

private struct TabChip: View {
    let title: String
    let selected: Bool
    let action: () -> Void
    @ViewState private var hover = false

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 13.5, weight: .regular))
                .foregroundStyle(selected || hover ? Palette.text : Palette.secondary)
                .lineLimit(1).fixedSize()
                .padding(.horizontal, 12).padding(.vertical, 7)
                .background(selected ? Palette.field : (hover ? Palette.rowHover : .clear), in: Capsule())
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .onHover { hover = $0 }
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}
