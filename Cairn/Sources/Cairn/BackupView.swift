import AppKit
import CairnCore
import SwiftUI

struct VersionInfo: Identifiable, Hashable {
    let name: String
    let date: Date
    let damaged: Bool
    var id: String { name }
}

/// Sauvegardes : destination, versions, rétention, planification.
struct BackupView: View {
    @EnvironmentObject var model: AppModel
    @ViewState private var pendingRetention: (CairnConfig.Retention, [String], Int64)?
    @ViewState private var confirmRetention = false
    /// Vérification complète : rapport par version.
    @ViewState private var fullReports: [String: [Integrity.Report]] = [:]
    /// Destination ouverte dans la feuille de modification ou de suppression.
    @ViewState private var editing: CairnConfig.Destination?
    @ViewState private var deleting: CairnConfig.Destination?

    var body: some View {
        let dests = model.config?.destinations ?? []
        Group {
            if let d = dests.first(where: { $0.id == model.selectedDestination }) ?? dests.first {
                detail(d)
            } else {
                VStack(spacing: 14) {
                    Icon("externaldrive.badge.plus", size: 39).foregroundStyle(Palette.secondary)
                    Text(T("backup.no_destination")).foregroundStyle(Palette.secondary)
                    Button(T("sidebar.add_destination")) { model.addDestination() }.buttonStyle(.pillPrimary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .sheet(isPresented: $model.showAddDestination) { AddDestinationSheet().environmentObject(model) }
        .sheet(isPresented: Binding(get: { editing != nil }, set: { if !$0 { editing = nil } })) {
            if let editing { AddDestinationSheet(editing: editing).environmentObject(model) }
        }
        .sheet(isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } })) {
            if let deleting { DeleteDestinationSheet(destination: deleting).environmentObject(model) }
        }
        .alert(T("backup.image_password.title"), isPresented: Binding(get: { model.newImagePassword != nil }, set: { if !$0 { model.newImagePassword = nil } })) {
            Button(T("backup.image_password.copy")) { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(model.newImagePassword?.1 ?? "", forType: .string) }
            Button(T("backup.image_password.noted"), role: .cancel) {}
        } message: {
            Text(T("backup.image_password.message", model.newImagePassword?.1 ?? ""))
        }
        .confirmationDialog(T("backup.retention.confirm_title", pendingRetention?.1.count ?? 0, Fmt.bytes(pendingRetention?.2 ?? 0)),
                            isPresented: $confirmRetention, titleVisibility: .visible) {
            Button(T("action.delete"), role: .destructive) { applyPendingRetention() }
            Button(T("action.cancel"), role: .cancel) { pendingRetention = nil }
        } message: {
            Text((pendingRetention?.1.prefix(10) ?? []).joined(separator: "\n"))
        }
    }

    func detail(_ d: CairnConfig.Destination) -> some View {
        let ds = model.runState[d.id]
        let probed = model.destinationWaiting[d.id]
        let waiting = probed ?? false
        return ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                HStack(spacing: 14) {
                    Icon(d.provider == .smb ? "server.rack" : "externaldrive", size: 16)
                        .font(.system(size: 22)).frame(width: 48, height: 48).background(Palette.field, in: RoundedRectangle(cornerRadius: 14))
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(spacing: 8) {
                            Text(model.destinationLabel(d)).font(.system(size: 22, weight: .semibold))
                            Badge(text: probed == nil ? T("destination.not_checked") : (waiting ? T("backup.badge.waiting") : T("backup.badge.reachable")),
                                  tone: probed == nil ? .neutral : (waiting ? .warning : .success))
                            if d.encrypted { Badge(text: T("backup.badge.encrypted")) } else { Badge(text: T("backup.badge.clear"), tone: .warning) }
                        }
                        Text(d.url ?? d.path ?? "").font(.system(size: 13)).foregroundStyle(Palette.secondary)
                    }
                    Spacer()
                    moreMenu(d)
                    Button { editing = d } label: { Label(T("destination.edit"), systemImage: "gearshape") }.buttonStyle(.pill)
                    if model.isBackingUp {
                        Button(T("action.stop")) { model.backups.cancel() }.buttonStyle(.pill)
                    } else {
                        Button(T("action.backup_now")) { model.backups.run(destinations: [d.id], dryRun: false) }.buttonStyle(.pillPrimary)
                            .disabled(reason(.backup, d) != nil).help(reason(.backup, d).map { T($0) } ?? "")
                    }
                }
                if !d.encrypted && model.config?.home.include.contains(where: { $0.hasPrefix(".ssh") || $0.hasPrefix(".aws") }) == true {
                    Banner(icon: "lock.open", text: T("onboarding.destination.unencrypted_warning"), tone: .warning)
                }
                if let (dest, p) = model.backupProgress, dest == d.id {
                    Card {
                        VStack(alignment: .leading, spacing: 6) {
                            HStack { ProgressView().controlSize(.small); Text(T("backup.running", p.part)).fontWeight(.medium) }
                            Text(T("cli.backup.progress", model.destinationLabel(d), p.part, Fmt.count(p.files))).font(.system(size: 12.5)).foregroundStyle(Palette.secondary)
                            Text(p.current).font(.system(size: 11.5)).foregroundStyle(Palette.secondary).lineLimit(1).truncationMode(.middle)
                        }
                    }
                } else if model.isBackingUp && model.backupProgress == nil {
                    // Préparation commune à toutes les destinations (copie des bases des outils IA…) : pas encore de progression.
                    Card { HStack { ProgressView().controlSize(.small); Text(T("backup.preparing")).fontWeight(.medium) } }
                }
                if let r = model.lastBackupResults.first(where: { $0.destination == d.id }) {
                    lastResultCard(d, r)
                } else if let log = model.backups.lastLog, model.lastBackupResults.isEmpty, !model.isBackingUp {
                    // Échec avant les destinations : seul le journal peut l'expliquer.
                    HStack { Spacer(); Button(T("backup.view_log")) { Notifier.openLog(log) }.buttonStyle(.pill) }
                }
                if model.verifying.contains(d.id) || fullReports[d.id] != nil {
                    fullVerificationCard(d)
                }
                // Cartes d'une même rangée à la même hauteur : la rangée prend la hauteur de la plus haute.
                HStack(alignment: .top, spacing: 14) {
                    statCard(T("home.last_backup"), ds.lastSuccess.map(Fmt.date) ?? T("backup.never"),
                             ds.lastSuccess == nil ? (ds.lastError ?? "") : T("backup.transferred", Fmt.bytes(ds.lastBytesTransferred), Fmt.duration(ds.lastDuration)))
                    statCard(T("backup.next"), nextText(), waiting ? T("backup.waiting_since", ds.waitingSince.map(Fmt.date) ?? "—") : T("frequency.\(model.config?.schedule.frequency.rawValue ?? "daily")"))
                    statCard(T("backup.integrity"), ds.damagedVersions.isEmpty ? T("backup.integrity.ok") : T("backup.integrity.damaged", ds.damagedVersions.count),
                             ds.lastVerification.map { T("backup.integrity.checked", Fmt.date($0)) } ?? T("backup.integrity.never")) {
                        HStack(spacing: 8) {
                            Button(T("backup.verify.short")) { model.verify(d) }.buttonStyle(.pill).fixedSize()
                                .disabled(reason(.verify, d) != nil).help(reason(.verify, d).map { T($0) } ?? "")
                            Button(T("backup.verify_full.short")) { verifyFull(d) }.buttonStyle(.pill).fixedSize()
                                .disabled(reason(.verifyFull, d) != nil).help(reason(.verifyFull, d).map { T($0) } ?? "")
                        }
                    }
                }
                .fixedSize(horizontal: false, vertical: true)
                HStack(alignment: .top, spacing: 14) {
                    historyCard(d)
                    VStack(spacing: 14) {
                        retentionCard(d)
                        scheduleCard()
                    }
                    .frame(width: 370)
                }
                .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.horizontal, 32).padding(.vertical, 20)
        }
        // Historique lu dès l'ouverture, et relu quand la destination redevient joignable ou après une sauvegarde.
        .task(id: "\(d.id)|\(String(describing: probed))|\(model.isBackingUp)|\(model.versions[d.id] == nil)") {
            model.autoLoadVersions(d)
        }
    }

    /// Clé de la raison pour laquelle une action est indisponible (`nil` : disponible).
    func reason(_ action: BackupAction, _ d: CairnConfig.Destination) -> String? {
        let hasBackups = model.versions[d.id].map { !$0.isEmpty } ?? (model.runState[d.id].lastSuccess != nil)
        return BackupActions.unavailableReason(action, .init(reachable: model.destinationWaiting[d.id].map { !$0 },
                                                             backingUp: model.isBackingUp,
                                                             verifying: model.verifying.contains(d.id), hasBackups: hasBackups))
    }

    /// Menu « … » : simulation, adresse, suppression (en rouge, en dernier).
    func moreMenu(_ d: CairnConfig.Destination) -> some View {
        Menu {
            Button { model.backups.run(destinations: [d.id], dryRun: true) } label: { Label(T("backup.simulate"), systemImage: "play.circle") }
                .disabled(reason(.simulate, d) != nil)
            Button {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(d.url ?? d.path ?? "", forType: .string)
            } label: { Label(T("destination.copy_address"), systemImage: "link") }
            Divider()
            Button(role: .destructive) { deleting = d } label: { Label(T("destination.delete.menu"), systemImage: "trash") }
        } label: {
            Image(systemName: "ellipsis").font(.system(size: 14, weight: .semibold)).foregroundStyle(Palette.text)
                .frame(width: 36, height: 36).background(Palette.field, in: Circle()).contentShape(Circle())
        }
        .menuStyle(.button).buttonStyle(.plain).menuIndicator(.hidden).fixedSize()
        .help(T("destination.more"))
        .accessibilityLabel(T("destination.more"))
    }

    func statCard(_ title: String, _ value: String, _ detail: String) -> some View {
        statCard(title, value, detail) { EmptyView() }
    }

    func statCard<Actions: View>(_ title: String, _ value: String, _ detail: String, @ViewBuilder actions: () -> Actions) -> some View {
        Card(fill: true) {
            VStack(alignment: .leading, spacing: 6) {
                Text(title).font(.system(size: 13)).foregroundStyle(Palette.secondary)
                Text(value).font(.system(size: 20, weight: .semibold)).lineLimit(1).minimumScaleFactor(0.7)
                Text(detail).font(.system(size: 12.5)).foregroundStyle(Palette.secondary).lineLimit(2)
                Spacer(minLength: 0)
                actions().padding(.top, 4)
            }
        }
    }

    /// Résultat de la dernière sauvegarde ou simulation : volume par partie et total de la destination.
    func lastResultCard(_ d: CairnConfig.Destination, _ r: BackupService.Result) -> some View {
        Card {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text(r.outcome?.dryRun == true ? T("backup.result.simulation") : T("backup.result.backup"))
                        .font(.system(size: 15, weight: .semibold))
                    Spacer()
                    if let log = r.log { Button(T("backup.view_log")) { Notifier.openLog(log) }.buttonStyle(.pill) }
                    Button(T("backup.result.dismiss")) { model.lastBackupResults.removeAll { $0.destination == d.id } }.buttonStyle(.pill)
                }
                if let o = r.outcome {
                    ForEach(o.bytesByPart.sorted(by: { $0.key < $1.key }), id: \.key) { part, bytes in
                        HStack {
                            Text(part).font(.system(size: 12.5, design: .monospaced))
                            Spacer()
                            Text(Fmt.bytes(bytes)).font(.system(size: 12.5)).foregroundStyle(Palette.secondary)
                        }
                    }
                    Divider()
                    HStack {
                        Text(T("backup.result.total", model.destinationLabel(d))).fontWeight(.medium)
                        Spacer()
                        Text(T("backup.result.files", Fmt.bytes(o.totalBytes), Fmt.count(o.filesTransferred))).fontWeight(.medium)
                    }
                    ForEach(o.warnings, id: \.self) { Text($0).font(.system(size: 12.5)).foregroundStyle(Palette.foreground(.warning)) }
                    if !r.damagedFiles.isEmpty {
                        Text(T("backup.notify.damaged_body", r.damagedFiles.count)).font(.system(size: 12.5))
                            .foregroundStyle(Palette.foreground(.warning))
                    }
                    if let c = r.imageCheck, !c.ok {
                        Text(T("backup.image_check.failed", c.output)).font(.system(size: 12.5)).foregroundStyle(Palette.foreground(.warning))
                    }
                } else if let e = r.error {
                    Text(e).font(.system(size: 13)).foregroundStyle(r.waiting ? Palette.secondary : Palette.foreground(.warning))
                }
            }
        }
    }

    /// Rapport de la vérification complète, version par version.
    func fullVerificationCard(_ d: CairnConfig.Destination) -> some View {
        Card {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text(T("backup.verify_full.title")).font(.system(size: 15, weight: .semibold))
                    if model.verifying.contains(d.id) {
                        ProgressView().controlSize(.small)
                        Text(T("backup.verify_full.running")).font(.system(size: 12.5)).foregroundStyle(Palette.secondary)
                    }
                    Spacer()
                    if !model.verifying.contains(d.id) {
                        Button(T("backup.result.dismiss")) { fullReports[d.id] = nil }.buttonStyle(.pill)
                    }
                }
                ForEach(fullReports[d.id] ?? [], id: \.version) { r in
                    VStack(alignment: .leading, spacing: 2) {
                        HStack {
                            Circle().fill(r.damaged.isEmpty ? Palette.foreground(.success) : Color.orange).frame(width: 8, height: 8)
                            Text(r.version).font(.system(size: 12.5, design: .monospaced))
                            Spacer()
                            Text(r.missingChecksums ? T("backup.verify_full.pending")
                                                    : T("backup.verify_full.result", Fmt.count(r.checked), r.damaged.count))
                                .font(.system(size: 12.5)).foregroundStyle(Palette.secondary)
                        }
                        ForEach(r.damaged.prefix(10), id: \.self) { f in
                            Text("✗ " + f).font(.system(size: 11.5, design: .monospaced)).foregroundStyle(Palette.foreground(.warning))
                                .lineLimit(1).truncationMode(.middle)
                        }
                    }
                }
            }
        }
    }

    func verifyFull(_ d: CairnConfig.Destination) {
        fullReports[d.id] = nil
        model.verify(d, full: true) { reports in fullReports[d.id] = reports }
    }

    func nextText() -> String {
        guard let s = model.config?.schedule, s.frequency != .manual else { return T("frequency.manual") }
        let now = Date()
        let last = BackupSchedule.lastOccurrence(s, now: now) ?? now
        let step: TimeInterval = s.frequency == .daily ? 86_400 : 7 * 86_400
        return Fmt.date(last.addingTimeInterval(step))
    }

    /// Historique des sauvegardes de ce Mac sur la destination, lu automatiquement.
    func historyCard(_ d: CairnConfig.Destination) -> some View {
        let loading = model.versionsLoading.contains(d.id)
        let shown = 12
        return Card(fill: true) {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 8) {
                    Text(T("backup.history")).font(.system(size: 15, weight: .semibold))
                    if let v = model.versions[d.id], !v.isEmpty {
                        Text(T("backup.history.count", v.count)).foregroundStyle(Palette.secondary).font(.system(size: 12.5))
                    }
                    Spacer()
                    if loading { ProgressView().controlSize(.small) }
                    Button { model.loadVersions(d) } label: { Label(T("backup.history.refresh"), systemImage: "arrow.clockwise") }
                        .buttonStyle(.pill).disabled(loading || model.isBackingUp)
                }
                if let versions = model.versions[d.id], !versions.isEmpty {
                    ForEach(versions.reversed().prefix(shown)) { v in
                        HStack {
                            Circle().fill(v.damaged ? Color.orange : Palette.foreground(.success)).frame(width: 8, height: 8)
                            Text(Fmt.date(v.date)).fontWeight(.medium)
                            if v.damaged { Badge(text: T("backup.damaged"), tone: .warning) }
                            Spacer()
                            Text(v.name).font(.system(size: 11.5, design: .monospaced)).foregroundStyle(Palette.secondary)
                        }
                        .padding(.vertical, 4)
                    }
                    if versions.count > shown {
                        Text(T("backup.history.more", versions.count - shown)).font(.system(size: 12.5)).foregroundStyle(Palette.secondary)
                    }
                } else {
                    Text(historyPlaceholder(d, loading: loading)).foregroundStyle(Palette.secondary).font(.system(size: 13))
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
            }
        }
    }

    func historyPlaceholder(_ d: CairnConfig.Destination, loading: Bool) -> String {
        if loading { return T("backup.history.loading") }
        if let e = model.versionsError[d.id] { return T("backup.history.error", e) }
        if model.destinationWaiting[d.id] == true { return T("backup.history.unreachable") }
        return model.versions[d.id] == nil ? T("backup.history.loading") : T("backup.history.empty")
    }

    func retentionCard(_ d: CairnConfig.Destination) -> some View {
        let mode: Int = switch d.retention {
        case .tiered(30, 48): 0
        case .count: 1
        default: 2
        }
        let cov = RetentionPolicy.coverage(d.retention, frequency: model.config?.schedule.frequency ?? .daily)
        return Card {
            VStack(alignment: .leading, spacing: 12) {
                Text(T("backup.retention")).font(.system(size: 15, weight: .semibold))
                TabBar(options: [(0, T("backup.retention.recommended")), (1, T("backup.retention.count")), (2, T("backup.retention.custom"))],
                       selection: Binding(get: { mode }, set: { m in
                           guard m != mode else { return }
                           switch m {
                           case 0: change(d, .recommended)
                           case 1: change(d, .count(12))
                           default: change(d, .tiered(days: 14, weeks: 26))
                           }
                       }))
                switch d.retention {
                case let .count(n):
                    Stepper(T("backup.retention.versions", n), value: Binding(get: { n }, set: { change(d, .count($0)) }), in: 1...520)
                case let .tiered(days, weeks) where mode == 2:
                    Stepper(T("backup.retention.days", days), value: Binding(get: { days }, set: { change(d, .tiered(days: $0, weeks: weeks)) }), in: 0...3650)
                    Stepper(T("backup.retention.weeks", weeks), value: Binding(get: { weeks }, set: { change(d, .tiered(days: days, weeks: $0)) }), in: 0...520)
                default:
                    Text(T("backup.retention.recommended_detail")).font(.system(size: 12.5)).foregroundStyle(Palette.secondary)
                }
                Text(T("backup.retention.coverage", cov.days / 30 >= 12 ? T("backup.retention.years", Fmt.number(Double(cov.days) / 365, digits: 1)) : T("backup.retention.days_n", cov.days), cov.maxVersions))
                    .font(.system(size: 13))
            }
        }
    }

    func scheduleCard() -> some View {
        let s = model.config?.schedule ?? CairnConfig.Schedule()
        return Card(fill: true) {
            VStack(alignment: .leading, spacing: 10) {
                Text(T("settings.schedule")).font(.system(size: 15, weight: .semibold))
                Text(s.frequency == .manual ? T("frequency.manual") : "\(T("frequency.\(s.frequency.rawValue)")) · \(s.time)")
                Toggle(T("onboarding.schedule.background_toggle"), isOn: Binding(get: { s.background }, set: { v in model.updateConfig { $0.schedule.background = v } }))
                Text(T("settings.battery", s.onBatteryMinPercent)).font(.system(size: 12.5)).foregroundStyle(Palette.secondary)
                Text(T("backup.never_wakes")).font(.system(size: 12.5)).foregroundStyle(Palette.secondary)
                Spacer(minLength: 0)
            }
            .font(.system(size: 13.5))
        }
    }

    /// Un changement de rétention qui supprimerait des versions demande une confirmation.
    func change(_ d: CairnConfig.Destination, _ r: CairnConfig.Retention) {
        model.checkRetention(d, r) { found in
            // Destination illisible : une rétention plus courte n'est pas enregistrée (elle supprimerait des versions
            // à la prochaine sauvegarde, sans confirmation possible).
            guard let (excess, bytes) = found else {
                if RetentionPolicy.mayDeleteMore(r, than: d.retention) {
                    model.lastMessage = T("backup.retention.unreachable")
                } else {
                    model.updateConfig { c in if let i = c.destinations.firstIndex(where: { $0.id == d.id }) { c.destinations[i].retention = r } }
                }
                return
            }
            if excess.isEmpty {
                model.updateConfig { c in if let i = c.destinations.firstIndex(where: { $0.id == d.id }) { c.destinations[i].retention = r } }
            } else {
                pendingRetention = (r, excess, bytes)
                confirmRetention = true
            }
        }
        model.pendingRetentionDestination = d.id
    }

    func applyPendingRetention() {
        guard let (r, excess, _) = pendingRetention, let id = model.pendingRetentionDestination else { return }
        model.updateConfig { c in if let i = c.destinations.firstIndex(where: { $0.id == id }) { c.destinations[i].retention = r } }
        if let d = model.config?.destinations.first(where: { $0.id == id }) { model.deleteVersions(d, excess) }
        pendingRetention = nil
    }
}

