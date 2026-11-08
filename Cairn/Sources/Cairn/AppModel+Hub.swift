import CairnCore
import Foundation

/// Avancement d'un module pendant la vérification complète (absent : pas de vérification en cours).
enum CheckState: Equatable { case running, done, failed }

extension AppModel {
    // MARK: - État du hub

    /// Données de l'accueil, prises dans l'état courant (aucune analyse lancée).
    var hubInputs: HubState.Inputs {
        var i = HubState.Inputs()
        i.configErrors = configIssues.filter { $0.severity == .error }.map(\.description)
        i.schedule = config?.schedule ?? CairnConfig.Schedule()
        i.destinations = (config?.destinations ?? []).map {
            .init(id: $0.id, label: destinationLabel($0), state: runState[$0.id], waiting: destinationWaiting[$0.id] == true)
        }
        // Alertes de tous les volumes suivis, plus celle du volume affiché si le relevé ne l'a pas encore vue.
        var alerts = activeAlerts
        if let v = volume, let a = diskAlert, !alerts.contains(where: { $0.volume == v.name }) {
            alerts.append(.init(volume: v.name, level: a.critical ? .critical : .low, available: v.available,
                                percentFree: Double(v.available) / Double(max(v.total, 1)) * 100, daysToFull: nil))
        }
        i.volumeAlerts = alerts
        i.unavailableFolders = trackedFolders.filter { !$0.isAvailable }.map(\.expandedPath)
        i.freeBytes = volumeSummaries.first?.info.availableImportant ?? volume?.availableImportant
        i.summary = summary
        i.gitReports = gitReports
        var options = gitOptions
        options.staleDays = config?.git.worktreeStaleDays ?? 30
        i.gitOptions = options
        i.aiDetected = aiStats.map { $0.filter(\.detected).count }
        i.aiLastBackup = aiStats?.compactMap(\.lastBackup).max()
        i.versions = versions.mapValues(\.count)
        i.isBackingUp = isBackingUp
        return i
    }

    var hubState: HubState { HubState.make(hubInputs) }

    // MARK: - Vérification complète (lecture seule)

    var isChecking: Bool { checkStates.values.contains(.running) }

    /// « Tout vérifier » : analyse des dossiers suivis, analyse git en simulation, joignabilité des destinations
    /// (sans montage), relecture de l'état des sauvegardes et des outils IA. Rien n'est supprimé, nettoyé ni
    /// sauvegardé : seules des fonctions de lecture sont appelées.
    func checkEverything() {
        guard !isChecking else { return }
        let token = CancelToken()
        checkToken = token
        for m in HubState.Module.allCases { checkStates[m] = .running }

        // Stockage : `Scanner` ne modifie jamais le disque.
        scan { [weak self] ok in self?.finishCheck(.storage, ok: ok, token: token) }
        // Git : `GitMaintenance.analyzeAll` (pool de workers), sans `apply`, sans `git fetch` et sur tous les dépôts.
        analyzeGit(cancel: token, fullCheck: true) { [weak self] ok in self?.finishCheck(.git, ok: ok, token: token) }
        // Sauvegarde et restauration : joignabilité (test TCP ou présence du volume), relecture de runs.json.
        let dests = config?.destinations ?? []
        let paths = self.paths
        Task.detached(priority: .utility) {
            var waiting: [String: Bool] = [:]
            for d in dests where !token.isCancelled {
                waiting[d.id] = !DestinationSession.provider(for: d).isReachable()
            }
            let state = RunState.load(paths)
            let map = waiting
            await MainActor.run {
                guard !token.isCancelled else { return }
                self.destinationWaiting.merge(map) { $1 }
                self.runState = state
                self.finishCheck(.backup, ok: true, token: token)
                self.finishCheck(.restore, ok: true, token: token)
            }
        }
        // Outils IA : tailles et dernière sauvegarde (lecture).
        refreshAIStats(cancel: token) { [weak self] ok in self?.finishCheck(.ai, ok: ok, token: token) }
    }

    /// « Arrêter » : les modules non terminés gardent leur état précédent (résultats tardifs ignorés).
    func stopCheck() {
        guard let token = checkToken, isChecking else { return }
        token.cancel()
        if checkStates[.storage] == .running { cancel() }
        for (m, s) in checkStates where s == .running { checkStates[m] = nil }
        checkToken = nil
    }

