import CairnCore
import SwiftUI

// Choix : puces activables, puces de filtre, tuiles de choix exclusif.

/// Puce activable (catégories des outils IA) : pilule noire cochée quand active, bordée sinon.
public struct ChoiceChip: View {
    let title: String
    @Binding var isOn: Bool
    @ViewState private var hover = false

    public init(title: String, isOn: Binding<Bool>) {
        self.title = title
        self._isOn = isOn
    }

    public var body: some View {
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

/// Puce de filtre par catégorie : pastille de couleur, libellé et total ; teintée quand le filtre est actif.
public struct FilterChip: View {
    let title: String
    let total: Int64
    let color: Color
    let active: Bool
    let action: () -> Void

    public init(title: String, total: Int64, color: Color, active: Bool, action: @escaping () -> Void) {
        self.title = title
        self.total = total
        self.color = color
        self.active = active
        self.action = action
    }

    public var body: some View {
        Button(action: action) {
            HStack(spacing: 5) {
                Circle().fill(color).frame(width: 8, height: 8)
                Text(title)
                Text(Fmt.bytes(total)).foregroundStyle(.secondary).monospacedDigit()
            }
            .font(.callout)
            .padding(.horizontal, 10).padding(.vertical, 4)
            .background(active ? color.opacity(0.22) : Color.gray.opacity(0.1), in: Capsule())
            .overlay(Capsule().stroke(active ? color : .clear, lineWidth: 1))
        }
        .buttonStyle(.plain)
    }
}

/// Tuile de choix exclusif (type de destination) : icône, titre, description, rond coché quand choisie.
public struct ChoiceTile: View {
    let icon: String
    let title: String
    let subtitle: String
    let selected: Bool
    let action: () -> Void
    @ViewState private var hover = false

    public init(icon: String, title: String, subtitle: String, selected: Bool, action: @escaping () -> Void) {
        self.icon = icon
        self.title = title
        self.subtitle = subtitle
        self.selected = selected
        self.action = action
    }

    public var body: some View {
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
