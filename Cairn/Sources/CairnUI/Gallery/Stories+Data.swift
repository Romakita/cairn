import CairnCore
import SwiftUI

// Stories des retours visuels, des champs et des graphiques.

extension Stories {
    static var feedback: [Story] {
        [
            Story("feedback.badge", group: .feedback, component: "Badge", width: 240, controls: [
                .choice("tone", options: Palette.Tone.allCases.map { "\($0)" }, default: "success"),
                .text("label", default: T("hub.badge.ok")),
            ]) { v in
                Badge(text: v.text("label"), tone: Palette.Tone.allCases.first { "\($0)" == v.text("tone") } ?? .neutral)
            },
            Story("feedback.badge_tones", group: .feedback, component: "Badge") { _ in
                HStack(spacing: 8) {
                    ForEach(Palette.Tone.allCases, id: \.self) { Badge(text: T("gallery.option.\($0)"), tone: $0) }
                }
            },
            Story("feedback.fill_bar", group: .feedback, component: "FillBar", controls: [
                .number("percent", range: 0...100, default: 42),
            ]) { v in
                VStack(alignment: .leading, spacing: 8) {
                    FillBar(fraction: v.number("percent") / 100)
                    FillBar(fraction: v.number("percent") / 100, color: Palette.foreground(.danger))
                }
            },
            Story("feedback.segment_bar", group: .feedback, component: "SegmentBar", controls: [
                .number("percent", range: 0...100, default: 60),
            ]) { v in
                let p = v.number("percent")
                SegmentBar(parts: [(p, Palette.module(.git)), (100 - p, Palette.module(.git).opacity(0.45))])
            },
            Story("feedback.message_bar", group: .feedback, component: "MessageBar", width: 560) { _ in
                MessageBar(text: T("gallery.sample.banner")) {}
            },
            Story("feedback.worker_rows", group: .feedback, component: "WorkerRow", width: 520) { _ in
                VStack(spacing: 0) {
                    WorkerRow(icon: "arrow.up.doc", title: T("backup.worker.copy"), detail: "Developer/cairn/Package.swift", done: false)
                    RowDivider().padding(.horizontal, -16)
                    WorkerRow(icon: "cpu", title: T("backup.worker.copy"), detail: T("backup.worker.done"), done: true)
                }
                .padding(.horizontal, 14)
                .background(Palette.rowHover, in: RoundedRectangle(cornerRadius: 12))
            },
            Story("feedback.tooltip", group: .feedback, component: "HoverTooltip", width: 320) { _ in
                RailButton(icon: "house", label: T("gallery.sample.section.home"), selected: false) {}
                    .modifier(HoverTooltip(text: T("gallery.sample.section.home"), initiallyVisible: true))
                    .frame(maxWidth: .infinity, alignment: .leading)
            },
        ]
    }

