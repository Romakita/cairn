import CairnCore
import SwiftUI

/// Sections de l'app (rail de gauche).
enum AppSection: String, CaseIterable, Identifiable {
    case home, analysis, backup, ai, cli, git, restore, settings
    var id: String { rawValue }

    var icon: String {
        switch self {
        case .home: "house"
        case .analysis: "chart.pie"
        case .backup: "icloud.and.arrow.up"
        case .ai: "sparkles"
        case .cli: "terminal"
        case .git: "arrow.triangle.branch"
        case .restore: "arrow.counterclockwise"
        case .settings: "slider.horizontal.3"
        }
    }

    var title: String { T("section.\(rawValue)") }
}

/// Racine : assistant de premier lancement ou fenêtre principale.
struct RootView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        Group {
            if model.showOnboarding {
                OnboardingView().background(Palette.content)
            } else {
                MainShell()
            }
        }
        .id(model.languageRevision)
        .frame(minWidth: 1100, minHeight: 720)
        .tint(Palette.accent)
        .ignoresSafeArea()
    }
}

/// Disposition principale : rail, barre latérale et contenu.
struct MainShell: View {
    @EnvironmentObject var model: AppModel
    @ViewState private var sidebarVisible = true

    var body: some View {
        // Comme Codex : cadre gris (barre du haut et rail), corps blanc arrondi et ombré qui flotte dedans.
        VStack(spacing: 0) {
            TopBar(sidebarVisible: $sidebarVisible, hasSidebar: model.hasSidebar)
            HStack(alignment: .top, spacing: 0) {
                Rail().zIndex(1) // les infobulles débordent sur le corps
                HStack(spacing: 0) {
                    if sidebarVisible && model.hasSidebar {
                        SidebarView()
                            .frame(width: 248)
                            .frame(maxHeight: .infinity)
                            .background(Palette.sidebar) // gris propre, distinct du cadre et du contenu
                            .overlay(alignment: .trailing) { Rectangle().fill(Palette.border).frame(width: 1) }
                            .transition(.move(edge: .leading).combined(with: .opacity))
                    }
                    VStack(spacing: 0) {
                        content
                        if let msg = model.lastMessage {
                            MessageBar(text: msg) { model.lastMessage = nil }
                        }
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
                .background(Palette.content)
                .clipShape(RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(Palette.border))
                .shadow(color: .black.opacity(0.10), radius: 10, y: 2)
                .padding(.trailing, 6).padding(.bottom, 6)
            }
        }
        // Cadre gris uni de Codex (#F3F3F3).
        .background(Palette.rail)
    }

    @ViewBuilder var content: some View {
        switch model.section {
        case .home: HomeView()
        case .analysis: AnalysisSection()
        case .settings: SettingsView()
        case .cli: ToolsView()
        case .git: GitView()
        case .backup: BackupView()
        case .ai: AIToolsView()
        case .restore: RestoreView()
        default: ComingSoonView(section: model.section)
        }
    }
}

/// Barre du haut : place des boutons de fenêtre, bascule de la barre latérale, logo de Cairn au centre.
struct TopBar: View {
    @Binding var sidebarVisible: Bool
    /// Section sans sous-menu : rien à afficher ni masquer.
    var hasSidebar = true

    var body: some View {
        ZStack {
            HStack(spacing: 10) {
                Color.clear.frame(width: 70) // boutons de fenêtre
                IconButton(systemName: "sidebar.left", label: T("shell.toggle_sidebar")) {
                    withAnimation(.snappy(duration: 0.25)) { sidebarVisible.toggle() }
                }
                .disabled(!hasSidebar)
                .opacity(hasSidebar ? 1 : 0.4)
                Spacer()
            }
            HStack(spacing: 8) {
                CairnLogo(size: 15, color: Palette.primaryButtonText)
                    .frame(width: 24, height: 24)
                    .background(Palette.primaryButton, in: Circle())
                Text(verbatim: "Cairn").font(.system(size: 14.5, weight: .semibold)).foregroundStyle(Palette.text)
            }
            .accessibilityElement(children: .combine)
        }
        .frame(height: 44)
    }
}

struct Rail: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        VStack(spacing: 6) {
            ForEach([AppSection.home, .analysis, .backup, .ai, .cli, .git, .restore]) { s in
                RailButton(icon: s.icon, label: s.title, selected: model.section == s) { model.section = s }
            }
            Spacer()
            UpdateButton(updates: model.updates)
            RailButton(icon: AppSection.settings.icon, label: AppSection.settings.title, selected: model.section == .settings) {
                model.section = .settings
            }
            StatusDot(status: model.globalStatus, backingUp: model.isBackingUp) { model.section = model.globalStatusSection }
        }
        .padding(.top, 8).padding(.bottom, 14)
        .frame(width: 56)
        .frame(maxHeight: .infinity)
    }
}

