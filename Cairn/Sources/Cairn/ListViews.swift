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
        if let root = model.root { content(root) }
    }

    func content(_ root: Node) -> some View {
        let all = model.regenerableNodes().map { CleanRow(node: $0, relPath: $0.relativePath(to: root)) }
        let rows = all
            .filter { filter == nil || $0.node.category == filter }
            .filter { search.isEmpty || $0.relPath.localizedCaseInsensitiveContains(search) }
            .sorted(using: sortOrder)
        let selectedNodes = rows.filter { selection.contains($0.id) }.map(\.node)
        let selectedSize = selectedNodes.reduce(Int64(0)) { $0 + $1.size }

        return VStack(spacing: 0) {
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
                TextField(T("list.filter_path"), text: $search).cairnField(icon: "magnifyingglass").frame(width: 220)
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
                // La corbeille (réversible) est l'action mise en avant ; la suppression définitive reste secondaire.
                Button(T("action.delete_ellipsis"), role: .destructive) {
                    pending = PendingDeletion(nodes: selectedNodes, permanently: true)
                }
                .buttonStyle(.pill)
                .disabled(selectedNodes.isEmpty)
                Button(T("action.trash_ellipsis")) { pending = PendingDeletion(nodes: selectedNodes, permanently: false) }
                    .disabled(selectedNodes.isEmpty)
                    .buttonStyle(.pillPrimary)
            }
            .padding(10)
        }
        .deletionConfirmation($pending, model: model)
        .onAppear { applyPreselection(all) }
        .onChange(of: model.pendingCleanupPreselection) { _, _ in applyPreselection(all) }
    }

    /// Arrivée depuis une alerte ou le panneau : les plus gros dossiers régénérables sont cochés (sans rien supprimer).
    private func applyPreselection(_ all: [CleanRow]) {
        guard model.pendingCleanupPreselection else { return }
        model.pendingCleanupPreselection = false
        filter = nil
        search = ""
        selection = Set(CleanupSuggestion.preselect(all.map(\.node)).map(\.path))
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

// MARK: - Projets

struct ProjectRow: Identifiable {
    let project: Project
    let relPath: String
    var id: String { project.path }
    var size: Int64 { project.totalSize }
    var source: Int64 { project.source }
    var git: Int64 { project.git }
    var regen: Int64 { project.regenerable }
    var worktrees: Int64 { project.worktreeBytes }
}

struct ReposView: View {
    @EnvironmentObject var model: AppModel
    let root: Node
    @ViewState private var sortOrder = [KeyPathComparator(\ProjectRow.size, order: .reverse)]
    @ViewState private var selection: String?
    @ViewState private var search = ""

    var body: some View {
        let rows = model.projects.map { ProjectRow(project: $0, relPath: Self.relative($0.path, root.path)) }
            .filter { search.isEmpty || $0.relPath.localizedCaseInsensitiveContains(search) }
            .sorted(using: sortOrder)
        let maxSize = rows.map(\.size).max() ?? 1
        VStack(spacing: 0) {
            HStack {
                Text(T("projects.count", rows.count)).foregroundStyle(.secondary)
                Spacer()
                if let p = selection, let project = model.projects.first(where: { $0.path == p }),
                   project.isGitRepo || !project.worktrees.isEmpty {
                    Button(T("action.git_maintenance")) { model.openGitMaintenance(repo: project.path) }
                }
                TextField(T("list.filter"), text: $search).cairnField(icon: "magnifyingglass").frame(width: 220)
            }
            .padding(10)
            Divider()
            Table(rows, selection: $selection, sortOrder: $sortOrder) {
                TableColumn(T("col.repo"), value: \.relPath) { r in
                    HStack(spacing: 6) {
                        Icon(r.project.isGitRepo ? "arrow.triangle.branch" : "folder", size: 16)
                            .foregroundStyle(Palette.secondary)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(r.project.name).lineLimit(1)
                            Text((r.relPath as NSString).deletingLastPathComponent).font(.caption2)
                                .foregroundStyle(.secondary).lineLimit(1).truncationMode(.head)
                        }
                        .help(r.project.path)
                    }
                }
                TableColumn(T("col.breakdown")) { r in
                    ProjectBar(row: r, scale: maxSize).frame(height: 10)
                }
                .width(min: 120, ideal: 160)
                TableColumn(T("col.sources"), value: \.source) { r in sizeCell(r.source) }.width(min: 70, ideal: 90)
                TableColumn(T("col.git"), value: \.git) { r in sizeCell(r.git) }.width(min: 70, ideal: 90)
                TableColumn(T("col.regenerable"), value: \.regen) { r in sizeCell(r.regen) }.width(min: 80, ideal: 100)
                TableColumn(T("col.worktrees"), value: \.worktrees) { r in
                    if r.project.worktrees.isEmpty { Text(verbatim: "—").foregroundStyle(.tertiary) }
                    else { Text(T("projects.worktrees", r.project.worktrees.count, Fmt.bytes(r.worktrees))).monospacedDigit() }
                }
                .width(min: 110, ideal: 140)
                TableColumn(T("col.total"), value: \.size) { r in sizeCell(r.size).fontWeight(.semibold) }.width(min: 70, ideal: 90)
            }
            .contextMenu(forSelectionType: String.self) { ids in
                if let p = ids.first {
                    Button(T("action.open_in_explorer")) { if let n = model.node(at: p) { model.analysisTab = .explorer; model.open(n) } }
                    if let project = model.projects.first(where: { $0.path == p }), project.isGitRepo || !project.worktrees.isEmpty {
                        Button(T("action.git_maintenance")) { model.openGitMaintenance(repo: project.path) }
                    }
                    Button(T("action.reveal")) { model.reveal(p) }
                    Button(T("action.copy_path")) { model.copyPath(p) }
                }
            } primaryAction: { ids in
                if let p = ids.first { model.reveal(p) }
            }
        }
    }

    static func relative(_ p: String, _ root: String) -> String {
        p.hasPrefix(root + "/") ? String(p.dropFirst(root.count + 1)) : p
    }

    private func sizeCell(_ b: Int64) -> Text { Text(Fmt.bytes(b)).monospacedDigit() }
}

