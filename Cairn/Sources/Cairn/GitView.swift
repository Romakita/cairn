import AppKit
import CairnCore
import CairnUI
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

/// Analyse git en cours : rapports reçus au fil de l'eau et avancement.
struct GitLiveAnalysis {
    var reports: [RepoReport] = []
    var done = 0
    var total: Int?
}

/// Action à confirmer, demandée depuis le menu « … » d'une ligne.
enum GitDeletion: Identifiable {
    case worktree(WorktreeInfo, branch: GoneBranch?)
    case branch(GoneBranch)
    case repo(RepoReport)
    case compact(RepoReport)

    var id: String {
        switch self {
        case .worktree(let w, _): "w:" + w.id
        case .branch(let b): "b:" + b.id
        case .repo(let r): "r:" + r.id
        case .compact(let r): "c:" + r.id
        }
    }
}

extension RepoReport {
    /// Tri de la colonne « Dernière activité » (sans date : en premier, comme le plus ancien).
    var activity: Date { lastModified ?? .distantPast }
}

struct WorktreeRow: Identifiable {
    let w: WorktreeInfo
    let repoRel: String
    var id: String { w.id }
    var path: String { w.path }
    var size: Int64 { w.size }
    var status: String { w.status.rawValue }
}

/// Maintenance git : analyse en lecture seule ; chaque ligne a son menu « … » et toute suppression se confirme
/// une par une (rien n'est présélectionné).
struct GitView: View {
    @EnvironmentObject var model: AppModel
    @ViewState private var tab = GitTab.worktrees
    @ViewState private var deleting: GitDeletion?
    @ViewState private var repoSort = [KeyPathComparator(\RepoReport.gitBytes, order: .reverse)]