    private func finishCheck(_ m: HubState.Module, ok: Bool, token: CancelToken) {
        guard checkToken === token, !token.isCancelled else { return }
        checkStates[m] = ok ? .done : .failed
        guard !isChecking else { return }
        checkToken = nil
        let now = Date()
        lastCheck = now
        try? HubRecord(lastCheck: now).save(paths)
        logActivity(.init(date: now, kind: .check, count: hubState.causes.count))
    }

    // MARK: - Activité récente

    func logActivity(_ event: ActivityLog.Event) {
        ActivityLog(paths: paths).append(event)
        reloadActivity()
    }

    func reloadActivity() {
        let all = ActivityLog(paths: paths).recent(ActivityLog.maxLines)
        activity = Array(all.prefix(10))
        backupDays = ActivityLog.backupDays(all)
    }

    // MARK: - Actions (navigation, ou sauvegarde demandée)

    func perform(_ action: HubState.Action) {
        switch action {
        case .clean: openCleanupFromHub()
        case .analyze:
            section = .analysis
            analysisTab = .explorer
            if !isScanning { scan() }
        case .backupNow: backups.run(destinations: nil, dryRun: false)
        case .addDestination: addDestination()
        case .openBackup: section = .backup
        case .analyzeGit:
            section = .git
            if !isAnalyzingGit { analyzeGit() }
        case .openGit: section = .git
        case .viewAI: section = .ai
        case .restore: section = .restore
        }
    }

    /// « Résoudre » : ouvre l'endroit où le problème se règle, sans rien exécuter.
    func resolve(_ issue: HubState.Issue) {
        switch issue.kind {
        case .configInvalid, .folderUnavailable: section = .settings
        case .backupFailed, .destinationOverdue, .versionsDamaged:
            if let id = issue.ref { selectedDestination = id }
            section = .backup
        case .diskCritical, .diskLow: openCleanupFromHub()
        }
    }

    /// Écran Nettoyable avec les plus gros dossiers régénérables présélectionnés (aucune suppression sans
    /// confirmation). Sans analyse en mémoire, l'analyse est lancée d'abord.
    private func openCleanupFromHub() {
        pendingCleanupPreselection = true
        section = .analysis
        analysisTab = .cleanable
        if root == nil && !isScanning { scan() }
    }
}

// MARK: - Libellés

enum HubText {
    static func title(_ h: HubState) -> String {
        switch h.overall {
        case .ok: T("hub.title.ok")
        case .attention: T("hub.title.attention", h.causes.count)
        case .error: T("hub.title.error", h.causes.filter { $0.level == .error }.count)
        }
    }

    static func issue(_ i: HubState.Issue) -> String {
        switch i.kind {
        case .configInvalid: T("hub.issue.config_invalid", i.detail ?? "")
        case .backupFailed: T("hub.issue.backup_failed", i.subject)
        case .diskCritical: T("hub.issue.disk_critical", i.subject, Fmt.bytes(i.bytes ?? 0))
        case .destinationOverdue: T("hub.issue.destination_overdue", i.subject)
        case .diskLow: T("hub.issue.disk_low", i.subject, Fmt.bytes(i.bytes ?? 0))
        case .folderUnavailable: T("hub.issue.folder_unavailable", i.subject)
        case .versionsDamaged: T("hub.issue.versions_damaged", i.subject)
        }
    }

    /// Badge d'état d'une carte (aucun tant que le module n'a pas de données).
    static func badge(_ t: HubState.Tone) -> (String, Palette.Tone)? {
        switch t {
        case .ok: (T("hub.badge.ok"), .success)
        case .info: (T("hub.badge.info"), .info)
        case .attention: (T("hub.badge.attention"), .warning)
        case .error: (T("hub.badge.error"), .danger)
        case .unknown: nil
        }
    }

    static func module(_ m: HubState.Module) -> String { T("hub.module.\(m.rawValue)") }

    static func icon(_ m: HubState.Module) -> String {
        switch m {
        case .storage: "internaldrive"
        case .backup: "icloud.and.arrow.up"
        case .git: "arrow.triangle.branch"
        case .ai: "sparkles"
        case .restore: "arrow.counterclockwise"
        }
    }

