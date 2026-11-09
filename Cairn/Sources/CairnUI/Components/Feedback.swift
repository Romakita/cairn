import SwiftUI

/// Petite étiquette colorée.
public struct Badge: View {
    let text: String
    var tone = Palette.Tone.neutral

    public init(text: String, tone: Palette.Tone = .neutral) {
        self.text = text
        self.tone = tone
    }

    public var body: some View {
        Text(text)
            .font(.system(size: 11, weight: .semibold))
            .padding(.horizontal, 8).padding(.vertical, 3)
            .foregroundStyle(Palette.foreground(tone))
            .background(Palette.background(tone), in: Capsule())
    }
}

/// Barre de remplissage horizontale.
public struct FillBar: View {
    let fraction: Double
    var color: Color = Palette.accent

    public init(fraction: Double, color: Color = Palette.accent) {
        self.fraction = fraction
        self.color = color
    }

    public var body: some View {
        GeometryReader { g in
            ZStack(alignment: .leading) {
                Capsule().fill(Palette.field)
                Capsule().fill(color).frame(width: max(4, g.size.width * min(max(fraction, 0), 1)))
            }
        }
        .frame(height: 8)
    }
}

/// Barre segmentée : une part colorée par valeur, proportionnelle au total, séparées de 2 pt ; invisible si tout est nul.
public struct SegmentBar: View {
    let parts: [(Double, Color)]

    public init(parts: [(Double, Color)]) { self.parts = parts }

    public var body: some View {
        let total = parts.reduce(0) { $0 + $1.0 }
        GeometryReader { g in
            HStack(spacing: 2) {
                ForEach(Array(parts.enumerated()), id: \.offset) { _, p in
                    if p.0 > 0 { Rectangle().fill(p.1).frame(width: max(3, (g.size.width - 2 * CGFloat(parts.count - 1)) * p.0 / total)) }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Palette.field)
            .clipShape(Capsule())
        }
        .frame(height: 8)
        .opacity(total > 0 ? 1 : 0)
    }
}

/// Barre de message en bas de fenêtre : icône d'information, texte sélectionnable, bouton de fermeture.
public struct MessageBar: View {
    let text: String
    let close: () -> Void

    public init(text: String, close: @escaping () -> Void) {
        self.text = text
        self.close = close
    }

    public var body: some View {
        HStack {
            Icon("info.circle", size: 16).foregroundStyle(Palette.secondary)
            Text(text).font(.callout).foregroundStyle(Palette.secondary).textSelection(.enabled)
            Spacer()
            Button(action: close) { Icon("xmark", size: 16) }
                .buttonStyle(.plain)
                .accessibilityLabel(T("action.close"))
        }
        .padding(.horizontal, 16).padding(.vertical, 8)
        .overlay(alignment: .top) { Rectangle().fill(Palette.border).frame(height: 1) }
    }
}

/// Infobulle sombre à la Codex, affichée à droite de l'élément après un court survol.
public struct HoverTooltip: ViewModifier {
    let text: String
    var offset: CGFloat = 48
    /// Infobulle affichée d'emblée, sans survol (catalogue de composants).
    var initiallyVisible = false
    @ViewState private var visible = false
    @ViewState private var pending: Task<Void, Never>?

    public init(text: String, offset: CGFloat = 48, initiallyVisible: Bool = false) {
        self.text = text
        self.offset = offset
        self.initiallyVisible = initiallyVisible
        self._visible = ViewState(initialValue: initiallyVisible)
    }

    public func body(content: Content) -> some View {
        content
            .onHover { inside in
                pending?.cancel()
                if inside {
                    pending = Task { @MainActor in
                        try? await Task.sleep(for: .milliseconds(350))
                        if !Task.isCancelled { withAnimation(.easeOut(duration: 0.12)) { visible = true } }
                    }
                } else {
                    visible = initiallyVisible
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
    public func tooltip(_ text: String, offset: CGFloat = 48) -> some View { modifier(HoverTooltip(text: text, offset: offset)) }
}
