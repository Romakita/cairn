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
        AppModel.offline = true // aucune lecture de destination (montage, réseau)
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
                // Historique de démonstration pour la page Sauvegardes (la vraie destination n'est jamais lue).
                if let d = model.config?.destinations.first {
                    model.destinationWaiting[d.id] = false
                    model.versions[d.id] = (0..<16).reversed().map { i in
                        let date = Date().addingTimeInterval(-Double(i) * 86_400)
                        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd_HHmmss"
                        return VersionInfo(name: f.string(from: date), date: date, damaged: i == 5)
                    }
                }
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
                renderDestinationStates(model: model, outDir: outDir, suffix: suffix, size: size, dark: dark)
                for step in OnboardingView.steps.indices {
                    render(OnboardingView(step: step).environmentObject(model).frame(width: size.width, height: size.height)
                            .background(Palette.content),
                           size: size, dark: dark, to: "\(outDir)/onboarding\(step + 1)-\(suffix).png")
                }
            }
        }
    }

    /// Étape Destination de l'assistant : dossier local vérifié (avec une sauvegarde d'un autre Mac), NAS dont le
    /// mot de passe est refusé, serveur injoignable ; et la feuille « Ajouter une destination » de l'app.
    /// Aucun réseau : les états NAS sont posés directement, le dossier local est un vrai dossier de démonstration.
    static func renderDestinationStates(model: AppModel, outDir: String, suffix: String, size: CGSize, dark: Bool) {
        let step = OnboardingView.steps.firstIndex(of: "destination")!
        let demo = URL(fileURLWithPath: outDir).appendingPathComponent("destination-demo/Sauvegardes")
        for sub in ["cairn-MacBook-Pro.sparsebundle", "Archives", "Photos", "Mac mini"] {
            try? FileManager.default.createDirectory(at: demo.appendingPathComponent(sub), withIntermediateDirectories: true)
        }
        let local = DestinationFormModel(kind: .local)
        local.open(demo, verify: false)
        if case let .ok(free, images) = DestinationProbe.checkFolder(demo) { local.status = .verified(freeBytes: free, images: images) }

        let auth = DestinationFormModel(kind: .smb)
        auth.smbAddress = "smb://nas.local/backups"
        auth.smbUser = "romain"
        auth.password = "secret"
        auth.status = .failed(.authenticationFailed)

        let unreachable = DestinationFormModel(kind: .smb)
        unreachable.smbAddress = "smb://nas.local/backups"
        unreachable.smbUser = "romain"
        unreachable.status = .failed(.unreachable("nas.local"))

        for (name, form) in [("local", local), ("nas", auth), ("error", unreachable)] {
            render(OnboardingView(step: step, form: form).environmentObject(model).frame(width: size.width, height: 1100)
                    .background(Palette.content),
                   size: CGSize(width: size.width, height: 1100), dark: dark, to: "\(outDir)/destination-\(name)-\(suffix).png")
        }
        let sheet = DestinationFormModel(kind: .local)
        sheet.open(demo, verify: false)
        render(AddDestinationSheet(form: sheet).environmentObject(model), size: CGSize(width: 760, height: 720), dark: dark,
               to: "\(outDir)/add-destination-\(suffix).png")
        // Modification d'un NAS et suppression (simulation des sauvegardes affichée).
        let nas = CairnConfig.Destination(id: "main", provider: .smb, url: "smb://nas.local/backups/mac", username: "romain")
        render(AddDestinationSheet(editing: nas).environmentObject(model), size: CGSize(width: 760, height: 720), dark: dark,
               to: "\(outDir)/edit-destination-\(suffix).png")
        let plan = DestinationRemoval.Plan(destination: nas, includeBackups: true, machine: BackupEngine.machineName(), items: [
            .configuration(id: nas.id), .state(id: nas.id),
            .backups(path: "/Volumes/backups/mac/cairn-\(BackupEngine.machineName()).sparsebundle", bytes: 48_300_000_000),
            .imagePassword(service: Keychain.servicePrefix + "image.main", account: BackupEngine.machineName()),
        ])
        render(DeleteDestinationSheet(destination: nas, includeBackups: true, simulated: plan).environmentObject(model),
               size: CGSize(width: 640, height: 620), dark: dark, to: "\(outDir)/delete-destination-\(suffix).png")
        render(DeleteDestinationSheet(destination: nas).environmentObject(model),
               size: CGSize(width: 640, height: 620), dark: dark, to: "\(outDir)/delete-destination-keep-\(suffix).png")
        for f in [local, auth, unreachable, sheet] { f.close() }
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
