import AppKit
import CairnCore
import SwiftUI

/// Export statique du catalogue : une image PNG par story et par combinaison thème × langue, plus une page
/// `index.html` autonome qui les présente groupées. N'écrit que dans le dossier demandé.
@MainActor
public enum GalleryExport {
    public enum Failure: Error, Equatable {
        case cannotCreate(String)
        case invalidName(String)
        case renderFailed(String)
    }

    nonisolated public static let languages: [AppLanguage] = [.enUS, .frFR]
    nonisolated public static let themes: [(name: String, dark: Bool)] = [("light", false), ("dark", true)]

    /// Nom de fichier d'une image exportée, par exemple `badge.tones-fr-dark.png`.
    nonisolated public static func fileName(story: String, language: AppLanguage, theme: String) -> String {
        "\(story)-\(language.lproj)-\(theme).png"
    }

    /// Exporte `stories` dans `outDir` et renvoie le nombre d'images écrites.
    @discardableResult
    public static func run(outDir: URL, stories: [Story] = Stories.all, settle: TimeInterval = 0.25) throws -> Int {
        let dir = outDir.standardizedFileURL
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        } catch {
            throw Failure.cannotCreate(dir.path)
        }
        let saved = L10n.current
        defer { L10n.current = saved }
        var count = 0
        for story in stories {
            guard story.id.range(of: "^[a-z0-9_.]+$", options: .regularExpression) != nil else {
                throw Failure.invalidName(story.id)
            }
        }
        for language in languages {
            L10n.current = language
            // Le registre est relu dans chaque langue : les valeurs par défaut des contrôles sont traduites.
            let localized = Dictionary(uniqueKeysWithValues: Stories.all.map { ($0.id, $0) })
            for story in stories {
                let s = localized[story.id] ?? story
                for theme in themes {
                    let url = dir.appendingPathComponent(fileName(story: s.id, language: language, theme: theme.name))
                    guard url.standardizedFileURL.deletingLastPathComponent().path == dir.path else {
                        throw Failure.invalidName(s.id)
                    }
                    let ok = Offscreen.png(StoryCanvas(story: s), width: s.width + 2 * StoryCanvas.margin, dark: theme.dark,
                                           settle: settle, to: url)
                    guard ok else { throw Failure.renderFailed(s.id) }
                    count += 1
                }
            }
        }
        L10n.current = saved
        try indexHTML(stories: stories).write(to: dir.appendingPathComponent("index.html"), atomically: true, encoding: .utf8)
        return count
    }

    /// Page `index.html` : une section par groupe, une ligne par story avec ses quatre images.
    public static func indexHTML(stories: [Story]) -> String {
        func esc(_ s: String) -> String {
            s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;")
                .replacingOccurrences(of: ">", with: "&gt;").replacingOccurrences(of: "\"", with: "&quot;")
        }
        var body = ""
        for group in StoryGroup.allCases {
            let items = stories.filter { $0.group == group }
            guard !items.isEmpty else { continue }
            body += "<section><h2>\(esc(group.title))</h2>\n"
            for s in items {
                body += "<article id=\"\(esc(s.id))\"><h3>\(esc(s.title)) <code>\(esc(s.component))</code></h3><div class=\"grid\">\n"
                for language in languages {
                    for theme in themes {
                        let file = fileName(story: s.id, language: language, theme: theme.name)
                        body += "<figure class=\"\(theme.name)\"><img src=\"\(esc(file))\" alt=\"\(esc(s.id))\" loading=\"lazy\">"
                            + "<figcaption>\(language.lproj) · \(esc(T("gallery.toolbar.\(theme.name)")))</figcaption></figure>\n"
                    }
                }
                body += "</div></article>\n"
            }
            body += "</section>\n"
        }
        return """
        <!doctype html>
        <html lang="\(L10n.current.lproj)">
        <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>\(esc(T("gallery.window.title")))</title>
        <style>
        :root { color-scheme: light dark; --bg: #fff; --fg: #222529; --muted: #8f8f8f; --border: #e6e6e6; }
        @media (prefers-color-scheme: dark) { :root { --bg: #181818; --fg: #f2f2f2; --muted: #9b9b9b; --border: #2f2f2f; } }
        body { margin: 0; padding: 32px 16px; background: var(--bg); color: var(--fg); font: 14px -apple-system, system-ui, sans-serif; }
        main { max-width: 1400px; margin: 0 auto; }
        h1 { font-size: 24px; margin: 0 0 4px; } h2 { font-size: 18px; margin: 40px 0 8px; }
        h3 { font-size: 14px; font-weight: 500; margin: 24px 0 8px; } code { color: var(--muted); font-size: 12px; }
        p { color: var(--muted); margin: 0; }
        .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; }
        figure { margin: 0; border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }
        figure.dark { background: #181818; } figure.light { background: #fff; }
        img { display: block; max-width: 100%; height: auto; }
        figcaption { padding: 6px 10px; font-size: 11px; color: #8f8f8f; border-top: 1px solid var(--border); }
        </style>
        </head>
        <body><main>
        <h1>\(esc(T("gallery.window.title")))</h1>
        <p>\(esc(T("gallery.stories_count", stories.count))) · \(esc(T("gallery.export.subtitle")))</p>
        \(body)</main></body>
        </html>

        """
    }
}
