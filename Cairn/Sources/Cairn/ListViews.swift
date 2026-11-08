import CairnCore
import SwiftUI

// MARK: - Nettoyable

struct CleanRow: Identifiable {
    let node: Node
    let relPath: String
    var id: String { node.path }
    var size: Int64 { node.size }
    var categoryName: String { node.category.shortLabel }
    var files: Int { node.fileCount }
}

struct CleanableView: View {
    @EnvironmentObject var model: AppModel
    @ViewState private var filter: Category?
    @ViewState private var search = ""
    @ViewState private var selection = Set<String>()
    @ViewState private var sortOrder = [KeyPathComparator(\CleanRow.size, order: .reverse)]
    @ViewState private var pending: PendingDeletion?

    var body: some View {
        let root = model.root!
        let all = model.regenerableNodes().map { CleanRow(node: $0, relPath: $0.relativePath(to: root)) }
        let rows = all
            .filter { filter == nil || $0.node.category == filter }
            .filter { search.isEmpty || $0.relPath.localizedCaseInsensitiveContains(search) }
            .sorted(using: sortOrder)
        let selectedNodes = rows.filter { selection.contains($0.id) }.map(\.node)
        let selectedSize = selectedNodes.reduce(Int64(0)) { $0 + $1.size }

        VStack(spacing: 0) {
            HStack(spacing: 8) {
                FilterChip(title: T("list.all"), total: all.reduce(0) { $0 + $1.size }, color: .accentColor, active: filter == nil) {
                    filter = nil
                }
                ForEach(Category.allCases.filter(\.isRegenerable)) { c in
                    let t = all.filter { $0.node.category == c }.reduce(Int64(0)) { $0 + $1.size }
                    if t > 0 {
                        FilterChip(title: c.shortLabel, total: t, color: c.color, active: filter == c) { filter = c }
                    }
                }
                Spacer()
                TextField(T("list.filter_path"), text: $search).textFieldStyle(.roundedBorder).frame(width: 220)
            }
            .padding(10)
            Divider()

            Table(rows, selection: $selection, sortOrder: $sortOrder) {
                TableColumn(T("col.type"), value: \.categoryName) { r in CategoryTag(category: r.node.category) }
                    .width(min: 90, ideal: 110, max: 140)
                TableColumn(T("col.path"), value: \.relPath) { r in
                    Text(r.relPath).lineLimit(1).truncationMode(.head).help(r.node.path)
                }
                TableColumn(T("col.files"), value: \.files) { r in
                    Text(Fmt.count(r.files)).monospacedDigit().foregroundStyle(.secondary)
                }
                .width(min: 70, ideal: 90, max: 110)
                TableColumn(T("col.size"), value: \.size) { r in
                    Text(Fmt.bytes(r.size)).monospacedDigit().frame(maxWidth: .infinity, alignment: .trailing)
                }
                .width(min: 80, ideal: 100, max: 130)
            }
            .contextMenu(forSelectionType: String.self) { ids in
                if ids.count == 1, let p = ids.first {
                    Button(T("action.reveal")) { model.reveal(p) }
                    Button(T("action.copy_path")) { model.copyPath(p) }
                }
            } primaryAction: { ids in
                if let p = ids.first { model.reveal(p) }
            }

            Divider()
            HStack {
                Button(T("action.select_all")) { selection = Set(rows.map(\.id)) }
                Button(T("action.deselect")) { selection = [] }.disabled(selection.isEmpty)
                Text(selection.isEmpty
                     ? T("list.folders_total", rows.count, Fmt.bytes(rows.reduce(0) { $0 + $1.size }))
                     : T("list.selected_total", selectedNodes.count, Fmt.bytes(selectedSize)))
                    .foregroundStyle(.secondary).monospacedDigit()
                Spacer()
                Button(T("action.trash_ellipsis")) { pending = PendingDeletion(nodes: selectedNodes, permanently: false) }
                    .disabled(selectedNodes.isEmpty)
                Button(T("action.delete_ellipsis"), role: .destructive) {
                    pending = PendingDeletion(nodes: selectedNodes, permanently: true)
                }
                .disabled(selectedNodes.isEmpty)
                .buttonStyle(.borderedProminent).tint(.red)
            }
            .padding(10)
        }
        .deletionConfirmation($pending, model: model)
    }
}

struct FilterChip: View {
    let title: String
    let total: Int64
    let color: Color
    let active: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 5) {
                Circle().fill(color).frame(width: 8, height: 8)
                Text(title)
                Text(Fmt.bytes(total)).foregroundStyle(.secondary).monospacedDigit()
            }
            .font(.callout)
            .padding(.horizontal, 10).padding(.vertical, 4)
            .background(active ? color.opacity(0.22) : Color.gray.opacity(0.1), in: Capsule())
            .overlay(Capsule().stroke(active ? color : .clear, lineWidth: 1))
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Dépôts git

