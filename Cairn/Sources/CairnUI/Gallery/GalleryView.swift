import AppKit
import CairnCore
import SwiftUI

/// Fenêtre du catalogue : stories groupées à gauche, aperçu au centre, réglages de la story à droite.
/// Thème, langue et largeur de l'aperçu se changent sans relancer l'app.
public struct GalleryView: View {
    @ViewState private var selection: String?
    @ViewState private var dark: Bool
    @ViewState private var language = L10n.current
    /// Largeur du cadre d'aperçu ; 0 = largeur prévue par la story.
    @ViewState private var width = 0
    @ViewState private var values: [String: StoryValues]

    /// État initial optionnel (captures `--snapshot`) : story choisie, aperçu sombre, valeurs des contrôles.
    public init(selection: String? = nil, dark: Bool = false, values: [String: StoryValues] = [:]) {
        _selection = ViewState(initialValue: selection ?? Stories.all.first?.id)
        _dark = ViewState(initialValue: dark)
        _values = ViewState(initialValue: values)
    }

    public static let widths = [0, 320, 480, 640, 800]

    public var body: some View {
        // Le registre est relu à chaque rendu : titres et valeurs par défaut suivent la langue choisie.
        let stories = Stories.all
        let story = stories.first { $0.id == selection } ?? stories[0]
        HStack(spacing: 0) {
            sidebar(stories)
                .frame(width: 240)
                .background(Palette.sidebar)
            Rectangle().fill(Palette.border).frame(width: 1)
            VStack(spacing: 0) {
                toolbar
                Rectangle().fill(Palette.border).frame(height: 1)
                ScrollView([.vertical, .horizontal]) {
                    AppearanceHost(dark: dark) {
                        StoryCanvas(story: story, values: binding(for: story).wrappedValue,
                                    width: width == 0 ? story.width : CGFloat(width))
                            .id("\(story.id)-\(language.rawValue)")
                    }
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                    .overlay(RoundedRectangle(cornerRadius: 12).stroke(Palette.border))
                    .padding(32)
                    .frame(maxWidth: .infinity, alignment: .topLeading)
                }
                .background(Palette.rail)
            }
            Rectangle().fill(Palette.border).frame(width: 1)
            ControlsPanel(story: story, values: binding(for: story))
                .frame(width: 280)
                .background(Palette.content)
        }
        .foregroundStyle(Palette.text)
        .environment(\.locale, language.locale)
        .id(language)
        .onChange(of: language) {
            L10n.current = language
            values = [:] // valeurs par défaut traduites dans la nouvelle langue
        }
    }

    private func binding(for story: Story) -> Binding<StoryValues> {
        Binding(get: { values[story.id] ?? StoryValues(story.controls) }, set: { values[story.id] = $0 })
    }

    private func sidebar(_ stories: [Story]) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 8) {
                    CairnLogo(size: 20)
                    Text(T("gallery.window.title")).font(.system(size: 14, weight: .semibold))
                }
                .padding(.horizontal, 8).padding(.top, 4)
                Text(T("gallery.stories_count", stories.count)).font(.system(size: 12)).foregroundStyle(Palette.secondary)
                    .padding(.horizontal, 8)
                ForEach(StoryGroup.allCases) { group in
                    SidebarHeader(title: group.title)
                    ForEach(stories.filter { $0.group == group }) { s in
                        SidebarRow(title: s.title, selected: s.id == story(stories).id) { selection = s.id }
                    }
                }
            }
            .padding(12)
        }
    }

    private func story(_ stories: [Story]) -> Story { stories.first { $0.id == selection } ?? stories[0] }

    private var toolbar: some View {
        HStack(spacing: 16) {
            PillPicker(options: [(false, T("gallery.toolbar.light")), (true, T("gallery.toolbar.dark"))], selection: $dark)
            PillPicker(options: [(AppLanguage.enUS, "English"), (.frFR, "Français")], selection: $language)
            Spacer()
            Text(T("gallery.toolbar.width")).font(.system(size: 13)).foregroundStyle(Palette.secondary)
            DropdownMenu(options: Self.widths.map { ($0, $0 == 0 ? T("gallery.toolbar.width_auto") : T("gallery.toolbar.width_value", $0)) },
                         selection: $width)
        }
        .padding(.horizontal, 20).padding(.vertical, 12)
        .background(Palette.content)
    }
}

/// Réglages de la story sélectionnée, ou un message quand elle n'en a aucun.
struct ControlsPanel: View {
    let story: Story
    @Binding var values: StoryValues

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack {
                    Text(T("gallery.controls.title")).font(.system(size: 15, weight: .medium))
                    Spacer()
                    if !story.controls.isEmpty {
                        Button(T("gallery.controls.reset")) { values = StoryValues(story.controls) }.buttonStyle(.pill)
                    }
                }
                VStack(alignment: .leading, spacing: 4) {
                    Text(story.title).font(.system(size: 13, weight: .medium))
                    Text(verbatim: story.component).font(.system(size: 12, design: .monospaced)).foregroundStyle(Palette.secondary)
                }
                if story.controls.isEmpty {
                    Text(T("gallery.controls.none")).font(.system(size: 13)).foregroundStyle(Palette.secondary)
                } else {
                    ForEach(story.controls, id: \.key) { control($0) }
                }
            }
            .padding(20)
        }
    }

    @ViewBuilder private func control(_ c: StoryControl) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            switch c {
            case let .text(key, _):
                Text(c.label).font(.system(size: 12)).foregroundStyle(Palette.secondary)
                TextField("", text: Binding(get: { values.text(key) }, set: { values.values[key] = .text($0) }))
                    .cairnField()
            case let .toggle(key, _):
                Toggle(isOn: Binding(get: { values.bool(key) }, set: { values.values[key] = .bool($0) })) {
                    Text(c.label).font(.system(size: 13))
                }
                .toggleStyle(.switch)
            case let .number(key, range, step, _):
                HStack {
                    Text(c.label).font(.system(size: 12)).foregroundStyle(Palette.secondary)
                    Spacer()
                    Text(verbatim: "\(Int(values.number(key)))").font(.system(size: 12)).monospacedDigit()
                }
                // Arrondi au pas sans `step:` : un curseur à pas affiche une graduation par valeur possible.
                Slider(value: Binding(get: { values.number(key) },
                                      set: { values.values[key] = .number(($0 / step).rounded() * step) }), in: range)
            case let .choice(key, options, _):
                Text(c.label).font(.system(size: 12)).foregroundStyle(Palette.secondary)
                DropdownMenu(options: options.map { ($0, T("gallery.option.\($0)")) },
                             selection: Binding(get: { values.text(key) }, set: { values.values[key] = .text($0) }))
            }
        }
    }
}

/// Affiche son contenu avec une apparence AppKit forcée (clair ou sombre) : les couleurs de la palette sont des
/// `NSColor` dynamiques, résolues d'après l'apparence de la vue AppKit qui les héberge.
struct AppearanceHost<Content: View>: NSViewRepresentable {
    let dark: Bool
    @ViewBuilder var content: Content

    func makeNSView(context: Context) -> NSHostingView<Content> {
        let host = NSHostingView(rootView: content)
        host.sizingOptions = [.intrinsicContentSize]
        return host
    }

    func updateNSView(_ host: NSHostingView<Content>, context: Context) {
        host.rootView = content
        host.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView: NSHostingView<Content>, context: Context) -> CGSize? {
        nsView.fittingSize
    }
}
