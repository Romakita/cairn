import CairnCore
import SwiftUI

/// Accueil : état global, « Tout vérifier », une carte par module, activité récente et problème prioritaire.
struct HomeView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        let hub = model.hubState
        ScrollView {
            VStack(spacing: 30) {
                HubHeader(hub: hub)
                ModuleGrid(hub: hub)
                ActivitySection()
            }
            .frame(maxWidth: 1040)
            .padding(.horizontal, 40).padding(.top, 44).padding(.bottom, 28)
            .frame(maxWidth: .infinity)
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if let issue = hub.topIssue {
                PriorityBanner(issue: issue)
                    .frame(maxWidth: 1040)
                    .padding(.horizontal, 40).padding(.vertical, 14)
                    .frame(maxWidth: .infinity)
                    .background(Palette.content)
                    .overlay(alignment: .top) { Rectangle().fill(Palette.border).frame(height: 1) }
            }
        }
        .onAppear { model.reloadActivity() }
    }
}

/// Icône cerclée au ton d'un état : anneau fin coloré, comme une jauge mais en trait fin.
struct StatusRing: View {
    let icon: String
    let tone: HubState.Tone
    var size: CGFloat = 40

    var body: some View {
        Image(systemName: icon)
            .font(.system(size: size * 0.4))
            .fontWeight(.light)
            .foregroundStyle(tone == .unknown ? Palette.secondary : Palette.text)
            .frame(width: size, height: size)
            .overlay(Circle().stroke(Self.color(tone), lineWidth: size > 48 ? 2 : 1.5))
    }

    static func color(_ t: HubState.Tone) -> Color {
        switch t {
        case .ok: Palette.foreground(.success)
        case .info: Palette.accent
        case .attention: Color.orange
        case .error: Palette.foreground(.danger)
        case .unknown: Palette.fieldBorder
        }
    }
}

// MARK: - En-tête

struct HubHeader: View {
    @EnvironmentObject var model: AppModel
    let hub: HubState

    var body: some View {
        VStack(spacing: 12) {
            StatusRing(icon: icon, tone: tone, size: 64)
                .padding(.bottom, 4)
            Text(HubText.title(hub))
                .font(.system(size: 28, weight: .medium))
                .foregroundStyle(Palette.text)
                .multilineTextAlignment(.center)
            if !hub.causes.isEmpty {
                VStack(spacing: 3) {
                    ForEach(Array(hub.causes.prefix(3).enumerated()), id: \.offset) { _, c in
                        Text(HubText.issue(c)).foregroundStyle(Palette.tertiary)
                    }
                    if hub.causes.count > 3 {
                        Text(T("hub.more_causes", hub.causes.count - 3)).foregroundStyle(Palette.secondary)
                    }
                }
                .font(.system(size: 13.5))
                .multilineTextAlignment(.center)
            }
            Text(model.lastCheck.map { T("hub.checked", HubText.relative($0, sentence: false)) } ?? T("hub.never_checked"))
                .font(.system(size: 13)).foregroundStyle(Palette.secondary)
            Group {
                if model.isChecking {
                    HStack(spacing: 10) {
                        ProgressView().controlSize(.small)
                        Text(T("hub.checking")).font(.system(size: 13)).foregroundStyle(Palette.secondary)
                        Button(T("action.stop")) { model.stopCheck() }.buttonStyle(.pill)
                    }
                } else {
                    Button { model.checkEverything() } label: {
                        Label(T("hub.check"), systemImage: "checkmark.shield").padding(.horizontal, 6)
                    }
                    .buttonStyle(.pillPrimary)
                    .tooltip(T("hub.check.help"))
                }
            }
            .frame(height: 34)
            .padding(.top, 6)
        }
        .frame(maxWidth: .infinity)
    }

    var icon: String {
        switch hub.overall {
        case .ok: "checkmark"
        case .attention: "exclamationmark"
        case .error: "xmark"
        }
    }

    var tone: HubState.Tone {
        switch hub.overall {
        case .ok: .ok
        case .attention: .attention
        case .error: .error
        }
    }
}

// MARK: - Cartes de modules

