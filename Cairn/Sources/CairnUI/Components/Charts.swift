import CairnCore
import Charts
import SwiftUI

// Graphiques de l'analyse : barre empilée, anneau et étiquettes de catégorie.

/// Barre empilée par catégorie.
public struct BreakdownBar: View {
    let node: Node
    let scale: Int64   // taille correspondant à 100 % de la largeur

    public init(node: Node, scale: Int64) {
        self.node = node
        self.scale = scale
    }

    public var body: some View {
        GeometryReader { g in
            let w = g.size.width * CGFloat(Double(node.size) / Double(max(scale, 1)))
            HStack(spacing: 0) {
                ForEach(Category.allCases) { c in
                    let b = node.breakdown[c.rawValue]
                    if b > 0 {
                        Rectangle().fill(c.color)
                            .frame(width: w * CGFloat(Double(b) / Double(max(node.size, 1))))
                    }
                }
            }
            .frame(width: max(w, 1), alignment: .leading)
            .clipShape(RoundedRectangle(cornerRadius: 3))
        }
        .frame(height: 10)
    }
}

/// Étiquette d'une catégorie (icône et nom court sur sa couleur).
public struct CategoryTag: View {
    let category: CairnCore.Category

    public init(category: CairnCore.Category) { self.category = category }

    public var body: some View {
        Label(category.shortLabel, systemImage: category.icon)
            .lineLimit(1)
            .font(.caption2.weight(.medium))
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background(category.color.opacity(0.18), in: Capsule())
            .foregroundStyle(category.color)
    }
}

/// Anneau de répartition par catégorie, avec la légende détaillée.
public struct BreakdownChart: View {
    let node: Node

    public init(node: Node) { self.node = node }

    public var body: some View {
        let items = Category.allCases.filter { node.breakdown[$0.rawValue] > 0 }
        VStack(alignment: .leading, spacing: 10) {
            Chart(items) { c in
                SectorMark(angle: .value(T("col.size"), node.breakdown[c.rawValue]), innerRadius: .ratio(0.6), angularInset: 1)
                    .foregroundStyle(c.color)
            }
            .chartLegend(.hidden)
            .frame(height: 170)
            .overlay {
                VStack(spacing: 0) {
                    Text(Fmt.bytes(node.size)).font(.headline).monospacedDigit()
                    Text(T("stat.files", Fmt.count(node.fileCount))).font(.caption2).foregroundStyle(.secondary)
                }
            }
            ForEach(items) { c in
                HStack {
                    Circle().fill(c.color).frame(width: 9, height: 9)
                    Text(c.label).font(.callout)
                    Spacer()
                    Text(Fmt.bytes(node.breakdown[c.rawValue])).monospacedDigit().font(.callout)
                    Text(Fmt.percent(node.breakdown[c.rawValue], of: node.size))
                        .monospacedDigit().font(.caption).foregroundStyle(.secondary).frame(width: 52, alignment: .trailing)
                }
            }
        }
    }
}
