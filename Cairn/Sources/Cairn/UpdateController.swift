import AppKit
import CairnCore
import SwiftUI

/// Mise à jour de l'app : contrôle périodique des releases GitHub, proposition dans le rail, installation et relance.
@MainActor
final class UpdateController: ObservableObject {
    enum Phase: Equatable { case idle, checking, downloading, failed(String) }

    @Published var available: AppRelease?
    @Published var phase: Phase = .idle
    @Published var showPanel = false

    private weak var model: AppModel?
    private var timer: Timer?
    static let interval: TimeInterval = 6 * 3600

    /// Bundle remplaçable, ou nil (exécution de développement, dossier en lecture seule).
    let bundle = Updater.installableBundle()

    func start(model: AppModel) {
        self.model = model
        // Premier contrôle peu après le lancement, puis toutes les 6 heures si le réglage l'autorise.
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in self?.automaticCheck() }
        timer = Timer.scheduledTimer(withTimeInterval: Self.interval, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.automaticCheck() }
        }
    }

    private func automaticCheck() {
        guard model?.config?.checkUpdates ?? true else { return }
        check(manual: false)
    }

    /// Contrôle : silencieux en automatique, message à l'utilisateur en manuel.
    func check(manual: Bool) {
        guard phase != .checking, phase != .downloading else { return }
        phase = .checking
        Task {
            do {
                let r = try await Updater.check()
                available = r
                phase = .idle
                if manual {
                    if r != nil { showPanel = true }
                    else { model?.lastMessage = T("update.up_to_date", CairnVersion.current) }
                }
            } catch {
                phase = .idle
                if manual { model?.lastMessage = String(describing: error) }
            }
        }
    }

    /// Raison pour laquelle l'installation est impossible maintenant, sinon nil.
    var blocker: String? {
        if model?.isBackingUp == true { return T("update.blocked.backup") }
        if bundle == nil { return T("update.blocked.not_installable") }
        return nil
    }

    /// Télécharge et vérifie la release, programme le remplacement du bundle puis quitte (le script relance l'app).
    func install() {
        guard let r = available, let bundle, blocker == nil, phase != .downloading else { return }
        phase = .downloading
        Task {
            do {
                let app = try await Updater.download(r, replacing: bundle)
                // Une sauvegarde lancée pendant le téléchargement l'emporte.
                if let b = blocker {
                    try? FileManager.default.removeItem(at: app.deletingLastPathComponent())
                    phase = .failed(b)
                    return
                }
                try Updater.scheduleSwap(newApp: app, replacing: bundle)
                NSApp.terminate(nil)
            } catch {
                phase = .failed(String(describing: error))
            }
        }
    }

    func openReleasePage() {
        NSWorkspace.shared.open(available?.pageURL ?? Updater.releasesPage)
    }
}