struct RepoRow: Identifiable {
    let node: Node
    let relPath: String
    var id: String { node.path }
    var size: Int64 { node.size }
    var source: Int64 { node.bytes(.source) }
    var git: Int64 { node.bytes(.git) }
    var regen: Int64 { node.regenerableBytes }
}

struct ReposView: View {
    @EnvironmentObject var model: AppModel
    let root: Node
    @ViewState private var sortOrder = [KeyPathComparator(\RepoRow.size, order: .reverse)]
    @ViewState private var selection: String?
    @ViewState private var search = ""

    var body: some View {
        let rows = model.gitRepos().map { RepoRow(node: $0, relPath: $0.relativePath(to: root)) }
            .filter { search.isEmpty || $0.relPath.localizedCaseInsensitiveContains(search) }
            .sorted(using: sortOrder)
        VStack(spacing: 0) {
            HStack {
                Text(T("list.repos", rows.count)).foregroundStyle(.secondary)
                Spacer()
                TextField(T("list.filter"), text: $search).textFieldStyle(.roundedBorder).frame(width: 220)
            }
            .padding(10)
            Divider()
            Table(rows, selection: $selection, sortOrder: $sortOrder) {
                TableColumn(T("col.repo"), value: \.relPath) { r in
                    Text(r.relPath).lineLimit(1).truncationMode(.head).help(r.node.path)
                }
                TableColumn(T("col.breakdown")) { r in
                    BreakdownBar(node: r.node, scale: rows.map(\.size).max() ?? 1)
                }
                .width(min: 120, ideal: 160)
                TableColumn(T("col.sources"), value: \.source) { r in sizeCell(r.source) }.width(min: 70, ideal: 90)
                TableColumn(T("col.git"), value: \.git) { r in sizeCell(r.git) }.width(min: 70, ideal: 90)
                TableColumn(T("col.regenerable"), value: \.regen) { r in sizeCell(r.regen) }.width(min: 80, ideal: 100)
                TableColumn(T("col.total"), value: \.size) { r in sizeCell(r.size).fontWeight(.semibold) }.width(min: 70, ideal: 90)
            }
            .contextMenu(forSelectionType: String.self) { ids in
                if let p = ids.first, let n = rows.first(where: { $0.id == p })?.node {
                    Button(T("action.open_in_explorer")) { model.open(n) }
                    Button(T("action.reveal")) { model.reveal(p) }
                    Button(T("action.copy_path")) { model.copyPath(p) }
                }
            } primaryAction: { ids in
                if let p = ids.first { model.reveal(p) }
            }
        }
    }

    private func sizeCell(_ b: Int64) -> Text {
        Text(Fmt.bytes(b)).monospacedDigit()
    }
}

// MARK: - Gros fichiers

struct BigFilesView: View {
    @EnvironmentObject var model: AppModel
    let root: Node
    @ViewState private var sortOrder = [KeyPathComparator(\BigFile.size, order: .reverse)]
    @ViewState private var selection: String?

    var body: some View {
        let files = (model.result?.bigFiles ?? []).sorted(using: sortOrder)
        VStack(spacing: 0) {
            HStack {
                Text(T("list.big_files", files.count, Fmt.bytes(Scanner.bigFileThreshold), Fmt.bytes(files.reduce(0) { $0 + $1.size })))
                    .foregroundStyle(.secondary)
                Spacer()
            }
            .padding(10)
            Divider()
            Table(files, selection: $selection, sortOrder: $sortOrder) {
                TableColumn(T("col.name"), value: \.name) { f in
                    Label(f.name, systemImage: "doc").lineLimit(1)
                }
                .width(min: 160, ideal: 240)
                TableColumn(T("col.location"), value: \.path) { f in
                    Text(relative((f.path as NSString).deletingLastPathComponent))
                        .lineLimit(1).truncationMode(.head).foregroundStyle(.secondary).help(f.path)
                }
                TableColumn(T("col.in")) { f in
                    if f.category != .source { CategoryTag(category: f.category) }
                }
                .width(min: 80, ideal: 100, max: 120)
                TableColumn(T("col.size"), value: \.size) { f in Text(Fmt.bytes(f.size)).monospacedDigit() }
                    .width(min: 70, ideal: 90)
            }
            .contextMenu(forSelectionType: String.self) { ids in
                if let p = ids.first {
                    Button(T("action.reveal")) { model.reveal(p) }
                    Button(T("action.copy_path")) { model.copyPath(p) }
                }
            } primaryAction: { ids in
                if let p = ids.first { model.reveal(p) }
            }
        }
    }

    private func relative(_ p: String) -> String {
        p.hasPrefix(root.path + "/") ? String(p.dropFirst(root.path.count + 1)) : (p == root.path ? "/" : p)
    }
}
