import SwiftUI

// Étapes et fil d'Ariane : progression d'un assistant, chemin dans une arborescence.

/// Étapes d'un assistant : pastilles numérotées reliées par une ligne, étape courante noire, étapes faites cochées.
/// Une étape n'est cliquable que si `canSelect` l'autorise.
public struct WizardStepper: View {
    let titles: [String]
    let current: Int
    let reached: Int
    let canSelect: (Int) -> Bool
    let select: (Int) -> Void

    public init(titles: [String], current: Int, reached: Int, canSelect: @escaping (Int) -> Bool,
                select: @escaping (Int) -> Void) {
        self.titles = titles
        self.current = current
        self.reached = reached
        self.canSelect = canSelect
        self.select = select
    }

    public var body: some View {
        HStack(alignment: .top, spacing: 0) {
            ForEach(titles.indices, id: \.self) { i in
                StepNode(index: i, title: titles[i], current: current, reached: reached, enabled: canSelect(i)) { select(i) }
                    .frame(maxWidth: .infinity)
            }
        }
        .background(alignment: .topLeading) {
            GeometryReader { g in
                let column = g.size.width / CGFloat(max(titles.count, 1))
                ZStack(alignment: .leading) {
                    Capsule().fill(Palette.border).frame(width: max(0, g.size.width - column), height: 2)
                    Capsule().fill(Palette.text).frame(width: column * CGFloat(current), height: 2)
                }
                .offset(x: column / 2, y: StepNode.size / 2 - 1)
            }
        }
    }
}

private struct StepNode: View {
    static let size: CGFloat = 28
    let index: Int
    let title: String
    let current: Int
    let reached: Int
    let enabled: Bool
    let action: () -> Void
    @ViewState private var hover = false

    var isCurrent: Bool { index == current }
    var isDone: Bool { index < current }
    var isReached: Bool { index <= reached }

    var body: some View {
        Button(action: action) {
            VStack(spacing: 8) {
                ZStack {
                    Circle().fill(Palette.text.opacity(isCurrent ? 0.10 : 0)).frame(width: Self.size + 10, height: Self.size + 10)
                    Circle().fill(isCurrent || isDone ? Palette.primaryButton : Palette.content)
                    Circle().stroke(isCurrent || isDone ? .clear : (isReached ? Palette.text : Palette.fieldBorder), lineWidth: 1.5)
                    if isDone {
                        Image(systemName: "checkmark").font(.system(size: 11, weight: .bold)).foregroundStyle(Palette.primaryButtonText)
                            .transition(.scale.combined(with: .opacity))
                    } else {
                        Text(verbatim: "\(index + 1)").font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(isCurrent ? Palette.primaryButtonText : (isReached ? Palette.text : Palette.secondary))
                    }
                }
                .frame(width: Self.size, height: Self.size)
                .scaleEffect(hover && enabled ? 1.08 : 1)
                Text(title)
                    .font(.system(size: 12.5, weight: isCurrent ? .medium : .regular))
                    .foregroundStyle(isCurrent || (hover && enabled) ? Palette.text : (isReached ? Palette.tertiary : Palette.secondary))
                    .lineLimit(1)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .allowsHitTesting(enabled) // pas .disabled : l'étape courante grisée serait illisible
        .onHover { hover = $0 }
        .animation(.easeOut(duration: 0.15), value: hover)
        .accessibilityLabel(title)
        .accessibilityAddTraits(isCurrent ? .isSelected : [])
    }
}

/// Fil d'Ariane d'un explorateur de dossiers : un élément par niveau, le dernier sélectionné.
/// Un élément « … » (niveaux masqués) n'est pas cliquable.
public struct FolderBreadcrumb: View {
    let items: [(String, URL?)]
    let select: (URL?) -> Void

    public init(items: [(String, URL?)], select: @escaping (URL?) -> Void) {
        self.items = items
        self.select = select
    }

    public var body: some View {
        HStack(spacing: 2) {
            ForEach(items.indices, id: \.self) { i in
                if i > 0 {
                    Image(systemName: "chevron.right").font(.system(size: 9, weight: .semibold)).foregroundStyle(Palette.secondary)
                }
                Crumb(title: items[i].0, current: i == items.count - 1) { select(items[i].1) }
                    .disabled(items[i].0 == "…")
            }
        }
        .lineLimit(1)
    }
}

/// Élément du fil d'Ariane, au style des onglets de page (`TabBar`).
private struct Crumb: View {
    let title: String
    let current: Bool
    let action: () -> Void
    @ViewState private var hover = false

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 13, weight: current ? .medium : .regular))
                .foregroundStyle(current || hover ? Palette.text : Palette.secondary)
                .lineLimit(1).truncationMode(.middle)
                .padding(.horizontal, 9).padding(.vertical, 5)
                .background(current ? Palette.field : (hover ? Palette.rowHover : .clear), in: RoundedRectangle(cornerRadius: 8))
                .contentShape(RoundedRectangle(cornerRadius: 8))
        }
        .buttonStyle(.plain)
        .onHover { hover = $0 }
    }
}
