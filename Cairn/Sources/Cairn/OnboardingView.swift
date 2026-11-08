import AppKit
import CairnCore
import SwiftUI

/// Assistant de premier lancement. Rien n'est écrit sur disque avant « Terminer ».
struct OnboardingView: View {
    @EnvironmentObject var model: AppModel
    @ViewState private var draft = OnboardingDraft.detect(legacyRootPath: UserDefaults.standard.string(forKey: "rootPath"))
    @ViewState private var step = 0
    @ViewState private var destinationKind = 0 // 0 plus tard, 1 dossier, 2 NAS
    @ViewState private var localPath = ""
    @ViewState private var smbURL = "smb://"
    @ViewState private var smbUser = NSUserName()
    @ViewState private var password = ""
    @ViewState private var notifications = true
    @ViewState private var newHomeItem = ""
    @ViewState private var confirmUnencrypted = false

    static let steps = ["folders", "home", "ai", "destination", "schedule", "notifications"]

    init(step: Int = 0) { _step = ViewState(initialValue: step) }

    var body: some View {
        HStack(spacing: 0) {
            stepsColumn
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    Text(T("onboarding.step_of", step + 1, Self.steps.count)).font(.system(size: 13)).foregroundStyle(Palette.secondary)
                    content
                    navigation.padding(.top, 8)
                }
                .frame(maxWidth: 640, alignment: .leading)
                .padding(.horizontal, 48).padding(.top, 72).padding(.bottom, 40)
                .frame(maxWidth: .infinity)
            }
            .background(Palette.content)
        }
    }

    var stepsColumn: some View {
        VStack(alignment: .leading, spacing: 2) {
            Color.clear.frame(height: 44)
            HStack(spacing: 8) {
                CairnLogo(size: 24)
                Text(T("onboarding.welcome")).font(.system(size: 18, weight: .semibold))
            }
            .padding(.horizontal, 10).padding(.bottom, 18)
            ForEach(Self.steps.indices, id: \.self) { i in
                HStack(spacing: 12) {
                    ZStack {
                        Circle().fill(i < step ? Palette.background(.success) : (i == step ? Palette.primaryButton : Palette.rowSelected))
                        if i < step { Image(systemName: "checkmark").font(.system(size: 11, weight: .bold)).foregroundStyle(Palette.foreground(.success)) }
                        else { Text(verbatim: "\(i + 1)").font(.system(size: 12, weight: .semibold)).foregroundStyle(i == step ? Palette.primaryButtonText : Palette.tertiary) }
                    }
                    .frame(width: 24, height: 24)
                    Text(T("onboarding.\(Self.steps[i]).title")).font(.system(size: 13.5, weight: i == step ? .medium : .regular))
                    Spacer()
                }
                .padding(.horizontal, 10).padding(.vertical, 9)
                .background(i == step ? Palette.rowSelected : .clear, in: RoundedRectangle(cornerRadius: 10))
            }
            Spacer()
            Button { model.restoreInsteadOfOnboarding() } label: {
                Label(T("onboarding.restore_instead"), systemImage: "arrow.counterclockwise").font(.system(size: 13))
            }
            .buttonStyle(.plain).foregroundStyle(Palette.accent).padding(10)
        }
        .padding(.horizontal, 16).padding(.bottom, 12)
        .frame(width: 304)
        .background(Palette.sidebar)
        .overlay(alignment: .trailing) { Rectangle().fill(Palette.border).frame(width: 1) }
    }

    @ViewBuilder var content: some View {
        let key = Self.steps[step]
        Text(T("onboarding.\(key).heading")).font(.system(size: 30, weight: .medium))
        Text(T("onboarding.\(key).text")).font(.system(size: 15)).foregroundStyle(Palette.tertiary)
            .fixedSize(horizontal: false, vertical: true)
        switch key {
        case "folders": foldersStep
        case "home": homeStep
        case "ai": aiStep
        case "destination": destinationStep
        case "schedule": scheduleStep
        default: notificationsStep
        }
    }

    // MARK: Étapes

    var foldersStep: some View {
        Card(padding: 6) {
            VStack(alignment: .leading, spacing: 0) {
                ForEach($draft.folders) { $f in
                    Toggle(isOn: $f.selected) { Text(f.path).font(.system(size: 14)) }
                        .toggleStyle(.checkbox).padding(12)
                }
                Button { addFolder() } label: { Label(T("sidebar.add_folder"), systemImage: "plus") }
                    .buttonStyle(.plain).foregroundStyle(Palette.accent).padding(12)
            }
        }
    }

    var homeStep: some View {
        Card(padding: 6) {
            VStack(alignment: .leading, spacing: 0) {
                if draft.home.isEmpty { Text(T("onboarding.home.none")).foregroundStyle(Palette.secondary).padding(12) }
                ForEach($draft.home) { $h in
                    Toggle(isOn: $h.selected) { Text("~/" + h.path).font(.system(size: 14, design: .monospaced)) }
                        .toggleStyle(.checkbox).padding(.horizontal, 12).padding(.vertical, 8)
                }
                HStack {
                    TextField(T("onboarding.home.add_placeholder"), text: $newHomeItem)
                        .textFieldStyle(.roundedBorder)
                        .onSubmit(addHomeItem)
                    Button(T("action.add"), action: addHomeItem).buttonStyle(.pill)
                }
                .padding(12)
            }
        }
    }

    var aiStep: some View {
        VStack(spacing: 12) {
            ForEach($draft.ai) { $tool in
                Card {
                    VStack(alignment: .leading, spacing: 10) {
                        HStack {
                            Text(T("ai.\(tool.id)")).font(.system(size: 15, weight: .semibold))
                            Spacer()
                            Badge(text: tool.detected ? T("onboarding.ai.detected") : T("onboarding.ai.not_detected"),
                                  tone: tool.detected ? .success : .neutral)
                        }
                        if tool.detected {
                            HStack(spacing: 16) {
                                ForEach(CairnConfig.AITool.categories, id: \.self) { cat in
                                    Toggle(T("ai.category.\(cat)"), isOn: Binding(
                                        get: { tool.categories.contains(cat) },
                                        set: { on in if on { tool.categories.insert(cat) } else { tool.categories.remove(cat) } }))
                                        .toggleStyle(.checkbox)
                                }
                            }
                        }
                    }
                }
            }
            Text(T("onboarding.ai.credentials_note")).font(.system(size: 12.5)).foregroundStyle(Palette.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    var destinationStep: some View {
        VStack(alignment: .leading, spacing: 14) {
            PillPicker(options: [(0, T("onboarding.destination.later")), (1, T("onboarding.destination.local")),
                                 (2, T("onboarding.destination.smb"))], selection: $destinationKind)
            if destinationKind == 1 {
                HStack {
                    TextField(T("onboarding.destination.path"), text: $localPath).textFieldStyle(.roundedBorder)
                    Button(T("action.choose")) { chooseLocal() }.buttonStyle(.pill)
                }
            } else if destinationKind == 2 {
                VStack(alignment: .leading, spacing: 10) {
                    TextField(T("onboarding.destination.url"), text: $smbURL).textFieldStyle(.roundedBorder)
                    TextField(T("onboarding.destination.user"), text: $smbUser).textFieldStyle(.roundedBorder)
                    SecureField(T("onboarding.destination.password"), text: $password).textFieldStyle(.roundedBorder)
                    Text(T("onboarding.destination.keychain")).font(.system(size: 12.5)).foregroundStyle(Palette.secondary)
                }
            }
            if destinationKind != 0 {
                // Décocher le chiffrement demande une confirmation explicite.
                Toggle(T("onboarding.destination.encrypted"), isOn: Binding(get: { draft.encrypted }, set: { on in
                    if on { draft.encrypted = true } else { confirmUnencrypted = true }
                })).toggleStyle(.switch)
                if !draft.encrypted {
                    Banner(icon: "lock.open", text: T("onboarding.destination.unencrypted_warning"), tone: .warning)
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
        VStack(alignment: .leading, spacing: 18) {
            Card(padding: 0) {
                VStack(alignment: .leading, spacing: 0) {
                    point("menubar.rectangle", "onboarding.schedule.point_menubar")
                    Divider()
                    point("power", "onboarding.schedule.point_login")
                    Divider()
                    point("moon", "onboarding.schedule.point_sleep")
                }
            }
            HStack(spacing: 14) {
                Text(T("onboarding.schedule.backup"))
                PillPicker(options: CairnConfig.Frequency.allCases.map { ($0, T("frequency.\($0.rawValue)")) }, selection: $draft.frequency)
                if draft.frequency != .manual {
                    TextField("12:30", text: $draft.time).textFieldStyle(.roundedBorder).frame(width: 72)
                }
            }
            if draft.frequency == .weekly {
                Picker(T("onboarding.schedule.weekday"), selection: $draft.weekday) {
                    ForEach(CairnConfig.weekdays, id: \.self) { Text(T("weekday.\($0)")).tag($0) }
                }
                .frame(width: 260)
            }
            Toggle(T("onboarding.schedule.background_toggle"), isOn: $draft.background).toggleStyle(.switch)
        }
    }

    var notificationsStep: some View {
        VStack(alignment: .leading, spacing: 14) {
            Toggle(T("onboarding.notifications.toggle"), isOn: $notifications).toggleStyle(.switch)
            Card {
                VStack(alignment: .leading, spacing: 6) {
                    Text(T("onboarding.summary")).font(.system(size: 15, weight: .semibold))
                    let c = previewConfig
                    Text(T("onboarding.summary.folders", c.folders.count))
                    Text(T("onboarding.summary.home", c.home.include.count))
                    Text(T("onboarding.summary.ai", c.ai.count))
                    Text(c.destinations.isEmpty ? T("onboarding.summary.no_destination") : T("onboarding.summary.destination"))
                }
                .font(.system(size: 13.5)).foregroundStyle(Palette.tertiary)
            }
        }
    }

    func point(_ icon: String, _ key: String) -> some View {
        HStack(alignment: .top, spacing: 14) {
            Image(systemName: icon).frame(width: 34, height: 34).background(Palette.field, in: RoundedRectangle(cornerRadius: 10))
            VStack(alignment: .leading, spacing: 3) {
                Text(T(key + ".title")).font(.system(size: 14, weight: .medium))
                Text(T(key + ".text")).font(.system(size: 13)).foregroundStyle(Palette.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(14)
    }

    // MARK: Navigation

    var navigation: some View {
        HStack(spacing: 10) {
            if step > 0 { Button(T("action.back")) { step -= 1 }.buttonStyle(.pill) }
            Spacer()
            if let problem = validationProblem {
                Text(problem).font(.system(size: 12.5)).foregroundStyle(Palette.foreground(.warning))
            }
            if step < Self.steps.count - 1 {
                Button(T("action.continue")) { syncDestination(); step += 1 }
                    .buttonStyle(.pillPrimary).disabled(validationProblem != nil)
            } else {
                Button(T("action.finish")) {
                    syncDestination()
                    model.finishOnboarding(draft, password: password, notifications: notifications)
                }
                .buttonStyle(.pillPrimary)
            }
        }
    }

    var validationProblem: String? {
        switch Self.steps[step] {
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
        if !draft.folders.contains(where: { $0.path == url.path }) { draft.folders.append(.init(path: url.path, selected: true)) }
    }

    func addHomeItem() {
        var item = newHomeItem.trimmingCharacters(in: .whitespaces)
        if item.hasPrefix("~/") { item.removeFirst(2) }
        guard !item.isEmpty, !draft.home.contains(where: { $0.path == item }) else { return }
        draft.home.append(.init(path: item, selected: true))
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
