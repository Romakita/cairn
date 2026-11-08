import CairnCore
import SwiftUI

struct PendingDeletion: Identifiable {
    let id = UUID()
    let nodes: [Node]
    let permanently: Bool
    var total: Int64 { nodes.reduce(0) { $0 + $1.size } }
}

extension View {
    func deletionConfirmation(_ pending: Binding<PendingDeletion?>, model: AppModel) -> some View {
        confirmationDialog(
            pending.wrappedValue.map { p in
                p.permanently
                    ? T("confirm.delete.title", p.nodes.count, Fmt.bytes(p.total))
                    : T("confirm.trash.title", p.nodes.count, Fmt.bytes(p.total))
            } ?? "",
            isPresented: Binding(get: { pending.wrappedValue != nil }, set: { if !$0 { pending.wrappedValue = nil } }),
            titleVisibility: .visible,
            presenting: pending.wrappedValue
        ) { p in
            Button(p.permanently ? T("action.delete") : T("action.trash"), role: .destructive) {
                model.remove(p.nodes, permanently: p.permanently)
            }
            Button(T("action.cancel"), role: .cancel) {}
        } message: { p in
            let names = p.nodes.prefix(6).map { $0.path }.joined(separator: "\n")
            let more = p.nodes.count > 6 ? "\n" + T("confirm.more", p.nodes.count - 6) : ""
            Text(names + more + (p.permanently
                ? "\n\n" + T("confirm.irreversible")
                : "\n\n" + T("confirm.trash_note")))
        }
    }
}

struct ExplorerView: View {
    @EnvironmentObject var model: AppModel
    @ViewState private var selection = Set<String>()
    @ViewState private var pending: PendingDeletion?

    var body: some View {
        if let current = model.current, let root = model.root {
            let children = current.children
            let scale = children.first?.size ?? 1
            let selected = children.filter { selection.contains($0.id) }

            VStack(spacing: 0) {
                Breadcrumb()
                Divider()
                HSplitView {
                    List(selection: $selection) {
                        ForEach(children) { n in
                            NodeRow(node: n, parentSize: current.size, scale: scale)
                                .tag(n.id)
                        }
                        if current.ownBytes > 0 {
                            OwnFilesRow(node: current, scale: scale)
                                .selectionDisabled()
                        }
                    }
                    .listStyle(.inset(alternatesRowBackgrounds: true))
                    .contextMenu(forSelectionType: String.self) { ids in
                        let nodes = children.filter { ids.contains($0.id) }
                        if nodes.count == 1, let n = nodes.first {
                            if n.isDirectory && n.category == .source { Button(T("action.open")) { model.open(n) } }
                            Button(T("action.reveal")) { model.reveal(n.path) }
                            Button(T("action.copy_path")) { model.copyPath(n.path) }
                            Divider()
                        }
                        if !nodes.isEmpty {
                            Button(T("action.trash_ellipsis")) { pending = PendingDeletion(nodes: nodes, permanently: false) }
                            Button(T("action.delete_ellipsis"), role: .destructive) {
                                pending = PendingDeletion(nodes: nodes, permanently: true)
                            }
                        }
                    } primaryAction: { ids in
                        if let n = children.first(where: { ids.contains($0.id) }) {
                            if n.isDirectory && n.category == .source { model.open(n) } else { model.reveal(n.path) }
                            selection = []
                        }
                    }
                    .frame(minWidth: 520)

                    ScrollView {
                        VStack(alignment: .leading, spacing: 14) {
                            let focus = selected.count == 1 ? selected[0] : current
                            Text(focus === root ? focus.path : focus.relativePath(to: root))
                                .font(.headline).lineLimit(2).truncationMode(.middle)
                            if focus.category != .source { CategoryTag(category: focus.category) }
                            BreakdownChart(node: focus)
                            if focus.regenerableBytes > 0 && focus.category == .source {
                                Text(T("explorer.regenerable_hint", Fmt.bytes(focus.regenerableBytes)))
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                            HStack {
                                Button(T("action.reveal")) { model.reveal(focus.path) }
                                if selected.count >= 1 {
                                    Button(T("action.trash_short")) { pending = PendingDeletion(nodes: selected, permanently: false) }
                                }
                            }
                        }
                        .padding(16)
                    }
                    .frame(minWidth: 280, idealWidth: 300, maxWidth: 340)
                }
            }
            .deletionConfirmation($pending, model: model)
            .onChange(of: model.path) { selection = [] }
        }
    }
}

struct Breadcrumb: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        HStack(spacing: 4) {
            Button { model.goTo(index: model.path.count - 2) } label: { Icon("chevron.left", size: 16) }
                .disabled(model.path.isEmpty)
                .keyboardShortcut(.upArrow, modifiers: .command)
                .help(T("explorer.parent"))
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 2) {
                    crumb(model.root?.path ?? "", index: -1, isLast: model.path.isEmpty)
                    ForEach(Array(model.path.enumerated()), id: \.offset) { i, n in
                        Icon("chevron.right", size: 11).foregroundStyle(.tertiary)
                        crumb(n.name, index: i, isLast: i == model.path.count - 1)
                    }
                }
            }
            Spacer()
            if let c = model.current {
                Text(T("explorer.items", c.children.count, Fmt.bytes(c.size))).font(.callout).foregroundStyle(.secondary)
                    .monospacedDigit()
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 7)
    }

    private func crumb(_ title: String, index: Int, isLast: Bool) -> some View {
        Button(title) { model.goTo(index: index) }
            .buttonStyle(.plain)
            .font(isLast ? .callout.weight(.semibold) : .callout)
            .foregroundStyle(isLast ? .primary : .secondary)
    }
}

