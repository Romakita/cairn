import CairnCore
import CairnUI
import SwiftUI

// Progression de l'analyse (les graphiques sont dans CairnUI).

struct ScanningView: View {
    @EnvironmentObject var model: AppModel
    var body: some View {
        VStack(spacing: 14) {
            ProgressView().controlSize(.large)
            Text(T("scan.progress_title", model.rootPath)).font(.headline)
            Text(T("scan.progress", Fmt.count(model.scannedFiles), Fmt.bytes(model.scannedBytes)))
                .monospacedDigit().foregroundStyle(.secondary)
            Text(model.currentPath).font(.caption).foregroundStyle(.tertiary)
                .lineLimit(1).truncationMode(.middle).frame(maxWidth: 600)
            Button(T("action.stop")) { model.cancel() }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