extension AppModel {
    /// Lit l'historique à l'ouverture de la page : destination pas connue injoignable, rien de déjà lu ou en cours,
    /// aucune sauvegarde en cours (elle tient l'image montée). Rien en mode `--snapshot`. Une erreur précédente ne
    /// bloque pas : l'appel vient du `.task(id:)` de la page, relancé seulement à l'ouverture, quand la destination
    /// redevient joignable ou après une sauvegarde, donc sans boucle de nouvelles tentatives.
    func autoLoadVersions(_ d: CairnConfig.Destination) {
        guard !Self.offline, !isBackingUp, destinationWaiting[d.id] != true, versions[d.id] == nil,
              !versionsLoading.contains(d.id) else { return }
        loadVersions(d)
    }

    /// Liste les sauvegardes de ce Mac sur une destination, en arrière-plan ; démonte toujours ce qui a été monté.
    func loadVersions(_ d: CairnConfig.Destination) {
        guard !Self.offline, !versionsLoading.contains(d.id) else { return }
        versionsLoading.insert(d.id)
        versionsError[d.id] = nil
        Task.detached(priority: .userInitiated) {
            let session = DestinationSession(d)
            var list: [VersionInfo] = []
            var failure: String?
            do {
                let root = try session.open(createIfMissing: false)
                let dir = BackupEngine.versionsDir(root: root)
                list = BackupEngine.versions(in: dir).compactMap { n in
                    BackupEngine.date(ofVersion: n).map { VersionInfo(name: n, date: $0, damaged: !Integrity.readDamaged(dir.appendingPathComponent(n)).isEmpty) }
                }
            } catch ProviderError.notCreated {
                // Destination encore vide : aucune sauvegarde.
            } catch { failure = String(describing: error) }
            session.close()
            let (l, e) = (list, failure)
            await MainActor.run {
                self.versionsLoading.remove(d.id)
                if let e { self.versionsError[d.id] = e; self.versions[d.id] = nil } else { self.versions[d.id] = l }
            }
        }
    }

