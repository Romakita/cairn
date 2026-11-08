import AppKit
import CairnCore
import SwiftUI

/// Assistant de premier lancement. Rien n'est écrit sur disque avant « Terminer ».
/// Disposition : en-tête, étapes horizontales cliquables, contenu centré, barre d'actions fixe en bas.
struct OnboardingView: View {
    @EnvironmentObject var model: AppModel
    @ViewState private var draft = OnboardingDraft.detect(legacyRootPath: UserDefaults.standard.string(forKey: "rootPath"))
    @ViewState private var step = 0
    @ViewState private var reached = 0 // étape la plus avancée atteinte (navigation directe par le stepper)
    @ViewState private var forward = true // sens de l'animation de transition
    @ViewState private var destinationKind = 0 // 0 plus tard, 1 dossier, 2 NAS
    @ViewState private var localPath = ""
    @ViewState private var smbURL = "smb://"
    @ViewState private var smbUser = NSUserName()
    @ViewState private var password = ""
    @ViewState private var notifications = true
    @ViewState private var newHomeItem = ""
    @ViewState private var confirmUnencrypted = false

    static let steps = ["folders", "home", "ai", "destination", "schedule", "notifications"]

    init(step: Int = 0) {
        _step = ViewState(initialValue: step)
        _reached = ViewState(initialValue: step)
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            WizardStepper(titles: Self.steps.map { T("onboarding.\($0).title") }, current: step, reached: reached,
                          canSelect: canJump(to:), select: go(to:))
                .frame(maxWidth: 860)
                .padding(.horizontal, 48).padding(.top, 4).padding(.bottom, 22)
            Rectangle().fill(Palette.border).frame(height: 1)
            ScrollView {
                ZStack(alignment: .top) {
                    page
                        .id(step)
                        .transition(.asymmetric(
                            insertion: .offset(x: forward ? 36 : -36).combined(with: .opacity),
                            removal: .opacity))
                }
                .frame(maxWidth: 680)
                .padding(.horizontal, 48).padding(.top, 40).padding(.bottom, 48)
                .frame(maxWidth: .infinity)
            }
            Rectangle().fill(Palette.border).frame(height: 1)
            navigation
        }
        .background(Palette.content)
    }

    // MARK: En-tête et page

    var header: some View {
        HStack(spacing: 10) {
            CairnLogo(size: 22)
            Text(T("onboarding.welcome")).font(.system(size: 14, weight: .semibold))
            Spacer()
            Button { model.restoreInsteadOfOnboarding() } label: {
                Label(T("onboarding.restore_instead"), systemImage: "arrow.counterclockwise")
            }
            .buttonStyle(.pillOutline)
        }
        .padding(.leading, 88) // place des boutons de fenêtre
        .padding(.trailing, 20)
        .frame(height: 56)
    }

    var page: some View {
        let key = Self.steps[step]
        return VStack(alignment: .leading, spacing: 28) {
            VStack(spacing: 10) {
                Text(T("onboarding.\(key).heading")).font(.system(size: 28, weight: .regular))
                Text(T("onboarding.\(key).text")).font(.system(size: 14.5)).foregroundStyle(Palette.secondary)
                    .lineSpacing(3)
            }
            .multilineTextAlignment(.center)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity)
            switch key {
            case "folders": foldersStep
            case "home": homeStep
            case "ai": aiStep
            case "destination": destinationStep
            case "schedule": scheduleStep
            default: notificationsStep
            }
        }
    }

    // MARK: Étapes

    var foldersStep: some View {
        Card(padding: 0) {
            VStack(spacing: 0) {
                selectionHeader(items: $draft.folders)
                ForEach(draft.folders.indices, id: \.self) { i in
                    RowDivider()
                    SelectableRow(icon: "folder", title: (draft.folders[i].path as NSString).lastPathComponent,
                                  subtitle: (draft.folders[i].path as NSString).abbreviatingWithTildeInPath,
                                  isOn: $draft.folders[i].selected)
                }
                CardTray {
                    Button { addFolder() } label: { Label(T("sidebar.add_folder"), systemImage: "plus") }
                        .buttonStyle(.pill)
                    Spacer()
                }
            }
        }
    }

    var homeStep: some View {
        Card(padding: 0) {
            VStack(spacing: 0) {
                if draft.home.isEmpty {
                    Text(T("onboarding.home.none")).font(.system(size: 13.5)).foregroundStyle(Palette.secondary)
                        .frame(maxWidth: .infinity).padding(24)
                } else {
                    selectionHeader(items: $draft.home)
                }
                ForEach(draft.home.indices, id: \.self) { i in
                    RowDivider()
                    SelectableRow(icon: Self.homeIcon(draft.home[i].path), title: "~/" + draft.home[i].path,
                                  monospaced: true, isOn: $draft.home[i].selected)
                        .transition(.opacity.combined(with: .move(edge: .top)))
                }
                CardTray {
                    PathField(placeholder: T("onboarding.home.add_placeholder"), text: $newHomeItem,
                              excluding: Set(draft.home.map(\.path)), onSubmit: addHomeItem)
                    Button(action: addHomeItem) { Label(T("action.add"), systemImage: "plus") }
                        .buttonStyle(.pillPrimary)
                        .disabled(newHomeItem.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
    }

    var aiStep: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach($draft.ai) { $tool in
                Card(padding: 0) {
                    VStack(alignment: .leading, spacing: 0) {
                        SettingsRow(icon: "sparkles", title: AIProfiles.name(for: tool.id)) {
                            Badge(text: tool.detected ? T("onboarding.ai.detected") : T("onboarding.ai.not_detected"),
                                  tone: tool.detected ? .success : .neutral)
                        }
                        if tool.detected {
                            HStack(spacing: 8) {
                                ForEach(CairnConfig.AITool.categories, id: \.self) { cat in
                                    ChoiceChip(title: T("ai.category.\(cat)"), isOn: Binding(
                                        get: { tool.categories.contains(cat) },
                                        set: { on in if on { tool.categories.insert(cat) } else { tool.categories.remove(cat) } }))
                                }
                            }
                            .padding(.leading, 62).padding(.trailing, 16).padding(.bottom, 14)
                        }
                    }
                }
                .opacity(tool.detected ? 1 : 0.6)
            }
            Label(T("onboarding.ai.credentials_note"), systemImage: "lock")
                .font(.system(size: 12.5)).foregroundStyle(Palette.secondary)
                .padding(.top, 4)
        }
    }

    var destinationStep: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 12) {
                ChoiceTile(icon: "clock", title: T("onboarding.destination.later"),
                           subtitle: T("onboarding.destination.later.text"), selected: destinationKind == 0) { pickDestination(0) }
                ChoiceTile(icon: "externaldrive", title: T("onboarding.destination.local"),
                           subtitle: T("onboarding.destination.local.text"), selected: destinationKind == 1) { pickDestination(1) }
                ChoiceTile(icon: "server.rack", title: T("onboarding.destination.smb"),
                           subtitle: T("onboarding.destination.smb.text"), selected: destinationKind == 2) { pickDestination(2) }
            }
            if destinationKind == 1 {
                Card(padding: 0) {
                    SettingsRow(title: T("onboarding.destination.path")) {
                        TextField("", text: $localPath, prompt: Text(verbatim: "/Volumes/Backup")).cairnField().frame(width: 260)
                        Button(T("action.choose_folder")) { chooseLocal() }.buttonStyle(.pill)
                    }
                }
                .transition(.opacity)
            } else if destinationKind == 2 {
                Card(padding: 0) {
                    VStack(spacing: 0) {
                        SettingsRow(title: T("onboarding.destination.url_label")) {
                            TextField("", text: $smbURL, prompt: Text(verbatim: "smb://nas.local/backups")).cairnField().frame(width: 300)
                        }
                        RowDivider()
                        SettingsRow(title: T("onboarding.destination.user")) {
                            TextField("", text: $smbUser).cairnField().frame(width: 300)
                        }
                        RowDivider()
                        SettingsRow(title: T("onboarding.destination.password"), subtitle: T("onboarding.destination.keychain")) {
                            SecureField("", text: $password).cairnField().frame(width: 300)
                        }
                    }
                }
                .transition(.opacity)
            }
            if destinationKind != 0 {
                Card(padding: 0) {
                    // Décocher le chiffrement demande une confirmation explicite.
                    SettingsRow(icon: draft.encrypted ? "lock.shield" : "lock.open", title: T("onboarding.destination.encrypted"),
                                subtitle: T("onboarding.destination.encrypted.text")) {
                        Toggle("", isOn: Binding(get: { draft.encrypted }, set: { on in
                            if on { draft.encrypted = true } else { confirmUnencrypted = true }
                        }))
                        .labelsHidden().toggleStyle(.switch)
                    }
                }
                if !draft.encrypted {
                    Banner(icon: "exclamationmark.triangle", text: T("onboarding.destination.unencrypted_warning"), tone: .warning)
                }
            }
        }
        .confirmationDialog(T("onboarding.destination.disable_encryption.title"), isPresented: $confirmUnencrypted,
                            titleVisibility: .visible) {
            Button(T("onboarding.destination.disable_encryption.confirm"), role: .destructive) { draft.encrypted = false }
            Button(T("action.cancel"), role: .cancel) {}
        } message: {
            Text(T("onboarding.destination.disable_encryption.message"))
        }
    }

    var scheduleStep: some View {
        VStack(alignment: .leading, spacing: 16) {
            Card(padding: 0) {
                VStack(spacing: 0) {
                    point("menubar.rectangle", "onboarding.schedule.point_menubar")
                    RowDivider()
                    point("power", "onboarding.schedule.point_login")
                    RowDivider()
                    point("moon", "onboarding.schedule.point_sleep")
                }
            }
            Card(padding: 0) {
                VStack(spacing: 0) {
                    SettingsRow(title: T("onboarding.schedule.backup")) {
                        PillPicker(options: CairnConfig.Frequency.allCases.map { ($0, T("frequency.\($0.rawValue)")) },
                                   selection: $draft.frequency)
                    }
                    if draft.frequency != .manual {
                        RowDivider()
                        SettingsRow(title: T("settings.time")) {
                            TextField("", text: $draft.time, prompt: Text(verbatim: "12:30")).cairnField().frame(width: 100)
                        }
                    }
                    if draft.frequency == .weekly {
                        RowDivider()
                        SettingsRow(title: T("onboarding.schedule.weekday")) {
                            DropdownMenu(options: CairnConfig.weekdays.map { ($0, T("weekday.\($0)")) }, selection: $draft.weekday)
                        }
                    }
                    RowDivider()
                    SettingsRow(title: T("onboarding.schedule.background_toggle")) {
                        Toggle("", isOn: $draft.background).labelsHidden().toggleStyle(.switch)
                    }
                }
            }
        }
    }

    var notificationsStep: some View {
        VStack(alignment: .leading, spacing: 16) {
            Card(padding: 0) {
                SettingsRow(icon: "bell", title: T("onboarding.notifications.toggle")) {
                    Toggle("", isOn: $notifications).labelsHidden().toggleStyle(.switch)
                }
            }
            Text(T("onboarding.summary")).font(.system(size: 15, weight: .medium)).padding(.top, 12)
            let c = previewConfig
            Card(padding: 0) {
                VStack(spacing: 0) {
                    summaryRow("folder", T("onboarding.summary.folders", c.folders.count), done: !c.folders.isEmpty, step: 0)
                    RowDivider()
                    summaryRow("house", T("onboarding.summary.home", c.home.include.count), done: !c.home.include.isEmpty, step: 1)
                    RowDivider()
                    summaryRow("sparkles", T("onboarding.summary.ai", c.ai.count), done: !c.ai.isEmpty, step: 2)
                    RowDivider()
                    summaryRow("externaldrive", c.destinations.isEmpty ? T("onboarding.summary.no_destination")
                               : T("onboarding.summary.destination"), done: !c.destinations.isEmpty, step: 3)
                }
            }
        }
    }

    func point(_ icon: String, _ key: String) -> some View {
        SettingsRow(icon: icon, title: T(key + ".title"), subtitle: T(key + ".text")) { EmptyView() }
    }

    func summaryRow(_ icon: String, _ text: String, done: Bool, step target: Int) -> some View {
        SettingsRow(icon: icon, title: text) {
            Image(systemName: done ? "checkmark.circle.fill" : "minus.circle")
                .foregroundStyle(done ? Palette.foreground(.success) : Palette.secondary)
            Button(T("onboarding.edit")) { go(to: target) }.buttonStyle(.pill)
        }
    }

    /// En-tête de liste : compteur et bouton tout cocher / tout décocher.
    func selectionHeader(items: Binding<[OnboardingDraft.Choice]>) -> some View {
        let selected = items.wrappedValue.filter(\.selected).count
        let all = selected == items.wrappedValue.count
        return HStack {
            Text(T("onboarding.selected_count", selected, items.wrappedValue.count))
                .font(.system(size: 13)).foregroundStyle(Palette.secondary).monospacedDigit()
            Spacer()
            Button(all ? T("action.select_none") : T("action.select_all")) {
                withAnimation(.easeOut(duration: 0.15)) {
                    for i in items.wrappedValue.indices { items.wrappedValue[i].selected = !all }
                }
            }
            .buttonStyle(.plain).font(.system(size: 13)).foregroundStyle(Palette.accent)
        }
        .padding(.horizontal, 16).padding(.vertical, 11)
    }

    static func homeIcon(_ path: String) -> String {
        let p = path.lowercased()
        if p.contains("history") { return "clock.arrow.circlepath" }
        if p.contains("ssh") { return "key" }
        if p.contains("aws") { return "cloud" }
        if p.contains("docker") { return "shippingbox" }
        if p.contains("git") || p.hasSuffix("/gh") { return "arrow.triangle.branch" }
        if p.contains("zsh") || p.contains("bash") || p.contains("profile") { return "terminal" }
        if p.contains("npm") || p.contains("yarn") || p.contains("mise") { return "wrench.and.screwdriver" }
        if p.contains("netrc") { return "network" }
        var isDir: ObjCBool = false
        let full = (NSHomeDirectory() as NSString).appendingPathComponent(path)
        return FileManager.default.fileExists(atPath: full, isDirectory: &isDir) && isDir.boolValue ? "folder" : "doc.text"
    }

    // MARK: Navigation

    var navigation: some View {
        HStack(spacing: 12) {
            Button { go(to: step - 1) } label: { Label(T("action.back"), systemImage: "chevron.left") }
                .buttonStyle(.pill)
                .opacity(step > 0 ? 1 : 0).disabled(step == 0)
            Text(T("onboarding.step_of", step + 1, Self.steps.count))
                .font(.system(size: 12.5)).foregroundStyle(Palette.secondary).monospacedDigit()
            Spacer()
            if let problem = validationProblem(at: step) {
                Label(problem, systemImage: "exclamationmark.circle")
                    .font(.system(size: 12.5)).foregroundStyle(Palette.foreground(.warning))
                    .transition(.opacity)
            }
            if step < Self.steps.count - 1 {
                Button { go(to: step + 1) } label: {
                    HStack(spacing: 6) { Text(T("action.continue")); Image(systemName: "arrow.right") }
                }
                .buttonStyle(.pillPrimary).disabled(validationProblem(at: step) != nil)
            } else {
                Button {
                    syncDestination()
                    model.finishOnboarding(draft, password: password, notifications: notifications)
                } label: {
                    HStack(spacing: 6) { Image(systemName: "checkmark"); Text(T("action.finish")) }
                }
                .buttonStyle(.pillPrimary)
            }
        }
        .padding(.horizontal, 24).frame(height: 60)
        .animation(.easeOut(duration: 0.15), value: validationProblem(at: step))
    }

    /// On peut revenir en arrière librement, ou avancer jusqu'à l'étape suivant la plus avancée atteinte,
    /// à condition que toutes les étapes franchies soient valides.
    func canJump(to target: Int) -> Bool {
        guard target != step, target >= 0, target < Self.steps.count else { return false }
        if target < step { return true }
        return target <= reached + 1 && (step..<target).allSatisfy { validationProblem(at: $0) == nil }
    }

    func go(to target: Int) {
        guard canJump(to: target) else { return }
        syncDestination()
        forward = target > step
        withAnimation(.snappy(duration: 0.3)) {
            step = target
            reached = max(reached, target)
        }
    }

    func pickDestination(_ kind: Int) {
        withAnimation(.snappy(duration: 0.25)) { destinationKind = kind }
    }

    func validationProblem(at index: Int) -> String? {
        switch Self.steps[index] {
        case "folders" where !draft.folders.contains(where: \.selected): return T("onboarding.need_folder")
        case "destination" where destinationKind == 1 && localPath.isEmpty: return T("onboarding.need_path")
        case "destination" where destinationKind == 2 && (!smbURL.lowercased().hasPrefix("smb://") || smbURL.count < 7):
            return T("config.issue.smb_url")
        case "schedule" where draft.time.range(of: #"^([01]\d|2[0-3]):[0-5]\d$"#, options: .regularExpression) == nil:
            return T("config.issue.time")
        default: return nil
        }
    }

    var previewConfig: CairnConfig {
        var d = draft
        d.destination = destinationChoice
        return d.makeConfig()
    }

    var destinationChoice: OnboardingDraft.DestinationChoice {
        switch destinationKind {
        case 1: .local(path: localPath)
        case 2: .smb(url: smbURL, username: smbUser)
        default: .later
        }
    }

    func syncDestination() { draft.destination = destinationChoice }

    func addFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        guard panel.runModal() == .OK, let url = panel.url else { return }
        if !draft.folders.contains(where: { $0.path == url.path }) {
            withAnimation(.snappy) { draft.folders.append(.init(path: url.path, selected: true)) }
        }
    }

    func addHomeItem() {
        var item = newHomeItem.trimmingCharacters(in: .whitespaces)
        if item.hasPrefix("~/") { item.removeFirst(2) }
        guard !item.isEmpty, !draft.home.contains(where: { $0.path == item }) else { return }
        withAnimation(.snappy) { draft.home.append(.init(path: item, selected: true)) }
        newHomeItem = ""
    }

    func chooseLocal() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        if panel.runModal() == .OK, let url = panel.url { localPath = url.path }
    }
}