/// Pastille d'état global en bas du rail : un clic ouvre la section où se trouve la cause. Pendant une
/// sauvegarde (planifiée ou manuelle), elle tourne et mène à la page Sauvegarde.
struct StatusDot: View {
    let status: AppModel.GlobalStatus
    let backingUp: Bool
    let action: () -> Void
    var body: some View {
        let (icon, tone): (String, Palette.Tone) = switch status {
        case .ok: ("checkmark", .success)
        case .attention: ("exclamationmark.triangle", .warning)
        case .error: ("xmark", .danger)
        }
        let label = backingUp ? T("status.backing_up") : T("status.\(status.rawValue)")
        Button(action: action) {
            Group {
                if backingUp {
                    ProgressView().controlSize(.small)
                } else {
                    Icon(icon, size: 15).foregroundStyle(Palette.foreground(tone))
                }
            }
            .frame(width: 32, height: 32)
            .background(backingUp ? Palette.field : Palette.background(tone), in: Circle())
            .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .help(label)
        .accessibilityLabel(label)
    }
}

/// Bouton « Mise à jour disponible » du rail, comme dans Codex : visible seulement quand une release plus récente existe.
struct UpdateButton: View {
    @ObservedObject var updates: UpdateController

    var body: some View {
        if let r = updates.available {
            Button { updates.showPanel.toggle() } label: {
                Image(systemName: "arrow.down.to.line")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 30, height: 30)
                    .background(Palette.accent, in: Circle())
                    .frame(width: 40, height: 40)
                    .background(updates.showPanel ? Palette.railSelected : .clear, in: RoundedRectangle(cornerRadius: 10))
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(T("update.available"))
            .accessibilityLabel(T("update.available"))
            .popover(isPresented: $updates.showPanel, arrowEdge: .trailing) { UpdatePanel(updates: updates, release: r) }
        }
    }
}

/// Panneau de la mise à jour : versions, notes et actions.
struct UpdatePanel: View {
    @ObservedObject var updates: UpdateController
    let release: AppRelease

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(T("update.title", release.version)).font(.system(size: 15, weight: .semibold))
            Text(verbatim: "\(CairnVersion.current) → \(release.version)")
                .font(.system(size: 12.5, design: .monospaced)).foregroundStyle(Palette.secondary)
            if !release.notes.isEmpty {
                ScrollView {
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(Array(noteLines.enumerated()), id: \.offset) { _, l in
                            if l.heading {
                                Text(verbatim: l.text).font(.system(size: 12.5, weight: .semibold)).padding(.top, 4)
                            } else {
                                Text(LocalizedStringKey(l.text)).font(.system(size: 12.5))
                            }
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .textSelection(.enabled)
                }
                .frame(maxHeight: 220)
            }
            if case let .failed(msg) = updates.phase {
                Banner(icon: "exclamationmark.triangle", text: msg, tone: .danger)
            } else if let b = updates.blocker {
                Text(b).font(.system(size: 12)).foregroundStyle(Palette.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack {
                Button(T("update.later")) { updates.showPanel = false }.buttonStyle(.pill)
                Button(T("update.release_page")) { updates.openReleasePage() }.buttonStyle(.pill)
                Spacer()
                if updates.phase == .downloading {
                    ProgressView().controlSize(.small)
                    Text(T("update.downloading")).font(.system(size: 12)).foregroundStyle(Palette.secondary)
                } else {
                    Button(T("update.install")) { updates.install() }
                        .buttonStyle(.pillPrimary)
                        .disabled(updates.blocker != nil)
                }
            }
        }
        .padding(18)
        .frame(width: 400)
    }

    /// Notes du CHANGELOG : titres `#` en gras, puces `-` en `•`, liens et gras Markdown conservés.
    var noteLines: [(heading: Bool, text: String)] {
        release.notes.components(separatedBy: .newlines).compactMap { raw in
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.isEmpty || line == "---" { return nil }
            if line.hasPrefix("#") { return (true, line.drop { $0 == "#" }.trimmingCharacters(in: .whitespaces)) }
            if line.hasPrefix("- ") || line.hasPrefix("* ") { return (false, "• " + line.dropFirst(2)) }
            return (false, line)
        }
    }
}

/// Barre de message en bas de la zone de contenu.
struct MessageBar: View {
    let text: String
    let close: () -> Void
    var body: some View {
        HStack {
            Icon("info.circle", size: 16).foregroundStyle(Palette.secondary)
            Text(text).font(.callout).foregroundStyle(Palette.secondary).textSelection(.enabled)
            Spacer()
            Button(action: close) { Icon("xmark", size: 16) }
                .buttonStyle(.plain)
                .accessibilityLabel(T("action.close"))
        }
        .padding(.horizontal, 16).padding(.vertical, 8)
        .overlay(alignment: .top) { Rectangle().fill(Palette.border).frame(height: 1) }
    }
}

// MARK: - Barre latérale

extension AppModel {
    /// La section a un sous-menu à afficher (pas seulement son titre) ; sinon la barre latérale est masquée.
    var hasSidebar: Bool {
        switch section {
        case .home, .analysis, .settings, .backup: true
        case .cli: inventory != nil
        case .git, .ai, .restore: false
        }
    }
}

struct SidebarView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 2) {
                switch model.section {
                case .home: homeSidebar
                case .analysis: analysisSidebar
                case .settings: settingsSidebar
                case .cli: toolsSidebar
                case .backup: backupSidebar
                default: EmptyView() // masquée par `hasSidebar`
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 4)
        }
    }

    @ViewBuilder var homeSidebar: some View {
        Text(AppSection.home.title).font(.system(size: 17, weight: .semibold)).padding(.horizontal, 8).padding(.top, 8)
        foldersSection
        SidebarHeader(title: T("sidebar.destinations"))
        if let dests = model.config?.destinations, !dests.isEmpty {
            ForEach(dests, id: \.id) { d in
                SidebarRow(dot: Palette.secondary, title: d.id == OnboardingDraft.destinationID ? model.destinationLabel(d) : d.id,
                           meta: T("destination.not_checked")) { model.section = .backup }
            }
        } else {
            SidebarRow(icon: "plus", title: T("sidebar.add_destination")) { model.section = .settings }
        }
        if let root = model.root, !model.isScanning {
            SidebarHeader(title: T("sidebar.heaviest"))
            ForEach(root.children.filter(\.isDirectory).prefix(6)) { n in
                SidebarRow(icon: "folder", title: n.name, meta: Fmt.bytes(n.size)) {
                    model.section = .analysis
                    model.open(n)
                }
            }
        }
    }

    @ViewBuilder var foldersSection: some View {
        SidebarHeader(title: T("sidebar.folders"))
        ForEach(model.trackedFolders, id: \.path) { f in
            let size = model.analyses[f.expandedPath]?.result.root.size
            SidebarRow(icon: f.isAvailable ? "folder" : "externaldrive.badge.xmark",
                       title: (f.path as NSString).lastPathComponent,
                       meta: f.isAvailable ? size.map(Fmt.bytes) : T("folder.unavailable"),
                       selected: model.rootPath == f.expandedPath && model.section == .analysis) {
                guard f.isAvailable else { return }
                model.section = .analysis
                model.select(folder: f.expandedPath)
            }
        }
        if model.analyses.count > 1 {
            SidebarRow(icon: "sum", title: T("sidebar.total"), meta: Fmt.bytes(model.totalAnalyzed))
        }
    }

    @ViewBuilder var analysisSidebar: some View {
        Text(AppSection.analysis.title).font(.system(size: 17, weight: .semibold)).padding(.horizontal, 8).padding(.top, 8)
        foldersSection
        SidebarRow(icon: "plus", title: T("sidebar.add_folder")) { model.addFolder() }
        if let root = model.root, !model.isScanning {
            SidebarHeader(title: T("sidebar.by_type"))
            ForEach(Category.allCases.filter { root.bytes($0) > 0 }.sorted { root.bytes($0) > root.bytes($1) }) { c in
                SidebarRow(dot: c.color, title: c.shortLabel, meta: Fmt.bytes(root.bytes(c)))
            }
            Text(T("sidebar.files_count", Fmt.count(root.fileCount)))
                .font(.system(size: 12)).foregroundStyle(Palette.secondary).padding(8)
        }
    }

    @ViewBuilder var backupSidebar: some View {
        Text(AppSection.backup.title).font(.system(size: 17, weight: .semibold)).padding(.horizontal, 8).padding(.top, 8)
        SidebarHeader(title: T("sidebar.destinations"))
        ForEach(model.config?.destinations ?? [], id: \.id) { d in
            let probed = model.destinationWaiting[d.id]
            SidebarRow(dot: probed == nil ? Palette.secondary : (probed! ? .orange : Palette.foreground(.success)), title: model.destinationLabel(d),
                       meta: probed == nil ? T("destination.not_checked") : (probed! ? T("backup.badge.waiting") : T("backup.badge.reachable")),
                       selected: (model.selectedDestination ?? model.config?.destinations.first?.id) == d.id) {
                model.selectedDestination = d.id
            }
        }
        SidebarRow(icon: "plus", title: T("sidebar.add_destination")) { model.addDestination() }
        SidebarHeader(title: T("backup.content"))
        ForEach((model.config?.folders ?? []).filter(\.backup), id: \.path) { f in
            SidebarRow(icon: "folder", title: (f.path as NSString).lastPathComponent)
        }
        SidebarRow(icon: "house", title: T("settings.home"), meta: "\(model.config?.home.include.count ?? 0)")
        SidebarRow(icon: "sparkles", title: AppSection.ai.title, meta: "\(model.config?.ai.count ?? 0)")
        SidebarRow(icon: "terminal", title: AppSection.cli.title)
    }

    @ViewBuilder var toolsSidebar: some View {
        Text(AppSection.cli.title).font(.system(size: 17, weight: .semibold)).padding(.horizontal, 8).padding(.top, 8)
        if let inv = model.inventory {
            SidebarHeader(title: T("sidebar.sources"))
            let tools = inv.entries.compactMap(\.tool)
            ForEach(ToolSource.allCases.filter { s in tools.contains { $0.source == s } }, id: \.self) { s in
                SidebarRow(icon: "shippingbox", title: T("source.\(s.rawValue)"), meta: "\(tools.filter { $0.source == s }.count)")
            }
            SidebarHeader(title: T("sidebar.status"))
            SidebarRow(dot: Palette.foreground(.success), title: T("inventory.status.used"), meta: "\(inv.entries.filter { $0.status == .used }.count)")
            SidebarRow(dot: Palette.secondary, title: T("inventory.status.unused"), meta: "\(inv.entries.filter { $0.status == .unused }.count)")
            SidebarRow(dot: Palette.foreground(.danger), title: T("inventory.status.missing"), meta: "\(inv.entries.filter { $0.status == .missing }.count)")
        }
    }

    @ViewBuilder var settingsSidebar: some View {
        Text(AppSection.settings.title).font(.system(size: 17, weight: .semibold)).padding(.horizontal, 8).padding(.top, 8)
        SidebarHeader(title: T("settings.file"))
        SidebarRow(icon: "doc.text", title: "config.toml", meta: nil) { model.revealConfig() }
        Text(T("settings.file_hint"))
            .font(.system(size: 12)).foregroundStyle(Palette.secondary).padding(8)
            .fixedSize(horizontal: false, vertical: true)
    }
}

