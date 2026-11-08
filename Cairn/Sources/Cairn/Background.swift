import AppKit
import CairnCore
import ServiceManagement

/// Fonctionnement en tâche de fond : ouverture à la connexion et maintien de l'app sans fenêtre.
/// N'est actif qu'avec l'accord de l'utilisateur (`schedule.background`).
@MainActor
final class BackgroundController {
    private(set) var enabled = false

    func apply(enabled: Bool, log: RunLog) {
        self.enabled = enabled
        let service = SMAppService.mainApp
        do {
            if enabled, service.status != .enabled {
                try service.register()
                log.write("login item registered (\(service.status.rawValue))")
            } else if !enabled, service.status == .enabled {
                try service.unregister()
                log.write("login item unregistered")
            }
        } catch {
            log.write("SMAppService failed: \(error) — fallback")
            if enabled { addLoginItemFallback(log: log) }
        }
    }

    /// Solution de repli : élément d'ouverture ajouté via System Events.
    private func addLoginItemFallback(log: RunLog) {
        let path = Bundle.main.bundlePath
        guard path.hasSuffix(".app") else { return }
        let script = "tell application \"System Events\" to make login item at end with properties {path:\"\(path)\", hidden:true}"
        var error: NSDictionary?
        NSAppleScript(source: script)?.executeAndReturnError(&error)
        log.write(error == nil ? "login item added via System Events" : "System Events failed: \(error!)")
    }

    /// Fenêtre fermée : l'app reste dans la barre des menus (pas d'icône dans le Dock).
    func windowsClosed() {
        if enabled { NSApp.setActivationPolicy(.accessory) }
    }

    func windowOpened() {
        NSApp.setActivationPolicy(.regular)
    }
}
