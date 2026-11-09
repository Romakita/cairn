import AppKit
import CairnCore
import SwiftUI
import UserNotifications

/// Surveillance de l'espace libre et notifications de disque plein.
@MainActor
final class StorageMonitor: NSObject, UNUserNotificationCenterDelegate {
    weak var model: AppModel?
    private var timer: Timer?
    static let category = "cairn.disk"

    func start(model: AppModel) {
        self.model = model
        guard let center = Notifier.center else { timer = Timer.scheduledTimer(withTimeInterval: 15 * 60, repeats: true) { [weak self] _ in MainActor.assumeIsolated { self?.check() } }; check(); return }
        center.delegate = self
        let clean = UNNotificationAction(identifier: "clean", title: T("action.clean"), options: [.foreground])
        let snooze = UNNotificationAction(identifier: "snooze", title: T("alerts.snooze"), options: [])
        center.setNotificationCategories([UNNotificationCategory(identifier: Self.category, actions: [clean, snooze],
                                                                 intentIdentifiers: [], options: [])])
        timer = Timer.scheduledTimer(withTimeInterval: 15 * 60, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.check() }
        }
        check()
    }

    /// Relève la capacité des volumes suivis (sans parcourir les fichiers) et envoie les alertes nécessaires.
    func check() {
        guard let model else { return }
        let alerts = model.config?.alerts ?? CairnConfig.Alerts()
        var history = VolumeHistory.load(model.paths)
        var states = StorageAlerts.loadStates(model.paths)
        var seen = Set<String>()
        let now = Date()
        var active: [StorageAlerts.Alert] = []
        for f in model.trackedFolders where f.isAvailable {
            guard let v = Scanner.volumeInfo(for: f.expandedPath), seen.insert(v.name).inserted else { continue }
            let reading = VolumeHistory.Reading(date: now, available: v.availableImportant, total: v.total)
            let past = history.readings[v.name] ?? []
            history.add(v.name, reading)
            let (alert, state) = StorageAlerts.evaluate(volume: v.name, reading: reading, history: past,
                                                        state: states[v.name] ?? .init(), alerts: alerts, now: now)
            states[v.name] = state
            if StorageAlerts.level(available: reading.available, total: reading.total, alerts: alerts) != .ok
                || StorageAlerts.daysToFull(past + [reading], now: now).map({ $0 < 7 }) == true {
                active.append(StorageAlerts.Alert(volume: v.name, level: max(.low, StorageAlerts.level(available: reading.available, total: reading.total, alerts: alerts)),
                                                  available: reading.available, percentFree: Double(reading.available) / Double(max(reading.total, 1)) * 100,
                                                  daysToFull: StorageAlerts.daysToFull(past + [reading], now: now)))
            }
            if let alert { notify(alert) }
        }
        try? history.save(model.paths)
        StorageAlerts.saveStates(states, model.paths)
        model.activeAlerts = active
    }

    func notify(_ a: StorageAlerts.Alert) {
        model?.logActivity(.init(kind: .diskAlert, subject: a.volume, bytes: a.available,
                                 level: a.level == .critical ? "critical" : "low"))
        let c = UNMutableNotificationContent()
        c.title = T(a.level == .critical ? "alerts.critical_title" : "alerts.low_title", a.volume)
        var body = T("alerts.body", Fmt.bytes(a.available), Fmt.number(a.percentFree, digits: 1))
        if let d = a.daysToFull, d < 7 { body += " " + T("alerts.forecast", Fmt.number(d, digits: 0)) }
        if let s = model?.summary, s.reclaimableBytes > 0 { body += " " + T("alert.reclaimable", Fmt.bytes(s.reclaimableBytes)) }
        if let s = model?.summary, s.trashBytes > 1_000_000_000 { body += " " + T("alerts.trash", Fmt.bytes(s.trashBytes)) }
        c.body = body
        c.categoryIdentifier = Self.category
        c.userInfo = ["volume": a.volume]
        Notifier.center?.add(UNNotificationRequest(identifier: "disk-\(a.volume)", content: c, trigger: nil))
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                            withCompletionHandler done: @escaping () -> Void) {
        let action = response.actionIdentifier
        let volume = response.notification.request.content.userInfo["volume"] as? String
        Task { @MainActor in
            guard let model = self.model else { return }
            if action == "snooze", let volume {
                var states = StorageAlerts.loadStates(model.paths)
                states[volume] = StorageAlerts.snooze(states[volume] ?? .init(), now: Date())
                StorageAlerts.saveStates(states, model.paths)
            } else {
                model.openCleanup()
            }
            done()
        }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                            withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void) {
        done([.banner, .sound])
    }
}

extension AppModel {
    /// Ouvre l'écran Nettoyable avec les plus gros dossiers régénérables présélectionnés
    /// (rien n'est supprimé sans confirmation).
    func openCleanup() {
        pendingCleanupPreselection = true
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        NSApp.windows.first { $0.canBecomeMain }?.makeKeyAndOrderFront(nil)
        section = .analysis
        analysisTab = .cleanable
    }

