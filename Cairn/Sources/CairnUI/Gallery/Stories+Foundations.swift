import CairnCore
import SwiftUI

// Stories des fondations : palette, boutons et identité (logo, icônes).

extension Stories {
    static var palette: [Story] {
        [
            Story("palette.colors", group: .palette, component: "Palette", width: 560) { _ in
                let tokens: [(String, Color)] = [
                    ("content", Palette.content), ("sidebar", Palette.sidebar), ("rail", Palette.rail),
                    ("rowSelected", Palette.rowSelected), ("rowHover", Palette.rowHover), ("border", Palette.border),
                    ("fieldBorder", Palette.fieldBorder), ("field", Palette.field), ("fieldPressed", Palette.fieldPressed),
                    ("text", Palette.text), ("secondary", Palette.secondary), ("tertiary", Palette.tertiary),
                    ("placeholder", Palette.placeholder), ("accent", Palette.accent), ("primaryButton", Palette.primaryButton),
                ]
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), alignment: .leading), count: 3), spacing: 12) {
                    ForEach(tokens, id: \.0) { name, color in Swatch(name: name, color: color) }
                }
            },
            Story("palette.tones", group: .palette, component: "Palette.Tone") { _ in
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(Palette.Tone.allCases, id: \.self) { tone in
                        HStack(spacing: 10) {
                            Swatch(name: T("gallery.option.\(tone)"), color: Palette.background(tone))
                            Swatch(name: T("gallery.label.foreground"), color: Palette.foreground(tone))
                        }
                    }
                }
            },
            Story("palette.categories", group: .palette, component: "Category.color") { _ in
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), alignment: .leading), count: 2), spacing: 12) {
                    ForEach(CairnCore.Category.allCases) { c in Swatch(name: c.label, color: c.color) }
                }
            },
        ]
    }

    static var buttons: [Story] {
        [
            Story("buttons.pill", group: .buttons, component: "PillButtonStyle", controls: [
                .choice("kind", options: PillButtonStyle.Kind.allCases.map { "\($0)" }, default: "primary"),
                .text("label", default: T("action.backup_now")),
                .toggle("disabled", default: false),
            ]) { v in
                let kind = PillButtonStyle.Kind.allCases.first { "\($0)" == v.text("kind") } ?? .secondary
                Button(v.text("label")) {}
                    .buttonStyle(PillButtonStyle(kind: kind))
                    .disabled(v.bool("disabled"))
            },
            Story("buttons.pill_all", group: .buttons, component: "PillButtonStyle") { _ in
                HStack(spacing: 10) {
                    ForEach(PillButtonStyle.Kind.allCases, id: \.self) { kind in
                        Button(T("gallery.option.\(kind)")) {}.buttonStyle(PillButtonStyle(kind: kind))
                    }
                }
            },
            Story("buttons.icon", group: .buttons, component: "IconButton") { _ in
                HStack(spacing: 6) {
                    IconButton(systemName: "trash", label: T("action.delete")) {}
                    IconButton(systemName: "arrow.clockwise", label: T("gallery.sample.refresh")) {}
                    IconButton(systemName: "ellipsis", label: T("gallery.sample.more")) {}
                }
            },
            Story("buttons.more_icon", group: .buttons, component: "MoreIcon", width: 120) { _ in
                MoreIcon()
            },
            Story("buttons.more_menu", group: .buttons, component: "PopupMenuButton", width: 240) { _ in
                // Le panneau s'ouvre au clic dans la fenêtre du catalogue (pas dans les images exportées).
                PopupMenuButton(entries: { SampleData.menu }) { MoreIcon() }
            },
        ]
    }

    static var brand: [Story] {
        [
            Story("brand.logo", group: .brand, component: "CairnLogo", width: 240, controls: [
                .number("size", range: 16...96, step: 4, default: 48),
            ]) { v in
                CairnLogo(size: v.number("size"))
            },
            Story("brand.icons", group: .brand, component: "Icon") { _ in
                let names = ["house", "chart.pie", "arrow.up.circle", "sparkles", "terminal", "arrow.triangle.branch",
                             "clock.arrow.circlepath", "folder", "trash", "gearshape", "magnifyingglass", "externaldrive"]
                LazyVGrid(columns: Array(repeating: GridItem(.fixed(64)), count: 6), spacing: 14) {
                    ForEach(names, id: \.self) { name in
                        VStack(spacing: 6) {
                            Icon(name, size: 20).foregroundStyle(Palette.text)
                            Text(verbatim: name).font(.system(size: 9)).foregroundStyle(Palette.secondary)
                                .lineLimit(1).truncationMode(.middle)
                        }
                    }
                }
            },
            Story("brand.icon_tile", group: .brand, component: "IconTile", controls: [
                .number("size", range: 24...64, step: 4, default: 32),
            ]) { v in
                HStack(spacing: 12) {
                    ForEach(["folder", "externaldrive", "sparkles", "terminal"], id: \.self) {
                        IconTile(systemName: $0, size: v.number("size"))
                    }
                }
            },
        ]
    }
}

/// Pastille de couleur avec son nom.
struct Swatch: View {
    let name: String
    let color: Color

    var body: some View {
        HStack(spacing: 8) {
            RoundedRectangle(cornerRadius: 6).fill(color)
                .frame(width: 28, height: 28)
                .overlay(RoundedRectangle(cornerRadius: 6).stroke(Palette.border))
            Text(verbatim: name).font(.system(size: 12)).foregroundStyle(Palette.text).lineLimit(1)
        }
    }
}
