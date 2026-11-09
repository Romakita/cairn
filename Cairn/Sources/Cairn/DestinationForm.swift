import AppKit
import CairnCore
import SwiftUI

// Formulaire « Ajouter une destination », commun à l'assistant et à l'app : type, connexion, navigateur de
// dossiers, vérification, chiffrement. Rien n'est enregistré ici ; l'appelant enregistre après vérification.

/// État du formulaire. Toute modification de l'adresse, de l'identifiant, du mot de passe ou du dossier remet
/// l'état à « non vérifié » ; le démontage du volume choisi aussi.
@MainActor
final class DestinationFormModel: ObservableObject {
    enum Kind: Int { case later, local, smb }

    enum Status: Equatable {
        case unverified
        case checking
        case verified(freeBytes: Int64?, images: [ExistingImage])
        case failed(ProbeFailure)
    }

    @Published var kind: Kind { didSet { if kind != oldValue { kindChanged() } } }
    @Published var localPath = "" { didSet { if localPath != oldValue && !navigating { invalidate() } } }
    @Published var smbAddress = "smb://" { didSet { if smbAddress != oldValue { disconnect() } } }
    @Published var smbUser = NSUserName() { didSet { if smbUser != oldValue { disconnect() } } }
    @Published var password = "" { didSet { if password != oldValue { disconnect() } } }
    @Published var encrypted = true
    @Published var status = Status.unverified

    // Navigateur : `browserFolder == nil` affiche les racines locales (volumes et home).
    @Published private(set) var browserFolder: URL?
    @Published private(set) var listing: Result<[FolderEntry], ProbeFailure> = .success([])
    @Published private(set) var browserImages: [ExistingImage] = []
    @Published private(set) var connected = false
    /// Dossiers partagés du serveur, quand l'adresse ne nomme que l'hôte (`smb://syno`) : à choisir avant le montage.
    @Published private(set) var shares: [String]?

    /// Dossier créé dans le dossier partagé choisi pour y ranger les sauvegardes.
    static let shareFolder = "cairn"

    /// Destination modifiée (`nil` à l'ajout) : type et chiffrement figés, mot de passe vide = celui du Trousseau.
    private(set) var editing: CairnConfig.Destination?

    private var session = ProbeSession()
    private var generation = 0
    private var navigating = false
    private var observers: [NSObjectProtocol] = []

    init(kind: Kind = .later) {
        self.kind = kind
        if kind == .local { refreshListing() }
        let center = NSWorkspace.shared.notificationCenter
        observers = [NSWorkspace.didUnmountNotification, NSWorkspace.didMountNotification].map { name in
            center.addObserver(forName: name, object: nil, queue: .main) { [weak self] n in
                MainActor.assumeIsolated { self?.volumesChanged(unmounted: n.name == NSWorkspace.didUnmountNotification) }
            }
        }
    }

    /// Formulaire prérempli pour modifier une destination. Un dossier local est vérifié tout de suite ; un NAS attend
    /// « Se connecter » (pas de montage sans action de l'utilisateur).
    convenience init(editing d: CairnConfig.Destination) {
        self.init(kind: d.provider == .smb ? .smb : .local)
        editing = d
        encrypted = d.encrypted
        switch d.provider {
        case .smb:
            smbAddress = d.url ?? "smb://"
            smbUser = d.username ?? NSUserName()
        case .local:
            localPath = d.path ?? ""
            if !localPath.isEmpty { submitLocalPath() }
        }
    }

    /// Emplacement choisi différent de celui de la destination modifiée (les sauvegardes faites restent à l'ancien).
    var locationChanged: Bool {
        guard let editing, let d = destination(id: editing.id) else { return false }
        if d.provider == .smb {
            let (a, b) = (DestinationProbe.smbParts(d.url ?? ""), DestinationProbe.smbParts(editing.url ?? ""))
            return a?.host.lowercased() != b?.host.lowercased() || a?.share != b?.share || a?.subpath != b?.subpath
        }
        let norm: (String?) -> String? = { $0.map { (($0 as NSString).expandingTildeInPath as NSString).standardizingPath } }
        return norm(d.path) != norm(editing.path)
    }

    // MARK: Résultat

    var isVerified: Bool { if case .verified = status { return true } else { return false } }

    /// Le mot de passe saisi a été refusé (champ mis en évidence).
    var passwordRejected: Bool { status == .failed(.authenticationFailed) || status == .failed(.passwordRequired) }

