import CairnCore
import SwiftUI

/// Champ de saisie à la Codex : capsule bordée, icône ou préfixe optionnels, anneau bleu au focus.
/// S'applique à un `TextField` ou un `SecureField` à la place de `.cairnField()`.
public struct CairnFieldModifier: ViewModifier {
    var icon: String?
    var prefix: String?
    @FocusState private var focused: Bool

    public init(icon: String? = nil, prefix: String? = nil) {
        self.icon = icon
        self.prefix = prefix
    }

    public func body(content: Content) -> some View {
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
    public func cairnField(icon: String? = nil, prefix: String? = nil) -> some View {
        modifier(CairnFieldModifier(icon: icon, prefix: prefix))
    }
}

/// Menu déroulant bordé à la Codex (« Terminal ⌄ ») à la place du menu natif aux chevrons bleus.
public struct DropdownMenu<Value: Hashable>: View {
    let options: [(Value, String)]
    @Binding var selection: Value
    @ViewState private var hover = false

    public init(options: [(Value, String)], selection: Binding<Value>) {
        self.options = options
        self._selection = selection
    }

    public var body: some View {
        PopupMenuButton(entries: {
            options.map { o in .item(title: o.1, checked: o.0 == selection) { selection = o.0 } }
        }, minWidth: 160) {
            HStack(spacing: 8) {
                Text(options.first { $0.0 == selection }?.1 ?? "").font(.system(size: 13.5)).foregroundStyle(Palette.text)
                Icon("chevron.down", size: 13).foregroundStyle(Palette.secondary)
            }
            .padding(.horizontal, 12).frame(height: 32)
            .background(hover ? Palette.rowHover : Palette.content, in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(Palette.fieldBorder))
            .contentShape(RoundedRectangle(cornerRadius: 10))
            .onHover { hover = $0 }
        }
        .fixedSize()
    }
}

/// Champ de chemin relatif au home avec complétion : liste de suggestions au-dessus du champ,
/// ↑/↓ pour choisir, Tab ou Entrée pour accepter, Échap pour fermer. Un dossier accepté garde la liste ouverte.
public struct PathField: View {
    let placeholder: String
    @Binding var text: String
    var base = URL(fileURLWithPath: NSHomeDirectory())
    var excluding: Set<String> = []
    var onSubmit: () -> Void = {}
    @ViewState private var highlighted: Int?
    @ViewState private var dismissed = false

    public init(placeholder: String, text: Binding<String>, base: URL = URL(fileURLWithPath: NSHomeDirectory()),
                excluding: Set<String> = [], onSubmit: @escaping () -> Void = {}) {
        self.placeholder = placeholder
        self._text = text
        self.base = base
        self.excluding = excluding
        self.onSubmit = onSubmit
    }

    var suggestions: [PathCompletion.Suggestion] {
        text.trimmingCharacters(in: .whitespaces).isEmpty || dismissed ? []
            : PathCompletion.suggestions(for: text, base: base, excluding: excluding)
    }

    public var body: some View {
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
