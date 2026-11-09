import AppKit
import CairnCore
import CairnUI
import Foundation
import Testing

/// Rendu hors écran depuis le processus de tests (pas de bundle .app, aucune fenêtre affichée).
@MainActor private func prepareRendering() {
    _ = NSApplication.shared
    NSApp.setActivationPolicy(.prohibited)
}

/// Composants publics déclarés dans `Sources/CairnUI/Components` (vues, styles de bouton, modificateurs).
private func publicComponents() throws -> Set<String> {
    let dir = packageRoot.appendingPathComponent("Sources/CairnUI/Components")
    let regex = try NSRegularExpression(pattern: #"public struct (\w+)(?:<[^>]*>)?\s*:\s*(?:View|ButtonStyle|ViewModifier)\b"#)
    var names: Set<String> = []
    for f in FileManager.default.subpaths(atPath: dir.path) ?? [] where f.hasSuffix(".swift") {
        let text = try String(contentsOf: dir.appendingPathComponent(f), encoding: .utf8)
        let ns = text as NSString
        for m in regex.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            names.insert(ns.substring(with: m.range(at: 1)))
        }
    }
    return names
}

extension CairnTests {
    @Suite struct GalleryTests {
        @Test func story_ids_are_unique() throws {
            let ids = Stories.all.map(\.id)
            try #require(!ids.isEmpty, "registre vide")
            let duplicates = Dictionary(grouping: ids, by: { $0 }).filter { $0.value.count > 1 }.keys.sorted()
            #expect(duplicates.isEmpty, "identifiants en double : \(duplicates)")
            for id in ids {
                #expect(id.range(of: "^[a-z0-9_.]+$", options: .regularExpression) != nil, "identifiant invalide : \(id)")
            }
        }

        @Test func every_group_has_stories() {
            #expect(Set(Stories.all.map(\.group)) == Set(StoryGroup.allCases), "groupes sans story")
        }

        @Test func every_component_has_a_story() throws {
            let components = try publicComponents()
            try #require(components.count >= 20, "composants introuvables : \(components.sorted())")
            let missing = components.subtracting(Set(Stories.all.map(\.component))).sorted()
            #expect(missing.isEmpty, "composants sans story : \(missing)")
        }

        @Test(.globalState) func stories_and_controls_are_translated() {
            let saved = L10n.current
            defer { L10n.current = saved }
            for lang in [AppLanguage.enUS, .frFR] {
                L10n.current = lang
                for s in Stories.all {
                    #expect(s.title != "gallery.story.\(s.id)", "titre manquant pour \(s.id) (\(lang.lproj))")
                    for c in s.controls {
                        #expect(c.label != "gallery.control.\(c.key)", "libellé manquant pour \(s.id).\(c.key)")
                        if case let .choice(_, options, _) = c {
                            for o in options { #expect(T("gallery.option.\(o)") != "gallery.option.\(o)", "option \(o)") }
                        }
                    }
                }
                for g in StoryGroup.allCases { #expect(g.title != "gallery.group.\(g.rawValue)", "groupe \(g.rawValue)") }
            }
        }

        @Test func controls_have_defaults() {
            for s in Stories.all {
                #expect(StoryValues(s.controls).values.count == s.controls.count, "clés de contrôle en double dans \(s.id)")
                for c in s.controls {
                    if case let .number(_, range, _, d) = c { #expect(range.contains(d), "\(s.id).\(c.key) hors intervalle") }
                    if case let .choice(_, options, d) = c { #expect(options.contains(d), "\(s.id).\(c.key) : défaut absent") }
                }
            }
        }

        @Test(.globalState) @MainActor func every_story_renders() {
            prepareRendering()
            for s in Stories.all {
                for dark in [false, true] {
                    let rep = Offscreen.image(StoryCanvas(story: s), width: s.width + 2 * StoryCanvas.margin, dark: dark, settle: 0.02)
                    #expect(rep != nil, "rendu impossible : \(s.id)")
                    #expect((rep?.pixelsHigh ?? 0) > 2 * Int(StoryCanvas.margin), "rendu vide : \(s.id)")
                }
            }
        }

        @Test(.globalState) @MainActor func export_writes_images_and_index() throws {
            prepareRendering()
            try withTempDir { dir in
                let out = dir.appendingPathComponent("gallery")
                let stories = Array(Stories.all.prefix(2))
                let count = try GalleryExport.run(outDir: out, stories: stories, settle: 0.02)
                #expect(count == stories.count * 4)
                let files = try FileManager.default.contentsOfDirectory(atPath: out.path)
                #expect(files.filter { $0.hasSuffix(".png") }.count == stories.count * 4)
                let html = try String(contentsOf: out.appendingPathComponent("index.html"), encoding: .utf8)
                for s in stories {
                    for lang in GalleryExport.languages {
                        for theme in ["light", "dark"] {
                            let file = GalleryExport.fileName(story: s.id, language: lang, theme: theme)
                            #expect(files.contains(file), "image absente : \(file)")
                            #expect(html.contains("src=\"\(file)\""), "image non référencée : \(file)")
                        }
                    }
                }
                // Légendes de thème traduites ; les identifiants bruts restent dans les noms de fichiers et les classes CSS.
                let saved = L10n.current
                defer { L10n.current = saved }
                L10n.current = .frFR
                let fr = GalleryExport.indexHTML(stories: stories)
                #expect(fr.contains(" · Sombre</figcaption>") && fr.contains(" · Clair</figcaption>"), "légende non traduite")
                #expect(!fr.contains(" · dark</figcaption>"), "légende brute")
                #expect(fr.contains("<figure class=\"dark\">"), "classe CSS modifiée")
                // Rien n'est écrit hors du dossier demandé.
                #expect(try FileManager.default.contentsOfDirectory(atPath: dir.path) == ["gallery"])
            }
        }
    }
}
