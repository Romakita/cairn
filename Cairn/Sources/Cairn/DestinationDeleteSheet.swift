import CairnCore
import SwiftUI

/// « Supprimer la destination » : garder les sauvegardes (par défaut) ou les supprimer aussi, après une simulation
/// qui liste ce qui sera retiré. Seules les sauvegardes de ce Mac sont visées.
struct DeleteDestinationSheet: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let destination: CairnConfig.Destination
    @ViewState private var includeBackups: Bool
    /// Simulation de la suppression des sauvegardes (lecture de la destination).
    @ViewState private var simulated: DestinationRemoval.Plan?
    @ViewState private var simulating = false
    @ViewState private var deleting = false
    @ViewState private var error: String?
    @ViewState private var generation = 0

    init(destination: CairnConfig.Destination, includeBackups: Bool = false, simulated: DestinationRemoval.Plan? = nil) {
        self.destination = destination
        _includeBackups = ViewState(wrappedValue: includeBackups)
        _simulated = ViewState(wrappedValue: simulated)
    }

    /// Plan affiché : sans les sauvegardes, rien n'est lu sur la destination ; avec, il faut la simulation.
    var plan: DestinationRemoval.Plan? {
        includeBackups ? simulated : DestinationRemoval.plan(destination, includeBackups: false)
    }

    var body: some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 6) {
                Text(T("destination.delete.title", model.destinationLabel(destination))).font(.system(size: 22, weight: .medium))
                Text(T("destination.delete.text")).font(.system(size: 13.5)).foregroundStyle(Palette.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 28).padding(.top, 24).padding(.bottom, 18)
            Rectangle().fill(Palette.border).frame(height: 1)
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    HStack(spacing: 12) {
                        ChoiceTile(icon: "externaldrive.badge.checkmark", title: T("destination.delete.keep"),
                                   subtitle: T("destination.delete.keep.text"), selected: !includeBackups) { choose(false) }
                        ChoiceTile(icon: "trash", title: T("destination.delete.remove"),
                                   subtitle: T("destination.delete.remove.text"), selected: includeBackups) { choose(true) }
                    }
                    .fixedSize(horizontal: false, vertical: true)
                    preview
                    if let error { Banner(icon: "exclamationmark.triangle", text: error, tone: .danger) }
                }
                .padding(28)
            }
            Rectangle().fill(Palette.border).frame(height: 1)
            HStack(spacing: 12) {
                if includeBackups && simulated == nil && !simulating {
                    Label(T("destination.delete.need_simulation"), systemImage: "exclamationmark.circle")
                        .font(.system(size: 12.5)).foregroundStyle(Palette.secondary)
                }
                Spacer()
                Button(T("action.cancel")) { dismiss() }.buttonStyle(.pill).keyboardShortcut(.cancelAction)
                if includeBackups {
                    Button(T("backup.simulate")) { simulate() }.buttonStyle(.pill).disabled(simulating || deleting)
                }
                Button(role: .destructive) { delete() } label: {
                    if deleting { ProgressView().controlSize(.small) }
                    Text(includeBackups && (plan?.backupBytes ?? 0) > 0
                         ? T("destination.delete.confirm_all", Fmt.bytes(plan?.backupBytes ?? 0)) : T("destination.delete.confirm"))
                }
                .buttonStyle(.pillDanger)
                .disabled(!(plan?.canExecute ?? false) || simulating || deleting || model.isBackingUp)
                .help(model.isBackingUp ? T("backup.unavailable.running") : "")
            }
            .padding(.horizontal, 24).frame(height: 60)
        }
        .frame(width: 640, height: 620)
        .background(Palette.content)
    }

    @ViewBuilder var preview: some View {
        if simulating {
            Card(padding: 0) {
                SettingsRow(title: T("destination.delete.simulating"), subtitle: destination.url ?? destination.path) {
                    ProgressView().controlSize(.small)
                }
            }
        } else if let plan {
            VStack(alignment: .leading, spacing: 10) {
                SectionTitle(title: T("destination.delete.preview_title"))
                Card(padding: 0) {
                    VStack(spacing: 0) {
                        ForEach(plan.items.indices, id: \.self) { i in
                            if i > 0 { RowDivider() }
                            row(plan.items[i])
                        }
                        if includeBackups && !plan.items.contains(where: { if case .backups = $0 { true } else { false } })
                            && plan.backupsUnavailable == nil {
                            RowDivider()
                            SettingsRow(icon: "externaldrive", title: T("destination.delete.no_backups")) { EmptyView() }
                        }
                    }
                }
                if let why = plan.backupsUnavailable {
                    Banner(icon: "exclamationmark.triangle", text: T("destination.delete.error.unavailable", why), tone: .danger)
                }
                if !includeBackups || destination.provider == .smb {
                    Text(T(includeBackups ? "destination.delete.kept_share_password" : "destination.delete.kept_note"))
                        .font(.system(size: 12.5)).foregroundStyle(Palette.secondary)
                }
            }
        }
    }

    @ViewBuilder func row(_ item: DestinationRemoval.Item) -> some View {
        switch item {
        case let .configuration(id):
            SettingsRow(icon: "doc.text", title: T("destination.delete.item.config", id)) { EmptyView() }
        case .state:
            SettingsRow(icon: "clock.arrow.circlepath", title: T("destination.delete.item.state")) { EmptyView() }
        case .imagePassword:
            SettingsRow(icon: "key", title: T("destination.delete.item.password")) { EmptyView() }
        case let .backups(path, bytes):
            SettingsRow(icon: "trash", title: T("destination.delete.item.backups", Fmt.bytes(bytes)), subtitle: path) {
                EmptyView()
            }
        }
    }

    func choose(_ withBackups: Bool) {
        includeBackups = withBackups
        error = nil
        if !withBackups { simulated = nil; generation += 1; simulating = false }
    }

    func simulate() {
        generation += 1
        let (gen, d) = (generation, destination)
        simulating = true
        simulated = nil
        error = nil
        Task.detached(priority: .userInitiated) {
            let p = DestinationRemoval.plan(d, includeBackups: true)
            await MainActor.run {
                guard gen == generation else { return }
                simulated = p
                simulating = false
            }
        }
    }

    func delete() {
        guard let plan, plan.canExecute else { return }
        deleting = true
        error = nil
        let paths = model.paths
        Task.detached(priority: .userInitiated) {
            var failure: String?
            do { try DestinationRemoval.execute(plan, paths: paths) } catch OperationLock.Failure.alreadyHeld {
                failure = L10n.tr("cli.busy")
            } catch { failure = String(describing: error) }
            let f = failure
            await MainActor.run {
                deleting = false
                if let f { error = f; return }
                model.removeDestination(plan.destination)
                dismiss()
            }
        }
    }
}

extension AppModel {
    /// Retire une destination de `config.toml` et de l'état de l'interface (après `DestinationRemoval.execute`).
    func removeDestination(_ d: CairnConfig.Destination) {
        updateConfig { $0.destinations.removeAll { $0.id == d.id } }
        runState = RunState.load(paths)
        versions[d.id] = nil
        versionsError[d.id] = nil
        destinationWaiting[d.id] = nil
        lastBackupResults.removeAll { $0.destination == d.id }
        if selectedDestination == d.id { selectedDestination = config?.destinations.first?.id }
        lastMessage = T("destination.delete.done", destinationLabel(d))
    }
}
