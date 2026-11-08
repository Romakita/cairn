import Foundation
import UserNotifications

/// Accès aux notifications : UNUserNotificationCenter n'existe que dans un bundle .app (pas en debug ni en ligne de commande).
enum Notifier {
    static var available: Bool { Bundle.main.bundleIdentifier != nil && Bundle.main.bundlePath.hasSuffix(".app") }
    static var center: UNUserNotificationCenter? { available ? UNUserNotificationCenter.current() : nil }
}