    /// Sous-dossier choisi dans le partage monté.
    var smbSubpath: [String] {
        guard let root = session.mountRoot?.standardizedFileURL.pathComponents,
              let folder = browserFolder?.standardizedFileURL.pathComponents,
              folder.starts(with: root) else { return DestinationProbe.smbParts(smbAddress)?.subpath ?? [] }
        return Array(folder.dropFirst(root.count))
    }

    /// Adresse enregistrée : partage saisi + dossier choisi dans le navigateur.
    var finalSMBAddress: String {
        guard let p = DestinationProbe.smbParts(smbAddress) else { return smbAddress }
        return DestinationProbe.smbAddress(host: p.host, share: p.share, subpath: connected ? smbSubpath : p.subpath)
    }

    var choice: OnboardingDraft.DestinationChoice {
        switch kind {
        case .later: .later
        case .local: .local(path: localPath)
        case .smb: .smb(url: finalSMBAddress, username: smbUser)
        }
    }

    func destination(id: String) -> CairnConfig.Destination? {
        switch kind {
        case .later: nil
        case .local: .init(id: id, provider: .local, path: localPath, encrypted: encrypted)
        case .smb: .init(id: id, provider: .smb, url: finalSMBAddress, username: smbUser, encrypted: encrypted)
        }
    }

    /// Sauvegarde d'une autre machine trouvée dans le dossier vérifié.
    var otherMachineImage: ExistingImage? {
        if case let .verified(_, images) = status { return images.first { !$0.isThisMac } }
        return nil
    }

    // MARK: Actions

    /// Ouvre un dossier dans le navigateur ; il devient le dossier de la destination et est vérifié.
    func open(_ url: URL?, verify: Bool = true) {
        browserFolder = url
        refreshListing()
        guard let url else {
            // Retour à la liste des emplacements : plus aucun dossier choisi, la vérification précédente ne vaut plus.
            if kind == .local { invalidate(); setLocalPath("") }
            return
        }
        if kind == .local { setLocalPath(url.path) } else { status = .unverified }
        if verify { self.verify() }
    }

    func goUp() {
        guard let f = browserFolder else { return }
        if kind == .smb, f.standardizedFileURL == session.mountRoot?.standardizedFileURL { return }
        if kind == .local, DestinationProbe.localRoots().contains(where: { $0.url.standardizedFileURL == f.standardizedFileURL }) {
            open(nil); return
        }
        open(f.deletingLastPathComponent())
    }

    /// Chemin saisi à la main puis validé (Entrée ou « Vérifier »).
    func submitLocalPath() {
        let p = (localPath.trimmingCharacters(in: .whitespaces) as NSString).expandingTildeInPath
        guard !p.isEmpty else { return }
        open(URL(fileURLWithPath: p))
    }