// MARK: - Composants de l'assistant

/// Étapes horizontales : pastilles reliées par une ligne qui se remplit, étapes atteintes cliquables.
struct WizardStepper: View {
    let titles: [String]
    let current: Int
    let reached: Int
    let canSelect: (Int) -> Bool
    let select: (Int) -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            ForEach(titles.indices, id: \.self) { i in
                StepNode(index: i, title: titles[i], current: current, reached: reached, enabled: canSelect(i)) { select(i) }
                    .frame(maxWidth: .infinity)
            }
        }
        .background(alignment: .topLeading) {
            GeometryReader { g in
                let column = g.size.width / CGFloat(max(titles.count, 1))
                ZStack(alignment: .leading) {
                    Capsule().fill(Palette.border).frame(width: max(0, g.size.width - column), height: 2)
                    Capsule().fill(Palette.text).frame(width: column * CGFloat(current), height: 2)
                }
                .offset(x: column / 2, y: StepNode.size / 2 - 1)
            }
        }
    }
}

private struct StepNode: View {
    static let size: CGFloat = 28
    let index: Int
    let title: String
    let current: Int
    let reached: Int
    let enabled: Bool
    let action: () -> Void
    @ViewState private var hover = false

    var isCurrent: Bool { index == current }
    var isDone: Bool { index < current }
    var isReached: Bool { index <= reached }

