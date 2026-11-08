import AppKit
import CairnCore
import SwiftUI
import UniformTypeIdentifiers

enum GitTab: String { case repos, branches, worktrees }

struct BranchRow: Identifiable {
    let b: GoneBranch
    let repoRel: String
    var id: String { b.id }
    var name: String { b.name }
    var status: String { b.status.rawValue }
}

struct WorktreeRow: Identifiable {
    let w: WorktreeInfo
    let repoRel: String
    var id: String { w.id }
    var path: String { w.path }
    var size: Int64 { w.size }
    var status: String { w.status.rawValue }
}

/// Maintenance git : analyse en lecture seule, sélection, confirmation récapitulative, application journalisée.
struct GitView: View {
    @EnvironmentObject var model: AppModel
    @ViewState private var tab = GitTab.worktrees
    @ViewState private var confirming = false

    var body: some View {
        VStack(spacing: 0) {
            PillPicker(options: [(GitTab.repos, T("git.tab.repos")), (.branches, T("git.tab.branches")), (.worktrees, T("git.tab.worktrees"))],
                       selection: $tab)
                .frame(height: 64)
            if model.isAnalyzingGit {
                VStack(spacing: 12) { ProgressView(); Text(T("git.analyzing")).foregroundStyle(Palette.secondary) }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let reports = model.gitReports {
                content(reports)
            } else {
                VStack(spacing: 14) {
                    Image(systemName: "arrow.triangle.branch").font(.system(size: 34)).foregroundStyle(Palette.secondary)
                    Text(T("git.intro")).foregroundStyle(Palette.secondary).multilineTextAlignment(.center).frame(maxWidth: 460)
                    Button(T("git.analyze")) { model.analyzeGit() }.buttonStyle(.pillPrimary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .sheet(isPresented: $confirming) {
            GitConfirmSheet(root: rootPath) { confirming = false }.environmentObject(model)
        }
        .onChange(of: model.selectedBranches) { _, _ in model.updateGitEstimate() }
        .onChange(of: model.selectedWorktrees) { _, _ in model.updateGitEstimate() }
    }

    var rootPath: String { model.trackedFolders.first?.expandedPath ?? "" }

    func content(_ reports: [RepoReport]) -> some View {
        let root = rootPath
        func rel(_ p: String) -> String { p.hasPrefix(root + "/") ? String(p.dropFirst(root.count + 1)) : p }
        let allWT = reports.flatMap(\.worktrees)
        let recap = GitMaintenance.recap(reports, branches: model.selectedBranches, worktrees: model.selectedWorktrees)
        return VStack(spacing: 14) {
            if let only = model.gitOptions.only {
                HStack(spacing: 10) {
                    Image(systemName: "line.3.horizontal.decrease.circle").foregroundStyle(Palette.secondary)
                    Text(T("git.filter.repo", rel(only))).lineLimit(1).truncationMode(.head)
                    Spacer()
                    Button(T("git.filter.all")) { model.gitOptions.only = nil; model.analyzeGit() }.buttonStyle(.pill)
                }
            }
            HStack(spacing: 12) {
                stat(T("git.stat.repos"), "\(reports.count)")
                stat(T("git.stat.git_total"), Fmt.bytes(recap.gitBytes))
                stat(T("git.stat.branches"), "\(reports.flatMap(\.branches).count)")
                stat(T("git.stat.worktrees"), "\(allWT.count)")
                stat(T("git.stat.obsolete"), "\(allWT.filter(\.isObsolete).count)")
                stat(T("git.stat.risk"), "\(allWT.filter(\.isAtRisk).count)", tone: .warning)
                stat(T("git.stat.reclaimable"), model.gitSelectionReclaimable.map(Fmt.bytes) ?? "…")
            }
            Group {
                switch tab {
                case .repos: reposTable(reports, rel: rel)
                case .branches: branchesTable(reports, rel: rel)
                case .worktrees: worktreesTable(reports, rel: rel)
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(Palette.border))
            HStack(spacing: 14) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(T("git.selection", model.selectedBranches.count, model.selectedWorktrees.count)).fontWeight(.semibold)
                    Text(T("git.recap", recap.deletedBranches, recap.keptBranches, recap.removedWorktrees, recap.keptWorktrees))
                        .font(.system(size: 12)).foregroundStyle(Palette.secondary)
                }
                Toggle(T("git.option.prune_now"), isOn: $model.gitOptions.pruneNow).toggleStyle(.checkbox)
                Toggle(T("settings.git_gc"), isOn: $model.gitOptions.gc).toggleStyle(.checkbox)
                Text(T("git.simulation_default")).font(.system(size: 12.5)).foregroundStyle(Palette.secondary)
                Spacer()
                Button(T("git.export_ellipsis")) { model.exportGitReport(root: root) }.buttonStyle(.pill)
                Button(T("git.analyze")) { model.analyzeGit() }.buttonStyle(.pill)
                Button(T("git.apply_ellipsis")) { confirming = true }.buttonStyle(.pillPrimary)
                    .disabled(model.selectedBranches.isEmpty && model.selectedWorktrees.isEmpty)
            }
        }
        .padding(.horizontal, 32).padding(.bottom, 24)
    }

    func stat(_ title: String, _ value: String, tone: Palette.Tone? = nil) -> some View {
        Card(padding: 14) {
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.system(size: 12.5)).foregroundStyle(Palette.secondary)
                Text(value).font(.system(size: 22, weight: .semibold)).foregroundStyle(tone.map(Palette.foreground) ?? Palette.text)
            }
        }
    }

    func reposTable(_ reports: [RepoReport], rel: @escaping (String) -> String) -> some View {
        Table(reports.sorted { $0.gitBytes > $1.gitBytes }) {
            TableColumn(T("col.repo")) { r in Text(rel(r.path)).lineLimit(1).truncationMode(.head).help(r.path) }
            TableColumn(T("col.git")) { r in Text(Fmt.bytes(r.gitBytes)).monospacedDigit() }.width(90)
            TableColumn(T("git.col.loose")) { r in Text(Fmt.bytes(r.looseBytes)).monospacedDigit() }.width(110)
            TableColumn(T("git.tab.branches")) { r in Text(verbatim: "\(r.branches.count)") }.width(80)
            TableColumn(T("git.tab.worktrees")) { r in Text(verbatim: "\(r.worktrees.count)") }.width(80)
            TableColumn(T("git.stat.reclaimable")) { r in Text(Fmt.bytes(r.reclaimableBytes)).monospacedDigit() }.width(100)
        }
    }

    func branchesTable(_ reports: [RepoReport], rel: @escaping (String) -> String) -> some View {
        let rows = reports.flatMap { r in r.branches.map { BranchRow(b: $0, repoRel: rel(r.path)) } }
        return Table(rows) {
            TableColumn("") { row in
                Toggle("", isOn: Binding(get: { model.selectedBranches.contains(row.id) },
                                         set: { on in if on { model.selectedBranches.insert(row.id) } else { model.selectedBranches.remove(row.id) } }))
                    .labelsHidden().toggleStyle(.checkbox)
                    // Branche extraite dans un worktree : supprimable seulement avec lui.
                    .disabled(row.b.checkedOutInWorktree.map { !model.selectedWorktrees.contains($0) } ?? false)
            }
            .width(30)
            TableColumn(T("col.repo")) { r in Text(r.repoRel).lineLimit(1).truncationMode(.head).foregroundStyle(Palette.secondary) }
            TableColumn(T("git.col.branch")) { r in
                VStack(alignment: .leading, spacing: 1) {
                    Text(r.name).font(.system(size: 12.5, design: .monospaced))
                    if let wt = r.b.checkedOutInWorktree {
                        Text(T("git.branch.in_worktree", rel(wt))).font(.caption2).foregroundStyle(Palette.secondary).lineLimit(1)
                    }
                }
            }
            TableColumn(T("col.status")) { r in
                let tone: Palette.Tone = r.b.status == .unmerged ? .warning : .success
                Badge(text: T("branch.status.\(r.status)"), tone: tone)
            }
            .width(110)
            TableColumn(T("git.col.last_commit")) { r in Text(r.b.date).foregroundStyle(Palette.secondary) }.width(100)
            TableColumn(T("git.col.subject")) { r in Text(r.b.subject).lineLimit(1).foregroundStyle(Palette.secondary) }
        }
    }

    func worktreesTable(_ reports: [RepoReport], rel: @escaping (String) -> String) -> some View {
        let rows = reports.flatMap { r in r.worktrees.map { WorktreeRow(w: $0, repoRel: rel(r.path)) } }
        return Table(rows) {
            TableColumn("") { row in
                Toggle("", isOn: Binding(get: { model.selectedWorktrees.contains(row.id) },
                                         set: { on in model.setWorktree(row.id, selected: on) }))
                    .labelsHidden().toggleStyle(.checkbox)
                    .disabled(row.w.status == .active)
            }
            .width(30)
            TableColumn(T("git.col.worktree")) { r in
                VStack(alignment: .leading, spacing: 1) {
                    Text(rel(r.path)).lineLimit(1).truncationMode(.head)
                    Text(r.repoRel).font(.caption2).foregroundStyle(Palette.secondary).lineLimit(1)
                }
                .help(r.path)
            }
            TableColumn(T("git.col.branch")) { r in Text(r.w.branch ?? "—").font(.system(size: 12.5, design: .monospaced)) }
            TableColumn(T("col.status")) { r in
                let tone: Palette.Tone = switch r.w.status { case .risk: .warning; case .active: .info; case .orphan: .neutral; default: .success }
                VStack(alignment: .leading, spacing: 2) {
                    Badge(text: T("worktree.status.\(r.status)"), tone: tone)
                    if r.w.isAtRisk {
                        Text(T("git.risk_detail", r.w.modifiedFiles + r.w.untrackedFiles, r.w.unpushedCommits))
                            .font(.caption2).foregroundStyle(Palette.secondary)
                    }
                }
            }
            .width(min: 140, ideal: 170)
            TableColumn(T("git.col.modified")) { r in
                Text(r.w.lastModified.map(Fmt.date) ?? "—").foregroundStyle(Palette.secondary)
            }
            .width(min: 110, ideal: 140)
            TableColumn(T("col.size")) { r in Text(Fmt.bytes(r.size)).monospacedDigit() }.width(90)
        }
    }
}

/// Confirmation : sélection groupée par dépôt, options d'application, accord explicite pour les worktrees à risque.
struct GitConfirmSheet: View {
    @EnvironmentObject var model: AppModel
    let root: String
    let dismiss: () -> Void
    @ViewState private var riskAcknowledged = false

    var body: some View {
        let branches = model.selectedBranchRefs
        let worktrees = model.selectedWorktreeRefs
        let repos = Set(branches.map(\.repo) + worktrees.map(\.repo)).sorted()
        let atRisk = worktrees.filter(\.isAtRisk)
        VStack(alignment: .leading, spacing: 14) {
            Text(T("git.confirm.title", branches.count, worktrees.count)).font(.system(size: 17, weight: .semibold))
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    ForEach(repos, id: \.self) { repo in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(rel(repo)).fontWeight(.semibold).lineLimit(1).truncationMode(.head).help(repo)
                            ForEach(worktrees.filter { $0.repo == repo }) { w in
                                Text(verbatim: "• " + rel(w.path) + (w.isAtRisk ? " — " + T("worktree.status.risk") : ""))
                                    .foregroundStyle(w.isAtRisk ? Palette.foreground(.warning) : Palette.text)
                            }
                            ForEach(branches.filter { $0.repo == repo }) { b in
                                Text(verbatim: "• \(b.name) (\(T("branch.status.\(b.status.rawValue)")))")
                                    .font(.system(size: 12.5, design: .monospaced))
                            }
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxHeight: 280)
            Divider()
            Toggle(T("git.option.prune_now"), isOn: $model.gitOptions.pruneNow).toggleStyle(.checkbox)
            Toggle(T("settings.git_gc"), isOn: $model.gitOptions.gc).toggleStyle(.checkbox)
            Text(T("git.confirm.log")).font(.system(size: 12)).foregroundStyle(Palette.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if model.gitOptions.pruneNow {
                Text(T("cli.git.prune_warning").trimmingCharacters(in: .whitespaces))
                    .font(.system(size: 12)).foregroundStyle(Palette.foreground(.warning)).fixedSize(horizontal: false, vertical: true)
            }
            if !atRisk.isEmpty {
                Text(T("git.confirm.risk")).font(.system(size: 12.5, weight: .medium)).foregroundStyle(Palette.foreground(.danger))
                    .fixedSize(horizontal: false, vertical: true)
                Toggle(T("git.confirm.risk_ack", atRisk.count), isOn: $riskAcknowledged).toggleStyle(.checkbox)
            }
            HStack {
                Spacer()
                Button(T("action.cancel"), role: .cancel) { dismiss() }.keyboardShortcut(.cancelAction)
                Button(T("git.apply"), role: .destructive) { dismiss(); model.applyGit() }
                    .disabled(!atRisk.isEmpty && !riskAcknowledged)
            }
        }
        .padding(22)
        .frame(width: 520)
    }

    func rel(_ p: String) -> String { p.hasPrefix(root + "/") ? String(p.dropFirst(root.count + 1)) : p }
}

extension AppModel {
    var selectedBranchRefs: [GoneBranch] {
        (gitReports ?? []).flatMap(\.branches).filter { selectedBranches.contains($0.id) }
    }

    var selectedWorktreeRefs: [WorktreeInfo] {
        (gitReports ?? []).flatMap(\.worktrees).filter { selectedWorktrees.contains($0.id) }
    }

    /// Coche ou décoche un worktree ; sa branche fusionnée ou squashée suit.
    func setWorktree(_ path: String, selected on: Bool) {
        if on { selectedWorktrees.insert(path) } else { selectedWorktrees.remove(path) }
        let following = GitMaintenance.branchesFollowing(worktrees: [path], in: (gitReports ?? []).flatMap(\.branches)).map(\.id)
        if on { selectedBranches.formUnion(following) } else { selectedBranches.subtract(following) }
    }

    /// Espace récupérable de la sélection réelle : objets propres aux branches cochées + taille des worktrees cochés.
    /// Calcul par git en arrière-plan (rien n'est chargé en mémoire) ; un calcul plus récent remplace le précédent.
    func updateGitEstimate() {
        gitEstimateGeneration += 1
        let generation = gitEstimateGeneration
        gitSelectionReclaimable = nil
        let branches = selectedBranchRefs
        let worktreeBytes = selectedWorktreeRefs.reduce(Int64(0)) { $0 + $1.size }
        Task.detached(priority: .utility) {
            var total = worktreeBytes
            for repo in Set(branches.map(\.repo)) {
                total += GitMaintenance.estimate(Git(repo), deleting: branches.filter { $0.repo == repo }.map(\.name))
            }
            let bytes = total
            await MainActor.run {
                guard generation == self.gitEstimateGeneration else { return }
                self.gitSelectionReclaimable = bytes
            }
        }
    }

    /// Ouvre la maintenance git limitée à un dépôt (depuis l'onglet Projets).
    func openGitMaintenance(repo: String) {
        gitOptions.only = repo
        section = .git
        analyzeGit()
    }

    /// Exporte le rapport TSV des branches (comme `cairn git --report`).
    func exportGitReport(root: String) {
        guard let reports = gitReports else { return }
        let panel = NSSavePanel()
        panel.nameFieldStringValue = "git-cleanup-report.tsv"
        panel.allowedContentTypes = [UTType.tabSeparatedText]
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do {
            try GitMaintenance.tsv(reports, root: root).write(to: url, atomically: true, encoding: .utf8)
            lastMessage = T("git.exported", url.path)
        } catch {
            lastMessage = String(describing: error)
        }
    }

    /// Analyse en lecture seule de tous les dépôts des dossiers suivis.
    /// `cancel` : résultats ignorés et analyse arrêtée (vérification complète) ; `onDone(false)` dans ce cas.
    func analyzeGit(cancel: CancelToken? = nil, onDone: ((Bool) -> Void)? = nil) {
        isAnalyzingGit = true
        var options = gitOptions
        options.staleDays = config?.git.worktreeStaleDays ?? 30
        options.fetch = config?.git.fetchBefore ?? false
        let folders = trackedFolders.filter(\.isAvailable).map(\.expandedPath)
        Task.detached(priority: .userInitiated) {
            let reports = GitMaintenance.analyzeAll(folders: folders, options: options, cancel: cancel)
            await MainActor.run {
                if cancel?.isCancelled == true {
                    self.isAnalyzingGit = false
                    onDone?(false)
                    return
                }
                self.gitReports = reports
                // Présélection : branches fusionnées/squashées, worktrees obsolètes sans travail en cours,
                // et la branche fusionnée de chaque worktree présélectionné.
                let worktrees = Set(reports.flatMap(\.worktrees).filter { GitMaintenance.selectedByDefault($0, options: options) }.map(\.id))
                let all = reports.flatMap(\.branches)
                self.selectedWorktrees = worktrees
                self.selectedBranches = Set(all.filter { GitMaintenance.selectedByDefault($0, options: options) }.map(\.id))
                    .union(GitMaintenance.branchesFollowing(worktrees: worktrees, in: all).map(\.id))
                self.isAnalyzingGit = false
                // Les worktrees obsolètes comptent dans le résumé (barre des menus).
                self.refreshSummary()
                self.updateGitEstimate()
                onDone?(true)
            }
        }
    }

    func applyGit() {
        let branches = selectedBranchRefs
        let worktrees = selectedWorktreeRefs
        let options = gitOptions
        let paths = self.paths
        isAnalyzingGit = true
        Task.detached(priority: .userInitiated) {
            var deleted = 0, removed = 0, failures: [String] = []
            // Même verrou que la sauvegarde : gc et prune ne doivent pas réécrire un .git en cours de copie.
            let lock = OperationLock(url: paths.operationLock)
            var busy = false
            do { try lock.acquire(operation: "git-clean") } catch { busy = true }
            if !busy {
                for repo in Set(branches.map(\.repo) + worktrees.map(\.repo)).sorted() {
                    let mine = branches.filter { $0.repo == repo }
                    let res = GitMaintenance.apply(repo: repo, branches: mine.map(\.name),
                                                   worktrees: worktrees.filter { $0.repo == repo }, options: options,
                                                   expectedSHAs: Dictionary(mine.map { ($0.name, $0.sha) }, uniquingKeysWith: { a, _ in a }))
                    deleted += res.deletedBranches.count
                    removed += res.removedWorktrees.count
                    failures += res.failures
                }
                lock.release()
            }
            let (d, r, f, wasBusy) = (deleted, removed, failures, busy)
            await MainActor.run {
                if !wasBusy && d + r > 0 { self.logActivity(.init(kind: .gitCleanup, count: d + r)) }
                self.lastMessage = wasBusy ? T("cli.busy")
                    : T("git.done", d, r) + (f.isEmpty ? "" : "\n" + T("remove.failures", f.joined(separator: ", ")))
                self.storage.check()
                self.analyzeGit()
            }
        }
    }
}
