import AppKit
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
        // Événements écrits par la commande `cairn` pendant que l'app était en arrière-plan.
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            model.reloadActivity()
        }
    }
}

/// Couleur d'un état du hub (icône de l'en-tête).
enum StatusColor {
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
            Image(systemName: icon)
                .font(.system(size: 30, weight: .medium))
                .foregroundStyle(StatusColor.color(tone))
                .frame(width: 76, height: 76)
                .background(StatusColor.color(tone).opacity(0.12), in: Circle())
                .overlay(Circle().stroke(StatusColor.color(tone).opacity(0.5), lineWidth: 1.5))
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
        let color = Palette.module(state.module)
        Card(padding: 18) {
            VStack(spacing: 0) {
                Image(systemName: HubText.icon(state.module))
                    .font(.system(size: 28, weight: .regular))
                    .foregroundStyle(color)
                    .frame(width: 64, height: 64)
                    .background(color.opacity(0.13), in: RoundedRectangle(cornerRadius: 18))
                    .padding(.top, 6)
                Text(HubText.module(state.module))
                    .font(.system(size: 13, weight: .medium)).foregroundStyle(Palette.secondary)
                    .padding(.top, 14)
                Text(HubText.figure(state.figure))
                    .font(.system(size: 20, weight: .semibold)).foregroundStyle(Palette.text)
                    .multilineTextAlignment(.center)
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
                .multilineTextAlignment(.center)
                .lineLimit(2).fixedSize(horizontal: false, vertical: true)
                .padding(.top, 4)
                ModuleChart(module: state.module)
                    .frame(height: 10)
                    .padding(.top, 14).padding(.horizontal, 6)
                Spacer(minLength: 16)
                Button { model.perform(state.action) } label: {
                    Text(HubText.action(state.action)).lineLimit(1).frame(maxWidth: .infinity)
                }
                .buttonStyle(.pillOutline)
                .disabled(disabled)
            }
            .frame(maxWidth: .infinity, minHeight: 260, alignment: .top)
        }
        .overlay(alignment: .topTrailing) {
            Group {
                if progress == .running {
                    ProgressView().controlSize(.small)
                } else if let badge = HubText.badge(state.tone) {
                    Badge(text: badge.0, tone: badge.1)
                }
            }
            .padding(12)
        }
    }

    /// Pas de sauvegarde pendant une autre sauvegarde ou avec une configuration invalide.
    var disabled: Bool {
        state.action == .backupNow && (model.isBackingUp || model.configIssues.contains { $0.severity == .error })
    }
}

/// Mini-graphique d'une carte : occupation et récupérable (Stockage), 7 derniers jours (Sauvegarde),
/// branches et worktrees (Git), poids des outils (IA). Vide quand il n'y a rien à montrer.
struct ModuleChart: View {
    @EnvironmentObject var model: AppModel
    let module: HubState.Module

    var body: some View {
        let color = Palette.module(module)
        switch module {
        case .storage:
            if let v = model.volumeSummaries.first {
                FillBar(fraction: v.used, color: v.color == Palette.accent ? color : v.color)
            } else { Color.clear }
        case .backup:
            if model.config?.destinations.isEmpty == false {
                HStack(spacing: 6) {
                    ForEach(Array(model.backupDays.enumerated()), id: \.offset) { _, day in
                        Circle()
                            .fill(day == nil ? Palette.field : (day! ? color : Palette.foreground(.danger)))
                            .frame(width: 9, height: 9)
                    }
                }
                .frame(maxWidth: .infinity)
            } else { Color.clear }
        case .git:
            if let reports = model.gitReports {
                let branches = reports.flatMap(\.branches).filter { GitMaintenance.selectedByDefault($0, options: model.gitOptions) }.count
                let worktrees = reports.flatMap(\.worktrees).filter { GitMaintenance.selectedByDefault($0, options: model.gitOptions) }.count
                SegmentBar(parts: [(Double(branches), color), (Double(worktrees), color.opacity(0.45))])
            } else { Color.clear }
        case .ai:
            if let stats = model.aiStats?.filter(\.detected), !stats.isEmpty {
                let shades = [1.0, 0.65, 0.4, 0.25]
                SegmentBar(parts: stats.enumerated().map { (Double(max($0.element.totalBytes, 1)), color.opacity(shades[$0.offset % shades.count])) })
            } else { Color.clear }
        case .restore:
            Color.clear
        }
    }
}

/// Barre segmentée (proportions), sur la piste grise des jauges.
struct SegmentBar: View {
    let parts: [(Double, Color)]
    var body: some View {
        let total = parts.reduce(0) { $0 + $1.0 }
        GeometryReader { g in
            HStack(spacing: 2) {
                ForEach(Array(parts.enumerated()), id: \.offset) { _, p in
                    if p.0 > 0 { Rectangle().fill(p.1).frame(width: max(3, (g.size.width - 2 * CGFloat(parts.count - 1)) * p.0 / total)) }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Palette.field)
            .clipShape(Capsule())
        }
        .frame(height: 8)
        .opacity(total > 0 ? 1 : 0)
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