/// Barre sources / .git / régénérable / worktrees d'un projet.
struct ProjectBar: View {
    let row: ProjectRow
    let scale: Int64
    var body: some View {
        GeometryReader { g in
            let w = g.size.width * CGFloat(Double(row.size) / Double(max(scale, 1)))
            // Les worktrees situés dans le dépôt sont déjà comptés dans sa taille : seuls ceux d'à côté s'ajoutent.
            let inside = row.project.size
            let outside = row.size - inside
            let parts: [(Int64, Color)] = [(max(inside - row.git - row.regen, 0), Category.source.color),
                                           (row.git, Category.git.color), (row.regen, Category.deps.color),
                                           (outside, Category.ios.color)]
            HStack(spacing: 0) {
                ForEach(parts.indices, id: \.self) { i in
                    Rectangle().fill(parts[i].1).frame(width: w * CGFloat(Double(parts[i].0) / Double(max(row.size, 1))))
                }
            }
            .frame(width: max(w, 1), alignment: .leading)
            .clipShape(RoundedRectangle(cornerRadius: 3))
        }
    }
}

// MARK: - Gros objets

struct BigFilesView: View {
    @EnvironmentObject var model: AppModel
    let root: Node
    @ViewState private var sortOrder = [KeyPathComparator(\BigObject.size, order: .reverse)]
    @ViewState private var selection: String?

    var body: some View {
        let objects = model.bigObjects.sorted(using: sortOrder)
        let c = model.config?.analysis ?? CairnConfig.Analysis()
        VStack(spacing: 0) {
            HStack {
                Text(T("big_objects.summary", objects.filter { $0.kind == .file }.count, Fmt.bytes(Int64(c.bigFileThresholdMB) * 1_000_000),
                       objects.filter { $0.kind == .folder }.count, Fmt.bytes(Int64(c.bigFolderThresholdGB * 1_000_000_000))))
                    .foregroundStyle(.secondary)
                Spacer()
            }
            .padding(10)
            Divider()
            Table(objects, selection: $selection, sortOrder: $sortOrder) {
                TableColumn(T("col.name"), value: \.name) { o in
                    Label { Text(o.name) } icon: { Icon(o.kind == .file ? "doc" : "folder", size: 15) }.lineLimit(1)
                }
                .width(min: 160, ideal: 240)
                TableColumn(T("col.kind"), value: \.kind.rawValue) { o in
                    Text(T("kind.\(o.kind.rawValue)")).foregroundStyle(.secondary)
                }
                .width(min: 60, ideal: 80, max: 100)
                TableColumn(T("col.location"), value: \.path) { o in
                    Text(relative((o.path as NSString).deletingLastPathComponent))
                        .lineLimit(1).truncationMode(.head).foregroundStyle(.secondary).help(o.path)
                }
                TableColumn(T("col.in")) { o in
                    if o.category != .source { CategoryTag(category: o.category).fixedSize() }
                }
                .width(min: 80, ideal: 110, max: 130)
                TableColumn(T("col.size"), value: \.size) { o in Text(Fmt.bytes(o.size)).monospacedDigit() }
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
