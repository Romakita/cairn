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

    var body: some View {
        let dests = model.config?.destinations ?? []
        Group {
            if let d = dests.first(where: { $0.id == model.selectedDestination }) ?? dests.first {
                detail(d)
            } else {
                VStack(spacing: 14) {
                    Image(systemName: "externaldrive.badge.plus").font(.system(size: 34)).foregroundStyle(Palette.secondary)
                    Text(T("backup.no_destination")).foregroundStyle(Palette.secondary)
                    Button(T("sidebar.add_destination")) { model.addDestination() }.buttonStyle(.pillPrimary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
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
        let waiting = model.destinationWaiting[d.id] ?? false
        return ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                HStack(spacing: 14) {
                    Image(systemName: d.provider == .smb ? "server.rack" : "externaldrive")
                        .font(.system(size: 22)).frame(width: 48, height: 48).background(Palette.field, in: RoundedRectangle(cornerRadius: 14))
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(spacing: 8) {
                            Text(model.destinationLabel(d)).font(.system(size: 22, weight: .semibold))
                            Badge(text: waiting ? T("backup.badge.waiting") : T("backup.badge.reachable"), tone: waiting ? .warning : .success)
                            if d.encrypted { Badge(text: T("backup.badge.encrypted")) } else { Badge(text: T("backup.badge.clear"), tone: .warning) }
                        }
                        Text(d.url ?? d.path ?? "").font(.system(size: 13)).foregroundStyle(Palette.secondary)
                    }
                    Spacer()
                    Button(T("backup.simulate")) { model.backups.run(destinations: [d.id], dryRun: true) }.buttonStyle(.pill)
                    Button(T("backup.verify")) { model.verify(d) }.buttonStyle(.pill)
                    if model.isBackingUp {
                        Button(T("action.stop")) { model.backups.cancel() }.buttonStyle(.pill)
                    } else {
                        Button(T("action.backup_now")) { model.backups.run(destinations: [d.id], dryRun: false) }.buttonStyle(.pillPrimary)
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
                }
                HStack(alignment: .top, spacing: 14) {
                    statCard(T("home.last_backup"), ds.lastSuccess.map(Fmt.date) ?? T("backup.never"),
                             ds.lastSuccess == nil ? (ds.lastError ?? "") : T("backup.transferred", Fmt.bytes(ds.lastBytesTransferred), Fmt.duration(ds.lastDuration)))
                    statCard(T("backup.next"), nextText(), waiting ? T("backup.waiting_since", ds.waitingSince.map(Fmt.date) ?? "—") : T("frequency.\(model.config?.schedule.frequency.rawValue ?? "daily")"))
                    statCard(T("backup.integrity"), ds.damagedVersions.isEmpty ? T("backup.integrity.ok") : T("backup.integrity.damaged", ds.damagedVersions.count),
                             ds.lastVerification.map { T("backup.integrity.checked", Fmt.date($0)) } ?? T("backup.integrity.never"))
                }
                HStack(alignment: .top, spacing: 14) {
                    versionsCard(d)
                    VStack(spacing: 14) {
                        retentionCard(d)
                        scheduleCard()
                    }
                    .frame(width: 340)
                }
            }
            .padding(.horizontal, 32).padding(.vertical, 20)
        }
    }

    func statCard(_ title: String, _ value: String, _ detail: String) -> some View {
        Card {
            VStack(alignment: .leading, spacing: 6) {
                Text(title).font(.system(size: 13)).foregroundStyle(Palette.secondary)
                Text(value).font(.system(size: 20, weight: .semibold)).lineLimit(1).minimumScaleFactor(0.7)
                Text(detail).font(.system(size: 12.5)).foregroundStyle(Palette.secondary).lineLimit(2)
            }
        }
    }

    func nextText() -> String {
        guard let s = model.config?.schedule, s.frequency != .manual else { return T("frequency.manual") }
        let now = Date()
        let last = BackupSchedule.lastOccurrence(s, now: now) ?? now
        let step: TimeInterval = s.frequency == .daily ? 86_400 : 7 * 86_400
        return Fmt.date(last.addingTimeInterval(step))
    }

    func versionsCard(_ d: CairnConfig.Destination) -> some View {
        Card {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text(T("backup.versions")).font(.system(size: 15, weight: .semibold))
                    if let v = model.versions[d.id] { Text(T("backup.versions_count", v.count)).foregroundStyle(Palette.secondary).font(.system(size: 12.5)) }
                    Spacer()
                    Button(T("backup.load_versions")) { model.loadVersions(d) }.buttonStyle(.pill)
                }
                if let versions = model.versions[d.id] {
                    ForEach(versions.reversed().prefix(30)) { v in
                        HStack {
                            Circle().fill(v.damaged ? Color.orange : Palette.foreground(.success)).frame(width: 8, height: 8)
                            Text(Fmt.date(v.date)).fontWeight(.medium)
                            if v.damaged { Badge(text: T("backup.damaged"), tone: .warning) }
                            Spacer()
                            Text(v.name).font(.system(size: 11.5, design: .monospaced)).foregroundStyle(Palette.secondary)
                        }
                        .padding(.vertical, 4)
                    }
                } else {
                    Text(T("backup.versions_hint")).foregroundStyle(Palette.secondary).font(.system(size: 13))
                }
            }
        }
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
                PillPicker(options: [(0, T("backup.retention.recommended")), (1, T("backup.retention.count")), (2, T("backup.retention.custom"))],
                           selection: Binding(get: { mode }, set: { m in
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
        return Card {
            VStack(alignment: .leading, spacing: 10) {
                Text(T("settings.schedule")).font(.system(size: 15, weight: .semibold))
                Text(s.frequency == .manual ? T("frequency.manual") : "\(T("frequency.\(s.frequency.rawValue)")) · \(s.time)")
                Toggle(T("onboarding.schedule.background_toggle"), isOn: Binding(get: { s.background }, set: { v in model.updateConfig { $0.schedule.background = v } }))
                Text(T("settings.battery", s.onBatteryMinPercent)).font(.system(size: 12.5)).foregroundStyle(Palette.secondary)
                Text(T("backup.never_wakes")).font(.system(size: 12.5)).foregroundStyle(Palette.secondary)
            }
            .font(.system(size: 13.5))
        }
    }

    /// Un changement de rétention qui supprimerait des versions demande une confirmation.
    func change(_ d: CairnConfig.Destination, _ r: CairnConfig.Retention) {
        model.checkRetention(d, r) { excess, bytes in
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
    func addDestination() {
        section = .settings
        lastMessage = T("backup.add_hint")
    }

    /// Liste les versions d'une destination (monte puis démonte).
    func loadVersions(_ d: CairnConfig.Destination) {
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
                session.close()
            } catch { failure = String(describing: error) }
            let (l, e) = (list, failure)
            await MainActor.run {
                self.versions[d.id] = l
                if let e { self.lastMessage = e }
            }
        }
    }

    /// Calcule les versions en trop avec une nouvelle rétention (destination joignable requise).
    func checkRetention(_ d: CairnConfig.Destination, _ r: CairnConfig.Retention, then: @escaping ([String], Int64) -> Void) {
        Task.detached(priority: .userInitiated) {
            let session = DestinationSession(d)
            var excess: [String] = []
            var bytes: Int64 = 0
            if session.provider.isReachable(), let root = try? session.open(createIfMissing: false) {
                let dir = BackupEngine.versionsDir(root: root)
                excess = BackupEngine.excessVersions(versionsDir: dir, retention: r, now: Date())
                bytes = BackupEngine.uniqueBytes(excess.map { dir.appendingPathComponent($0) })
                session.close()
            }
            let (e, b) = (excess, bytes)
            await MainActor.run { then(e, b) }
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

    func verify(_ d: CairnConfig.Destination) {
        Task.detached(priority: .utility) {
            let session = DestinationSession(d)
            var msg = ""
            do {
                let root = try session.open(createIfMissing: false)
                let dir = BackupEngine.versionsDir(root: root)
                if let last = BackupEngine.versions(in: dir).last {
                    let r = Integrity.verify(version: dir.appendingPathComponent(last), full: false)
                    msg = L10n.tr("cli.verify.result", d.id, last, Fmt.count(r.checked), r.damaged.count)
                    var state = RunState.load(self.paths)
                    var ds = state[d.id]
                    ds.lastVerification = Date()
                    if !r.damaged.isEmpty { ds.damagedVersions.append(last) }
                    state[d.id] = ds
                    try? state.save(self.paths)
                }
                session.close()
            } catch { msg = String(describing: error) }
            let m = msg
            await MainActor.run {
                self.lastMessage = m
                self.runState = RunState.load(self.paths)
            }
        }
    }
}
