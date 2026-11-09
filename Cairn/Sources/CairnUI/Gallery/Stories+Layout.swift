import CairnCore
import SwiftUI

// Stories de navigation et de mise en page : rail, barre latérale, sélecteurs, cartes et bandeaux.

extension Stories {
    static var navigation: [Story] {
        [
            Story("navigation.rail", group: .navigation, component: "RailButton", width: 120, controls: [
                .number("selected", range: 0...3, default: 0),
            ]) { v in
                let items = [("house", "home"), ("chart.pie", "analysis"), ("arrow.up.circle", "backup"), ("sparkles", "ai")]
                VStack(spacing: 6) {
                    ForEach(items.indices, id: \.self) { i in
                        RailButton(icon: items[i].0, label: T("gallery.sample.section.\(items[i].1)"),
                                   selected: i == Int(v.number("selected"))) {}
                    }
                }
                .padding(8)
                .background(Palette.rail, in: RoundedRectangle(cornerRadius: 14))
            },
            Story("navigation.sidebar", group: .navigation, component: "SidebarRow", width: 280) { _ in
                VStack(spacing: 2) {
                    SidebarHeader(title: T("sidebar.destinations"))
                    SidebarRow(dot: Palette.foreground(.success), title: "syno", meta: T("gallery.sample.reachable"), selected: true) {}
                    SidebarRow(dot: Palette.foreground(.success), title: "nas", busy: true, fraction: 0.42)
                    SidebarRow(dot: Palette.foreground(.success), title: "usb", busy: true)
                    SidebarRow(icon: "plus", title: T("sidebar.add_destination")) {}
                    SidebarHeader(title: T("sidebar.folders"))
                    SidebarRow(icon: "folder", title: "workspaces", meta: Fmt.bytes(128_000_000_000))
                    SidebarRow(icon: "folder", title: "Documents", meta: Fmt.bytes(12_000_000_000))
                }
                .padding(8)
                .background(Palette.sidebar, in: RoundedRectangle(cornerRadius: 14))
            },
            Story("navigation.sidebar_header", group: .navigation, component: "SidebarHeader", width: 280) { _ in
                SidebarHeader(title: T("sidebar.sources"))
            },
            Story("navigation.wizard_stepper", group: .navigation, component: "WizardStepper", width: 640, controls: [
                .number("selected", range: 0...4, default: 2),
            ]) { v in
                let current = Int(v.number("selected"))
                WizardStepper(titles: ["folders", "home", "ai", "destination", "schedule"].map { T("onboarding.\($0).title") },
                              current: current, reached: current, canSelect: { $0 <= current }, select: { _ in })
            },
            Story("navigation.folder_breadcrumb", group: .navigation, component: "FolderBreadcrumb", width: 420) { _ in
                FolderBreadcrumb(items: [("Macintosh HD", URL(fileURLWithPath: "/")), ("…", nil),
                                         ("Developer", URL(fileURLWithPath: "/Developer")),
                                         ("cairn", URL(fileURLWithPath: "/Developer/cairn"))]) { _ in }
            },
            Story("navigation.pill_picker", group: .navigation, component: "PillPicker") { _ in
                StoryState("chat") { selection in
                    PillPicker(options: [("chat", T("gallery.sample.option_a")), ("work", T("gallery.sample.option_b"))],
                               selection: selection)
                }
            },
            Story("navigation.tab_bar", group: .navigation, component: "TabBar") { _ in
                StoryState(0) { selection in
                    TabBar(options: [(0, T("gallery.sample.tab_overview")), (1, T("gallery.sample.tab_projects")),
                                     (2, T("gallery.sample.tab_files"))],
                           selection: selection)
                }
            },
        ]
    }

