import SwiftUI
import Charts

enum Tab: String, CaseIterable, Identifiable {
    case explorer = "Explorateur"
    case cleanable = "Nettoyable"
    case repos = "Dépôts git"
    case bigFiles = "Gros fichiers"
    var id: String { rawValue }
    var icon: String {
        switch self {
        case .explorer: "folder"
        case .cleanable: "sparkles"
        case .repos: "arrow.triangle.branch"
        case .bigFiles: "doc.fill"
        }
    }
}

struct ContentView: View {
    @EnvironmentObject var model: AppModel
    @ViewState private var tab: Tab = .explorer

    var body: some View {
        VStack(spacing: 0) {
            SummaryHeader()
            Divider()
            if let root = model.root, !model.isScanning {
                Group {
                    switch tab {
                    case .explorer: ExplorerView()
                    case .cleanable: CleanableView()
                    case .repos: ReposView(root: root)
                    case .bigFiles: BigFilesView(root: root)
                    }
                }
                .id(model.revision)
            } else if model.isScanning {
                ScanningView()
            } else {
                ContentUnavailableView {
                    Label("Aucune analyse", systemImage: "internaldrive")
                } description: {
                    Text(model.rootPath)
                } actions: {
                    Button("Analyser") { model.scan() }.buttonStyle(.borderedProminent)
                }
            }
            if let msg = model.lastMessage {
                Divider()
                HStack {
                    Image(systemName: "info.circle").foregroundStyle(.secondary)
                    Text(msg).font(.callout).foregroundStyle(.secondary).textSelection(.enabled)
                    Spacer()
                    Button { model.lastMessage = nil } label: { Image(systemName: "xmark") }.buttonStyle(.plain)
                }
                .padding(.horizontal, 14).padding(.vertical, 6)
            }
        }
        .frame(minWidth: 980, minHeight: 640)
        .toolbar {
            ToolbarItem(placement: .principal) {
                Picker("Vue", selection: $tab) {
                    ForEach(Tab.allCases) { t in Label(t.rawValue, systemImage: t.icon).tag(t) }
                }
                .pickerStyle(.segmented)
                .disabled(model.root == nil || model.isScanning)
            }
            ToolbarItemGroup(placement: .primaryAction) {
                Button { model.chooseFolder() } label: { Label("Choisir un dossier", systemImage: "folder.badge.gearshape") }
                    .help("Choisir le dossier à analyser")
                if model.isScanning {
                    Button { model.cancel() } label: { Label("Arrêter", systemImage: "stop.circle") }
                } else {
                    Button { model.scan() } label: { Label("Analyser", systemImage: "arrow.clockwise") }
                        .keyboardShortcut("r")
                        .help("Relancer l'analyse (⌘R)")
                }
            }
        }
        .navigationTitle("Stockage — \((model.rootPath as NSString).lastPathComponent)")
        .overlay {
            if model.isDeleting {
                ProgressView("Suppression en cours…")
                    .padding(24)
                    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
            }
        }
    }
}

// MARK: - En-tête

struct SummaryHeader: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        HStack(alignment: .top, spacing: 18) {
            if let v = model.volume {
                VolumeGauge(volume: v, scanned: model.root?.size ?? (model.isScanning ? model.scannedBytes : 0))
                    .frame(width: 330)
            }
            if let root = model.root, !model.isScanning {
                StatCard(title: "Total analysé", value: Fmt.bytes(root.size),
                         detail: "\(Fmt.count(root.fileCount)) fichiers", color: .primary)
                StatCard(title: "Régénérable", value: Fmt.bytes(root.regenerableBytes),
                         detail: Fmt.percent(root.regenerableBytes, of: root.size) + " du total",
                         color: Category.deps.color)
                StatCard(title: "Historique git", value: Fmt.bytes(root.bytes(.git)),
                         detail: Fmt.percent(root.bytes(.git), of: root.size) + " du total",
                         color: Category.git.color)
                StatCard(title: "Sources & fichiers", value: Fmt.bytes(root.bytes(.source)),
                         detail: Fmt.percent(root.bytes(.source), of: root.size) + " du total",
                         color: Category.source.color)
            }
            Spacer(minLength: 0)
        }
        .padding(14)
    }
}