/// Cinq cartes sur une ligne quand la place le permet, sinon sur trois colonnes.
struct ModuleGrid: View {
    let hub: HubState

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .top, spacing: 14) { cards(idealWidth: 190) }
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 14, alignment: .top), count: 3),
                      alignment: .leading, spacing: 14) { cards(idealWidth: nil) }
        }
    }

    @ViewBuilder func cards(idealWidth: CGFloat?) -> some View {
        ForEach(hub.modules, id: \.module) { m in
            ModuleCard(state: m)
                .frame(minWidth: idealWidth, idealWidth: idealWidth, maxWidth: .infinity)
        }
    }
}

struct ModuleCard: View {
    @EnvironmentObject var model: AppModel
    let state: HubState.ModuleState

    var body: some View {
        let progress = model.checkStates[state.module]
        Card(padding: 16) {
            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .top) {
                    StatusRing(icon: HubText.icon(state.module), tone: state.tone)
                    Spacer()
                    if progress == .running { ProgressView().controlSize(.small) }
                }
                Text(HubText.module(state.module))
                    .font(.system(size: 13)).foregroundStyle(Palette.secondary)
                    .padding(.top, 14)
                Text(HubText.figure(state.figure))
                    .font(.system(size: 20, weight: .medium)).foregroundStyle(Palette.text)
                    .lineLimit(2).minimumScaleFactor(0.8)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 4)
                Group {
                    if progress == .running {
                        Text(T("hub.progress.running"))
                    } else if progress == .failed {
                        Text(T("hub.progress.failed")).foregroundStyle(Palette.foreground(.danger))
                    } else if let d = HubText.detail(state.detail) {
                        Text(d)
                    } else {
                        Text(verbatim: " ")
                    }
                }
                .font(.system(size: 12.5)).foregroundStyle(Palette.secondary)
                .lineLimit(2).fixedSize(horizontal: false, vertical: true)
                .padding(.top, 4)
                Spacer(minLength: 16)
                Button { model.perform(state.action) } label: {
                    Text(HubText.action(state.action)).lineLimit(1).frame(maxWidth: .infinity)
                }
                .buttonStyle(.pillOutline)
                .disabled(disabled)
            }
            .frame(maxWidth: .infinity, minHeight: 168, alignment: .topLeading)
        }
    }

    /// Pas de sauvegarde pendant une autre sauvegarde ou avec une configuration invalide.
    var disabled: Bool {
        state.action == .backupNow && (model.isBackingUp || model.configIssues.contains { $0.severity == .error })
    }
}

// MARK: - Activité récente

struct ActivitySection: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        let labels = Dictionary((model.config?.destinations ?? []).map { ($0.id, model.destinationLabel($0)) },
                                uniquingKeysWith: { a, _ in a })
        VStack(alignment: .leading, spacing: 8) {
            SectionTitle(title: T("hub.activity.title"))
            Card(padding: 0) {
                if model.activity.isEmpty {
                    Text(T("hub.activity.empty"))
                        .font(.system(size: 13.5)).foregroundStyle(Palette.secondary)
                        .padding(.horizontal, 16).padding(.vertical, 16)
                } else {
                    VStack(spacing: 0) {
                        ForEach(Array(model.activity.enumerated()), id: \.offset) { i, e in
                            if i > 0 { RowDivider() }
                            SettingsRow(icon: HubText.activityIcon(e.kind), title: HubText.activity(e, labels: labels)) {
                                Text(Fmt.date(e.date)).font(.system(size: 12.5)).foregroundStyle(Palette.secondary)
                            }
                        }
                    }
                }
            }
        }
    }
}

// MARK: - Problème prioritaire

struct PriorityBanner: View {
    @EnvironmentObject var model: AppModel
    let issue: HubState.Issue

    var body: some View {
        Banner(icon: issue.level == .error || issue.kind == .diskCritical ? "xmark.octagon" : "exclamationmark.triangle",
               text: HubText.issue(issue),
               tone: issue.level == .error || issue.kind == .diskCritical ? .danger : .warning) {
            Button(T("hub.resolve")) { model.resolve(issue) }.buttonStyle(.pillPrimary)
        }
    }
}
