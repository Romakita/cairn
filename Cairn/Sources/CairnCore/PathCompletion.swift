import Foundation

/// Complétion des chemins relatifs à un dossier (le home) pour les champs de saisie. Lecture seule.
public enum PathCompletion {
    public struct Suggestion: Equatable, Sendable, Identifiable {
        /// Chemin relatif complet proposé ; se termine par « / » pour un dossier.
        public var path: String
        public var isDirectory: Bool
        public var id: String { path }
    }

    /// Entrées de `base/<dossier saisi>` dont le nom commence par le dernier segment saisi (sans tenir compte
    /// de la casse). Les fichiers cachés ne sont proposés que si le segment commence par « . » ou si on est
    /// dans un sous-dossier ; les dossiers passent avant les fichiers, puis l'ordre alphabétique.
    public static func suggestions(for input: String, base: URL, excluding: Set<String> = [], limit: Int = 8) -> [Suggestion] {
        var text = input.trimmingCharacters(in: .whitespaces)
        if text.hasPrefix("~/") { text.removeFirst(2) }
        if text.hasPrefix("/") || text.contains("..") { return [] }
        let slash = text.lastIndex(of: "/")
        let dir = slash.map { String(text[..<text.index(after: $0)]) } ?? ""
        let prefix = slash.map { String(text[text.index(after: $0)...]) } ?? text
        let showHidden = prefix.hasPrefix(".") || !dir.isEmpty
        let folder = dir.isEmpty ? base : base.appendingPathComponent(dir, isDirectory: true)
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: folder.path) else { return [] }

        let matches = names.filter { name in
            (showHidden || !name.hasPrefix(".")) && name != ".DS_Store"
                && name.lowercased().hasPrefix(prefix.lowercased()) && name != prefix
        }
        let items = matches.compactMap { name -> Suggestion? in
            var isDir: ObjCBool = false
            guard FileManager.default.fileExists(atPath: folder.appendingPathComponent(name).path, isDirectory: &isDir) else { return nil }
            let path = dir + name + (isDir.boolValue ? "/" : "")
            if excluding.contains(dir + name) { return nil }
            return Suggestion(path: path, isDirectory: isDir.boolValue)
        }
        return Array(items.sorted { a, b in
            a.isDirectory != b.isDirectory ? a.isDirectory : a.path.localizedStandardCompare(b.path) == .orderedAscending
        }.prefix(limit))
    }
}
