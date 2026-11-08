import CairnCore
import SwiftUI

/// Réglages : chaque modification réécrit config.toml en conservant commentaires et clés inconnues.
struct SettingsView: View {
    @EnvironmentObject var model: AppModel
    @ViewState private var newHomeItem = ""

    var body: some View {
        let c = model.config ?? CairnConfig()
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Text(T("section.settings")).font(.system(size: 26, weight: .medium)).padding(.top, 24)
                if let e = model.configIssues.first(where: { $0.severity == .error }) {
                    // Erreur de syntaxe ou de schéma : rien n'est enregistré tant que le fichier n'est pas corrigé.
                    Banner(icon: "exclamationmark.octagon", text: e.description + "\n" + T("settings.blocked"), tone: .danger)
                }

                section(T("settings.general")) {
                    Picker(T("settings.language"), selection: Binding(get: { c.language }, set: { model.setLanguage($0) })) {
                        Text(T("settings.language.auto")).tag("auto")
                        Text(verbatim: "English (US)").tag("en-US")
                        Text(verbatim: "Français").tag("fr-FR")
                    }
                    .frame(maxWidth: 360)
                }

                section(T("sidebar.folders")) {
                    ForEach(Array(c.folders.enumerated()), id: \.offset) { i, f in
                        HStack {
                            Image(systemName: f.isAvailable ? "folder" : "externaldrive.badge.xmark")
                            Text(f.path)
                            if !f.isAvailable { Badge(text: T("folder.unavailable"), tone: .warning) }
                            Spacer()
                            Toggle(T("settings.folder.backup"), isOn: Binding(get: { f.backup },
                                set: { v in model.updateConfig { $0.folders[i].backup = v } }))
                                .toggleStyle(.checkbox)
                            Button { model.updateConfig { $0.folders.remove(at: i) } } label: { Image(systemName: "minus.circle") }
                                .buttonStyle(.plain).accessibilityLabel(T("action.remove"))
                        }
                    }
                    Button { model.addFolder() } label: { Label(T("sidebar.add_folder"), systemImage: "plus") }.buttonStyle(.pill)
                }

                section(T("settings.home")) {
                    ForEach(Array(c.home.include.enumerated()), id: \.offset) { i, item in
                        HStack {
                            Text("~/" + item).font(.system(size: 13, design: .monospaced))
                            Spacer()
                            Button { model.updateConfig { $0.home.include.remove(at: i) } } label: { Image(systemName: "minus.circle") }
                                .buttonStyle(.plain).accessibilityLabel(T("action.remove"))
                        }
                    }
                    HStack {
                        TextField(T("onboarding.home.add_placeholder"), text: $newHomeItem).textFieldStyle(.roundedBorder)
                            .onSubmit(addHomeItem)
                        Button(T("action.add"), action: addHomeItem).buttonStyle(.pill)
                    }
                }

                section(T("settings.schedule")) {
                    Picker(T("settings.frequency"), selection: Binding(get: { c.schedule.frequency },
                        set: { v in model.updateConfig { $0.schedule.frequency = v } })) {
                        ForEach(CairnConfig.Frequency.allCases, id: \.self) { Text(T("frequency.\($0.rawValue)")).tag($0) }
                    }
                    .pickerStyle(.segmented).frame(maxWidth: 360)
                    HStack {
                        Text(T("settings.time"))
                        TextField("12:30", text: Binding(get: { c.schedule.time }, set: { v in
                            if v.range(of: #"^([01]\d|2[0-3]):[0-5]\d$"#, options: .regularExpression) != nil {
                                model.updateConfig { $0.schedule.time = v }
                            }
                        }))
                        .textFieldStyle(.roundedBorder).frame(width: 72)
                        Picker(T("onboarding.schedule.weekday"), selection: Binding(get: { c.schedule.weekday },
                            set: { v in model.updateConfig { $0.schedule.weekday = v } })) {
                            ForEach(CairnConfig.weekdays, id: \.self) { Text(T("weekday.\($0)")).tag($0) }
                        }
                        .frame(maxWidth: 260)
                        .disabled(c.schedule.frequency != .weekly)
                    }
                    Toggle(T("onboarding.schedule.background_toggle"), isOn: Binding(get: { c.schedule.background },
                        set: { v in model.updateConfig { $0.schedule.background = v } }))
                    Stepper(T("settings.battery", c.schedule.onBatteryMinPercent), value: Binding(
                        get: { c.schedule.onBatteryMinPercent },
                        set: { v in model.updateConfig { $0.schedule.onBatteryMinPercent = v } }), in: 0...100, step: 5)
                }

                section(T("settings.alerts")) {
                    Stepper(T("settings.alerts.low", Fmt.number(c.alerts.lowPercent, digits: 0), Fmt.number(c.alerts.lowGB, digits: 0)),
                            value: Binding(get: { c.alerts.lowPercent }, set: { v in model.updateConfig { $0.alerts.lowPercent = v } }),
                            in: max(1, c.alerts.criticalPercent)...50, step: 1)
                    Stepper(T("settings.alerts.critical", Fmt.number(c.alerts.criticalPercent, digits: 0), Fmt.number(c.alerts.criticalGB, digits: 0)),
                            value: Binding(get: { c.alerts.criticalPercent }, set: { v in model.updateConfig { $0.alerts.criticalPercent = v } }),
                            in: 1...max(1, c.alerts.lowPercent), step: 1)
                }

                section(T("settings.maintenance")) {
                    Stepper(T("settings.logs", c.logRetentionDays), value: Binding(get: { c.logRetentionDays },
                        set: { v in model.updateConfig { $0.logRetentionDays = v } }), in: 1...3650, step: 15)
                    Stepper(T("settings.stale_days", c.git.worktreeStaleDays), value: Binding(get: { c.git.worktreeStaleDays },
                        set: { v in model.updateConfig { $0.git.worktreeStaleDays = v } }), in: 1...365)
                    Toggle(T("settings.git_gc"), isOn: Binding(get: { c.git.gc }, set: { v in model.updateConfig { $0.git.gc = v } }))
                }

                HStack {
                    Text(model.store.fileURL.path).font(.system(size: 12, design: .monospaced)).foregroundStyle(Palette.secondary)
                    Button(T("settings.reveal_file")) { model.revealConfig() }.buttonStyle(.pill)
                }
            }
            .frame(maxWidth: 760, alignment: .leading)
            .padding(.horizontal, 40).padding(.bottom, 32)
            .frame(maxWidth: .infinity)
        }
    }

    func section<C: View>(_ title: String, @ViewBuilder content: () -> C) -> some View {
        Card {
            VStack(alignment: .leading, spacing: 12) {
                Text(title).font(.system(size: 15, weight: .semibold))
                content()
            }
            .font(.system(size: 13.5))
        }
        // Le fichier sur disque est invalide : l'enregistrement serait refusé (ConfigStore.SaveError).
        .disabled(model.configIssues.contains { $0.severity == .error })
    }

    func addHomeItem() {
        var item = newHomeItem.trimmingCharacters(in: .whitespaces)
        if item.hasPrefix("~/") { item.removeFirst(2) }
        guard !item.isEmpty else { return }
        model.updateConfig { if !$0.home.include.contains(item) { $0.home.include.append(item) } }
        newHomeItem = ""
    }
}