    static func figure(_ f: HubState.Figure) -> String {
        switch f {
        case .notAnalyzed: T("hub.figure.not_analyzed")
        case let .free(b): T("hub.figure.free", Fmt.bytes(b))
        case .noDestination: T("hub.figure.no_destination")
        case .backingUp: T("hub.figure.backing_up")
        case let .failed(d): T("hub.figure.failed", d)
        case let .unreachable(d): T("hub.figure.unreachable", d)
        case let .lastBackup(d): relative(d, sentence: true)
        case .neverBackedUp: T("hub.figure.never_backed_up")
        case let .gitCandidates(n): T("hub.figure.git_candidates", n)
        case .gitClean: T("hub.figure.git_clean")
        case let .aiTools(n): T("hub.figure.ai_tools", n)
        case .noAITool: T("hub.figure.no_ai_tool")
        case let .versions(n): T("hub.figure.versions", n)
        case let .lastVersion(d): relative(d, sentence: true)
        case .noVersion: T("hub.figure.no_version")
        }
    }

    static func detail(_ d: HubState.Detail) -> String? {
        switch d {
        case .none: nil
        case let .reclaimable(b): T("hub.detail.reclaimable", Fmt.bytes(b))
        case let .nextBackup(date):
            Calendar.current.isDateInToday(date)
                ? T("hub.detail.next_today", date.formatted(Date.FormatStyle(date: .omitted, time: .shortened).locale(L10n.locale)))
                : T("hub.detail.next_date", Fmt.date(date))
        case .backupDue: T("hub.detail.backup_due")
        case .manualSchedule: T("hub.detail.manual")
        case let .gitReclaimable(b): T("hub.detail.git_reclaimable", Fmt.bytes(b))
        case let .aiLastBackup(date): T("hub.detail.ai_last_backup", relative(date, sentence: false))
        case let .destinations(n): T("hub.detail.destinations", n)
        case let .damaged(n): T("hub.detail.damaged", n)
        case .latestVersion: T("hub.detail.latest_version")
        }
    }

    static func action(_ a: HubState.Action) -> String {
        switch a {
        case .clean: T("action.clean")
        case .analyze, .analyzeGit: T("action.analyze")
        case .backupNow: T("action.backup_now")
        case .addDestination: T("sidebar.add_destination")
        case .openBackup, .viewAI: T("hub.action.view")
        case .openGit: T("hub.action.optimize")
        case .restore: T("action.restore")
        }
    }

    static func activity(_ e: ActivityLog.Event, labels: [String: String]) -> String {
        let subject = e.subject.map { labels[$0] ?? $0 } ?? ""
        switch e.kind {
        case .backupSucceeded: return T("hub.activity.backup_succeeded", subject)
        case .backupFailed: return T("hub.activity.backup_failed", subject)
        case .cleanup: return T("hub.activity.cleanup", Fmt.bytes(e.bytes ?? 0))
        case .gitCleanup: return T("hub.activity.git_cleanup", e.count ?? 0)
        case .diskAlert: return T(e.level == "critical" ? "hub.activity.disk_critical" : "hub.activity.disk_alert", subject)
        case .check: return (e.count ?? 0) == 0 ? T("hub.activity.check_ok") : T("hub.activity.check_issues", e.count ?? 0)
        }
    }

    static func activityIcon(_ k: ActivityLog.Event.Kind) -> String {
        switch k {
        case .backupSucceeded: "checkmark.icloud"
        case .backupFailed: "exclamationmark.icloud"
        case .cleanup: "trash"
        case .gitCleanup: "arrow.triangle.branch"
        case .diskAlert: "exclamationmark.triangle"
        case .check: "checklist"
        }
    }

    /// « il y a 3 heures » (ou « Il y a 3 heures » en début de phrase), dans la langue de l'app.
    static func relative(_ date: Date, sentence: Bool) -> String {
        let f = RelativeDateTimeFormatter()
        f.locale = L10n.locale
        f.unitsStyle = .full
        f.formattingContext = sentence ? .beginningOfSentence : .middleOfSentence
        return f.localizedString(for: date, relativeTo: Date())
    }
}