    var body: some View {
        VStack(spacing: 0) {
            PillPicker(options: [(GitTab.repos, T("git.tab.repos")), (.branches, T("git.tab.branches")), (.worktrees, T("git.tab.worktrees"))],
                       selection: $tab)
                .frame(maxWidth: .infinity)
                .overlay(alignment: .trailing) { headerActions.padding(.trailing, 32) }
                .frame(height: 64)
            if let live = model.gitLive, !live.reports.isEmpty {
                content(live.reports, live: live)
            } else if model.isAnalyzingGit {
                VStack(spacing: 12) {
                    ProgressView()
                    Text(model.gitLive.map(progressText) ?? T("git.analyzing")).foregroundStyle(Palette.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let reports = model.gitReports {
                content(reports)
            } else {
                VStack(spacing: 14) {
                    Icon("arrow.triangle.branch", size: 39).foregroundStyle(Palette.secondary)
                    Text(T("git.intro")).foregroundStyle(Palette.secondary).multilineTextAlignment(.center).frame(maxWidth: 460)
                    Button(T("git.analyze")) { model.analyzeGit() }.buttonStyle(.pillPrimary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .sheet(item: $deleting) { d in
            GitDeleteSheet(deletion: d, root: rootPath) { deleting = nil }.environmentObject(model)
        }
    }

    var rootPath: String { model.trackedFolders.first?.expandedPath ?? "" }

    func rel(_ p: String) -> String {
        let root = rootPath
        return p.hasPrefix(root + "/") ? String(p.dropFirst(root.count + 1)) : p
    }

    func progressText(_ live: GitLiveAnalysis) -> String {
        guard let total = live.total else { return T("git.live.discovering") }
        return T("git.live.progress", live.done, total)
    }

    /// `live` : analyse en cours, rapports partiels (suppressions possibles seulement une fois l'analyse finie).
    func content(_ reports: [RepoReport], live: GitLiveAnalysis? = nil) -> some View {
        let rel = self.rel
        let allWT = reports.flatMap(\.worktrees)
        // Estimation : branches fusionnées ou squashées et worktrees obsolètes sans travail en cours.
        let obsolete = GitMaintenance.preselection(reports, options: model.gitOptions).worktrees
        let reclaimable = reports.reduce(Int64(0)) { $0 + $1.reclaimableBytes }
            + allWT.filter { obsolete.contains($0.id) }.reduce(Int64(0)) { $0 + $1.size }
        return VStack(spacing: 14) {
            if let only = model.gitOptions.only {
                HStack(spacing: 10) {
                    Icon("line.3.horizontal.decrease.circle", size: 16).foregroundStyle(Palette.secondary)
                    Text(T("git.filter.repo", rel(only))).lineLimit(1).truncationMode(.head)
                    Spacer()
                    Button(T("git.filter.all")) { model.gitOptions.only = nil; model.analyzeGit() }.buttonStyle(.pill)
                }
            }
            HStack(spacing: 12) {
                stat(T("git.stat.repos"), "\(reports.count)")
                stat(T("git.stat.git_total"), Fmt.bytes(reports.reduce(Int64(0)) { $0 + $1.gitBytes }))
                stat(T("git.stat.branches"), "\(reports.flatMap(\.branches).count)")
                stat(T("git.stat.worktrees"), "\(allWT.count)")
                stat(T("git.stat.obsolete"), "\(allWT.filter(\.isObsolete).count)")
                stat(T("git.stat.risk"), "\(allWT.filter(\.isAtRisk).count)", tone: .warning)
                stat(T("git.stat.reclaimable"), Fmt.bytes(reclaimable))
            }
            Group {
                switch tab {
                case .repos: reposTable(reports, rel: rel, live: live)
                case .branches: branchesTable(reports, rel: rel, live: live)
                case .worktrees: worktreesTable(reports, rel: rel, live: live)
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(Palette.border))
            if let live { liveBar(live) }
        }
        .padding(.horizontal, 32).padding(.bottom, 24)
    }

    /// Avancement de l'analyse, à la place des actions tant qu'elle n'est pas finie.
    func liveBar(_ live: GitLiveAnalysis) -> some View {
        HStack(spacing: 14) {
            ProgressView(value: Double(live.done), total: Double(max(live.total ?? 1, 1))).frame(width: 160)
            Text(progressText(live)).fontWeight(.semibold)
            Spacer()
        }
    }

    /// Actions globales (en haut à droite) : relancer l'analyse ; dans l'onglet Branches, exporter leur rapport.
    @ViewBuilder
    var headerActions: some View {
        if model.gitReports != nil || model.isAnalyzingGit {
            HStack(spacing: 10) {
                if tab == .branches, model.gitReports != nil {
                    Button(T("git.export_ellipsis")) { model.exportGitReport(root: rootPath) }.buttonStyle(.pill)
                        .help(T("git.export.help"))
                }
                Button(T("git.reanalyze")) { model.analyzeGit() }.buttonStyle(.pill)
                    .disabled(model.isAnalyzingGit || !model.gitBusy.isEmpty)
                    .help(T("git.simulation_default"))
            }
        }
    }

    func stat(_ title: String, _ value: String, tone: Palette.Tone? = nil) -> some View {
        Card(padding: 14) {
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.system(size: 12.5)).foregroundStyle(Palette.secondary)
                Text(value).font(.system(size: 22, weight: .semibold)).foregroundStyle(tone.map(Palette.foreground) ?? Palette.text)
            }
        }
    }

    /// Pourquoi une suppression est indisponible (analyse en cours, dépôt déjà en cours de modification).
    func deleteBlocked(_ repo: String, live: GitLiveAnalysis?) -> String? {
        if live != nil { return T("git.action.wait_analysis") }
        if model.gitBusy.contains(repo) { return T("git.action.busy") }
        return nil
    }

    /// Menu « … » d'une ligne : actions sans effet d'abord, suppression (en rouge) en dernier.
    func rowMenu(_ entries: [PopupMenuEntry]) -> some View {
        PopupMenuButton(entries: { entries }) { MoreIcon() }
            .help(T("git.more"))
            .accessibilityLabel(T("git.more"))
    }

    func reposTable(_ reports: [RepoReport], rel: @escaping (String) -> String, live: GitLiveAnalysis?) -> some View {
        Table(reports.sorted(using: repoSort), sortOrder: $repoSort) {
            TableColumn(T("col.repo"), value: \.path) { r in Text(rel(r.path)).lineLimit(1).truncationMode(.head).help(r.path) }
            TableColumn(T("git.col.activity"), value: \.activity) { r in
                Text(r.lastModified.map(Fmt.date) ?? "—").foregroundStyle(Palette.secondary)
            }
            .width(min: 110, ideal: 140)
            TableColumn(T("col.git"), value: \.gitBytes) { r in Text(Fmt.bytes(r.gitBytes)).monospacedDigit() }.width(90)
            TableColumn(T("git.col.loose"), value: \.looseBytes) { r in Text(Fmt.bytes(r.looseBytes)).monospacedDigit() }.width(110)
            TableColumn(T("git.tab.branches")) { r in Text(verbatim: "\(r.branches.count)") }.width(70)
            TableColumn(T("git.tab.worktrees")) { r in Text(verbatim: "\(r.worktrees.count)") }.width(80)
            TableColumn(T("git.stat.reclaimable"), value: \.reclaimableBytes) { r in Text(Fmt.bytes(r.reclaimableBytes)).monospacedDigit() }.width(100)
            TableColumn("") { r in
                let blocked = deleteBlocked(r.path, live: live)
                rowMenu([
                    .item(icon: "folder", title: T("git.action.reveal")) { model.reveal(r.path) },
                    .item(icon: "doc.on.doc", title: T("git.action.copy_path")) { model.copyPath(r.path) },
                    .item(icon: "line.3.horizontal.decrease.circle", title: T("git.action.only_repo"), disabled: live != nil) {
                        model.gitOptions.only = r.path; model.analyzeGit()
                    },
                    .item(icon: "tray.full", title: T("git.action.compact"), disabled: blocked != nil, help: blocked ?? T("git.action.compact.help")) {
                        deleting = .compact(r)
                    },
                    .divider,
                    .item(icon: "trash", title: T("git.action.trash_repo"), destructive: true, disabled: blocked != nil, help: blocked) {
                        deleting = .repo(r)
                    },
                ])
            }
            .width(40)
        }
    }

    func branchesTable(_ reports: [RepoReport], rel: @escaping (String) -> String, live: GitLiveAnalysis?) -> some View {
        let rows = reports.flatMap { r in r.branches.map { BranchRow(b: $0, repoRel: rel(r.path)) } }
        return Table(rows) {
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
            TableColumn("") { row in
                // Branche extraite dans un worktree : on supprime le worktree (qui propose sa branche).
                let blocked = deleteBlocked(row.b.repo, live: live) ?? row.b.checkedOutInWorktree.map { _ in T("git.action.in_worktree") }
                rowMenu([
                    .item(icon: "doc.on.doc", title: T("git.action.copy_name")) { model.copyPath(row.name) },
                    .divider,
                    .item(icon: "trash", title: T("git.action.delete_branch"), destructive: true, disabled: blocked != nil, help: blocked) {
                        deleting = .branch(row.b)
                    },
                ])
            }
            .width(40)
        }
        .overlay { if rows.isEmpty { emptyTable(live == nil ? T("git.branches.empty") : nil) } }
    }

    /// Table vide : un simple indicateur pendant l'analyse, le message sinon.
    @ViewBuilder
    func emptyTable(_ text: String?) -> some View {
        if let text {
            Text(text).foregroundStyle(Palette.secondary).multilineTextAlignment(.center).frame(maxWidth: 420)
        } else {
            ProgressView().controlSize(.small)
        }
    }

    func worktreesTable(_ reports: [RepoReport], rel: @escaping (String) -> String, live: GitLiveAnalysis?) -> some View {
        let rows = reports.flatMap { r in r.worktrees.map { WorktreeRow(w: $0, repoRel: rel(r.path)) } }
        let branches = reports.flatMap(\.branches)
        return Table(rows) {
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
            TableColumn("") { row in
                let blocked = deleteBlocked(row.w.repo, live: live)
                let branch = GitMaintenance.branchesFollowing(worktrees: [row.id], in: branches).first
                rowMenu([
                    .item(icon: "folder", title: T("git.action.reveal"), disabled: !row.w.exists) { model.reveal(row.path) },
                    .item(icon: "doc.on.doc", title: T("git.action.copy_path")) { model.copyPath(row.path) },
                    .divider,
                    .item(icon: "trash", title: T("git.action.delete_worktree"), destructive: true, disabled: blocked != nil, help: blocked) {
                        deleting = .worktree(row.w, branch: branch)
                    },
                ])
            }
            .width(40)
        }
        .overlay { if rows.isEmpty { emptyTable(live == nil ? T("git.worktrees.empty") : nil) } }
    }
}

/// Confirmation d'une suppression : ce qui part, le travail qui serait perdu (accord explicite), les options git.
struct GitDeleteSheet: View {
    @EnvironmentObject var model: AppModel
    let deletion: GitDeletion
    let root: String
    let dismiss: () -> Void
    @ViewState private var withBranch = false
    @ViewState private var acknowledged = false
    @ViewState private var pruneNow = false

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            switch deletion {
            case .worktree(let w, let branch): worktree(w, branch: branch)
            case .branch(let b): branch(b)
            case .repo(let r): repo(r)
            case .compact(let r): compact(r)
            }
            HStack {
                Spacer()
                Button(T("action.cancel"), role: .cancel) { dismiss() }.keyboardShortcut(.cancelAction)
                Button(confirmTitle, role: .destructive) { dismiss(); confirm() }
                    .disabled(needsAck && !acknowledged)
            }
        }
        .padding(22)
        .frame(width: 520)
    }

    var confirmTitle: String {
        switch deletion {
        case .repo: return T("action.trash")
        case .compact: return T("git.compact.confirm")
        default: return T("git.apply")
        }
    }

    /// Travail perdu à reconnaître avant de confirmer.
    var needsAck: Bool {
        switch deletion {
        case .worktree(let w, _): w.isAtRisk
        case .branch(let b): b.status == .unmerged
        case .repo(let r): r.isAtRisk
        case .compact: false
        }
    }

    func confirm() {
        switch deletion {
        case .worktree(let w, let branch):
            model.deleteGit(repo: w.repo, branches: withBranch ? branch.map { [$0] } ?? [] : [], worktrees: [w])
        case .branch(let b):
            model.deleteGit(repo: b.repo, branches: [b], worktrees: [])
        case .repo(let r):
            model.trashGitRepo(r)
        case .compact(let r):
            model.compactGit(repo: r.path, pruneNow: pruneNow)
        }
    }

    func title(_ text: String) -> some View {
        Text(text).font(.system(size: 17, weight: .semibold)).lineLimit(2).truncationMode(.middle)
    }

    func warning(_ text: String) -> some View {
        Text(text).font(.system(size: 12.5, weight: .medium)).foregroundStyle(Palette.foreground(.danger))
            .fixedSize(horizontal: false, vertical: true)
    }

    func note(_ text: String) -> some View {
        Text(text).font(.system(size: 12)).foregroundStyle(Palette.secondary).fixedSize(horizontal: false, vertical: true)
    }

    @ViewBuilder
    func compact(_ r: RepoReport) -> some View {
        title(T("git.compact.title", rel(r.path)))
        note(T("git.compact.detail", Fmt.bytes(r.gitBytes), Fmt.bytes(r.looseBytes)))
        Toggle(T("git.compact.prune_now"), isOn: $pruneNow).toggleStyle(.checkbox)
        note(T("git.compact.prune_now.detail"))
    }

    @ViewBuilder
    func worktree(_ w: WorktreeInfo, branch: GoneBranch?) -> some View {
        title(T("git.delete.worktree.title", rel(w.path)))
        note(T("git.delete.worktree.detail", w.branch ?? "—", Fmt.bytes(w.size)))
        if let branch {
            Toggle(T("git.delete.with_branch", branch.name, T("branch.status.\(branch.status.rawValue)")), isOn: $withBranch)
                .toggleStyle(.checkbox)
        }
        if w.isAtRisk {
            warning(T("git.risk_detail", w.modifiedFiles + w.untrackedFiles, w.unpushedCommits) + " — " + T("git.delete.lost"))
            Toggle(T("git.delete.ack"), isOn: $acknowledged).toggleStyle(.checkbox)
        }
        note(T("git.confirm.log"))
    }

    @ViewBuilder
    func branch(_ b: GoneBranch) -> some View {
        title(T("git.delete.branch.title", b.name))
        note(rel(b.repo) + " · " + T("branch.status.\(b.status.rawValue)") + " · " + b.subject)
        if b.status == .unmerged {
            warning(T("git.delete.unmerged"))
            Toggle(T("git.delete.ack"), isOn: $acknowledged).toggleStyle(.checkbox)
        }
        note(T("git.confirm.log"))
    }

    @ViewBuilder
    func repo(_ r: RepoReport) -> some View {
        let outside = r.worktrees.filter { $0.exists && !$0.path.hasPrefix(r.path + "/") }
        title(T("git.trash.title", rel(r.path)))
        note(T("git.trash.detail", r.lastModified.map(Fmt.date) ?? "—"))
        if !outside.isEmpty {
            warning(T("git.trash.worktrees", outside.map { rel($0.path) }.joined(separator: ", ")))
        }
        if r.isAtRisk {
            warning(T("git.trash.risk", r.modifiedFiles, r.unpushedCommits))
            Toggle(T("git.delete.ack"), isOn: $acknowledged).toggleStyle(.checkbox)
        }
    }

    func rel(_ p: String) -> String { p.hasPrefix(root + "/") ? String(p.dropFirst(root.count + 1)) : p }
}

extension AppModel {
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
    /// `fullCheck` (« Tout vérifier ») : tous les dépôts, sans le filtre de l'écran Git, et jamais de `git fetch`
    /// (qui modifie le dépôt et supprime des références distantes avec `--prune`).
    /// Chaque dépôt s'affiche dès que son worker a fini (`gitLive`) ; les résultats précédents restent en place
    /// si l'analyse est arrêtée. Une analyse relancée remplace la précédente (ses résultats tardifs sont ignorés).
    func analyzeGit(cancel: CancelToken? = nil, fullCheck: Bool = false, onDone: ((Bool) -> Void)? = nil) {
        isAnalyzingGit = true
        gitAnalysisGeneration += 1
        let generation = gitAnalysisGeneration
        gitLive = GitLiveAnalysis()
        let options = gitOptions.forAnalysis(config: config, fullCheck: fullCheck)
        let folders = trackedFolders.filter(\.isAvailable).map(\.expandedPath)
        // Rappels des workers vers l'interface, dans l'ordre d'arrivée.
        let live: (@escaping @MainActor (inout GitLiveAnalysis) -> Void) -> Void = { update in
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    guard generation == self.gitAnalysisGeneration, cancel?.isCancelled != true, self.gitLive != nil else { return }
                    update(&self.gitLive!)
                }
            }
        }
        Task.detached(priority: .userInitiated) {
            let reports = GitMaintenance.analyzeAll(folders: folders, options: options, cancel: cancel, progress: { p in
                live { $0.total = p.total; $0.done = p.done }
            }, onReport: { report in
                live { $0.reports.append(report) }
            })
            await MainActor.run {
                guard generation == self.gitAnalysisGeneration else { onDone?(cancel?.isCancelled != true); return }
                self.gitLive = nil
                if cancel?.isCancelled == true {
                    self.isAnalyzingGit = false
                    onDone?(false)
                    return
                }
                self.gitReports = reports
                self.isAnalyzingGit = false
                // Les worktrees obsolètes comptent dans le résumé (barre des menus).
                self.refreshSummary()
                onDone?(true)
            }
        }
    }

    /// Supprime des branches et worktrees d'un dépôt, puis met à jour seulement ce dépôt dans les résultats :
    /// les lignes supprimées disparaissent et ses tailles sont remesurées, sans relancer l'analyse.
    /// Pas de gc ici : le compactage est une action à part (menu du dépôt), les branches restent récupérables.
    func deleteGit(repo: String, branches: [GoneBranch], worktrees: [WorktreeInfo]) {
        var options = gitOptions
        options.gc = false
        options.pruneNow = false
        runGit(repo: repo, branches: branches, worktrees: worktrees, options: options) { res in
            T("git.done", res.deletedBranches.count, res.removedWorktrees.count)
                + (res.failures.isEmpty ? "" : "\n" + T("remove.failures", res.failures.joined(separator: ", ")))
        }
    }

    /// `git gc` sur un dépôt ; `pruneNow` libère aussi tout de suite l'espace des branches déjà supprimées
    /// (reflog expiré : elles ne sont plus récupérables).
    func compactGit(repo: String, pruneNow: Bool) {
        var options = gitOptions
        options.gc = true
        options.pruneNow = pruneNow
        let before = gitReports?.first { $0.path == repo }?.gitBytes ?? 0
        let name = (repo as NSString).lastPathComponent
        runGit(repo: repo, branches: [], worktrees: [], options: options) { _ in "" } done: { report in
            self.lastMessage = T("git.compacted", name, Fmt.bytes(before), Fmt.bytes(report.gitBytes))
        }
    }

    /// Applique une opération git sur un dépôt sous le verrou d'opération, puis remesure ce seul dépôt.
    private func runGit(repo: String, branches: [GoneBranch], worktrees: [WorktreeInfo], options: GitOptions,
                        message: @escaping @MainActor (GitMaintenance.ApplyResult) -> String,
                        done: @escaping @MainActor (RepoReport) -> Void = { _ in }) {
        let paths = self.paths
        gitBusy.insert(repo)
        Task.detached(priority: .userInitiated) {
            // Même verrou que la sauvegarde : gc et prune ne doivent pas réécrire un .git en cours de copie.
            let lock = OperationLock(url: paths.operationLock)
            var result: GitMaintenance.ApplyResult?
            if (try? lock.acquire(operation: "git-clean")) != nil {
                result = GitMaintenance.apply(repo: repo, branches: branches.map(\.name), worktrees: worktrees, options: options,
                                              expectedSHAs: Dictionary(branches.map { ($0.name, $0.sha) }, uniquingKeysWith: { a, _ in a }))
                lock.release()
            }
            let res = result
            let current: RepoReport? = await MainActor.run {
                guard let res else {
                    self.gitBusy.remove(repo)
                    self.lastMessage = T("cli.busy")
                    return nil
                }
                let (d, r) = (res.deletedBranches.count, res.removedWorktrees.count)
                if d + r > 0 { self.logActivity(.init(kind: .gitCleanup, count: d + r)) }
                let text = message(res)
                if !text.isEmpty { self.lastMessage = text }
                self.updateGitReport(repo) { $0.removing(branches: Set(res.deletedBranches), worktrees: Set(res.removedWorktrees)) }
                self.refreshSummary()
                self.storage.check()
                return self.gitReports?.first { $0.path == repo }
            }
            guard let current else { return }
            let refreshed = GitMaintenance.refreshSizes(current, options: options)
            await MainActor.run {
                self.updateGitReport(repo) { _ in refreshed }
                self.gitBusy.remove(repo)
                done(refreshed)
            }
        }
    }

    /// Place un dépôt entier dans la corbeille (récupérable) et le retire des résultats.
    func trashGitRepo(_ report: RepoReport) {
        let path = report.path
        let name = (path as NSString).lastPathComponent
        gitBusy.insert(path)
        Task.detached(priority: .userInitiated) {
            var failure: String?
            do { try FileManager().trashItem(at: URL(fileURLWithPath: path), resultingItemURL: nil) } catch {
                failure = error.localizedDescription
            }
            let error = failure
            await MainActor.run {
                self.gitBusy.remove(path)
                if let error {
                    self.lastMessage = T("remove.failure_item", name, error)
                    return
                }
                self.gitReports?.removeAll { $0.path == path }
                self.lastMessage = T("git.trashed", name)
                self.refreshSummary()
                self.storage.check()
            }
        }
    }

    /// Remplace le rapport d'un dépôt (s'il est toujours affiché).
    func updateGitReport(_ repo: String, _ change: (RepoReport) -> RepoReport) {
        guard let i = gitReports?.firstIndex(where: { $0.path == repo }) else { return }
        gitReports?[i] = change(gitReports![i])
    }
}