    func chooseWithPanel() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        if let f = browserFolder { panel.directoryURL = f }
        if panel.runModal() == .OK, let url = panel.url { open(url) }
    }

    /// Crée un dossier dans le dossier courant et l'ouvre ; renvoie le motif d'un refus.
    func createFolder(_ name: String) -> String? {
        guard let parent = browserFolder else { return nil }
        switch DestinationProbe.createFolder(named: name, in: parent) {
        case let .success(url): open(url); return nil
        case let .failure(f): return f.description
        }
    }

    /// Lance la vérification (connexion au NAS si besoin).
    func verify() {
        switch kind {
        case .later: return
        case .local:
            let p = (localPath as NSString).expandingTildeInPath
            guard !p.isEmpty else { status = .unverified; return }
            run { DestinationProbe.checkFolder(URL(fileURLWithPath: p)) }
        case .smb:
            guard connected, let folder = browserFolder else { connect(); return }
            run { DestinationProbe.checkFolder(folder) }
        }
    }

    /// Connexion : liste des dossiers partagés si l'adresse ne nomme que l'hôte, sinon montage du partage.
    func connect() {
        if DestinationProbe.smbParts(smbAddress) == nil, let host = DestinationProbe.smbHost(smbAddress) {
            listShares(host: host)
        } else {
            mount(createFolder: nil)
        }
    }

    /// Dossier partagé choisi : montage, puis création (ou reprise) du dossier `cairn` où seront les sauvegardes.
    func chooseShare(_ share: String) {
        guard let host = DestinationProbe.smbHost(smbAddress) else { return }
        smbAddress = DestinationProbe.smbAddress(host: host, share: share, subpath: [])
        mount(createFolder: Self.shareFolder)
    }

    /// Dossier des sauvegardes à la racine du partage : repris s'il existe, créé sinon (`nil` si impossible).
    nonisolated private static func shareFolder(named name: String, in root: URL) -> URL? {
        let folder = root.appendingPathComponent(name)
        if FileManager.default.fileExists(atPath: folder.path) { return folder }
        if case let .success(created) = DestinationProbe.createFolder(named: name, in: root) { return created }
        return nil
    }

    /// Liste les dossiers partagés du serveur (sans fenêtre du système).
    private func listShares(host: String) {
        disconnect()
        generation += 1
        let gen = generation
        status = .checking
        let (user, pw) = (smbUser, password)
        Task.detached(priority: .userInitiated) {
            let result = DestinationProbe.listShares(host: host, username: user, password: pw)
            await MainActor.run {
                guard gen == self.generation else { return }
                switch result {
                case let .failure(f): self.status = .failed(f)
                case let .success(list): self.shares = list; self.status = .unverified
                }
            }
        }
    }

    /// Montage du partage (sonde TCP, montage), ouverture du navigateur puis vérification du dossier.
    /// `createFolder` : dossier à créer à la racine du partage s'il n'existe pas, puis à ouvrir.
    private func mount(createFolder: String?) {
        disconnect()
        generation += 1
        let gen = generation
        status = .checking
        let (address, user, pw) = (smbAddress, smbUser, password)
        let s = ProbeSession()
        Task.detached(priority: .userInitiated) {
            let result = s.connect(address: address, username: user, password: pw)
            let sub = DestinationProbe.smbParts(address)?.subpath ?? []
            let existing = s.folder(sub).flatMap { FileManager.default.fileExists(atPath: $0.path) ? $0 : nil } ?? s.mountRoot
            let start = createFolder.flatMap { name in s.mountRoot.flatMap { Self.shareFolder(named: name, in: $0) } } ?? existing
            await MainActor.run {
                guard gen == self.generation else { s.close(); return } // annulée ou remplacée
                switch result {
                case let .failure(f): s.close(); self.status = .failed(f)
                case .success:
                    self.session = s
                    self.connected = true
                    self.open(start)
                }
            }
        }
    }

    /// Abandonne la vérification en cours (un montage en cours est démonté à son retour).
    func cancel() {
        generation += 1
        status = .unverified
    }

    /// Fermeture du formulaire : démonte ce que Cairn a monté.
    func close() {
        generation += 1
        session.close()
        connected = false
        for o in observers { NSWorkspace.shared.notificationCenter.removeObserver(o) }
        observers = []
    }

    // MARK: Interne

    private func run(_ check: @escaping @Sendable () -> ProbeResult) {
        generation += 1
        let gen = generation
        status = .checking
        Task.detached(priority: .userInitiated) {
            let r = check()
            await MainActor.run {
                guard gen == self.generation else { return }
                switch r {
                case let .ok(free, images): self.status = .verified(freeBytes: free, images: images)
                case let .failed(f): self.status = .failed(f)
                }
            }
        }
    }

    private func setLocalPath(_ p: String) {
        navigating = true
        localPath = p
        navigating = false
    }

    private func invalidate() {
        generation += 1
        status = .unverified
    }

    private func disconnect() {
        invalidate()
        shares = nil
        guard connected else { return }
        session.close()
        connected = false
        browserFolder = nil
        listing = .success([])
        browserImages = []
    }

    private func kindChanged() {
        disconnect()
        browserFolder = nil
        refreshListing()
        if kind == .local && !localPath.isEmpty { submitLocalPath() }
    }

    func refreshListing() {
        if let f = browserFolder {
            listing = DestinationProbe.listFolders(at: f)
            browserImages = DestinationProbe.existingImages(at: f)
        } else {
            listing = .success(kind == .local ? DestinationProbe.localRoots() : [])
            browserImages = []
        }
    }

    /// Disque débranché ou partage coupé : la vérification précédente ne vaut plus.
    private func volumesChanged(unmounted: Bool) {
        guard unmounted else { if browserFolder == nil { refreshListing() }; return }
        switch kind {
        case .later: return
        case .local:
            if let v = DestinationProbe.volumeName(of: localPath), !FileManager.default.fileExists(atPath: "/Volumes/" + v) {
                generation += 1
                status = .failed(.volumeMissing(v))
                if browserFolder.map({ DestinationProbe.volumeName(of: $0.path) == v }) ?? false { browserFolder = nil }
            }
            refreshListing()
        case .smb:
            guard connected, let root = session.mountRoot, !FileManager.default.fileExists(atPath: root.path) else { return }
            let share = DestinationProbe.smbParts(smbAddress)?.share ?? smbAddress
            disconnect()
            status = .failed(.volumeMissing(share))
        }
    }

    /// Fil d'Ariane : (titre, dossier) ; `nil` pour les racines locales.
    var breadcrumb: [(String, URL?)] {
        guard let f = browserFolder?.standardizedFileURL else { return kind == .local ? [(T("probe.browser.locations"), nil)] : [] }
        if kind == .smb, let root = session.mountRoot?.standardizedFileURL {
            var out: [(String, URL?)] = [(DestinationProbe.smbParts(smbAddress)?.share ?? root.lastPathComponent, root)]
            var u = root
            for c in smbSubpath { u = u.appendingPathComponent(c); out.append((c, u)) }
            return out
        }
        var out: [(String, URL?)] = [(T("probe.browser.locations"), nil)]
        if let root = DestinationProbe.localRoots().first(where: { f.pathComponents.starts(with: $0.url.standardizedFileURL.pathComponents) }) {
            var u = root.url.standardizedFileURL
            out.append((root.name, u))
            for c in f.pathComponents.dropFirst(u.pathComponents.count) { u = u.appendingPathComponent(c); out.append((c, u)) }
        } else {
            // Dossier hors des racines (choisi avec « Parcourir… ») : parent et dossier seulement.
            out.append(("…", nil))
            out.append((f.deletingLastPathComponent().lastPathComponent, f.deletingLastPathComponent()))
            out.append((f.lastPathComponent, f))
        }
        return out
    }
}

