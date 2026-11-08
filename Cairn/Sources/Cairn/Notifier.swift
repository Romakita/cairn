import AppKit
import Foundation
import UserNotifications

/// Accès aux notifications : UNUserNotificationCenter n'existe que dans un bundle .app (pas en debug ni en ligne de commande).
enum Notifier {
    static var available: Bool { Bundle.main.bundleIdentifier != nil && Bundle.main.bundlePath.hasSuffix(".app") }
    static var center: UNUserNotificationCenter? { available ? UNUserNotificationCenter.current() : nil }

    /// Catégorie des notifications qui citent un journal, et son action « Voir le journal ».
    static let logCategory = "cairn.log"
    static let openLogAction = "cairn.open-log"
    /// Clé de `userInfo` qui porte le chemin du journal.
    static let logKey = "log"

    /// Enregistre l'action « Voir le journal » et le délégué qui l'exécute (à appeler une fois au démarrage).
    @MainActor static func setup() {
        guard let c = center else { return }
        c.delegate = NotifierDelegate.shared
        let open = UNNotificationAction(identifier: openLogAction, title: T("backup.notify.view_log"), options: [.foreground])
        c.setNotificationCategories([UNNotificationCategory(identifier: logCategory, actions: [open], intentIdentifiers: [])])
    }

    /// Publie une notification ; avec `log`, un clic (ou l'action) ouvre le journal.
    static func post(title: String, body: String, log: URL? = nil) {
        let c = UNMutableNotificationContent()
        c.title = title
        c.body = body
        if let log {
            c.categoryIdentifier = logCategory
            c.userInfo = [logKey: log.path]
        }
        center?.add(UNNotificationRequest(identifier: UUID().uuidString, content: c, trigger: nil))
    }

    /// Ouvre un journal dans l'application par défaut (Console).
    static func openLog(_ url: URL) {
        guard FileManager.default.fileExists(atPath: url.path) else { return }
        NSWorkspace.shared.open(url)
    }
}

/// Réponse aux notifications : ouvre le journal cité. Les notifications restent muettes quand l'app est au premier plan
/// (pas de `willPresent`), comme avant.
final class NotifierDelegate: NSObject, UNUserNotificationCenterDelegate {
    static let shared = NotifierDelegate()

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        if [Notifier.openLogAction, UNNotificationDefaultActionIdentifier].contains(response.actionIdentifier),
           let path = response.notification.request.content.userInfo[Notifier.logKey] as? String {
            let url = URL(fileURLWithPath: path)
            DispatchQueue.main.async { Notifier.openLog(url) }
        }
        completionHandler()
    }
}
