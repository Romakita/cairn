import CairnCore
import SwiftUI

extension CairnCore.Category {
    /// Couleur réservée aux graphiques.
    public var color: Color {
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