struct NodeRow: View {
    let node: Node
    let parentSize: Int64
    let scale: Int64

    var body: some View {
        HStack(spacing: 10) {
            Icon(node.isDirectory ? (node.isGitRepo ? "folder.fill.badge.gearshape" : node.category.icon) : "doc", size: 16)
                .foregroundStyle(node.category == .source ? Color.accentColor : node.category.color)
                .frame(width: 18)
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 6) {
                    Text(node.name).lineLimit(1).truncationMode(.middle).layoutPriority(1)
                    if node.category != .source { CategoryTag(category: node.category).fixedSize() }
                    if node.isGitRepo { CategoryTag(category: .git).fixedSize().opacity(0.7).help(T("explorer.git_repo")) }
                }
                if node.isDirectory && node.category == .source && node.regenerableBytes > 0 {
                    Text(T("explorer.of_regenerable", Fmt.bytes(node.regenerableBytes)))
                        .font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            .frame(minWidth: 160, alignment: .leading)
            .layoutPriority(1)
            Spacer(minLength: 8)
            BreakdownBar(node: node, scale: scale).frame(minWidth: 60, idealWidth: 140, maxWidth: 140)
            Text(Fmt.bytes(node.size)).monospacedDigit().frame(width: 80, alignment: .trailing)
            Text(Fmt.percent(node.size, of: parentSize)).monospacedDigit().font(.caption)
                .foregroundStyle(.secondary).frame(width: 52, alignment: .trailing)
            Icon("chevron.right", size: 12).foregroundStyle(.tertiary)
                .opacity(node.isDirectory && node.category == .source ? 1 : 0)
        }
        .padding(.vertical, 2)
        .help(node.path)
    }
}

struct OwnFilesRow: View {
    let node: Node
    let scale: Int64

    var body: some View {
        HStack(spacing: 10) {
            Icon("doc.on.doc", size: 16).foregroundStyle(.secondary).frame(width: 18)
            Text(T("explorer.small_files", Fmt.count(node.ownFileCount))).foregroundStyle(.secondary)
            Spacer()
            GeometryReader { g in
                RoundedRectangle(cornerRadius: 3).fill(node.category.color.opacity(0.5))
                    .frame(width: max(1, g.size.width * CGFloat(Double(node.ownBytes) / Double(max(scale, 1)))))
            }
            .frame(width: 170, height: 10)
            Text(Fmt.bytes(node.ownBytes)).monospacedDigit().frame(width: 80, alignment: .trailing)
            Text(Fmt.percent(node.ownBytes, of: node.size)).monospacedDigit().font(.caption)
                .foregroundStyle(.secondary).frame(width: 52, alignment: .trailing)
            Icon("chevron.right", size: 16).opacity(0)
        }
        .padding(.vertical, 2)
    }
}
