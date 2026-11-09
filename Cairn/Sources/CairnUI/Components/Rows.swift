import CairnCore
import SwiftUI

// Lignes de liste : élément à cocher, dossier à ouvrir, tâche en cours.

/// Ligne cochable d'une carte : icône, libellé, interrupteur ; toute la ligne est cliquable.
public struct SelectableRow: View {
    let icon: String
    let title: String
    var subtitle: String?
    var monospaced = false
    @Binding var isOn: Bool
    @ViewState private var hover = false

    public init(icon: String, title: String, subtitle: String? = nil, monospaced: Bool = false, isOn: Binding<Bool>) {
        self.icon = icon
        self.title = title
        self.subtitle = subtitle
        self.monospaced = monospaced
        self._isOn = isOn
    }

    public var body: some View {
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

/// Ligne d'un explorateur de dossiers : tuile d'icône, nom, chevron ; toute la ligne ouvre le dossier.
public struct FolderRow: View {
    /// Hauteur d'une ligne (pour dimensionner une liste de N lignes).
    public static let height: CGFloat = 44

    let name: String
    let icon: String
    let action: () -> Void
    @ViewState private var hover = false

    public init(name: String, icon: String, action: @escaping () -> Void) {
        self.name = name
        self.icon = icon
        self.action = action
    }

    /// Dossier du navigateur : volume ou home à la racine, dossier sinon.
    public init(entry: FolderEntry, isRoot: Bool, action: @escaping () -> Void) {
        let icon = !isRoot ? "folder" : entry.url.path.hasPrefix("/Volumes/") ? "externaldrive" : "house"
        self.init(name: entry.name, icon: icon, action: action)
    }

    public var body: some View {
        HStack(spacing: 12) {
            IconTile(systemName: icon, size: 28)
            Text(name).font(.system(size: 13.5)).foregroundStyle(Palette.text).lineLimit(1).truncationMode(.middle)
            Spacer(minLength: 8)
            Image(systemName: "chevron.right").font(.system(size: 11, weight: .semibold)).foregroundStyle(Palette.secondary)
        }
        .padding(.horizontal, 16)
        .frame(height: Self.height)
        .background(hover ? Palette.rowHover : .clear)
        .contentShape(Rectangle())
        .onTapGesture(perform: action)
        .onHover { hover = $0 }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
    }
}

/// Ligne d'une tâche en cours (copie ou comptage) : icône, titre, détail en police fixe, roue ou coche.
public struct WorkerRow: View {
    let icon: String
    let title: String
    let detail: String
    let done: Bool

    public init(icon: String, title: String, detail: String, done: Bool) {
        self.icon = icon
        self.title = title
        self.detail = detail
        self.done = done
    }

    public var body: some View {
        HStack(spacing: 12) {
            Icon(icon, size: 15).foregroundStyle(Palette.secondary).frame(width: 18)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.system(size: 13, weight: .medium)).foregroundStyle(Palette.text).monospacedDigit()
                Text(detail).font(.system(size: 11.5, design: .monospaced)).foregroundStyle(Palette.secondary)
                    .lineLimit(1).truncationMode(.middle)
            }
            Spacer(minLength: 8)
            if done {
                Icon("checkmark.circle", size: 15).foregroundStyle(Palette.foreground(.success))
            } else {
                ProgressView().controlSize(.small)
            }
        }
        .padding(.vertical, 9)
    }
}
