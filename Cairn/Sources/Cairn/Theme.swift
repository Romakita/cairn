import AppKit
import CairnCore
import SwiftUI

typealias Category = CairnCore.Category

/// Raccourci de traduction pour les vues.
func T(_ key: String, _ args: CVarArg...) -> String { L10n.tr(key, args: args) }

extension Color {
    /// Couleur qui suit le mode clair/sombre.
    init(light: UInt32, dark: UInt32) {
        self.init(nsColor: NSColor(name: nil) { appearance in
            let hex = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? dark : light
            return NSColor(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
                           blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
        })
    }
}

/// Jetons de couleur de Cairn (un seul accent, couleurs de catégories réservées aux graphiques).
enum Palette {
    static let content = Color(light: 0xFFFFFF, dark: 0x141416)
    static let sidebar = Color(light: 0xF7F7F8, dark: 0x1C1C20)
    static let rail = Color(light: 0xEFEFF2, dark: 0x18181B)
    static let railSelected = Color(light: 0xFFFFFF, dark: 0x2C2C32)
    static let rowSelected = Color(light: 0xE9E9EE, dark: 0x2A2A30)
    static let border = Color(light: 0xECECF1, dark: 0x2C2C32)
    static let field = Color(light: 0xF0F0F3, dark: 0x232328)
    static let text = Color(light: 0x0D0D0D, dark: 0xF4F4F5)
    static let secondary = Color(light: 0x6E6E80, dark: 0xA1A1AA)
    static let tertiary = Color(light: 0x3F3F4A, dark: 0xD4D4D8)
    static let accent = Color(light: 0x2563EB, dark: 0x3B82F6)
    static let primaryButton = Color(light: 0x0D0D0D, dark: 0xF4F4F5)
    static let primaryButtonText = Color(light: 0xFFFFFF, dark: 0x0D0D0D)

    enum Tone { case neutral, success, warning, danger, info }

    static func background(_ t: Tone) -> Color {
        switch t {
        case .neutral: Color(light: 0xF0F0F3, dark: 0x2A2A30)
        case .success: Color(light: 0xDCFCE7, dark: 0x14302A)
        case .warning: Color(light: 0xFFF4ED, dark: 0x3A2414)
        case .danger: Color(light: 0xFEE2E2, dark: 0x3F1D1D)
        case .info: Color(light: 0xEFF6FF, dark: 0x172554)
        }
    }

    static func foreground(_ t: Tone) -> Color {
        switch t {
        case .neutral: Color(light: 0x3F3F4A, dark: 0xD4D4D8)
        case .success: Color(light: 0x166534, dark: 0x86EFAC)
        case .warning: Color(light: 0x7C2D12, dark: 0xFDBA74)
        case .danger: Color(light: 0x991B1B, dark: 0xFCA5A5)
        case .info: Color(light: 0x1E40AF, dark: 0x93C5FD)
        }
    }
}

extension CairnCore.Category {
    /// Couleur réservée aux graphiques.
    var color: Color {
        switch self {
        case .source: Color(red: 0.23, green: 0.51, blue: 0.96)
        case .git: Color(red: 0.98, green: 0.45, blue: 0.09)
        case .deps: Color(red: 0.86, green: 0.15, blue: 0.47)
        case .build: Color(red: 0.96, green: 0.62, blue: 0.04)
        case .ios: Color(red: 0.55, green: 0.36, blue: 0.96)
        case .python: Color(red: 0.06, green: 0.73, blue: 0.51)
        case .cache: Color(red: 0.55, green: 0.62, blue: 0.68)
        case .trash: Color(red: 0.45, green: 0.45, blue: 0.45)
        }
    }
}