// MARK: - Formulaire

struct DestinationForm: View {
    @ObservedObject var form: DestinationFormModel
    var allowsLater = true
    /// « Restaurer cette sauvegarde » (assistant seulement).
    var onRestore: ((ExistingImage) -> Void)?
    @ViewState private var confirmUnencrypted = false

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            if form.editing == nil { kindTiles }
            switch form.kind {
            case .later: EmptyView()
            case .local: localCard.transition(.opacity)
            case .smb: smbCard.transition(.opacity)
            }
            if form.kind == .local || form.connected {
                FolderBrowser(form: form).transition(.opacity)
            } else if form.kind == .smb, let shares = form.shares {
                SharePicker(shares: shares) { form.chooseShare($0) }.transition(.opacity)
            }
            if form.kind != .later {
                VerificationStatus(form: form, onRestore: onRestore)
                encryption
            }
        }
        .animation(.easeOut(duration: 0.15), value: form.status)
        .animation(.easeOut(duration: 0.15), value: form.connected)
        .animation(.easeOut(duration: 0.15), value: form.shares)
        .confirmationDialog(T("onboarding.destination.disable_encryption.title"), isPresented: $confirmUnencrypted,
                            titleVisibility: .visible) {
            Button(T("onboarding.destination.disable_encryption.confirm"), role: .destructive) { form.encrypted = false }
            Button(T("action.cancel"), role: .cancel) {}
        } message: {
            Text(T("onboarding.destination.disable_encryption.message"))
        }
    }

    var kindTiles: some View {
        HStack(spacing: 12) {
            if allowsLater {
                ChoiceTile(icon: "clock", title: T("onboarding.destination.later"),
                           subtitle: T("onboarding.destination.later.text"), selected: form.kind == .later) { pick(.later) }
            }
            ChoiceTile(icon: "externaldrive", title: T("onboarding.destination.local"),
                       subtitle: T("onboarding.destination.local.text"), selected: form.kind == .local) { pick(.local) }
            ChoiceTile(icon: "server.rack", title: T("onboarding.destination.smb"),
                       subtitle: T("onboarding.destination.smb.text"), selected: form.kind == .smb) { pick(.smb) }
        }
    }

    func pick(_ kind: DestinationFormModel.Kind) {
        withAnimation(.snappy(duration: 0.25)) { form.kind = kind }
    }

    var localCard: some View {
        Card(padding: 0) {
            SettingsRow(title: T("onboarding.destination.path")) {
                TextField("", text: $form.localPath, prompt: Text(verbatim: "/Volumes/Backup"))
                    .cairnField(icon: "folder").frame(width: 280)
                    .onSubmit { form.submitLocalPath() }
                Button(T("probe.browse")) { form.chooseWithPanel() }.buttonStyle(.pill)
            }
        }
    }

    var smbCard: some View {
        Card(padding: 0) {
            VStack(spacing: 0) {
                SettingsRow(title: T("onboarding.destination.url_label"), subtitle: T("probe.smb.url_hint")) {
                    TextField("", text: $form.smbAddress, prompt: Text(verbatim: "smb://nas.local"))
                        .cairnField().frame(width: 300).onSubmit { form.connect() }
                }
                RowDivider()
                SettingsRow(title: T("onboarding.destination.user")) {
                    TextField("", text: $form.smbUser).cairnField().frame(width: 300)
                }
                RowDivider()
                SettingsRow(title: T("onboarding.destination.password"), subtitle: T(form.editing == nil ? "probe.smb.keychain_later" : "destination.edit.password_hint")) {
                    SecureField("", text: $form.password).cairnField().frame(width: 300)
                        .overlay(Capsule().strokeBorder(Palette.foreground(.danger), lineWidth: 1.5).opacity(form.passwordRejected ? 1 : 0))
                        .onSubmit { form.connect() }
                }
                CardTray {
                    Button { form.connect() } label: {
                        Label(form.connected ? T("probe.smb.reconnect") : T("probe.smb.connect"), systemImage: "network")
                    }
                    .buttonStyle(.pillPrimary)
                    .disabled(DestinationProbe.smbHost(form.smbAddress) == nil || form.status == .checking)
                    if form.connected {
                        Text(verbatim: form.finalSMBAddress).font(.system(size: 12.5, design: .monospaced))
                            .foregroundStyle(Palette.secondary).lineLimit(1).truncationMode(.middle)
                    } else {
                        Text(T("probe.smb.connect_hint")).font(.system(size: 12.5)).foregroundStyle(Palette.secondary)
                    }
                    Spacer(minLength: 0)
                }
            }
        }
    }

    @ViewBuilder var encryption: some View {
        Card(padding: 0) {
            // Décocher le chiffrement demande une confirmation explicite.
            SettingsRow(icon: form.encrypted ? "lock.shield" : "lock.open", title: T("onboarding.destination.encrypted"),
                        subtitle: T("onboarding.destination.encrypted.text")) {
                Toggle("", isOn: Binding(get: { form.encrypted }, set: { on in
                    if on { form.encrypted = true } else { confirmUnencrypted = true }
                }))
                .labelsHidden().toggleStyle(.switch)
                .disabled(form.editing != nil)
            }
        }
        if form.editing != nil {
            Text(T("destination.edit.encryption_fixed")).font(.system(size: 12.5)).foregroundStyle(Palette.secondary)
        }
        if form.locationChanged {
            Banner(icon: "info.circle", text: T("destination.edit.folder_changed"), tone: .info)
        }
        if !form.encrypted {
            Banner(icon: "exclamationmark.triangle", text: T("onboarding.destination.unencrypted_warning"), tone: .warning)
        }
    }
}