struct VolumeGauge: View {
    let volume: VolumeInfo
    let scanned: Int64

    var body: some View {
        let total = max(volume.total, 1)
        let free = volume.available
        let other = max(total - free - scanned, 0)
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Label(volume.name, systemImage: "internaldrive").font(.headline)
                Spacer()
                Text("\(Fmt.bytes(free)) libres sur \(Fmt.bytes(volume.total))")
                    .font(.callout).foregroundStyle(free * 10 < total ? .red : .secondary)
            }
            GeometryReader { g in
                HStack(spacing: 1) {
                    Rectangle().fill(Category.deps.color.gradient)
                        .frame(width: g.size.width * CGFloat(Double(scanned) / Double(total)))
                    Rectangle().fill(Color.gray.opacity(0.55))
                        .frame(width: g.size.width * CGFloat(Double(other) / Double(total)))
                    Rectangle().fill(Color.gray.opacity(0.15))
                }
                .clipShape(RoundedRectangle(cornerRadius: 5))
            }
            .frame(height: 14)
            HStack(spacing: 12) {
                LegendDot(color: Category.deps.color, text: "Dossier analysé \(Fmt.bytes(scanned))")
                LegendDot(color: .gray.opacity(0.55), text: "Autres \(Fmt.bytes(other))")
            }
            .font(.caption)
            Text("Espace partagé par le conteneur APFS ; « libre » peut inclure de l'espace purgeable (\(Fmt.bytes(volume.availableImportant))).")
                .font(.caption2).foregroundStyle(.tertiary).fixedSize(horizontal: false, vertical: true)
        }
    }
}

struct LegendDot: View {
    let color: Color
    let text: String
    var body: some View {
        HStack(spacing: 4) {
            Circle().fill(color).frame(width: 8, height: 8)
            Text(text).foregroundStyle(.secondary)
        }
    }
}

struct StatCard: View {
    let title: String
    let value: String
    let detail: String
    let color: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title).font(.caption).foregroundStyle(.secondary)
            Text(value).font(.system(size: 22, weight: .semibold, design: .rounded)).foregroundStyle(color)
                .monospacedDigit()
            Text(detail).font(.caption).foregroundStyle(.secondary)
        }
        .padding(10)
        .frame(minWidth: 130, alignment: .leading)
        .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 10))
    }
}

struct ScanningView: View {
    @EnvironmentObject var model: AppModel
    var body: some View {
        VStack(spacing: 14) {
            ProgressView().controlSize(.large)
            Text("Analyse de \(model.rootPath)…").font(.headline)
            Text("\(Fmt.count(model.scannedFiles)) fichiers — \(Fmt.bytes(model.scannedBytes))")
                .monospacedDigit().foregroundStyle(.secondary)
            Text(model.currentPath).font(.caption).foregroundStyle(.tertiary)
                .lineLimit(1).truncationMode(.middle).frame(maxWidth: 600)
            Button("Arrêter") { model.cancel() }
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
        Label(category.shortLabel, systemImage: category.icon)
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
                SectorMark(angle: .value("Taille", node.breakdown[c.rawValue]), innerRadius: .ratio(0.6), angularInset: 1)
                    .foregroundStyle(c.color)
            }
            .chartLegend(.hidden)
            .frame(height: 170)
            .overlay {
                VStack(spacing: 0) {
                    Text(Fmt.bytes(node.size)).font(.headline).monospacedDigit()
                    Text("\(Fmt.count(node.fileCount)) fichiers").font(.caption2).foregroundStyle(.secondary)
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
