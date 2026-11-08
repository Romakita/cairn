import CairnCore
import Foundation

let iconTests: [TestCase] = [
    TestCase("every_mapped_lucide_icon_is_bundled") {
        let missing = Set(LucideIcons.map.values).filter { LucideIcons.url(lucide: $0) == nil }.sorted()
        try expect(missing.isEmpty, "icônes Lucide absentes de Resources/Icons : \(missing)")
    },
    TestCase("lucide_svgs_are_plain_strokes") {
        for name in Set(LucideIcons.map.values) {
            guard let url = LucideIcons.url(lucide: name) else { continue }
            let svg = try String(contentsOf: url, encoding: .utf8)
            try expect(svg.contains("stroke=\"currentColor\"") && !svg.lowercased().contains("<script"), "SVG inattendu : \(name)")
        }
    },
]
