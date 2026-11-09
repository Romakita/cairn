import CairnCore
import SwiftUI

/// `Category` de CairnCore (le nom seul entre en conflit avec le `Category` d'Objective-C).
typealias Category = CairnCore.Category

/// Le SDK des Command Line Tools ne livre pas le plugin de macro @State : on utilise directement le property wrapper.
public typealias ViewState = SwiftUI.State

/// Raccourci de traduction pour les vues.
public func T(_ key: String, _ args: CVarArg...) -> String { L10n.tr(key, args: args) }

extension Array {
    public subscript(safe index: Int) -> Element? { indices.contains(index) ? self[index] : nil }
}
