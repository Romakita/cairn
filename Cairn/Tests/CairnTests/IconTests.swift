import CairnCore
import Foundation
import Testing

extension CairnTests {
    @Suite struct IconTests {
        @Test func every_mapped_lucide_icon_is_bundled() {
            let missing = Set(LucideIcons.map.values).filter { LucideIcons.url(lucide: $0) == nil }.sorted()
            #expect(missing.isEmpty, "icônes Lucide absentes de Resources/Icons : \(missing)")
        }

        @Test func lucide_svgs_are_plain_strokes() throws {
            for name in Set(LucideIcons.map.values) {
                guard let url = LucideIcons.url(lucide: name) else { continue }
                let svg = try String(contentsOf: url, encoding: .utf8)
                #expect(svg.contains("stroke=\"currentColor\"") && !svg.lowercased().contains("<script"), "SVG inattendu : \(name)")
            }
        }
    }
}
