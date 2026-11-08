import AppKit
import CairnCore
import SwiftUI

struct RestoreVersion: Identifiable, Hashable {
    let machine: String
    let version: String
    let url: URL
    let partial: Bool
    var id: String { url.path }
}

/// Restauration : source → version → parties → récapitulatif. Rien n'est écrit avant « Restaurer ».
struct RestoreView: View {
    @EnvironmentObject var model: AppModel
    @ViewState private var step = 0
    @ViewState private var versions: [RestoreVersion] = []
    @ViewState private var source: RestoreSource?
    @ViewState private var session: DestinationSession?
    @ViewState private var plan = RestoreService.Plan()
    @ViewState private var sizes: [String: Int64] = [:]
    @ViewState private var busy = false
    @ViewState private var error: String?
    @ViewState private var results: [RestoreService.StepResult]?
    @ViewState private var confirming = false
    // Mac neuf : mots de passe saisis pour cette restauration seulement.
    @ViewState private var pending: CairnConfig.Destination?
    @ViewState private var askImagePassword = false
    @ViewState private var passwordInput = ""
    @ViewState private var sharePassword: String?
    @ViewState private var imagePassword: String?
    @ViewState private var nasURL = ""
    @ViewState private var nasUser = NSUserName()
    @ViewState private var quitMessage: String?
    /// Incrémenté après la création du volume : l'état « cible absente » est relu.
    @ViewState private var volumeRefresh = 0
    /// Résultat du bouton « Vérifier » (outils présents / manquants, rien n'est modifié).
    @ViewState private var checkResult: (present: [String], missing: [String])?

    static let steps = ["source", "version", "parts", "summary"]

