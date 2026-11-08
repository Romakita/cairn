import CairnCore
import AppKit
import SwiftUI

@MainActor
final class AppModel: ObservableObject {
    @AppStorage("rootPath") var rootPath: String = "/Volumes/workspaces"

    @Published var result: ScanResult?
    @Published var volume: VolumeInfo?
    @Published var isScanning = false
    @Published var scannedFiles = 0
    @Published var scannedBytes: Int64 = 0
    @Published var currentPath = ""
    @Published var path: [Node] = []          // fil d'Ariane de l'explorateur
    @Published var revision = 0               // incrémenté quand l'arbre change
    @Published var isDeleting = false
    @Published var lastMessage: String?

    private var ctx: ScanContext?
    private var timer: Timer?

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

    func scan() {
        cancel()
        let root = rootPath
        let ctx = ScanContext()
        self.ctx = ctx
        isScanning = true
        scannedFiles = 0
        scannedBytes = 0
        currentPath = root
        volume = Scanner.volumeInfo(for: root)

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
            let r = Scanner.scan(root: root, ctx: ctx)
            await MainActor.run {
                guard self.ctx === ctx else { return }
                self.timer?.invalidate()
                self.isScanning = false
                if ctx.cancelled { return }
                self.result = r
                self.path = []
                self.revision += 1
                self.lastMessage = T("scan.done", Fmt.duration(r.duration))
                    + (r.errors > 0 ? T("scan.errors", r.errors) : "")
            }
        }
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
