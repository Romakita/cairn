import CairnCore
import SwiftUI

/// Outils IA : catégories sauvegardées par outil (config.toml), tailles, ce qui n'est jamais copié.
struct AIToolsView: View {
    @EnvironmentObject var model: AppModel
    @ViewState private var pendingCredentials: String?

    var body: some View {
        let unencrypted = model.config?.destinations.contains { !$0.encrypted } ?? false
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text(AppSection.ai.title).font(.system(size: 26, weight: .medium)).padding(.top, 20)
                Banner(icon: unencrypted ? "lock.open" : "lock", text: T(unencrypted ? "ai.banner.unencrypted" : "ai.banner.encrypted"),
                       tone: unencrypted ? .warning : .info)
                if let stats = model.aiStats {
                    LazyVGrid(columns: [GridItem(.flexible(), spacing: 14), GridItem(.flexible(), spacing: 14), GridItem(.flexible())], spacing: 14) {
                        ForEach(stats, id: \.profile.id) { s in card(s, unencrypted: unencrypted) }
                    }
                } else {
                    HStack { ProgressView().controlSize(.small); Text(T("ai.measuring")).foregroundStyle(Palette.secondary) }
                }
                HStack {
                    Text(T("ai.sqlite_note")).font(.system(size: 12.5)).foregroundStyle(Palette.secondary)
                    Spacer()
                    Button(T("backup.simulate")) { model.backups.run(destinations: nil, dryRun: true, only: [.ai]) }.buttonStyle(.pill)
                    Button(T("ai.backup_now")) { model.backups.run(destinations: nil, dryRun: false, only: [.ai]) }
                        .buttonStyle(.pillPrimary).disabled(model.isBackingUp || (model.config?.destinations.isEmpty ?? true))
                }
            }
            .padding(.horizontal, 32).padding(.bottom, 24)
        }
        .onAppear { if model.aiStats == nil { model.refreshAIStats() } }
        .confirmationDialog(T("ai.credentials.confirm"), isPresented: Binding(get: { pendingCredentials != nil }, set: { if !$0 { pendingCredentials = nil } }),
                            titleVisibility: .visible) {
            Button(T("ai.credentials.include"), role: .destructive) {
                if let id = pendingCredentials { model.setAICategory(id, "credentials", on: true) }
                pendingCredentials = nil
            }
            Button(T("action.cancel"), role: .cancel) { pendingCredentials = nil }
        } message: { Text(T("onboarding.destination.unencrypted_warning")) }
    }

    func card(_ s: AIBackup.ToolStats, unencrypted: Bool) -> some View {
        let selected = model.config?.ai.first { $0.id == s.profile.id }?.categories ?? []
        return Card {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Text(T("ai.\(s.profile.id)")).font(.system(size: 15, weight: .semibold))
                    Spacer()
                    if s.detected { Text(Fmt.bytes(s.totalBytes)).fontWeight(.semibold) }
                    else { Badge(text: T("onboarding.ai.not_detected")) }
                }
                Text(s.profile.root).font(.system(size: 12, design: .monospaced)).foregroundStyle(Palette.secondary)
                if s.detected {
                    if s.conversations > 0 {
                        Text(T("cli.ai.conversations", s.conversations, s.latestConversation.map(Fmt.date) ?? "—"))
                            .font(.system(size: 12.5)).foregroundStyle(Palette.secondary)
                    }
                    Divider()
                    ForEach(CairnConfig.AITool.categories.filter { !(s.profile.categories[$0] ?? []).isEmpty }, id: \.self) { cat in
                        HStack {
                            Toggle(T("ai.category.\(cat)"), isOn: Binding(get: { selected.contains(cat) }, set: { on in
                                if on && cat == "credentials" && unencrypted { pendingCredentials = s.profile.id }
                                else { model.setAICategory(s.profile.id, cat, on: on) }
                            }))
                            .toggleStyle(.checkbox)
                            Spacer()
                            Text(Fmt.bytes(s.bytesByCategory[cat] ?? 0)).font(.system(size: 12.5)).monospacedDigit().foregroundStyle(Palette.secondary)
                        }
                    }
                    if s.profile.credentialsInKeychain {
                        Text(T("cli.ai.keychain")).font(.system(size: 12)).foregroundStyle(Palette.foreground(.warning))
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    if s.notCopiedBytes > 0 {
                        Divider()
                        Text(T("cli.ai.not_copied", Fmt.bytes(s.notCopiedBytes))).font(.system(size: 12.5)).foregroundStyle(Palette.secondary)
                    }
                    Text(T("ai.excluded", s.profile.exclude.prefix(4).joined(separator: ", "))).font(.system(size: 12)).foregroundStyle(Palette.secondary)
                }
            }
        }
    }
}

extension AppModel {
    func refreshAIStats() {
        Task.detached(priority: .utility) {
            let stats = AIProfiles.bundled.map { AIBackup.stats($0) }
            await MainActor.run { self.aiStats = stats }
        }
    }

    func setAICategory(_ id: String, _ cat: String, on: Bool) {
        updateConfig { c in
            if let i = c.ai.firstIndex(where: { $0.id == id }) {
                var cats = Set(c.ai[i].categories)
                if on { cats.insert(cat) } else { cats.remove(cat) }
                c.ai[i].categories = CairnConfig.AITool.categories.filter(cats.contains)
            } else if on {
                c.ai.append(.init(id: id, categories: [cat]))
            }
        }
    }
}