    var body: some View {
        Button(action: action) {
            VStack(spacing: 8) {
                ZStack {
                    Circle().fill(Palette.text.opacity(isCurrent ? 0.10 : 0)).frame(width: Self.size + 10, height: Self.size + 10)
                    Circle().fill(isCurrent || isDone ? Palette.primaryButton : Palette.content)
                    Circle().stroke(isCurrent || isDone ? .clear : (isReached ? Palette.text : Palette.fieldBorder), lineWidth: 1.5)
                    if isDone {
                        Image(systemName: "checkmark").font(.system(size: 11, weight: .bold)).foregroundStyle(Palette.primaryButtonText)
                            .transition(.scale.combined(with: .opacity))
                    } else {
                        Text(verbatim: "\(index + 1)").font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(isCurrent ? Palette.primaryButtonText : (isReached ? Palette.text : Palette.secondary))
                    }
                }
                .frame(width: Self.size, height: Self.size)
                .scaleEffect(hover && enabled ? 1.08 : 1)
                Text(title)
                    .font(.system(size: 12.5, weight: isCurrent ? .medium : .regular))
                    .foregroundStyle(isCurrent || (hover && enabled) ? Palette.text : (isReached ? Palette.tertiary : Palette.secondary))
                    .lineLimit(1)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .allowsHitTesting(enabled) // pas .disabled : l'étape courante grisée serait illisible
        .onHover { hover = $0 }
        .animation(.easeOut(duration: 0.15), value: hover)
        .accessibilityLabel(title)
        .accessibilityAddTraits(isCurrent ? .isSelected : [])
    }
}

/// Ligne cochable d'une carte : icône, libellé, interrupteur ; toute la ligne est cliquable.
private struct SelectableRow: View {
    let icon: String
    let title: String
    var subtitle: String?
    var monospaced = false
    @Binding var isOn: Bool
    @ViewState private var hover = false

    var body: some View {
        HStack(spacing: 12) {
            IconTile(systemName: icon, size: 30)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.system(size: 13.5, design: monospaced ? .monospaced : .default))
                    .foregroundStyle(isOn ? Palette.text : Palette.secondary)
                    .lineLimit(1).truncationMode(.middle)
                if let subtitle {
                    Text(subtitle).font(.system(size: 12)).foregroundStyle(Palette.secondary).lineLimit(1).truncationMode(.middle)
                }
            }
            Spacer(minLength: 12)
            Toggle("", isOn: $isOn).labelsHidden().toggleStyle(.switch).controlSize(.small)
        }
        .padding(.horizontal, 16).padding(.vertical, 9)
        .background(hover ? Palette.rowHover : .clear)
        .contentShape(Rectangle())
        .onTapGesture { withAnimation(.easeOut(duration: 0.15)) { isOn.toggle() } }
        .onHover { hover = $0 }
        .accessibilityElement(children: .combine)
    }
}