    var body: some View {
        HStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    Text(T("restore.step.\(Self.steps[step]).heading")).font(.system(size: 26, weight: .medium))
                    if let error { Banner(icon: "exclamationmark.triangle", text: error, tone: .danger) }
                    if let quitMessage { Banner(icon: "xmark.app", text: quitMessage, tone: .warning) }
                    switch step {
                    case 0: sourceStep
                    case 1: versionStep
                    case 2: partsStep
                    default: summaryStep
                    }
                    if busy { ProgressView().controlSize(.small) }
                    HStack {
                        if step > 0 && results == nil { Button(T("action.back")) { step -= 1 }.buttonStyle(.pill) }
                        Spacer()
                        if step == 2 { Button(T("action.continue")) { computeSizes() }.buttonStyle(.pillPrimary).disabled(busy) }
                        if step == 3 && results == nil {
                            Button(T("restore.run")) { confirming = true }.buttonStyle(.pillPrimary).disabled(busy)
                        }
                    }
                }
                .frame(maxWidth: 680, alignment: .leading)
                .padding(.horizontal, 40).padding(.vertical, 28)
                .frame(maxWidth: .infinity)
            }
            if let s = source { sideSummary(s).frame(width: 320).padding(.trailing, 24).padding(.top, 28) }
        }
        .confirmationDialog(T("cli.restore.confirm"), isPresented: $confirming, titleVisibility: .visible) {
            Button(T("restore.run"), role: .destructive) { run() }
            Button(T("action.cancel"), role: .cancel) {}
        }
        .onAppear {
            // Arrivée depuis l'assistant (« Restaurer cette sauvegarde ») : destination présélectionnée.
            guard let (d, pw) = model.pendingRestore else { return }
            model.pendingRestore = nil
            sharePassword = pw
            imagePassword = nil
            openDestination(d)
        }
        .onDisappear { session?.close() }
    }

    // MARK: Étapes

    var sourceStep: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(T("restore.source.text")).foregroundStyle(Palette.tertiary)
            ForEach(model.config?.destinations ?? [], id: \.id) { d in
                Button { openDestination(d) } label: {
                    Label(model.destinationLabel(d), systemImage: d.provider == .smb ? "server.rack" : "externaldrive")
                }
                .buttonStyle(.pill)
            }
            Button { chooseFolder() } label: { Label(T("restore.source.folder"), systemImage: "folder") }.buttonStyle(.pill)
            if let d = pending {
                Card {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(T(askImagePassword ? "restore.password.image" : "restore.password.share")).font(.system(size: 14, weight: .medium))
                        Text(T("restore.password.hint")).font(.system(size: 12.5)).foregroundStyle(Palette.secondary)
                        HStack {
                            SecureField("", text: $passwordInput).cairnField().frame(maxWidth: 280)
                                .onSubmit { submitPassword(d) }
                            Button(T("restore.password.submit")) { submitPassword(d) }.buttonStyle(.pillPrimary)
                                .disabled(passwordInput.isEmpty || busy)
                        }
                    }
                }
            }
            Card {
                VStack(alignment: .leading, spacing: 8) {
                    Text(T("restore.nas.title")).font(.system(size: 14, weight: .medium))
                    HStack {
                        TextField(T("restore.nas.url"), text: $nasURL).cairnField()
                        TextField(T("restore.nas.user"), text: $nasUser).cairnField().frame(width: 140)
                        Button(T("restore.nas.connect")) {
                            sharePassword = nil; imagePassword = nil
                            openDestination(CairnConfig.Destination(id: "restore", provider: .smb, url: nasURL, username: nasUser))
                        }
                        .buttonStyle(.pill).disabled(!nasURL.hasPrefix("smb://") || busy)
                    }
                }
            }
        }
    }

    var versionStep: some View {
        Card(padding: 6) {
            VStack(alignment: .leading, spacing: 0) {
                if versions.isEmpty { Text(T("cli.restore.no_version")).foregroundStyle(Palette.secondary).padding(12) }
                ForEach(versions.reversed()) { v in
                    Button { pick(v.url) } label: {
                        HStack {
                            Text(BackupEngine.date(ofVersion: v.version).map(Fmt.date) ?? v.version).fontWeight(.medium)
                            if v.partial { Text(T("restore.version.partial")).font(.system(size: 12)).foregroundStyle(Palette.secondary) }
                            Spacer()
                            Text(v.machine).foregroundStyle(Palette.secondary)
                        }
                        .padding(12).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    var partsStep: some View {
        let s = source!
        _ = volumeRefresh
        return Card(padding: 4) {
            VStack(alignment: .leading, spacing: 0) {
                partToggle(T("restore.part.tools"), T("restore.part.tools_detail"), isOn: $plan.tools).disabled(s.toolsDir == nil)
                Divider()
                partToggle(T("settings.home"), T("restore.part.home_detail"), isOn: $plan.home).disabled(s.home == nil)
                ForEach(s.aiTools, id: \.self) { id in
                    Divider()
                    partToggle(AIProfiles.name(for: id), T("restore.part.ai_detail"), isOn: Binding(
                        get: { plan.ai.contains(id) }, set: { on in plan.ai.removeAll { $0 == id }; if on { plan.ai.append(id) } }))
                }
                if !s.aiTools.isEmpty {
                    Toggle(T("restore.replace_databases"), isOn: $plan.replaceDatabases).toggleStyle(.checkbox).padding(14)
                }
                ForEach(s.folders, id: \.name) { f in
                    Divider()
                    VStack(alignment: .leading, spacing: 8) {
                        partToggle(f.name, T("restore.part.folder_detail"), isOn: Binding(
                            get: { plan.folders[f.name] != nil }, set: { on in plan.folders[f.name] = on ? f.originalPath : nil }))
                        if let target = plan.folders[f.name] {
                            HStack {
                                Text(T("restore.target", target)).font(.system(size: 12.5)).foregroundStyle(Palette.secondary)
                                Button(T("restore.change")) { chooseTarget(f.name) }.buttonStyle(.pill)
                            }
                            .padding(.horizontal, 14)
                            if RestoreService.targetIsMissing(target) {
                                Banner(icon: "externaldrive.badge.exclamationmark", text: T("restore.missing_volume", target), tone: .warning) {
                                    if target.hasPrefix("/Volumes/workspaces") {
                                        Button(T("restore.create_volume")) { createVolume() }.buttonStyle(.pill)
                                    }
                                }
                                .padding(.horizontal, 14).padding(.bottom, 10)
                            }
                        }
                    }
                }
            }
        }
    }

    var summaryStep: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let results {
                Card {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(Array(results.enumerated()), id: \.offset) { _, r in
                            Label(r.step + (r.detail.isEmpty ? "" : " — " + r.detail), systemImage: r.ok ? "checkmark.circle" : "xmark.circle")
                                .foregroundStyle(r.ok ? Palette.text : Palette.foreground(.danger)).font(.system(size: 13))
                        }
                    }
                }
                Banner(icon: "person.badge.key", text: T("cli.restore.manual"), tone: .info)
            } else {
                Card {
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(sizes.keys.sorted(), id: \.self) { k in
                            HStack { Text(k); Spacer(); Text(Fmt.bytes(sizes[k] ?? 0)).monospacedDigit() }
                        }
                        Divider()
                        HStack { Text(T("restore.total")).fontWeight(.semibold); Spacer(); Text(Fmt.bytes(sizes.values.reduce(0, +))).fontWeight(.semibold) }
                    }
                }
                Text(T("restore.pre_restore_note")).font(.system(size: 12.5)).foregroundStyle(Palette.secondary)
            }
        }
    }

    func sideSummary(_ s: RestoreSource) -> some View {
        Card {
            VStack(alignment: .leading, spacing: 8) {
                Text(T("restore.chosen")).font(.system(size: 15, weight: .semibold))
                row(T("restore.date"), s.date.map(Fmt.date) ?? "—")
                row(T("restore.machine"), s.machine)
                row(T("restore.arch"), s.arch + (s.archMatches ? "" : " ⚠︎"))
                row(T("restore.format"), s.kind == .legacy ? "backup.sh" : "Cairn")
                if !s.archMatches { Text(T("cli.restore.arch_warning", s.arch, BackupEngine.arch())).font(.system(size: 12)).foregroundStyle(Palette.foreground(.warning)) }
                Text(T("restore.terminal_note")).font(.system(size: 12)).foregroundStyle(Palette.secondary).fixedSize(horizontal: false, vertical: true)
                if s.toolsDir != nil {
                    Divider()
                    Button(T("restore.verify")) { verify(s) }.buttonStyle(.pill).disabled(busy)
                    Text(T("restore.verify_note")).font(.system(size: 12)).foregroundStyle(Palette.secondary).fixedSize(horizontal: false, vertical: true)
                    if let c = checkResult {
                        Text(T("cli.restore.check", c.present.count, c.missing.count)).fontWeight(.medium)
                        ForEach(c.missing, id: \.self) { name in
                            Label(name, systemImage: "xmark.circle").font(.system(size: 12.5)).foregroundStyle(Palette.foreground(.warning))
                        }
                    }
                }
            }
            .font(.system(size: 13.5))
        }
    }

    func row(_ k: String, _ v: String) -> some View {
        HStack { Text(k).foregroundStyle(Palette.secondary); Spacer(); Text(v) }
    }

    func partToggle(_ title: String, _ detail: String, isOn: Binding<Bool>) -> some View {
        Toggle(isOn: isOn) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.system(size: 14, weight: .medium))
                Text(detail).font(.system(size: 12.5)).foregroundStyle(Palette.secondary)
            }
        }
        .toggleStyle(.checkbox).padding(14)
    }

    // MARK: Actions

    func openDestination(_ d: CairnConfig.Destination) {
        busy = true; error = nil
        session?.close(); session = nil
        let (sharePW, imagePW) = (sharePassword, imagePassword)
        Task.detached(priority: .userInitiated) {
            let s = DestinationSession(d)
            s.sharePassword = sharePW
            s.imagePassword = imagePW
            do {
                let root = try s.open(createIfMissing: false)
                let list = RestoreSource.versions(onDestinationRoot: root)
                    .map { RestoreVersion(machine: $0.machine, version: $0.version, url: $0.url, partial: $0.partial) }
                await MainActor.run { session = s; versions = list; pending = nil; step = 1; busy = false }
            } catch ProviderError.missingPassword {
                s.close()
                await MainActor.run { pending = d; askImagePassword = false; passwordInput = ""; busy = false }
            } catch ProviderError.missingImagePassword {
                s.close()
                await MainActor.run { pending = d; askImagePassword = true; passwordInput = ""; busy = false }
            } catch {
                s.close()
                let m = String(describing: error)
                await MainActor.run { self.error = m; busy = false }
            }
        }
    }

    func submitPassword(_ d: CairnConfig.Destination) {
        if askImagePassword { imagePassword = passwordInput } else { sharePassword = passwordInput }
        passwordInput = ""
        openDestination(d)
    }

    func chooseFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        guard panel.runModal() == .OK, let url = panel.url else { return }
        pick(url)
    }

    func pick(_ url: URL) {
        guard let s = RestoreSource.open(url) else { error = T("cli.restore.unknown_format", url.path); return }
        source = s
        var p = RestoreService.Plan()
        p.home = s.home != nil
        p.tools = s.toolsDir != nil
        p.ai = s.aiTools
        for f in s.folders { p.folders[f.name] = f.originalPath }
        plan = p
        error = nil
        checkResult = nil
        step = 2
    }

    func chooseTarget(_ name: String) {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        if panel.runModal() == .OK, let url = panel.url { plan.folders[name] = url.path }
    }

    func createVolume() {
        busy = true
        Task.detached {
            let (ok, out) = RestoreService.createWorkspacesVolume()
            await MainActor.run { busy = false; volumeRefresh += 1; if !ok { error = out } }
        }
    }

    /// Vérification seule : outils de l'inventaire présents ou manquants sur ce Mac.
    func verify(_ s: RestoreSource) {
        busy = true
        Task.detached(priority: .userInitiated) {
            let r = RestoreService(source: s).check()
            await MainActor.run { checkResult = r; busy = false }
        }
    }

    func computeSizes() {
        guard let s = source else { return }
        busy = true
        let p = plan
        Task.detached(priority: .userInitiated) {
            let sz = RestoreService(source: s).sizes(p)
            await MainActor.run { sizes = sz; busy = false; step = 3 }
        }
    }

    func run() {
        guard let s = source else { return }
        busy = true
        let p = plan
        let paths = model.paths
        Task.detached(priority: .userInitiated) {
            let lock = OperationLock(url: paths.operationLock)
            var res: [RestoreService.StepResult]
            do {
                try lock.acquire(operation: "restore")
                res = RestoreService(source: s).run(p, apply: true, waitForAdmin: { cmd in
                    RestoreService.openInTerminal(cmd)
                    return RestoreService.waitAfterAdmin(cmd)
                }, waitForQuit: { tool in
                    let m = T("restore.quit_tool", tool.displayName)
                    DispatchQueue.main.async { quitMessage = m }
                    let ok = RestoreService.waitUntilQuit(tool)
                    DispatchQueue.main.async { quitMessage = nil }
                    return ok
                })
                lock.release()
            } catch {
                res = [.init(step: "lock", ok: false, detail: T("cli.busy"))]
            }
            let r = res
            await MainActor.run { results = r; busy = false }
        }
    }
}
