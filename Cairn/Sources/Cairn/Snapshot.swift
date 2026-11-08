import AppKit
import CairnCore
import SwiftUI

/// Rendu hors écran des vues principales en PNG (vérification visuelle sans capture d'écran).
/// Usage : Cairn --snapshot <dossier> [dossier-à-analyser]
@MainActor
enum Snapshot {
    static func run(outDir: String, sample: String) {
        let app = NSApplication.shared
        app.setActivationPolicy(.prohibited)
        try? FileManager.default.createDirectory(atPath: outDir, withIntermediateDirectories: true)
        let scan = Scanner.scan(root: sample, ctx: ScanContext())
        let volume = Scanner.volumeInfo(for: sample)

        for lang in [AppLanguage.frFR, .enUS] {
            for dark in [false, true] {
                let model = AppModel()
                L10n.current = lang // après le chargement de config.toml, qui fixe sa propre langue
                model.showOnboarding = false
                model.rootPath = sample
                model.analyses = [sample: FolderAnalysis(
                    result: scan, bigObjects: BigObjects.find(in: scan.root, bigFiles: scan.bigFiles, folderThreshold: 1_000_000_000),
                    projects: Projects.find(in: scan.root))]
                model.applyCurrentFolder()
                model.volume = volume
                let suffix = "\(lang.lproj)-\(dark ? "dark" : "light")"
                let size = CGSize(width: 1280, height: 800)
                for (name, section) in [("home", AppSection.home), ("analysis", .analysis), ("settings", .settings), ("backup", .backup)] {
                    model.section = section
                    render(RootView().environmentObject(model), size: size, dark: dark, to: "\(outDir)/\(name)-\(suffix).png")
                }
                model.section = .analysis
                for tab in [AnalysisTab.projects, .bigFiles, .cleanable] {
                    model.analysisTab = tab
                    render(RootView().environmentObject(model), size: size, dark: dark, to: "\(outDir)/analysis-\(tab.rawValue)-\(suffix).png")
                }
                model.analysisTab = .explorer
                model.refreshSummary()
                model.storage.model = model
                model.storage.check()
                render(MenuBarPanel().environmentObject(model).background(Palette.content), size: CGSize(width: 360, height: 640),
                       dark: dark, to: "\(outDir)/menubar-\(suffix).png")
                for step in [0, 2, 4] {
                    render(OnboardingView(step: step).environmentObject(model).frame(width: size.width, height: size.height)
                            .background(Palette.content),
                           size: size, dark: dark, to: "\(outDir)/onboarding\(step + 1)-\(suffix).png")
                }
            }
        }
    }

    static func render<V: View>(_ view: V, size: CGSize, dark: Bool, to path: String) {
        let host = NSHostingView(rootView: view.environment(\.locale, L10n.locale))
        host.frame = NSRect(origin: .zero, size: size)
        let window = NSWindow(contentRect: host.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        window.contentView = host
        host.layoutSubtreeIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(0.6))
        host.layoutSubtreeIfNeeded()
        guard let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { return }
        host.cacheDisplay(in: host.bounds, to: rep)
        try? rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: path))
        window.contentView = nil
    }
}