/// Puce activable (catégories des outils IA).
private struct ChoiceChip: View {
    let title: String
    @Binding var isOn: Bool
    @ViewState private var hover = false

    var body: some View {
        Button { withAnimation(.easeOut(duration: 0.15)) { isOn.toggle() } } label: {
            HStack(spacing: 5) {
                if isOn { Image(systemName: "checkmark").font(.system(size: 10, weight: .bold)) }
                Text(title).font(.system(size: 12.5))
            }
            .foregroundStyle(isOn ? Palette.primaryButtonText : Palette.tertiary)
            .padding(.horizontal, 11).padding(.vertical, 5)
            .background(isOn ? Palette.primaryButton : (hover ? Palette.rowHover : Palette.content), in: Capsule())
            .overlay(Capsule().stroke(isOn ? .clear : Palette.fieldBorder))
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .onHover { hover = $0 }
        .accessibilityAddTraits(isOn ? .isSelected : [])
    }
}

/// Tuile de choix exclusif (type de destination).
private struct ChoiceTile: View {
    let icon: String
    let title: String
    let subtitle: String
    let selected: Bool
    let action: () -> Void
    @ViewState private var hover = false

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .top) {
                    IconTile(systemName: icon, size: 32)
                    Spacer()
                    Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                        .font(.system(size: 16))
                        .foregroundStyle(selected ? Palette.text : Palette.fieldBorder)
                }
                VStack(alignment: .leading, spacing: 3) {
                    Text(title).font(.system(size: 14, weight: .medium)).foregroundStyle(Palette.text)
                    Text(subtitle).font(.system(size: 12.5)).foregroundStyle(Palette.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(14)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .background(hover && !selected ? Palette.rowHover : Palette.content, in: RoundedRectangle(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(selected ? Palette.text : Palette.border, lineWidth: selected ? 1.5 : 1))
            .contentShape(RoundedRectangle(cornerRadius: 14))
        }
        .buttonStyle(.plain)
        .onHover { hover = $0 }
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}