// Accueil : voir HomeView.swift.

// MARK: - Analyse

enum AnalysisTab: String, CaseIterable { case explorer, cleanable, projects, bigFiles }

struct AnalysisSection: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        VStack(spacing: 0) {
            PillPicker(options: [(AnalysisTab.explorer, T("tab.explorer")), (.cleanable, T("tab.cleanable")),
                                 (.projects, T("tab.projects")), (.bigFiles, T("tab.big_objects"))],
                       selection: $model.analysisTab)
                .frame(height: 64)
                .disabled(model.root == nil || model.isScanning)
            if model.isScanning {
                ScanningView()
            } else if let root = model.root {
                Group {
                    switch model.analysisTab {
                    case .explorer: ExplorerView()
                    case .cleanable: CleanableView()
                    case .projects: ReposView(root: root)
                    case .bigFiles: BigFilesView(root: root)
                    }
                }
                .id(model.revision)
            } else {
                VStack(spacing: 14) {
                    Icon("internaldrive", size: 39).foregroundStyle(Palette.secondary)
                    Text(T("empty.title")).font(.title3.weight(.semibold))
                    Text(model.rootPath).foregroundStyle(Palette.secondary)
                    Button(T("action.analyze")) { model.scan() }.buttonStyle(.pillPrimary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .overlay {
            if model.isDeleting {
                ProgressView(T("deleting"))
                    .padding(24)
                    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
            }
        }
    }
}

/// Section pas encore disponible dans cette version.
struct ComingSoonView: View {
    let section: AppSection
    var body: some View {
        VStack(spacing: 14) {
            Icon(section.icon, size: 39).foregroundStyle(Palette.secondary)
            Text(section.title).font(.system(size: 24, weight: .medium))
            Text(T("placeholder.soon")).foregroundStyle(Palette.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