// MARK: - Navigateur de dossiers

/// Fil d'Ariane, sous-dossiers du dossier courant, création d'un dossier dans le plateau du bas.
struct FolderBrowser: View {
    @ObservedObject var form: DestinationFormModel
    @ViewState private var newName = ""
    @ViewState private var createError: String?

    static let rowHeight: CGFloat = 44

    var body: some View {
        Card(padding: 0) {
            VStack(spacing: 0) {
                HStack(spacing: 8) {
                    FolderBreadcrumb(items: form.breadcrumb) { form.open($0) }
                    Spacer(minLength: 8)
                    ForEach(form.browserImages, id: \.path) { img in
                        Badge(text: img.isThisMac ? T("probe.image.this_mac_badge") : T("probe.image.found", img.machine),
                              tone: .info)
                    }
                }
                .padding(.horizontal, 12).padding(.vertical, 9)
                RowDivider()
                content
                if form.browserFolder != nil {
                    CardTray {
                        TextField("", text: $newName, prompt: Text(T("probe.browser.new_folder_placeholder")))
                            .cairnField(icon: "folder.badge.plus").frame(width: 240)
                            .onSubmit(create)
                            .onChange(of: newName) { createError = nil }
                        Button(T("probe.browser.create")) { create() }.buttonStyle(.pill)
                            .disabled(newName.trimmingCharacters(in: .whitespaces).isEmpty)
                        if let createError {
                            Text(createError).font(.system(size: 12.5)).foregroundStyle(Palette.foreground(.danger)).lineLimit(2)
                        }
                        Spacer(minLength: 0)
                    }
                }
            }
        }
    }