    /// Calcule les versions en trop avec une nouvelle rétention. `nil` si la destination n'a pas pu être lue
    /// (injoignable, mot de passe absent…) ; une destination encore vide n'a rien en trop.
    func checkRetention(_ d: CairnConfig.Destination, _ r: CairnConfig.Retention, then: @escaping (([String], Int64)?) -> Void) {
        Task.detached(priority: .userInitiated) {
            let session = DestinationSession(d)
            var found: ([String], Int64)?
            if session.provider.isReachable() {
                do {
                    let root = try session.open(createIfMissing: false)
                    let dir = BackupEngine.versionsDir(root: root)
                    let excess = BackupEngine.excessVersions(versionsDir: dir, retention: r, now: Date())
                    found = (excess, BackupEngine.uniqueBytes(excess.map { dir.appendingPathComponent($0) }))
                } catch ProviderError.notCreated {
                    found = ([], 0)
                } catch {}
                session.close()
            }
            let f = found
            await MainActor.run { then(f) }
        }
    }

    func deleteVersions(_ d: CairnConfig.Destination, _ names: [String]) {
        Task.detached(priority: .userInitiated) {
            let session = DestinationSession(d)
            if let root = try? session.open(createIfMissing: false) {
                let dir = BackupEngine.versionsDir(root: root)
                for n in names { try? FileManager.default.removeItem(at: dir.appendingPathComponent(n)) }
                session.close(compact: true)
            }
            await MainActor.run { self.loadVersions(d) }
        }
    }

