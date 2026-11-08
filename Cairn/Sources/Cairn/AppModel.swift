import CairnCore
import AppKit
import SwiftUI

@MainActor
final class AppModel: ObservableObject {
    @AppStorage("rootPath") var rootPath: String = "/Volumes/workspaces"

    @Published var result: ScanResult?
    /// Analyse de chaque dossier suivi (clé : chemin).
    @Published var analyses: [String: FolderAnalysis] = [:]
    @Published var unavailableFolders: [String] = []
    @Published var bigObjects: [BigObject] = []
    @Published var projects: [Project] = []
    @Published var volume: VolumeInfo?
    @Published var isScanning = false
    @Published var scannedFiles = 0
    @Published var scannedBytes: Int64 = 0
    @Published var currentPath = ""
    @Published var path: [Node] = []          // fil d'Ariane de l'explorateur
    @Published var revision = 0               // incrémenté quand l'arbre change
    @Published var isDeleting = false
    @Published var lastMessage: String?

    /// Configuration valide en cours (`nil` avant le premier lancement complet).
    @Published var config: CairnConfig?
    @Published var configIssues: [ConfigIssue] = []

    // Navigation et état de l'interface.
    @Published var section: AppSection = .home
    @Published var analysisTab: AnalysisTab = .explorer
    @Published var showOnboarding = false
    @Published var languageRevision = 0
    let background = BackgroundController()

    private var ctx: ScanContext?
    private var timer: Timer?
    let paths = CairnPaths()
    lazy var store = ConfigStore(paths: paths)
    private var watcher: FileWatcher?
    private var janitorTimer: Timer?
    private lazy var appLog = RunLog(paths: paths, type: "app")