    @ViewBuilder var content: some View {
        switch form.listing {
        case let .failure(f):
            HStack(spacing: 12) {
                IconTile(systemName: "lock", size: 28)
                VStack(alignment: .leading, spacing: 2) {
                    Text(T("probe.browser.access_denied")).font(.system(size: 13.5)).foregroundStyle(Palette.text)
                    Text(f.description).font(.system(size: 12)).foregroundStyle(Palette.secondary).lineLimit(1).truncationMode(.middle)
                }
                Spacer()
                Button { form.goUp() } label: { Label(T("probe.browser.up"), systemImage: "arrow.up") }.buttonStyle(.pill)
            }
            .padding(.horizontal, 16).padding(.vertical, 12)
        case let .success(entries) where entries.isEmpty:
            Text(T(form.browserFolder == nil ? "probe.browser.no_location" : "probe.browser.empty"))
                .font(.system(size: 13)).foregroundStyle(Palette.secondary)
                .frame(maxWidth: .infinity).padding(.vertical, 16)
        case let .success(entries):
            ScrollView {
                VStack(spacing: 0) {
                    ForEach(entries) { e in
                        FolderRow(entry: e, isRoot: form.browserFolder == nil) { form.open(e.url) }
                    }
                }
            }
            .frame(height: CGFloat(min(entries.count, 5)) * Self.rowHeight)
        }
    }

    func create() {
        guard !newName.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        createError = form.createFolder(newName)
        if createError == nil { newName = "" }
    }
}

private struct FolderBreadcrumb: View {
    let items: [(String, URL?)]
    let select: (URL?) -> Void

    var body: some View {
        HStack(spacing: 2) {
            ForEach(items.indices, id: \.self) { i in
                if i > 0 {
                    Image(systemName: "chevron.right").font(.system(size: 9, weight: .semibold)).foregroundStyle(Palette.secondary)
                }
                Crumb(title: items[i].0, current: i == items.count - 1) { select(items[i].1) }
                    .disabled(items[i].0 == "…")
            }
        }
        .lineLimit(1)
    }
}

/// Élément du fil d'Ariane, au style des onglets de page (`TabBar`).
private struct Crumb: View {
    let title: String
    let current: Bool
    let action: () -> Void
    @ViewState private var hover = false

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 13, weight: current ? .medium : .regular))
                .foregroundStyle(current || hover ? Palette.text : Palette.secondary)
                .lineLimit(1).truncationMode(.middle)
                .padding(.horizontal, 9).padding(.vertical, 5)
                .background(current ? Palette.field : (hover ? Palette.rowHover : .clear), in: RoundedRectangle(cornerRadius: 8))
                .contentShape(RoundedRectangle(cornerRadius: 8))
        }
        .buttonStyle(.plain)
        .onHover { hover = $0 }
    }
}

/// Dossiers partagés du serveur (adresse `smb://hôte`) : un clic monte le partage et y crée le dossier `cairn`.
private struct SharePicker: View {
    let shares: [String]
    let choose: (String) -> Void

    var body: some View {
        Card(padding: 0) {
            VStack(alignment: .leading, spacing: 0) {
                Text(T("probe.smb.shares_title")).font(.system(size: 13, weight: .medium)).foregroundStyle(Palette.text)
                    .padding(.horizontal, 16).padding(.vertical, 10)
                RowDivider()
                ScrollView {
                    VStack(spacing: 0) {
                        ForEach(shares, id: \.self) { name in
                            FolderRow(name: name, icon: "externaldrive.connected.to.line.below") { choose(name) }
                        }
                    }
                }
                .frame(height: CGFloat(min(shares.count, 5)) * FolderBrowser.rowHeight)
            }
        }
    }
}

private struct FolderRow: View {
    let name: String
    let icon: String
    let action: () -> Void
    @ViewState private var hover = false

    init(name: String, icon: String, action: @escaping () -> Void) {
        self.name = name
        self.icon = icon
        self.action = action
    }

    init(entry: FolderEntry, isRoot: Bool, action: @escaping () -> Void) {
        let icon = !isRoot ? "folder" : entry.url.path.hasPrefix("/Volumes/") ? "externaldrive" : "house"
        self.init(name: entry.name, icon: icon, action: action)
    }