    /// Vérifie une destination en arrière-plan, sous le verrou d'opération : échantillon de la dernière version, ou
    /// toutes les versions (`full`). L'état (`runs.json`) est mis à jour par `BackupService.verify`, comme en ligne
    /// de commande.
    func verify(_ d: CairnConfig.Destination, full: Bool = false, then: @escaping ([Integrity.Report]) -> Void = { _ in }) {
        guard !verifying.contains(d.id) else { return }
        verifying.insert(d.id)
        let paths = self.paths
        Task.detached(priority: .utility) {
            var msg = ""
            var reports: [Integrity.Report] = []
            do {
                reports = try BackupService.verify(destination: d, paths: paths, full: full)
                if full {
                    msg = L10n.tr("backup.verify_full.summary", reports.count, reports.reduce(0) { $0 + $1.damaged.count })
                } else if let r = reports.last {
                    msg = L10n.tr("cli.verify.result", d.id, r.version, Fmt.count(r.checked), r.damaged.count)
                }
            } catch OperationLock.Failure.alreadyHeld {
                msg = L10n.tr("cli.busy")
            } catch { msg = String(describing: error) }
            let (m, list) = (msg, reports)
            await MainActor.run {
                self.verifying.remove(d.id)
                if !m.isEmpty { self.lastMessage = m }
                self.runState = RunState.load(self.paths)
                then(list)
            }
        }
    }
}
