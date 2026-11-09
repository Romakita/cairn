import AppKit
import CairnCore
import SwiftUI

struct ToolRow: Identifiable {
    let entry: InventoryEntry
    var id: String { entry.id }
    var name: String { entry.name }
    var source: String { entry.tool?.source.rawValue ?? "" }
    var version: String { entry.tool?.version ?? "" }
    var status: String { entry.status.rawValue }
}

/// Inventaire des outils CLI : statut, choix de l'utilisateur (mémorisé dans config.toml) et export.
struct ToolsView: View {
    @EnvironmentObject var model: AppModel
    @ViewState private var filter: InventoryEntry.Status?
    @ViewState private var search = ""
    @ViewState private var sortOrder = [KeyPathComparator(\ToolRow.status), KeyPathComparator(\ToolRow.name)]

    var body: some View {
        VStack(spacing: 0) {
            PillPicker(options: [(InventoryEntry.Status?.none, T("inventory.filter.all")),
                                 (.used, T("inventory.status.used")), (.unused, T("inventory.status.unused")),
                                 (.missing, T("inventory.status.missing"))], selection: $filter)
                .frame(height: 64)
            if let inv = model.inventory {
                content(inv)
            } else {
                VStack(spacing: 12) {
                    ProgressView()
                    Text(T("inventory.collecting")).foregroundStyle(Palette.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .onAppear { if model.inventory == nil { model.refreshInventory() } }
    }

    func content(_ inv: Inventory) -> some View {
        let excluded = Set(model.config?.excludedTools ?? [])
        let rows = inv.entries
            .filter { filter == nil || $0.status == filter }
            .filter { search.isEmpty || $0.name.localizedCaseInsensitiveContains(search) }
            .map { e -> ToolRow in var e = e; e.excluded = excluded.contains(e.name); return ToolRow(entry: e) }
            .sorted(using: sortOrder)
        let kept = inv.entries.filter { $0.tool != nil && !excluded.contains($0.name) }.count
        return VStack(spacing: 12) {
            HStack {
                TextField(T("list.filter"), text: $search).cairnField(icon: "magnifyingglass").frame(width: 260)
                Text(T("inventory.apps_note")).font(.system(size: 12.5)).foregroundStyle(Palette.secondary)
                Spacer()
            }
            Table(rows, sortOrder: $sortOrder) {
                TableColumn(T("col.keep")) { r in
                    if r.entry.tool != nil {
                        Toggle("", isOn: Binding(get: { !r.entry.excluded }, set: { model.setToolExcluded(r.name, excluded: !$0) }))
                            .labelsHidden().toggleStyle(.checkbox)
                    }
                }
                .width(40)
                TableColumn(T("col.tool"), value: \.name) { r in
                    Text(r.name).font(.system(size: 13, design: .monospaced))
                }
                TableColumn(T("col.source"), value: \.source) { r in
                    Text(r.entry.tool.map { T("source.\($0.source.rawValue)") } ?? "—").foregroundStyle(Palette.tertiary)
                }
                .width(min: 90, ideal: 110)
                TableColumn(T("col.version"), value: \.version) { r in
                    Text(r.version).font(.system(size: 12.5, design: .monospaced)).foregroundStyle(Palette.secondary)
                }
                .width(min: 70, ideal: 90)
                TableColumn(T("col.why")) { r in
                    Text(r.entry.reasonTexts.joined(separator: ", ")).foregroundStyle(Palette.secondary).lineLimit(1).help(r.entry.reasonTexts.joined(separator: "\n"))
                }
                TableColumn(T("col.status"), value: \.status) { r in
                    let tone: Palette.Tone = switch r.entry.status { case .used: .success; case .unused: .neutral; case .missing: .danger }
                    Badge(text: T("inventory.badge.\(r.entry.status.rawValue)"), tone: tone)
                }
                .width(min: 90, ideal: 110)
            }
            .clipShape(RoundedRectangle(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(Palette.border))
            HStack(spacing: 12) {
                Text(T("inventory.retained", kept, inv.entries.filter { $0.tool != nil }.count)).fontWeight(.semibold)
                Text(T("inventory.export_note")).font(.system(size: 12.5)).foregroundStyle(Palette.secondary)
                Spacer()
                Button(T("inventory.refresh")) { model.refreshInventory() }.buttonStyle(.pill)
                Button(T("inventory.export")) { model.exportInventory() }.buttonStyle(.pillPrimary)
            }
        }
        .padding(.horizontal, 32).padding(.bottom, 24)
    }
}

extension AppModel {
    func refreshInventory() {
        inventory = nil
        let config = self.config ?? CairnConfig()
        Task.detached(priority: .userInitiated) {
            let inv = InventoryCollector.collect(config: config)
            await MainActor.run { self.inventory = inv }
        }
    }

    /// Outil coché/décoché : mémorisé dans `[tools].excluded` et réappliqué aux inventaires suivants.
    func setToolExcluded(_ name: String, excluded: Bool) {
        updateConfig { c in
            c.excludedTools.removeAll { $0 == name }
            if excluded { c.excludedTools.append(name) }
        }
    }

    func exportInventory() {
        guard var inv = inventory else { return }
        let excluded = Set(config?.excludedTools ?? [])
        for i in inv.entries.indices { inv.entries[i].excluded = excluded.contains(inv.entries[i].name) }
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        panel.prompt = T("inventory.export")
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do {
            try InventoryExport.write(inv, to: url)
            lastMessage = T("inventory.exported", inv.retained.count, url.path)
        } catch {
            lastMessage = String(describing: error)
        }
    }
}
