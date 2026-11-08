import SwiftUI

/// Le SDK des Command Line Tools ne livre pas le plugin de macro @State : on utilise directement le property wrapper.
typealias ViewState = SwiftUI.State
