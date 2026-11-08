import Foundation

/// Iconographie de Cairn : icônes Lucide (https://lucide.dev, licence ISC, version 1.61.0) embarquées en SVG dans
/// `Resources/Icons` (`lucide-<nom>.svg`, trait ramené à 1,6). Le code garde des noms de symboles SF comme
/// identifiants ; cette table donne l'icône Lucide de chacun. Un nom absent de la table reste un symbole SF.
public enum LucideIcons {
    public static let version = "1.61.0"

    /// Symbole SF → icône Lucide.
    public static let map: [String: String] = [
        // Navigation et structure
        "house": "house", "chart.pie": "chart-pie", "icloud.and.arrow.up": "cloud-upload", "sparkles": "sparkles",
        "terminal": "terminal", "arrow.triangle.branch": "git-branch", "arrow.counterclockwise": "rotate-ccw",
        "slider.horizontal.3": "sliders-horizontal", "sidebar.left": "panel-left", "square.stack.3d.up": "layers",
        "chevron.right": "chevron-right", "chevron.left": "chevron-left", "chevron.down": "chevron-down",
        "arrow.right": "arrow-right", "ellipsis": "ellipsis", "magnifyingglass": "search",
        "list.filter": "list-filter", "line.3.horizontal.decrease.circle": "list-filter",
        // Fichiers et stockage
        "folder": "folder", "folder.badge.plus": "folder-plus", "folder.fill.badge.gearshape": "folder-git-2",
        "doc": "file", "doc.text": "file-text", "doc.on.doc": "copy", "trash": "trash", "tray.full": "archive",
        "internaldrive": "hard-drive", "externaldrive": "hard-drive", "externaldrive.badge.plus": "hard-drive-download",
        "externaldrive.badge.xmark": "folder-x", "externaldrive.connected.to.line.below": "hard-drive",
        "server.rack": "server", "shippingbox": "package", "sum": "sigma",
        // Catégories d'analyse
        "hammer": "hammer", "iphone": "smartphone", "chevron.left.forwardslash.chevron.right": "code",
        // États et actions
        "plus": "plus", "minus": "minus", "checkmark": "check", "xmark": "x", "exclamationmark.triangle": "triangle-alert",
        "exclamationmark.circle": "circle-alert", "info.circle": "info", "xmark.octagon": "octagon-x",
        "xmark.circle": "circle-x", "xmark.app": "square-x", "checkmark.circle.fill": "circle-check",
        "circle": "circle", "minus.circle": "circle-minus", "checkmark.shield": "shield-check",
        "lock": "lock", "lock.open": "lock-open", "arrow.triangle.2.circlepath": "refresh-cw",
        "clock.arrow.circlepath": "rotate-ccw-clock", "wrench.and.screwdriver": "wrench",
        "checkmark.circle": "circle-check", "exclamationmark.octagon": "octagon-alert", "bell": "bell", "clock": "clock",
        "cloud": "cloud", "key": "key", "network": "network", "lock.shield": "shield", "menubar.rectangle": "app-window",
        "person.badge.key": "user-key", "externaldrive.badge.exclamationmark": "hard-drive",
        "checkmark.icloud": "cloud-check", "exclamationmark.icloud": "cloud-alert", "checklist": "list-checks",
    ]

    /// Fichier SVG d'une icône Lucide (nil si elle n'est pas embarquée).
    public static func url(lucide name: String) -> URL? {
        let file = "lucide-" + name
        return CairnResources.bundle.url(forResource: file, withExtension: "svg")
            ?? CairnResources.bundle.url(forResource: file, withExtension: "svg", subdirectory: "Icons")
    }

    /// Fichier SVG pour un nom de symbole SF (nil : pas d'équivalent Lucide, le symbole SF reste utilisé).
    public static func url(symbol: String) -> URL? { map[symbol].flatMap { url(lucide: $0) } }
}
