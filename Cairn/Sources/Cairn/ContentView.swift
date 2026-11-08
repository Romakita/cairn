import CairnCore
import SwiftUI
import Charts

enum Tab: String, CaseIterable, Identifiable {
    case explorer, cleanable, repos, bigFiles
    var id: String { rawValue }
    var title: String {
        switch self {
        case .explorer: T("tab.explorer")
        case .cleanable: T("tab.cleanable")
        case .repos: T("tab.repos")
        case .bigFiles: T("tab.big_files")
        }
    }
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
                    Label(T("empty.title"), systemImage: "internaldrive")
                } description: {
                    Text(model.rootPath)
                } actions: {
                    Button(T("action.analyze")) { model.scan() }.buttonStyle(.borderedProminent)
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
                Picker(T("view.picker"), selection: $tab) {
                    ForEach(Tab.allCases) { t in Label(t.title, systemImage: t.icon).tag(t) }
                }
                .pickerStyle(.segmented)
                .disabled(model.root == nil || model.isScanning)
            }
            ToolbarItemGroup(placement: .primaryAction) {
                Button { model.chooseFolder() } label: { Label(T("action.choose_folder"), systemImage: "folder.badge.gearshape") }
                    .help(T("action.choose_folder.help"))
                if model.isScanning {
                    Button { model.cancel() } label: { Label(T("action.stop"), systemImage: "stop.circle") }
                } else {
                    Button { model.scan() } label: { Label(T("action.analyze"), systemImage: "arrow.clockwise") }
                        .keyboardShortcut("r")
                        .help(T("action.rescan.help"))
                }
            }
        }
        .navigationTitle(T("app.title", (model.rootPath as NSString).lastPathComponent))
        .overlay {
            if model.isDeleting {
                ProgressView(T("deleting"))
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
                StatCard(title: T("stat.total"), value: Fmt.bytes(root.size),
                         detail: T("stat.files", Fmt.count(root.fileCount)), color: .primary)
                StatCard(title: T("stat.regenerable"), value: Fmt.bytes(root.regenerableBytes),
                         detail: T("stat.of_total", Fmt.percent(root.regenerableBytes, of: root.size)),
                         color: Category.deps.color)
                StatCard(title: Category.git.label, value: Fmt.bytes(root.bytes(.git)),
                         detail: T("stat.of_total", Fmt.percent(root.bytes(.git), of: root.size)),
                         color: Category.git.color)
                StatCard(title: Category.source.label, value: Fmt.bytes(root.bytes(.source)),
                         detail: T("stat.of_total", Fmt.percent(root.bytes(.source), of: root.size)),
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
                Text(T("volume.free_of", Fmt.bytes(free), Fmt.bytes(volume.total)))
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
                LegendDot(color: Category.deps.color, text: T("volume.scanned", Fmt.bytes(scanned)))
                LegendDot(color: .gray.opacity(0.55), text: T("volume.other", Fmt.bytes(other)))
            }
            .font(.caption)
            Text(T("volume.note", Fmt.bytes(volume.availableImportant)))
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
