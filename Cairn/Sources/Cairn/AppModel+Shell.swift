import AppKit
import CairnCore
import SwiftUI
import UserNotifications

extension AppModel {
    enum GlobalStatus: String { case ok, attention, error }

    struct DiskAlert { let text: String; let critical: Bool }

    /// Dossiers suivis : ceux de la configuration, sinon le dossier analysé.
    var trackedFolders: [CairnConfig.Folder] {
        if let f = config?.folders, !f.isEmpty { return f }
        return [CairnConfig.Folder(path: rootPath)]
    }

    /// Alerte d'espace libre selon les seuils de la configuration.
    var diskAlert: DiskAlert? {
        guard let v = volume, v.total > 0 else { return nil }
        let a = config?.alerts ?? CairnConfig.Alerts()
        let freePct = Double(v.available) / Double(v.total) * 100
        let freeGB = Double(v.available) / 1_000_000_000
        let critical = freePct < a.criticalPercent || freeGB < a.criticalGB
        let low = freePct < a.lowPercent || freeGB < a.lowGB
        guard low || critical else { return nil }
        var text = T("alert.disk_low", v.name, Fmt.bytes(v.available), Fmt.number(freePct, digits: 1))
        if let r = root, r.regenerableBytes > 0 { text += " " + T("alert.reclaimable", Fmt.bytes(r.regenerableBytes)) }
        return DiskAlert(text: text, critical: critical)
    }

    /// Texte d'une alerte de volume : espace libre, prévision de remplissage, espace récupérable.
    func alertText(_ a: StorageAlerts.Alert) -> String {
        var text = T("alert.disk_low", a.volume, Fmt.bytes(a.available), Fmt.number(a.percentFree, digits: 1))
        if let d = a.daysToFull, d < 7 { text += " " + T("alerts.forecast", Fmt.number(d, digits: 0)) }
        if let s = summary, s.reclaimableBytes > 0 { text += " " + T("alert.reclaimable", Fmt.bytes(s.reclaimableBytes)) }
        return text
    }

    /// Erreur : configuration invalide ou dernière sauvegarde en échec. Attention : disque presque plein, dossier
    /// indisponible, versions abîmées, destination en attente depuis plus d'un jour.
    var globalStatus: GlobalStatus {
        if configIssues.contains(where: { $0.severity == .error }) { return .error }
        let now = Date()
        let schedule = config?.schedule ?? CairnConfig.Schedule()
        let backup = (config?.destinations ?? []).map {
            Health.destination(runState[$0.id], waiting: destinationWaiting[$0.id] == true, schedule: schedule, now: now)
        }.max() ?? .ok
        if backup == .error { return .error }
        if backup == .attention || diskAlert != nil || !activeAlerts.isEmpty || trackedFolders.contains(where: { !$0.isAvailable }) {
            return .attention
        }
        return .ok
    }

    /// Symbole de la barre des menus : animé pendant une sauvegarde, distinct pour l'attention et l'erreur.
    var menuBarSymbol: String {
        if isBackingUp { return menuBarFrame == 0 ? "arrow.triangle.2.circlepath" : "arrow.triangle.2.circlepath.circle" }
        switch globalStatus {
        case .ok: return "square.stack.3d.up"
        case .attention: return "exclamationmark.triangle"
        case .error: return "xmark.octagon"
        }
    }

    func destinationLabel(_ d: CairnConfig.Destination) -> String {
        switch d.provider {
        case .smb: return d.url.flatMap { URL(string: $0)?.host } ?? d.id
        case .local: return d.path.map { ($0 as NSString).lastPathComponent } ?? d.id
        }
    }

    /// Ajoute un dossier suivi (config.toml mis à jour) et l'analyse.
    func addFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.prompt = T("action.add")
        guard panel.runModal() == .OK, let url = panel.url else { return }
        if config != nil {
            updateConfig { c in
                if !c.folders.contains(where: { $0.expandedPath == url.path }) { c.folders.append(.init(path: url.path)) }
            }
        }
        rootPath = url.path
        section = .analysis
        scan()
    }

    /// Modifie la configuration et l'enregistre (commentaires et clés inconnues conservés).
    func updateConfig(_ change: (inout CairnConfig) -> Void) {
        var c = config ?? CairnConfig()
        change(&c)
        do {
            try store.save(c)
            loadConfig(reloaded: true)
        } catch {
            lastMessage = T("config.banner.error", String(describing: error))
        }
    }

    /// Change la langue immédiatement (sans redémarrage).
    func setLanguage(_ value: String) {
        updateConfig { $0.language = value }
        L10n.configure(explicit: value)
        languageRevision += 1
    }

    func revealConfig() {
        reveal(store.fileURL.path)
    }

    /// Recherche depuis l'accueil : ouvre le premier dossier dont le nom correspond.
    func search(_ query: String) {
        let q = query.trimmingCharacters(in: .whitespaces)
        section = .analysis
        analysisTab = .explorer
        guard !q.isEmpty, let root else { return }
        var found: Node?
        func visit(_ n: Node, depth: Int) {
            guard found == nil, depth <= 3 else { return }
            for c in n.children where c.isDirectory {
                if c.name.localizedCaseInsensitiveContains(q) { found = c; return }
            }
            for c in n.children where c.isDirectory && c.category == .source { visit(c, depth: depth + 1) }
        }
        visit(root, depth: 0)
        if let found { open(found) }
    }

    // MARK: - Assistant

    /// Termine l'assistant : enregistre le mot de passe éventuel, écrit config.toml et applique la configuration.
    func finishOnboarding(_ draft: OnboardingDraft, password: String, notifications: Bool) {
        if case let .smb(url, username) = draft.destination, !password.isEmpty, let host = OnboardingDraft.smbHost(url) {
            do { try Keychain.setInternetPassword(password, server: host, account: username) } catch {
                lastMessage = T("onboarding.keychain_error", String(describing: error))
            }
        }
        do {
            try store.save(draft.makeConfig())
        } catch {
            lastMessage = T("config.banner.error", String(describing: error))
            return
        }
        if notifications {
            Notifier.center?.requestAuthorization(options: [.alert, .sound]) { _, _ in }
        }
        loadConfig()
        section = .home
        scan()
    }

    /// « Restaurer une sauvegarde » depuis l'assistant : rien n'est écrit.
    func restoreInsteadOfOnboarding() {
        showOnboarding = false
        section = .restore
    }
}
