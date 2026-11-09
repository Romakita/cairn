import SwiftUI

// Catalogue de composants (équivalent de Storybook sans Xcode) : chaque story présente un composant de CairnUI
// dans une variante nommée, avec des données factices. Le registre sert à la fenêtre `cairn --gallery`, à l'export
// `cairn --gallery-export` et aux tests.

/// Groupe de stories, dans l'ordre d'affichage du catalogue.
public enum StoryGroup: String, CaseIterable, Identifiable, Sendable {
    case palette, buttons, navigation, containers, feedback, fields, charts, brand

    public var id: String { rawValue }
    public var title: String { T("gallery.group.\(rawValue)") }
}

/// Valeur d'un contrôle de story.
public enum StoryValue: Equatable, Sendable {
    case text(String)
    case bool(Bool)
    case number(Double)
}

/// Réglage qu'une story expose dans le panneau des contrôles. Le libellé est la traduction de
/// `gallery.control.<key>` ; une option de `choice` est traduite par `gallery.option.<option>`.
public enum StoryControl: Sendable {
    case text(_ key: String, default: String)
    case toggle(_ key: String, default: Bool)
    case number(_ key: String, range: ClosedRange<Double>, step: Double = 1, default: Double)
    case choice(_ key: String, options: [String], default: String)

    public var key: String {
        switch self {
        case let .text(k, _), let .toggle(k, _), let .number(k, _, _, _), let .choice(k, _, _): k
        }
    }

    public var label: String { T("gallery.control.\(key)") }

    public var defaultValue: StoryValue {
        switch self {
        case let .text(_, d), let .choice(_, _, d): .text(d)
        case let .toggle(_, d): .bool(d)
        case let .number(_, _, _, d): .number(d)
        }
    }
}

/// Valeurs courantes des contrôles d'une story (valeur par défaut si le contrôle n'a pas été modifié).
public struct StoryValues: Equatable, Sendable {
    public var values: [String: StoryValue]

    public init(_ controls: [StoryControl] = []) {
        values = Dictionary(uniqueKeysWithValues: controls.map { ($0.key, $0.defaultValue) })
    }

    public func text(_ key: String) -> String {
        if case let .text(s) = values[key] { return s }
        return ""
    }

    public func bool(_ key: String) -> Bool {
        if case let .bool(b) = values[key] { return b }
        return false
    }

    public func number(_ key: String) -> Double {
        if case let .number(n) = values[key] { return n }
        return 0
    }
}

/// Une variante nommée d'un composant.
public struct Story: Identifiable {
    /// Identifiant unique et stable (nom des images exportées), par exemple `badge.tones`.
    public let id: String
    public let group: StoryGroup
    /// Nom du type présenté, pour vérifier que chaque composant a sa story.
    public let component: String
    let titleKey: String
    /// Largeur du cadre d'aperçu par défaut, en points.
    public var width: CGFloat
    public var controls: [StoryControl]
    let make: (StoryValues) -> AnyView

    public init<V: View>(_ id: String, group: StoryGroup, component: String, width: CGFloat = 480,
                         controls: [StoryControl] = [], @ViewBuilder make: @escaping (StoryValues) -> V) {
        self.id = id
        self.group = group
        self.component = component
        self.titleKey = "gallery.story.\(id)"
        self.width = width
        self.controls = controls
        self.make = { AnyView(make($0)) }
    }

    public var title: String { T(titleKey) }

    /// Vue de la story avec les valeurs données (par défaut celles des contrôles).
    public func view(_ values: StoryValues? = nil) -> AnyView { make(values ?? StoryValues(controls)) }
}

/// Registre de toutes les stories, groupe par groupe.
public enum Stories {
    public static var all: [Story] {
        palette + buttons + navigation + containers + feedback + fields + charts + brand
    }

    public static func story(_ id: String) -> Story? { all.first { $0.id == id } }
}

/// Liaison locale pour les composants qui demandent un `Binding` (sélecteurs, champs) dans une story.
struct StoryState<Value, Content: View>: View {
    @ViewState private var value: Value
    let content: (Binding<Value>) -> Content

    init(_ initial: Value, @ViewBuilder content: @escaping (Binding<Value>) -> Content) {
        self._value = ViewState(initialValue: initial)
        self.content = content
    }

    var body: some View { content($value) }
}
