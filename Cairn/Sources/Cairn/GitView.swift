import CairnCore
import SwiftUI

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
        .confirmationDialog(T("git.confirm.title", model.selectedBranches.count, model.selectedWorktrees.count),
                            isPresented: $confirming, titleVisibility: .visible) {
            Button(T("git.apply"), role: .destructive) { model.applyGit() }
            Button(T("action.cancel"), role: .cancel) {}
        } message: {
            Text(confirmationMessage)
        }
    }

    var confirmationMessage: String {
        var lines = model.selectedBranchRefs.prefix(8).map { "• \($0.name) (\(T("branch.status.\($0.status.rawValue)")))" }
        lines += model.selectedWorktreeRefs.prefix(8).map { "• \($0.path)" + ($0.isAtRisk ? " — " + T("worktree.status.risk") : "") }
        var text = lines.joined(separator: "\n")
        text += "\n\n" + T("git.confirm.log")
        if model.gitOptions.pruneNow { text += "\n" + T("cli.git.prune_warning").trimmingCharacters(in: .whitespaces) }
        if model.selectedWorktreeRefs.contains(where: \.isAtRisk) { text += "\n" + T("git.confirm.risk") }
        return text
    }

    func content(_ reports: [RepoReport]) -> some View {
        let root = model.trackedFolders.first?.expandedPath ?? ""
        func rel(_ p: String) -> String { p.hasPrefix(root + "/") ? String(p.dropFirst(root.count + 1)) : p }
        let allWT = reports.flatMap(\.worktrees)
        return VStack(spacing: 14) {
            HStack(spacing: 12) {
                stat(T("git.stat.repos"), "\(reports.count)")
                stat(T("git.stat.branches"), "\(reports.flatMap(\.branches).count)")
                stat(T("git.stat.worktrees"), "\(allWT.count)")
                stat(T("git.stat.obsolete"), "\(allWT.filter(\.isObsolete).count)")
                stat(T("git.stat.risk"), "\(allWT.filter(\.isAtRisk).count)", tone: .warning)
                stat(T("git.stat.reclaimable"), Fmt.bytes(model.gitReclaimable))
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
                Text(T("git.selection", model.selectedBranches.count, model.selectedWorktrees.count)).fontWeight(.semibold)
                Toggle(T("git.option.prune_now"), isOn: $model.gitOptions.pruneNow).toggleStyle(.checkbox)
                Toggle(T("settings.git_gc"), isOn: $model.gitOptions.gc).toggleStyle(.checkbox)
                Text(T("git.simulation_default")).font(.system(size: 12.5)).foregroundStyle(Palette.secondary)
                Spacer()
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
                    .disabled(row.b.checkedOutInWorktree != nil && !model.selectedWorktrees.contains(row.b.checkedOutInWorktree!))
            }
            .width(30)
            TableColumn(T("col.repo")) { r in Text(r.repoRel).lineLimit(1).truncationMode(.head).foregroundStyle(Palette.secondary) }
            TableColumn(T("git.col.branch")) { r in Text(r.name).font(.system(size: 12.5, design: .monospaced)) }
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
                                         set: { on in if on { model.selectedWorktrees.insert(row.id) } else { model.selectedWorktrees.remove(row.id) } }))
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

extension AppModel {
    var selectedBranchRefs: [GoneBranch] {
        (gitReports ?? []).flatMap(\.branches).filter { selectedBranches.contains($0.id) }
    }

    var selectedWorktreeRefs: [WorktreeInfo] {
        (gitReports ?? []).flatMap(\.worktrees).filter { selectedWorktrees.contains($0.id) }
    }

    var gitReclaimable: Int64 {
        selectedWorktreeRefs.reduce(Int64(0)) { $0 + $1.size } + (gitReports ?? []).reduce(Int64(0)) { $0 + $1.reclaimableBytes }
    }

    /// Analyse en lecture seule de tous les dépôts des dossiers suivis.
    func analyzeGit() {
        isAnalyzingGit = true
        var options = gitOptions
        options.staleDays = config?.git.worktreeStaleDays ?? 30
        options.fetch = config?.git.fetchBefore ?? false
        let folders = trackedFolders.filter(\.isAvailable).map(\.expandedPath)
        Task.detached(priority: .userInitiated) {
            let reports = GitMaintenance.analyzeAll(folders: folders, options: options)
            await MainActor.run {
                self.gitReports = reports
                // Présélection : branches fusionnées/squashées, worktrees obsolètes sans travail en cours.
                self.selectedBranches = Set(reports.flatMap(\.branches).filter { GitMaintenance.selectedByDefault($0, options: options) }.map(\.id))
                self.selectedWorktrees = Set(reports.flatMap(\.worktrees).filter { GitMaintenance.selectedByDefault($0, options: options) }.map(\.id))
                self.isAnalyzingGit = false
            }
        }
    }

    func applyGit() {
        let branches = selectedBranchRefs
        let worktrees = selectedWorktreeRefs
        let options = gitOptions
        isAnalyzingGit = true
        Task.detached(priority: .userInitiated) {
            var deleted = 0, removed = 0, failures: [String] = []
            for repo in Set(branches.map(\.repo) + worktrees.map(\.repo)).sorted() {
                let res = GitMaintenance.apply(repo: repo, branches: branches.filter { $0.repo == repo }.map(\.name),
                                               worktrees: worktrees.filter { $0.repo == repo }, options: options)
                deleted += res.deletedBranches.count
                removed += res.removedWorktrees.count
                failures += res.failures
            }
            let (d, r, f) = (deleted, removed, failures)
            await MainActor.run {
                self.lastMessage = T("git.done", d, r) + (f.isEmpty ? "" : "\n" + T("remove.failures", f.joined(separator: ", ")))
                self.analyzeGit()
            }
        }
    }
}
