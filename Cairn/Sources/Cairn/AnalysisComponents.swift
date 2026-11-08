import CairnCore
import Charts
import SwiftUI

// Composants de l'analyse (barres, anneau, étiquettes, progression).

struct ScanningView: View {
    @EnvironmentObject var model: AppModel
    var body: some View {
        VStack(spacing: 14) {
            ProgressView().controlSize(.large)
            Text(T("scan.progress_title", model.rootPath)).font(.headline)
            Text(T("scan.progress", Fmt.count(model.scannedFiles), Fmt.bytes(model.scannedBytes)))
                .monospacedDigit().foregroundStyle(.secondary)
            Text(model.currentPath).font(.caption).foregroundStyle(.tertiary)
                .lineLimit(1).truncationMode(.middle).frame(maxWidth: 600)
            Button(T("action.stop")) { model.cancel() }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: - Barre empilée par catégorie

struct BreakdownBar: View {
    let node: Node
    let scale: Int64   // taille correspondant à 100 % de la largeur

    var body: some View {
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

struct CategoryTag: View {
    let category: Category
    var body: some View {
        Label { Text(category.shortLabel) } icon: { Icon(category.icon, size: 15) }
            .lineLimit(1)
            .font(.caption2.weight(.medium))
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background(category.color.opacity(0.18), in: Capsule())
            .foregroundStyle(category.color)
    }
}

struct BreakdownChart: View {
    let node: Node

    var body: some View {
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