    static var containers: [Story] {
        [
            Story("containers.card", group: .containers, component: "Card", controls: [
                .number("padding", range: 0...32, step: 2, default: 18),
                .text("label", default: T("gallery.sample.card_body")),
            ]) { v in
                Card(padding: v.number("padding")) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(T("gallery.sample.card_title")).font(.system(size: 15, weight: .medium))
                        Text(v.text("label")).font(.system(size: 13)).foregroundStyle(Palette.secondary)
                    }
                }
            },
            Story("containers.section_title", group: .containers, component: "SectionTitle") { _ in
                VStack(alignment: .leading, spacing: 8) {
                    SectionTitle(title: T("gallery.sample.section_general"))
                    Card { Text(T("gallery.sample.card_body")).font(.system(size: 13)) }
                }
            },
            Story("containers.settings", group: .containers, component: "SettingsRow", width: 560) { _ in
                Card(padding: 0) {
                    VStack(spacing: 0) {
                        SettingsRow(icon: "clock", title: T("gallery.sample.setting_schedule"),
                                    subtitle: T("gallery.sample.setting_schedule_hint")) {
                            StoryState(true) { on in Toggle("", isOn: on).labelsHidden().toggleStyle(.switch) }
                        }
                        RowDivider()
                        SettingsRow(icon: "folder", title: "~/Developer", subtitle: Fmt.bytes(128_000_000_000), monospaced: true) {
                            IconButton(systemName: "trash", label: T("action.delete")) {}
                        }
                        CardTray {
                            Button(T("sidebar.add_folder")) {}.buttonStyle(.pill)
                        }
                    }
                }
            },
            Story("containers.selectable_rows", group: .containers, component: "SelectableRow", width: 520) { _ in
                Card(padding: 0) {
                    VStack(spacing: 0) {
                        StoryState(true) { on in SelectableRow(icon: "folder", title: "workspaces", subtitle: "~/workspaces", isOn: on) }
                        RowDivider()
                        StoryState(false) { on in SelectableRow(icon: "gearshape", title: "~/.config", monospaced: true, isOn: on) }
                    }
                    .padding(.vertical, 4)
                }
            },
            Story("containers.folder_rows", group: .containers, component: "FolderRow") { _ in
                Card(padding: 0) {
                    VStack(spacing: 0) {
                        FolderRow(name: "Macintosh HD", icon: "house") {}
                        FolderRow(name: "syno", icon: "externaldrive") {}
                        FolderRow(name: "Developer", icon: "folder") {}
                    }
                }
            },
            Story("containers.row_divider", group: .containers, component: "RowDivider") { _ in
                Card(padding: 0) {
                    VStack(spacing: 0) {
                        Text(T("gallery.sample.option_a")).padding(16).frame(maxWidth: .infinity, alignment: .leading)
                        RowDivider()
                        Text(T("gallery.sample.option_b")).padding(16).frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            },
            Story("containers.card_tray", group: .containers, component: "CardTray") { _ in
                Card(padding: 0) {
                    VStack(spacing: 0) {
                        Text(T("gallery.sample.card_body")).font(.system(size: 13)).padding(16)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        CardTray {
                            TextField(T("gallery.sample.field_placeholder"), text: .constant("")).cairnField()
                            Button(T("sidebar.add_folder")) {}.buttonStyle(.pillPrimary)
                        }
                    }
                }
            },
            Story("containers.banner", group: .containers, component: "Banner", width: 560, controls: [
                .choice("tone", options: Palette.Tone.allCases.map { "\($0)" }, default: "warning"),
                .text("label", default: T("gallery.sample.banner")),
                .toggle("action", default: true),
            ]) { v in
                let tone = Palette.Tone.allCases.first { "\($0)" == v.text("tone") } ?? .warning
                if v.bool("action") {
                    Banner(icon: "exclamationmark.triangle", text: v.text("label"), tone: tone) {
                        Button(T("action.backup_now")) {}.buttonStyle(.pillOutline)
                    }
                } else {
                    Banner(icon: "exclamationmark.triangle", text: v.text("label"), tone: tone)
                }
            },
        ]
    }
}