    static var fields: [Story] {
        [
            Story("fields.text", group: .fields, component: "CairnFieldModifier", controls: [
                .toggle("icon", default: true),
                .text("value", default: ""),
            ]) { v in
                StoryState(v.text("value")) { text in
                    TextField(T("gallery.sample.field_placeholder"), text: text)
                        .cairnField(icon: v.bool("icon") ? "magnifyingglass" : nil)
                }
                .id(v.text("value"))
            },
            Story("fields.dropdown", group: .fields, component: "DropdownMenu", width: 280) { _ in
                StoryState("weekly") { selection in
                    DropdownMenu(options: [("daily", T("gallery.sample.daily")), ("weekly", T("gallery.sample.weekly"))],
                                 selection: selection)
                }
            },
            Story("fields.choice_chips", group: .fields, component: "ChoiceChip") { _ in
                HStack(spacing: 8) {
                    ForEach(["conversations", "config", "memories", "credentials"], id: \.self) { cat in
                        StoryState(cat != "credentials") { on in ChoiceChip(title: T("ai.category.\(cat)"), isOn: on) }
                    }
                }
            },
            Story("fields.filter_chips", group: .fields, component: "FilterChip", width: 560) { _ in
                StoryState(-1) { selected in
                    HStack(spacing: 6) {
                        FilterChip(title: T("list.all"), total: SampleData.node.size, color: .accentColor,
                                   active: selected.wrappedValue == -1) { selected.wrappedValue = -1 }
                        ForEach([CairnCore.Category.deps, .build, .cache], id: \.self) { c in
                            FilterChip(title: c.shortLabel, total: SampleData.node.breakdown[c.rawValue], color: c.color,
                                       active: selected.wrappedValue == c.rawValue) { selected.wrappedValue = c.rawValue }
                        }
                    }
                }
            },
            Story("fields.choice_tiles", group: .fields, component: "ChoiceTile", width: 560) { _ in
                StoryState("local") { kind in
                    HStack(alignment: .top, spacing: 12) {
                        ChoiceTile(icon: "externaldrive", title: T("onboarding.destination.local"),
                                   subtitle: T("onboarding.destination.local.text"), selected: kind.wrappedValue == "local") {
                            kind.wrappedValue = "local"
                        }
                        ChoiceTile(icon: "server.rack", title: T("onboarding.destination.smb"),
                                   subtitle: T("onboarding.destination.smb.text"), selected: kind.wrappedValue == "smb") {
                            kind.wrappedValue = "smb"
                        }
                    }
                    .fixedSize(horizontal: false, vertical: true)
                }
            },
            Story("fields.popup_menu", group: .fields, component: "PopupMenuContent", width: 280) { _ in
                PopupMenuContent(entries: SampleData.menu) {}
            },
            Story("fields.path", group: .fields, component: "PathField", controls: [
                .text("value", default: "De"),
            ]) { v in
                // Complétion sur un dossier temporaire factice, jamais sur le home de l'utilisateur.
                StoryState(v.text("value")) { text in
                    PathField(placeholder: T("gallery.sample.field_placeholder"), text: text, base: SampleData.pathBase)
                }
                .id(v.text("value"))
                .padding(.top, 150)
            },
        ]
    }

    static var charts: [Story] {
        [
            Story("charts.breakdown_bar", group: .charts, component: "BreakdownBar", controls: [
                .number("percent", range: 5...100, step: 5, default: 80),
            ]) { v in
                let node = SampleData.node
                BreakdownBar(node: node, scale: Int64(Double(node.size) * 100 / max(v.number("percent"), 1)))
            },
            Story("charts.category_tags", group: .charts, component: "CategoryTag") { _ in
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), alignment: .leading), count: 4), spacing: 8) {
                    ForEach(CairnCore.Category.allCases) { CategoryTag(category: $0) }
                }
            },
            Story("charts.breakdown_chart", group: .charts, component: "BreakdownChart", width: 360) { _ in
                BreakdownChart(node: SampleData.node)
            },
        ]
    }
}

/// Données factices des stories.
enum SampleData {
    /// Menu « … » d'une destination : actions, séparateur, action destructive en dernier.
    static var menu: [PopupMenuEntry] {
        [
            .item(icon: "play.circle", title: T("action.backup_now")) {},
            .item(icon: "arrow.clockwise", title: T("gallery.sample.refresh")) {},
            .item(icon: "doc.on.doc", title: T("destination.copy_address"), disabled: true) {},
            .divider,
            .item(icon: "trash", title: T("action.delete"), destructive: true) {},
        ]
    }

    /// Dossier analysé fictif : répartition par catégorie, sans lecture du disque.
    static var node: Node {
        let n = Node(name: "workspaces", path: "/gallery/workspaces", isDirectory: true, category: .source)
        let bytes: [CairnCore.Category: Int64] = [
            .source: 18_400_000_000, .git: 9_100_000_000, .deps: 31_600_000_000, .build: 12_200_000_000,
            .ios: 4_300_000_000, .python: 2_700_000_000, .cache: 6_900_000_000, .trash: 800_000_000,
        ]
        for (c, b) in bytes { n.breakdown[c.rawValue] = b }
        n.size = bytes.values.reduce(0, +)
        n.fileCount = 412_380
        return n
    }

    /// Dossier temporaire avec quelques sous-dossiers, pour la complétion de `PathField`.
    static let pathBase: URL = {
        let base = FileManager.default.temporaryDirectory.appendingPathComponent("cairn-gallery-paths")
        for sub in ["Desktop", "Developer", "Developer/cairn", "Documents", "Downloads"] {
            try? FileManager.default.createDirectory(at: base.appendingPathComponent(sub), withIntermediateDirectories: true)
        }
        return base
    }()
}