    init() {
        loadConfig()
        watcher = store.watch { [weak self] in
            MainActor.assumeIsolated { self?.loadConfig(reloaded: true) }
        }
        pruneLogs()
        janitorTimer = Timer.scheduledTimer(withTimeInterval: 86_400, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.pruneLogs() }
        }
    }

    /// Charge `config.toml`. En cas d'erreur, la dernière configuration valide est gardée.
    func loadConfig(reloaded: Bool = false) {
        guard store.exists else {
            showOnboarding = true
            return
        }
        do {
            let loaded = try store.load()
            configIssues = loaded.issues
            if loaded.hasErrors {
                lastMessage = T("config.banner.error", loaded.issues.first { $0.severity == .error }!.description)
                appLog.write("config invalid: \(loaded.issues)")
                return
            }
            let previousFolders = config?.folders
            let previousLanguage = config?.language
            config = loaded.config
            showOnboarding = false
            L10n.configure(explicit: loaded.config.language)
            if previousLanguage != nil && previousLanguage != loaded.config.language { languageRevision += 1 }
            background.apply(enabled: loaded.config.schedule.background, log: appLog)
            if let first = loaded.config.folders.first(where: \.isAvailable) { rootPath = first.expandedPath }
            appLog.write(reloaded ? "config reloaded" : "config loaded")
            if reloaded {
                revision += 1
                if previousFolders != loaded.config.folders && !isScanning { scan() }
            }
        } catch {
            configIssues = []
            lastMessage = T("config.banner.error", String(describing: error))
            appLog.write("config unreadable: \(error)")
        }
    }

    private func pruneLogs() {
        let removed = LogJanitor.prune(paths: paths, retentionDays: config?.logRetentionDays ?? 90)
        if !removed.isEmpty { appLog.write("logs pruned: \(removed.count)") }
    }

    var root: Node? { result?.root }
    var current: Node? { path.last ?? root }

    func chooseFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.directoryURL = URL(fileURLWithPath: rootPath)
        panel.prompt = T("action.choose")
        if panel.runModal() == .OK, let url = panel.url {
            rootPath = url.path
            scan()
        }
    }

    /// Analyse tous les dossiers suivis disponibles (les liens physiques communs ne sont comptés qu'une fois).
    func scan() {
        cancel()
        var folders = trackedFolders.filter(\.isAvailable).map(\.expandedPath)
        if folders.isEmpty && FileManager.default.fileExists(atPath: rootPath) { folders = [rootPath] }
        unavailableFolders = trackedFolders.filter { !$0.isAvailable }.map(\.expandedPath)
        guard !folders.isEmpty else { return }
        if !folders.contains(rootPath) { rootPath = folders[0] }
        let analysis = config?.analysis ?? CairnConfig.Analysis()
        let ctx = ScanContext(bigFileThreshold: Int64(analysis.bigFileThresholdMB) * 1_000_000)
        let folderThreshold = Int64(analysis.bigFolderThresholdGB * 1_000_000_000)
        self.ctx = ctx
        isScanning = true
        scannedFiles = 0
        scannedBytes = 0
        currentPath = folders[0]
        volume = Scanner.volumeInfo(for: rootPath)

        timer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, let ctx = self.ctx else { return }
                let s = ctx.snapshot()
                self.scannedFiles = s.files
                self.scannedBytes = s.bytes
                self.currentPath = s.current
            }
        }

        Task.detached(priority: .userInitiated) {
            let start = Date()
            let scans = Scanner.scanFolders(folders, ctx: ctx)
            var out: [String: FolderAnalysis] = [:]
            for scan in scans {
                guard let r = scan.result else { continue }
                out[scan.folder] = FolderAnalysis(
                    result: r,
                    bigObjects: BigObjects.find(in: r.root, bigFiles: r.bigFiles, folderThreshold: folderThreshold),
                    projects: Projects.find(in: r.root))
            }
            let analyses = out
            let errors = scans.compactMap(\.result).reduce(0) { $0 + $1.errors }
            let duration = Date().timeIntervalSince(start)
            await MainActor.run {
                guard self.ctx === ctx else { return }
                self.timer?.invalidate()
                self.isScanning = false
                if ctx.cancelled { return }
                self.analyses = analyses
                self.applyCurrentFolder()
                self.lastMessage = T("scan.done", Fmt.duration(duration)) + (errors > 0 ? T("scan.errors", errors) : "")
            }
        }
    }

    /// Affiche l'analyse du dossier courant.
    func applyCurrentFolder() {
        let a = analyses[rootPath]
        result = a?.result
        bigObjects = a?.bigObjects ?? []
        projects = a?.projects ?? []
        volume = Scanner.volumeInfo(for: rootPath)
        path = []
        revision += 1
    }

    /// Change de dossier affiché (sans nouvelle analyse s'il est déjà analysé).
    func select(folder: String) {
        guard folder != rootPath || result == nil else { return }
        rootPath = folder
        if analyses[folder] != nil { applyCurrentFolder() } else { scan() }
    }

    /// Taille totale des dossiers analysés.
    var totalAnalyzed: Int64 { analyses.values.reduce(0) { $0 + $1.result.root.size } }

    func node(at path: String) -> Node? {
        var found: Node?
        root?.walk { if found == nil && $0.path == path { found = $0 } }
        return found
    }

    func cancel() {
        ctx?.cancel()
        timer?.invalidate()
        isScanning = false
    }

    // MARK: - Navigation

    func open(_ node: Node) {
        guard node.isDirectory, node.category == .source || !node.children.isEmpty else { return }
        var chain: [Node] = []
        var n: Node? = node
        while let c = n, c !== root { chain.insert(c, at: 0); n = c.parent }
        path = chain
    }

    func goTo(index: Int) {
        path = index < 0 ? [] : Array(path.prefix(index + 1))
    }

    func reveal(_ path: String) {
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
    }

    func copyPath(_ path: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(path, forType: .string)
    }

    // MARK: - Listes dérivées

    func regenerableNodes() -> [Node] {
        var out: [Node] = []
        root?.walk { if $0.isDirectory && $0.category.isRegenerable { out.append($0) } }
        return out.sorted { $0.size > $1.size }
    }

    func gitRepos() -> [Node] {
        var out: [Node] = []
        root?.walk { if $0.isGitRepo { out.append($0) } }
        return out.sorted { $0.size > $1.size }
    }

    // MARK: - Suppression

    func remove(_ nodes: [Node], permanently: Bool) {
        guard !nodes.isEmpty else { return }
        isDeleting = true
        let items = nodes.map { ($0, $0.path) }
        Task.detached(priority: .userInitiated) {
            var removed: [Node] = []
            var failures: [String] = []
            let fm = FileManager()
            for (node, p) in items {
                do {
                    if permanently {
                        try fm.removeItem(atPath: p)
                    } else {
                        try fm.trashItem(at: URL(fileURLWithPath: p), resultingItemURL: nil)
                    }
                    removed.append(node)
                } catch {
                    failures.append(T("remove.failure_item", (p as NSString).lastPathComponent, error.localizedDescription))
                }
            }
            let removedNodes = removed
            let failed = failures
            await MainActor.run {
                let freed = removedNodes.reduce(Int64(0)) { $0 + $1.size }
                for n in removedNodes { n.detach() }
                let removedPaths = Set(removedNodes.map(\.path))
                self.result?.bigFiles.removeAll { f in removedPaths.contains { f.path == $0 || f.path.hasPrefix($0 + "/") } }
                self.path = self.path.filter { n in !removedPaths.contains { n.path == $0 || n.path.hasPrefix($0 + "/") } }
                self.volume = Scanner.volumeInfo(for: self.rootPath)
                if let r = self.result, var a = self.analyses[self.rootPath] {
                    let analysis = self.config?.analysis ?? CairnConfig.Analysis()
                    a.bigObjects = BigObjects.find(in: r.root, bigFiles: r.bigFiles,
                                                   folderThreshold: Int64(analysis.bigFolderThresholdGB * 1_000_000_000))
                    a.projects = Projects.find(in: r.root)
                    a.result = r
                    self.analyses[self.rootPath] = a
                    self.bigObjects = a.bigObjects
                    self.projects = a.projects
                }
                self.isDeleting = false
                self.revision += 1
                var msg = permanently
                    ? T("remove.deleted", removedNodes.count, Fmt.bytes(freed))
                    : T("remove.trashed", removedNodes.count, Fmt.bytes(freed))
                if !failed.isEmpty { msg += "\n" + T("remove.failures", failed.joined(separator: ", ")) }
                self.lastMessage = msg
            }
        }
    }
}

/// Analyse d'un dossier : arbre, gros objets et projets.
struct FolderAnalysis {
    var result: ScanResult
    var bigObjects: [BigObject]
    var projects: [Project]
}
