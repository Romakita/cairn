import CairnCore
import CairnUI
import SwiftUI

/// Réglages : chaque modification réécrit config.toml en conservant commentaires et clés inconnues.
struct SettingsView: View {
    @EnvironmentObject var model: AppModel
    @ViewState private var newHomeItem = ""
    /// Éléments trouvés dans le home (fichiers connus, dossiers cachés et visibles), lus à l'ouverture.
    @ViewState private var homeFound: [String] = []

    var body: some View {
        let c = model.config ?? CairnConfig()
        let blocked = model.configIssues.contains { $0.severity == .error }
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text(T("section.settings")).font(.system(size: 28, weight: .medium)).padding(.top, 28).padding(.bottom, 8)
                if let e = model.configIssues.first(where: { $0.severity == .error }) {
                    // Erreur de syntaxe ou de schéma : rien n'est enregistré tant que le fichier n'est pas corrigé.
                    Banner(icon: "exclamationmark.octagon", text: e.description + "\n" + T("settings.blocked"), tone: .danger)
                }

                // Le fichier sur disque est invalide : l'enregistrement serait refusé (ConfigStore.SaveError).
                Group {
                    SectionTitle(title: T("settings.general"))
                    Card(padding: 0) {
                        VStack(spacing: 0) {
                            SettingsRow(title: T("settings.language"), subtitle: T("settings.language.text")) {
                                DropdownMenu(options: [("auto", T("settings.language.auto")), ("en-US", "English (US)"), ("fr-FR", "Français")],
                                             selection: Binding(get: { c.language }, set: { model.setLanguage($0) }))
                            }
                            RowDivider()
                            SettingsRow(title: T("settings.updates.check"), subtitle: T("settings.updates.version", CairnVersion.current)) {
                                Button(T("update.check")) { model.updates.check(manual: true) }.buttonStyle(.pill)
                                Toggle("", isOn: Binding(get: { c.checkUpdates },
                                    set: { v in model.updateConfig { $0.checkUpdates = v } }))
                                    .labelsHidden().toggleStyle(.switch)
                            }
                        }
                    }

                    SectionTitle(title: T("sidebar.folders"))
                    Card(padding: 0) {
                        VStack(spacing: 0) {
                            ForEach(Array(c.folders.enumerated()), id: \.offset) { i, f in
                                if i > 0 { RowDivider() }
                                SettingsRow(icon: f.isAvailable ? "folder" : "externaldrive.badge.xmark",
                                            title: (f.path as NSString).lastPathComponent,
                                            subtitle: (f.path as NSString).abbreviatingWithTildeInPath) {
                                    if !f.isAvailable { Badge(text: T("folder.unavailable"), tone: .warning) }
                                    Text(T("settings.folder.backup")).font(.system(size: 13)).foregroundStyle(Palette.secondary)
                                    Toggle("", isOn: Binding(get: { f.backup },
                                        set: { v in model.updateConfig { $0.folders[i].backup = v } }))
                                        .labelsHidden().toggleStyle(.switch).controlSize(.small)
                                    IconButton(systemName: "trash", label: T("action.remove")) {
                                        model.updateConfig { $0.folders.remove(at: i) }
                                    }
                                }
                            }
                            CardTray {
                                Button { model.addFolder() } label: { Label { Text(T("sidebar.add_folder")) } icon: { Icon("plus", size: 15) } }.buttonStyle(.pill)
                            }
                        }
                    }

                    SectionTitle(title: T("settings.home"))
                    Card(padding: 0) {
                        VStack(spacing: 0) {
                            // Tous les éléments du home (déjà sauvegardés ou trouvés), un interrupteur par ligne.
                            let items = OnboardingDraft.sortedHomeItems(c.home.include + homeFound)
                            ForEach(Array(items.enumerated()), id: \.element) { i, item in
                                if i > 0 { RowDivider() }
                                SettingsRow(icon: OnboardingView.homeIcon(item), title: "~/" + item, monospaced: true) {
                                    Toggle("", isOn: Binding(get: { c.home.include.contains(item) }, set: { on in
                                        model.updateConfig { cfg in
                                            if on { if !cfg.home.include.contains(item) { cfg.home.include.append(item) } }
                                            else { cfg.home.include.removeAll { $0 == item } }
                                        }
                                    }))
                                    .labelsHidden().toggleStyle(.switch).controlSize(.small)
                                    .accessibilityLabel("~/" + item)
                                }
                                .padding(.vertical, -4)
                            }
                            CardTray {
                                PathField(placeholder: T("onboarding.home.add_placeholder"), text: $newHomeItem,
                                          excluding: Set(items), onSubmit: addHomeItem)
                                Button(action: addHomeItem) { Label { Text(T("action.add")) } icon: { Icon("plus", size: 15) } }
                                    .buttonStyle(.pillPrimary)
                                    .disabled(newHomeItem.trimmingCharacters(in: .whitespaces).isEmpty)
                            }
                        }
                    }
                    .onAppear { homeFound = OnboardingDraft.homeChoices(include: []) }

                    SectionTitle(title: T("settings.schedule"))
                    Card(padding: 0) {
                        VStack(spacing: 0) {
                            SettingsRow(title: T("settings.frequency")) {
                                TabBar(options: CairnConfig.Frequency.allCases.map { ($0, T("frequency.\($0.rawValue)")) },
                                           selection: Binding(get: { c.schedule.frequency },
                                                              set: { v in model.updateConfig { $0.schedule.frequency = v } }))
                            }
                            if c.schedule.frequency != .manual {
                                RowDivider()
                                SettingsRow(title: T("settings.time")) {
                                    TextField("", text: Binding(get: { c.schedule.time }, set: { v in
                                        if v.range(of: #"^([01]\d|2[0-3]):[0-5]\d$"#, options: .regularExpression) != nil {
                                            model.updateConfig { $0.schedule.time = v }
                                        }
                                    }), prompt: Text(verbatim: "12:30"))
                                    .cairnField().frame(width: 100)
                                }
                            }
                            if c.schedule.frequency == .weekly {
                                RowDivider()
                                SettingsRow(title: T("onboarding.schedule.weekday")) {
                                    DropdownMenu(options: CairnConfig.weekdays.map { ($0, T("weekday.\($0)")) },
                                                 selection: Binding(get: { c.schedule.weekday },
                                                                    set: { v in model.updateConfig { $0.schedule.weekday = v } }))
                                }
                            }
                            RowDivider()
                            SettingsRow(title: T("onboarding.schedule.background_toggle")) {
                                Toggle("", isOn: Binding(get: { c.schedule.background },
                                    set: { v in model.updateConfig { $0.schedule.background = v } }))
                                    .labelsHidden().toggleStyle(.switch)
                            }
                            RowDivider()
                            stepperRow(T("settings.battery", c.schedule.onBatteryMinPercent), value: Binding(
                                get: { c.schedule.onBatteryMinPercent },
                                set: { v in model.updateConfig { $0.schedule.onBatteryMinPercent = v } }), in: 0...100, step: 5)
                        }
                    }

                    SectionTitle(title: T("settings.alerts"))
                    Card(padding: 0) {
                        VStack(spacing: 0) {
                            stepperRow(T("settings.alerts.low", Fmt.number(c.alerts.lowPercent, digits: 0), Fmt.number(c.alerts.lowGB, digits: 0)),
                                       value: Binding(get: { c.alerts.lowPercent }, set: { v in model.updateConfig { $0.alerts.lowPercent = v } }),
                                       in: max(1, c.alerts.criticalPercent)...50, step: 1)
                            RowDivider()
                            stepperRow(T("settings.alerts.critical", Fmt.number(c.alerts.criticalPercent, digits: 0), Fmt.number(c.alerts.criticalGB, digits: 0)),
                                       value: Binding(get: { c.alerts.criticalPercent }, set: { v in model.updateConfig { $0.alerts.criticalPercent = v } }),
                                       in: 1...max(1, c.alerts.lowPercent), step: 1)
                        }
                    }

                    SectionTitle(title: T("settings.maintenance"))
                    Card(padding: 0) {
                        VStack(spacing: 0) {
                            stepperRow(T("settings.logs", c.logRetentionDays), value: Binding(get: { c.logRetentionDays },
                                set: { v in model.updateConfig { $0.logRetentionDays = v } }), in: 1...3650, step: 15)
                            RowDivider()
                            stepperRow(T("settings.stale_days", c.git.worktreeStaleDays), value: Binding(get: { c.git.worktreeStaleDays },
                                set: { v in model.updateConfig { $0.git.worktreeStaleDays = v } }), in: 1...365, step: 1)
                            RowDivider()
                            SettingsRow(title: T("settings.git_gc")) {
                                Toggle("", isOn: Binding(get: { c.git.gc }, set: { v in model.updateConfig { $0.git.gc = v } }))
                                    .labelsHidden().toggleStyle(.switch)
                            }
                        }
                    }
                }
                .disabled(blocked)

                SectionTitle(title: T("settings.file"))
                Card(padding: 0) {
                    SettingsRow(icon: "doc.text", title: (model.store.fileURL.path as NSString).abbreviatingWithTildeInPath, monospaced: true) {
                        Button(T("settings.reveal_file")) { model.revealConfig() }.buttonStyle(.pill)
                    }
                }
            }
            .frame(maxWidth: 760, alignment: .leading)
            .padding(.horizontal, 40).padding(.bottom, 40)
            .frame(maxWidth: .infinity)
        }
    }

    /// Ligne de réglage numérique : le libellé affiche la valeur, petits boutons − / + à droite.
    func stepperRow<V: Strideable>(_ title: String, value: Binding<V>, in range: ClosedRange<V>, step: V.Stride) -> some View {
        SettingsRow(title: title) {
            Stepper("", value: value, in: range, step: step).labelsHidden()
        }
    }

    func addHomeItem() {
        var item = newHomeItem.trimmingCharacters(in: .whitespaces)
        if item.hasPrefix("~/") { item.removeFirst(2) }
        guard !item.isEmpty else { return }
        model.updateConfig { if !$0.home.include.contains(item) { $0.home.include.append(item) } }
        newHomeItem = ""
    }
}