    /// Met à jour le résumé persistant après une analyse.
    func refreshSummary() {
        let roots = analyses.values.map(\.result.root)
        guard !roots.isEmpty else { return }
        let obsolete = (gitReports ?? []).flatMap(\.worktrees).filter(\.isObsolete).reduce(Int64(0)) { $0 + $1.size }
        let s = AnalysisSummary.from(roots: roots, obsoleteWorktreeBytes: obsolete)
        try? s.save(paths)
        summary = s
    }
}

/// Panneau de la barre des menus : résumé du stockage et des sauvegardes, actions rapides.
struct MenuBarPanel: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                CairnLogo(size: 20)
                Text(verbatim: "Cairn").font(.system(size: 15, weight: .semibold))
                if model.globalStatus != .ok { Badge(text: T("status.\(model.globalStatus.rawValue)"), tone: model.globalStatus == .error ? .danger : .warning) }
                Spacer()
                Button { open(.settings) } label: { Icon("slider.horizontal.3", size: 16) }
                    .buttonStyle(.plain).foregroundStyle(Palette.secondary).accessibilityLabel(T("section.settings"))
            }
            gauges
            if let s = model.summary {
                tile {
                    HStack(alignment: .firstTextBaseline) {
                        Text(T("home.reclaimable")).font(.system(size: 12, weight: .medium)).foregroundStyle(Palette.secondary)
                        Spacer()
                        Text(Fmt.bytes(s.reclaimableBytes)).font(.system(size: 20, weight: .bold))
                    }
                    let parts = Category.allCases.filter { (s.reclaimableByType[$0.key] ?? 0) > 0 }
                    GeometryReader { g in
                        HStack(spacing: 0) {
                            ForEach(parts) { c in
                                Rectangle().fill(c.color).frame(width: g.size.width * CGFloat(Double(s.reclaimableByType[c.key] ?? 0) / Double(max(s.reclaimableBytes, 1))))
                            }
                        }
                        .clipShape(Capsule())
                    }
                    .frame(height: 6)
                    Text(parts.map { "\($0.shortLabel) \(Fmt.bytes(s.reclaimableByType[$0.key] ?? 0))" }.joined(separator: " · "))
                        .font(.system(size: 12)).foregroundStyle(Palette.secondary)
                    if s.obsoleteWorktreeBytes > 0 || s.trashBytes > 0 {
                        Text(T("menu.extra_reclaimable", Fmt.bytes(s.obsoleteWorktreeBytes), Fmt.bytes(s.trashBytes)))
                            .font(.system(size: 12)).foregroundStyle(Palette.secondary)
                    }
                }
            }
            backupTile
            if !model.isScanning, Health.analysisIsStale(model.summary?.date, now: Date()) {
                tile {
                    HStack(spacing: 10) {
                        Label { Text(model.summary.map { T("menu.analysis_stale", Fmt.date($0.date)) } ?? T("menu.no_analysis")) } icon: { Icon("clock.arrow.circlepath", size: 15) }
                            .font(.system(size: 13, weight: .medium)).foregroundStyle(Palette.foreground(.warning))
                        Spacer()
                        Button(T("action.analyze")) { model.scan() }.buttonStyle(.pill)
                    }
                }
            }
            ForEach(model.activeAlerts, id: \.volume) { a in
                tile {
                    Label { Text(a.daysToFull.map { T("alerts.forecast_short", a.volume, Fmt.number($0, digits: 0)) }
                          ?? T(a.level == .critical ? "alerts.critical_title" : "alerts.low_title", a.volume)) } icon: { Icon("exclamationmark.triangle", size: 15) }
                        .font(.system(size: 13, weight: .medium)).foregroundStyle(Palette.foreground(a.level == .critical ? .danger : .warning))
                }
            }
            Button { model.openCleanup(); openWindow(id: "main") } label: {
                Text(model.summary.map { T("menu.clean_amount", Fmt.bytes($0.reclaimableBytes)) } ?? T("action.clean"))
                    .frame(maxWidth: .infinity, minHeight: 36)
            }
            .buttonStyle(.pillPrimary)
            HStack(spacing: 8) {
                Button { model.backups.run(destinations: nil, dryRun: false) } label: {
                    Text(T("action.backup_now")).frame(maxWidth: .infinity, minHeight: 30)
                }
                .buttonStyle(.pill)
                .disabled(model.isBackingUp || model.otherOperationRunning || (model.config?.destinations.isEmpty ?? true))
                PopupMenuButton(entries: {
                    [.item(icon: "magnifyingglass", title: T("action.analyze")) { model.scan() },
                     .item(icon: "macwindow", title: T("menu.open")) { open(.home) },
                     .item(icon: "gearshape", title: T("section.settings")) { open(.settings) },
                     .divider,
                     .item(icon: "power", title: T("menu.quit")) { NSApp.terminate(nil) }]
                }) {
                    MoreIcon()
                }
                .accessibilityLabel(T("menu.more"))
            }
            Text(model.summary.map { T("menu.analysis_date", Fmt.date($0.date)) } ?? T("menu.no_analysis"))
                .font(.system(size: 11.5)).foregroundStyle(Palette.secondary).frame(maxWidth: .infinity)
        }
        .padding(16)
        .frame(width: 360)
    }

    var gauges: some View {
        let volumes = model.volumeSummaries
        return VStack(spacing: 10) {
            if let main = volumes.first {
                HStack(spacing: 16) {
                    ZStack {
                        Circle().stroke(Palette.field, lineWidth: 12)
                        Circle().trim(from: 0, to: main.used).stroke(main.color, style: StrokeStyle(lineWidth: 12, lineCap: .round)).rotationEffect(.degrees(-90))
                        VStack(spacing: 0) {
                            Text(Fmt.bytes(main.info.availableImportant)).font(.system(size: 20, weight: .bold)).minimumScaleFactor(0.6)
                            Text(T("home.free")).font(.system(size: 11)).foregroundStyle(Palette.secondary)
                        }
                        .padding(14)
                    }
                    .frame(width: 118, height: 118)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(main.info.name).font(.system(size: 15, weight: .semibold))
                        Text(T("home.used_of", Fmt.bytes(main.info.total - main.info.availableImportant), Fmt.bytes(main.info.total)))
                            .font(.system(size: 12.5)).foregroundStyle(Palette.secondary)
                    }
                }
            }
            ForEach(volumes.dropFirst(), id: \.info.name) { v in
                HStack {
                    Text(v.info.name).font(.system(size: 12.5))
                    FillBar(fraction: v.used, color: v.color)
                    Text(Fmt.bytes(v.info.availableImportant)).font(.system(size: 12)).foregroundStyle(Palette.secondary)
                }
            }
        }
    }

    var backupTile: some View {
        let dests = model.config?.destinations ?? []
        let last = dests.compactMap { model.runState[$0.id].lastSuccess }.max()
        let waiting = dests.filter { model.destinationWaiting[$0.id] == true }
        return tile {
            HStack(spacing: 10) {
                Icon(model.isBackingUp ? "arrow.triangle.2.circlepath" : (waiting.isEmpty ? "checkmark.shield" : "clock"), size: 16)
                    .foregroundStyle(waiting.isEmpty ? Palette.foreground(.success) : Palette.foreground(.warning))
                VStack(alignment: .leading, spacing: 2) {
                    Text(model.isBackingUp ? (model.backupProgress?.1.fraction.map { T("backup.progress.menu", Int($0 * 100)) }
                                              ?? model.backupProgress.map { T("backup.running", $0.1.part) } ?? T("backup.preparing")) :
                            (last.map { T("menu.backed_up", Fmt.date($0)) } ?? T("home.no_backup")))
                        .font(.system(size: 13.5, weight: .semibold))
                    if let w = waiting.first { Text(T("menu.waiting", model.destinationLabel(w))).font(.system(size: 12)).foregroundStyle(Palette.secondary) }
                    else if dests.isEmpty { Text(T("home.no_destination")).font(.system(size: 12)).foregroundStyle(Palette.secondary) }
                    if !dests.isEmpty, !model.isBackingUp, let next = nextBackupText(dests) {
                        Text(next).font(.system(size: 12)).foregroundStyle(Palette.secondary)
                    }
                }
            }
        }
    }

    /// Prochaine échéance (la plus proche parmi les destinations), « en retard » si elle est déjà passée.
    func nextBackupText(_ dests: [CairnConfig.Destination]) -> String? {
        guard let s = model.config?.schedule else { return nil }
        guard s.frequency != .manual else { return T("menu.next_backup_manual") }
        let now = Date()
        guard let next = dests.compactMap({ Health.nextBackup(s, lastSuccess: model.runState[$0.id].lastSuccess, now: now) }).min() else { return nil }
        return next <= now ? T("menu.next_backup_due") : T("menu.next_backup", Fmt.date(next))
    }

    func tile<C: View>(@ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 8) { content() }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Palette.field, in: RoundedRectangle(cornerRadius: 14))
    }

    func open(_ section: AppSection) {
        model.section = section
        openWindow(id: "main")
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
    }
}

extension AppModel {
    struct VolumeSummary {
        let info: VolumeInfo
        var used: Double { Double(info.total - info.availableImportant) / Double(max(info.total, 1)) }
        let color: Color
    }

    /// Volumes des dossiers suivis (capacité seulement, aucun parcours de fichiers).
    var volumeSummaries: [VolumeSummary] {
        var seen = Set<String>()
        return trackedFolders.filter(\.isAvailable).compactMap { f in
            guard let v = Scanner.volumeInfo(for: f.expandedPath), seen.insert(v.name).inserted else { return nil }
            let lvl = StorageAlerts.level(available: v.availableImportant, total: v.total, alerts: config?.alerts ?? .init())
            return VolumeSummary(info: v, color: lvl == .critical ? .red : (lvl == .low ? .orange : Palette.accent))
        }
    }
}
