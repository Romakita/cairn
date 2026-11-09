import AppKit
import CairnCore
import SwiftUI

extension Color {
    /// Couleur qui suit le mode clair/sombre.
    public init(light: UInt32, dark: UInt32) {
        self.init(nsColor: NSColor(name: nil) { appearance in
            let hex = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? dark : light
            return NSColor(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
                           blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
        })
    }
}

/// Jetons de couleur de Cairn, alignés sur le design de Codex (voir DESIGN.md) :
/// gris neutres, un seul accent bleu, noir pour l'action principale, couleurs de catégories réservées aux graphiques.
public enum Palette {
    public static let content = Color(light: 0xFFFFFF, dark: 0x181818)
    public static let sidebar = Color(light: 0xFCFCFC, dark: 0x1F1F1F)
    public static let rail = Color(light: 0xF3F3F3, dark: 0x1B1B1B)
    public static let railSelected = Color(light: 0xFFFFFF, dark: 0x2E2E2E)
    public static let rowSelected = Color(light: 0xEDEDED, dark: 0x2C2C2C)
    /// Survol d'une ligne cliquable.
    public static let rowHover = Color(light: 0xF6F6F6, dark: 0x222222)
    public static let border = Color(light: 0xE6E6E6, dark: 0x2F2F2F)
    /// Bordure d'un champ ou d'un menu déroulant (un peu plus marquée que celle des cartes).
    public static let fieldBorder = Color(light: 0xDCDCDC, dark: 0x3A3A3A)
    /// Fond gris des boutons secondaires, de l'onglet sélectionné et des pistes de jauge.
    public static let field = Color(light: 0xF2F2F2, dark: 0x2A2A2A)
    public static let fieldPressed = Color(light: 0xE6E6E6, dark: 0x333333)
    public static let text = Color(light: 0x222529, dark: 0xF2F2F2)
    public static let secondary = Color(light: 0x8F8F8F, dark: 0x9B9B9B)
    public static let tertiary = Color(light: 0x3D3D3D, dark: 0xD0D0D0)
    public static let placeholder = Color(light: 0x9A9A9A, dark: 0x6E6E6E)
    public static let accent = Color(light: 0x3B6FE0, dark: 0x5B8DEF)
    public static let primaryButton = Color(light: 0x0D0D0D, dark: 0xF2F2F2)
    public static let primaryButtonText = Color(light: 0xFFFFFF, dark: 0x0D0D0D)

    public enum Tone: CaseIterable { case neutral, success, warning, danger, info }

    public static func background(_ t: Tone) -> Color {
        switch t {
        case .neutral: Color(light: 0xF0F0F3, dark: 0x2A2A30)
        case .success: Color(light: 0xDCFCE7, dark: 0x14302A)
        case .warning: Color(light: 0xFFF4ED, dark: 0x3A2414)
        case .danger: Color(light: 0xFEE2E2, dark: 0x3F1D1D)
        case .info: Color(light: 0xEFF6FF, dark: 0x172554)
        }
    }

    public static func foreground(_ t: Tone) -> Color {
        switch t {
        case .neutral: Color(light: 0x3F3F4A, dark: 0xD4D4D8)
        case .success: Color(light: 0x166534, dark: 0x86EFAC)
        case .warning: Color(light: 0x7C2D12, dark: 0xFDBA74)
        case .danger: Color(light: 0x991B1B, dark: 0xFCA5A5)
        case .info: Color(light: 0x1E40AF, dark: 0x93C5FD)
        }
    }
}

extension Palette {
    /// Couleur d'identité d'un module de l'accueil (tuile d'icône et mini-graphiques). Les tons d'état restent
    /// réservés aux badges et aux bandeaux.
    public static func module(_ m: HubState.Module) -> Color {
        switch m {
        case .storage: Color(light: 0x2563EB, dark: 0x60A5FA)
        case .backup: Color(light: 0x0D9488, dark: 0x2DD4BF)
        case .git: Color(light: 0xEA580C, dark: 0xFB923C)
        case .ai: Color(light: 0x7C3AED, dark: 0xA78BFA)
        case .restore: Color(light: 0x4F46E5, dark: 0x818CF8)
        }
    }
}