    var body: some View {
        HStack(spacing: 12) {
            IconTile(systemName: icon, size: 28)
            Text(name).font(.system(size: 13.5)).foregroundStyle(Palette.text).lineLimit(1).truncationMode(.middle)
            Spacer(minLength: 8)
            Image(systemName: "chevron.right").font(.system(size: 11, weight: .semibold)).foregroundStyle(Palette.secondary)
        }
        .padding(.horizontal, 16)
        .frame(height: FolderBrowser.rowHeight)
        .background(hover ? Palette.rowHover : .clear)
        .contentShape(Rectangle())
        .onTapGesture(perform: action)
        .onHover { hover = $0 }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
    }
}

// MARK: - État de la vérification

struct VerificationStatus: View {
    @ObservedObject var form: DestinationFormModel
    var onRestore: ((ExistingImage) -> Void)?

    var body: some View {
        switch form.status {
        case .unverified:
            Card(padding: 0) {
                SettingsRow(icon: "checkmark.shield", title: T("probe.status.unverified"), subtitle: unverifiedHint) {
                    if form.kind == .local {
                        Button(T("probe.verify")) { form.submitLocalPath() }.buttonStyle(.pill)
                            .disabled(form.localPath.trimmingCharacters(in: .whitespaces).isEmpty)
                    } else if form.connected {
                        Button(T("probe.verify")) { form.verify() }.buttonStyle(.pill)
                    }
                }
            }
        case .checking:
            Card(padding: 0) {
                SettingsRow(title: T(form.kind == .smb && !form.connected ? "probe.status.connecting" : "probe.status.checking"),
                            subtitle: target) {
                    ProgressView().controlSize(.small)
                    Button(T("action.cancel")) { form.cancel() }.buttonStyle(.pill)
                }
            }
        case let .verified(free, images):
            VStack(alignment: .leading, spacing: 10) {
                Banner(icon: "checkmark.circle", text: free.map { T("probe.status.ok_free", Fmt.bytes($0)) } ?? T("probe.status.ok"),
                       tone: .success)
                ForEach(images, id: \.path) { img in
                    if img.isThisMac {
                        Banner(icon: "arrow.triangle.2.circlepath", text: T("probe.image.this_mac"), tone: .info)
                    } else {
                        Banner(icon: "externaldrive.badge.checkmark", text: T("probe.image.found", img.machine), tone: .info) {
                            if let onRestore {
                                Button(T("probe.image.restore")) { onRestore(img) }.buttonStyle(.pill)
                            }
                        }
                    }
                }
            }
        case let .failed(f):
            Banner(icon: "exclamationmark.triangle", text: f.description + (f.hint.isEmpty ? "" : " " + f.hint), tone: .danger) {
                Button(T("probe.retry")) { form.kind == .smb && !form.connected ? form.connect() : form.verify() }
                    .buttonStyle(.pill)
            }
        }
    }

    var unverifiedHint: String {
        switch form.kind {
        case .smb: T(form.connected ? "probe.status.pick_folder" : form.shares != nil ? "probe.status.pick_share" : "probe.status.connect_first")
        default: T("probe.status.pick_folder")
        }
    }

    var target: String { form.kind == .smb ? form.finalSMBAddress : form.localPath }
}

// MARK: - Feuille de l'app

/// « Ajouter une destination » ou « Modifier la destination » depuis l'app : même formulaire que l'assistant,
/// enregistrement seulement après vérification.
struct AddDestinationSheet: View {
    @EnvironmentObject var model: AppModel
    @StateObject private var form: DestinationFormModel
    @Environment(\.dismiss) private var dismiss

    init(form: DestinationFormModel? = nil) {
        _form = StateObject(wrappedValue: form ?? DestinationFormModel(kind: .local))
    }

    /// Feuille de modification d'une destination existante.
    init(editing d: CairnConfig.Destination) {
        _form = StateObject(wrappedValue: DestinationFormModel(editing: d))
    }

