import AppKit
import CairnCore
import SwiftUI

// Composants du design system de Cairn, repris de Codex (voir DESIGN.md) : rail, barre latérale, onglets,
// cartes et lignes de réglages, boutons, champs.

/// Bouton carré du rail de navigation : fond gris sans ombre quand actif (comme Codex), icônes ramenées
/// à une même boîte pour qu'elles aient toutes la même taille visuelle.
struct RailButton: View {
    let icon: String
    let label: String
    let selected: Bool
    let action: () -> Void
    @ViewState private var hover = false

    var body: some View {
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
            if let icon { Icon(icon, size: 16) }
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

/// Sélecteur segmenté à la Codex (bascule « Chat / Work ») : piste grise bordée, segments de même largeur,
/// libellés gris foncé, segment choisi blanc, ombré, qui glisse d'une option à l'autre.
struct PillPicker<Value: Hashable>: View {
    let options: [(Value, String)]
    @Binding var selection: Value
    @Namespace private var pill

    var body: some View {
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
/// grise. Pour les onglets de page comme pour un choix d'option (rétention, fréquence).
struct TabBar<Value: Hashable>: View {
    let options: [(Value, String)]
    @Binding var selection: Value

    var body: some View {
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

/// Carte arrondie avec bordure légère, sans ombre (comme les panneaux de réglages de Codex).
struct Card<Content: View>: View {
    var padding: CGFloat = 18
    /// S'étire en hauteur (cartes d'une même rangée, rangée en `fixedSize` vertical).
    var fill = false
    @ViewBuilder var content: Content

    var body: some View {
        content
            .padding(padding)
            .frame(maxWidth: .infinity, maxHeight: fill ? .infinity : nil, alignment: .topLeading)
            .background(Palette.content, in: RoundedRectangle(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).stroke(Palette.border))
    }
}

/// Ligne de réglage : titre, description grise, contrôle à droite. À placer dans une `Card(padding: 0)`,
/// séparée de la suivante par `RowDivider()`.
struct SettingsRow<Trailing: View>: View {
    var icon: String?
    let title: String
    var subtitle: String?
    var monospaced = false
    @ViewBuilder var trailing: Trailing

    var body: some View {
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
struct RowDivider: View {
    var body: some View { Rectangle().fill(Palette.border).frame(height: 1).padding(.horizontal, 16) }
}

/// Icône dans une tuile carrée bordée (icônes de plugins de Codex).
struct IconTile: View {
    let systemName: String
    var size: CGFloat = 32
    var body: some View {
        Icon(systemName, size: size * 0.52)
            .foregroundStyle(Palette.tertiary)
            .frame(width: size, height: size)
            .background(Palette.content, in: RoundedRectangle(cornerRadius: size * 0.28))
            .overlay(RoundedRectangle(cornerRadius: size * 0.28).stroke(Palette.border))
    }
}

/// Menu déroulant bordé à la Codex (« Terminal ⌄ ») à la place du menu natif aux chevrons bleus.
struct DropdownMenu<Value: Hashable>: View {
    let options: [(Value, String)]
    @Binding var selection: Value
    @ViewState private var hover = false

    var body: some View {
        // Le chevron est dessiné hors du Menu : un menu macOS sans bordure teinte et déplace l'image de son libellé.
        HStack(spacing: 8) {
            Menu {
                ForEach(options.indices, id: \.self) { i in
                    Button { selection = options[i].0 } label: {
                        if options[i].0 == selection { Label(options[i].1, systemImage: "checkmark") } else { Text(options[i].1) }
                    }
                }
            } label: {
                Text(options.first { $0.0 == selection }?.1 ?? "").font(.system(size: 13.5)).foregroundStyle(Palette.text)
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .fixedSize()
            Icon("chevron.down", size: 13).foregroundStyle(Palette.secondary)
                .allowsHitTesting(false)
        }
        .padding(.horizontal, 12).frame(height: 32)
        .background(hover ? Palette.rowHover : Palette.content, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Palette.fieldBorder))
        .onHover { hover = $0 }
    }
}

/// Bouton icône discret (corbeille des listes de Codex).
struct IconButton: View {
    let systemName: String
    let label: String
    let action: () -> Void
    @ViewState private var hover = false

    var body: some View {
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

/// Titre de section au-dessus d'une carte (« Autorisations », « Général » dans les réglages de Codex).
struct SectionTitle: View {
    let title: String
    var body: some View {
        Text(title).font(.system(size: 15, weight: .medium)).foregroundStyle(Palette.text)
            .padding(.top, 14).padding(.bottom, 2)
    }
}

/// Bas de carte gris (plateau sous la zone de saisie de Codex), pour ajouter un élément à une liste.
struct CardTray<Content: View>: View {
    @ViewBuilder var content: Content
    var body: some View {
        HStack(spacing: 10) { content }
            .padding(.horizontal, 14).padding(.vertical, 12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Palette.sidebar, in: UnevenRoundedRectangle(bottomLeadingRadius: 16, bottomTrailingRadius: 16))
            .overlay(alignment: .top) { Rectangle().fill(Palette.border).frame(height: 1) }
    }
}

/// Boutons à la Codex : principal (noir), secondaire (gris plein, sans bordure) ou bordé (blanc).
struct PillButtonStyle: ButtonStyle {
    enum Kind { case primary, secondary, outline, danger }
    var kind = Kind.secondary
    var primary: Bool { kind == .primary }

    func makeBody(configuration: Configuration) -> some View {
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
    static var pill: PillButtonStyle { PillButtonStyle() }
    static var pillPrimary: PillButtonStyle { PillButtonStyle(kind: .primary) }
    static var pillOutline: PillButtonStyle { PillButtonStyle(kind: .outline) }
    /// Action destructive confirmée (suppression).
    static var pillDanger: PillButtonStyle { PillButtonStyle(kind: .danger) }
}

/// Champ de saisie à la Codex : capsule bordée, icône ou préfixe optionnels, anneau bleu au focus.
/// S'applique à un `TextField` ou un `SecureField` à la place de `.cairnField()`.
struct CairnFieldModifier: ViewModifier {
    var icon: String?
    var prefix: String?
    @FocusState private var focused: Bool

    func body(content: Content) -> some View {
        HStack(spacing: 8) {
            if let icon { Icon(icon, size: 15).foregroundStyle(Palette.secondary) }
            if let prefix { Text(verbatim: prefix).font(.system(size: 13.5, design: .monospaced)).foregroundStyle(Palette.secondary) }
            content
                .textFieldStyle(.plain)
                .frame(minWidth: 0, maxWidth: .infinity)
                .focusEffectDisabled() // l'anneau de focus natif déborde de la capsule
                .font(.system(size: 13.5, design: prefix == nil ? .default : .monospaced))
                .focused($focused)
        }
        .padding(.horizontal, 14).frame(height: 34)
        .background(Palette.content, in: Capsule())
        .overlay(Capsule().strokeBorder(focused ? Palette.accent : Palette.fieldBorder, lineWidth: focused ? 1.5 : 1))
        .contentShape(Capsule())
        .onTapGesture { focused = true }
        .animation(.easeOut(duration: 0.12), value: focused)
    }
}

extension View {
    func cairnField(icon: String? = nil, prefix: String? = nil) -> some View {
        modifier(CairnFieldModifier(icon: icon, prefix: prefix))
    }
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

/// Icône de Cairn : Lucide (SVG embarqué, teinté comme le texte) pour un nom de symbole SF de la table
/// `LucideIcons.map`, sinon le symbole SF. `size` est la boîte de l'icône en points.
struct Icon: View {
    let name: String
    var size: CGFloat = 16

    init(_ name: String, size: CGFloat = 16) {
        self.name = name
        self.size = size
    }

    var body: some View {
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

    @MainActor static func image(_ name: String) -> NSImage? {
        if let i = cache[name] { return i }
        guard let url = LucideIcons.url(symbol: name), let i = NSImage(contentsOf: url) else { return nil }
        i.isTemplate = true
        cache[name] = i
        return i
    }
}

/// Logo de Cairn : trois pierres empilées.
struct CairnLogo: View {
    var size: CGFloat = 22
    var color: Color = Palette.text
    var body: some View {
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

/// Infobulle sombre à la Codex, affichée à droite de l'élément après un court survol.
struct HoverTooltip: ViewModifier {
    let text: String
    var offset: CGFloat = 48
    @ViewState private var visible = false
    @ViewState private var pending: Task<Void, Never>?

    func body(content: Content) -> some View {
        content
            .onHover { inside in
                pending?.cancel()
                if inside {
                    pending = Task { @MainActor in
                        try? await Task.sleep(for: .milliseconds(350))
                        if !Task.isCancelled { withAnimation(.easeOut(duration: 0.12)) { visible = true } }
                    }
                } else {
                    visible = false
                }
            }
            .overlay(alignment: .leading) {
                if visible {
                    Text(text)
                        .font(.system(size: 13))
                        .foregroundStyle(Palette.primaryButtonText)
                        .padding(.horizontal, 10).padding(.vertical, 6)
                        .background(Palette.primaryButton, in: RoundedRectangle(cornerRadius: 8))
                        .shadow(color: .black.opacity(0.18), radius: 6, y: 2)
                        .fixedSize()
                        .offset(x: offset)
                        .transition(.opacity)
                        .allowsHitTesting(false)
                }
            }
    }
}

extension View {
    func tooltip(_ text: String, offset: CGFloat = 48) -> some View { modifier(HoverTooltip(text: text, offset: offset)) }
}

/// Champ de chemin relatif au home avec complétion : liste de suggestions au-dessus du champ,
/// ↑/↓ pour choisir, Tab ou Entrée pour accepter, Échap pour fermer. Un dossier accepté garde la liste ouverte.
struct PathField: View {
    let placeholder: String
    @Binding var text: String
    var base = URL(fileURLWithPath: NSHomeDirectory())
    var excluding: Set<String> = []
    var onSubmit: () -> Void = {}
    @ViewState private var highlighted: Int?
    @ViewState private var dismissed = false

    var suggestions: [PathCompletion.Suggestion] {
        text.trimmingCharacters(in: .whitespaces).isEmpty || dismissed ? []
            : PathCompletion.suggestions(for: text, base: base, excluding: excluding)
    }

    var body: some View {
        let items = suggestions
        TextField(placeholder, text: $text)
            .cairnField(prefix: "~/")
            .onSubmit { onSubmit(); dismissed = true }
            .onChange(of: text) { dismissed = false; highlighted = nil }
            .onKeyPress(.downArrow) { move(1, count: items.count) }
            .onKeyPress(.upArrow) { move(-1, count: items.count) }
            .onKeyPress(.escape) { guard !items.isEmpty else { return .ignored }; dismissed = true; return .handled }
            .onKeyPress(.tab) {
                guard let s = items[safe: highlighted ?? 0] else { return .ignored }
                accept(s); return .handled
            }
            .onKeyPress(.return) {
                guard let i = highlighted, let s = items[safe: i] else { return .ignored }
                accept(s); return .handled
            }
            .overlay(alignment: .bottom) {
                if !items.isEmpty {
                    SuggestionList(items: items, highlighted: highlighted, select: accept)
                        .offset(y: -42)
                        .transition(.opacity)
                }
            }
            .animation(.easeOut(duration: 0.12), value: items.map(\.path))
    }

    func move(_ delta: Int, count: Int) -> KeyPress.Result {
        guard count > 0 else { return .ignored }
        highlighted = ((highlighted ?? (delta > 0 ? -1 : count)) + delta + count) % count
        return .handled
    }

    func accept(_ s: PathCompletion.Suggestion) {
        text = s.path
        DispatchQueue.main.async {
            highlighted = nil
            dismissed = !s.isDirectory
        }
    }
}

private struct SuggestionList: View {
    let items: [PathCompletion.Suggestion]
    let highlighted: Int?
    let select: (PathCompletion.Suggestion) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(items.indices, id: \.self) { i in
                SuggestionRow(item: items[i], highlighted: i == highlighted) { select(items[i]) }
            }
        }
        .padding(6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .fixedSize(horizontal: false, vertical: true)
        .background(Palette.content, in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Palette.border))
        .shadow(color: .black.opacity(0.12), radius: 14, y: 4)
    }
}

private struct SuggestionRow: View {
    let item: PathCompletion.Suggestion
    let highlighted: Bool
    let action: () -> Void
    @ViewState private var hover = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Icon(item.isDirectory ? "folder" : "doc", size: 15).fontWeight(.light)
                    .foregroundStyle(Palette.secondary).frame(width: 16)
                Text(verbatim: "~/" + item.path).font(.system(size: 13, design: .monospaced)).foregroundStyle(Palette.text)
                    .lineLimit(1).truncationMode(.middle)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 10).padding(.vertical, 7)
            .background(highlighted || hover ? Palette.field : .clear, in: RoundedRectangle(cornerRadius: 8))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hover = $0 }
    }
}

extension Array {
    subscript(safe index: Int) -> Element? { indices.contains(index) ? self[index] : nil }
}