    var body: some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 6) {
                Text(T(form.editing == nil ? "sidebar.add_destination" : "destination.edit.title")).font(.system(size: 22, weight: .medium))
                Text(T(form.editing == nil ? "probe.sheet.text" : "destination.edit.text")).font(.system(size: 13.5)).foregroundStyle(Palette.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 28).padding(.top, 24).padding(.bottom, 18)
            Rectangle().fill(Palette.border).frame(height: 1)
            ScrollView {
                DestinationForm(form: form, allowsLater: false).padding(28)
            }
            Rectangle().fill(Palette.border).frame(height: 1)
            HStack(spacing: 12) {
                if !form.isVerified {
                    Label(T("probe.need_verification"), systemImage: "exclamationmark.circle")
                        .font(.system(size: 12.5)).foregroundStyle(Palette.secondary)
                }
                Spacer()
                Button(T("action.cancel")) { close() }.buttonStyle(.pill).keyboardShortcut(.cancelAction)
                if let original = form.editing {
                    Button { if model.saveEditedDestination(form, original: original) { close() } } label: {
                        Label(T("action.save"), systemImage: "checkmark")
                    }
                    .buttonStyle(.pillPrimary).disabled(!form.isVerified)
                } else {
                    Button { if model.saveNewDestination(form) { close() } } label: {
                        Label(T("action.add"), systemImage: "plus")
                    }
                    .buttonStyle(.pillPrimary).disabled(!form.isVerified)
                }
            }
            .padding(.horizontal, 24).frame(height: 60)
        }
        .frame(width: 760, height: 720)
        .background(Palette.content)
        .onDisappear { form.close() }
    }

    func close() {
        form.close()
        dismiss()
    }
}

extension AppModel {
    /// Ouvre la feuille « Ajouter une destination » depuis la page Sauvegardes.
    func addDestination() {
        section = .backup
        showAddDestination = true
    }

    /// Enregistre une destination vérifiée : `config.toml`, puis le mot de passe du NAS dans le Trousseau.
    func saveNewDestination(_ form: DestinationFormModel) -> Bool {
        guard form.isVerified else { return false }
        let provider: CairnConfig.Provider = form.kind == .smb ? .smb : .local
        let id = CairnConfig.newDestinationID(provider: provider, existing: (config?.destinations ?? []).map(\.id))
        guard let d = form.destination(id: id) else { return false }
        // config.toml d'abord : si l'écriture échoue, la feuille reste ouverte et rien n'est écrit au Trousseau.
        guard updateConfig({ $0.destinations.append(d) }) else { return false }
        selectedDestination = id
        if d.provider == .smb, !form.password.isEmpty, let host = d.url.flatMap(OnboardingDraft.smbHost) {
            do { try Keychain.setInternetPassword(form.password, server: host, account: form.smbUser) } catch {
                // La destination est enregistrée ; le mot de passe sera redemandé à la première sauvegarde.
                lastMessage = T("onboarding.keychain_error", String(describing: error))
            }
        }
        return true
    }

    /// Enregistre une destination modifiée et vérifiée : seule la connexion change (identifiant, chiffrement, rétention
    /// et historique conservés). Le mot de passe saisi va dans le Trousseau ; vide, celui du Trousseau reste.
    func saveEditedDestination(_ form: DestinationFormModel, original: CairnConfig.Destination) -> Bool {
        guard form.isVerified, let edited = form.destination(id: original.id) else { return false }
        let d = original.updatingConnection(from: edited)
        if d.provider == .smb, !form.password.isEmpty, let host = d.url.flatMap(OnboardingDraft.smbHost) {
            do { try Keychain.setInternetPassword(form.password, server: host, account: d.username ?? NSUserName()) } catch {
                lastMessage = T("onboarding.keychain_error", String(describing: error))
                return false
            }
        }
        // Écriture refusée : la feuille reste ouverte avec l'erreur (`lastMessage`).
        guard updateConfig({ c in if let i = c.destinations.firstIndex(where: { $0.id == d.id }) { c.destinations[i] = d } }) else {
            return false
        }
        versions[d.id] = nil
        versionsError[d.id] = nil
        destinationWaiting[d.id] = false // vient d'être vérifiée
        lastMessage = T("destination.edit.saved", destinationLabel(d))
        return true
    }

    /// « Restaurer cette sauvegarde » depuis l'assistant : la restauration s'ouvre sur cette destination.
    func restoreFromOnboarding(_ form: DestinationFormModel, image: ExistingImage) {
        if var d = form.destination(id: "restore") {
            d.encrypted = true // l'image est lue telle quelle, chiffrée ou non
            pendingRestore = (d, form.kind == .smb && !form.password.isEmpty ? form.password : nil, (image.path as NSString).lastPathComponent)
        }
        form.close()
        restoreInsteadOfOnboarding()
    }
}
