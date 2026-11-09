// swift-tools-version:5.10
import PackageDescription

let package = Package(
    name: "Cairn",
    defaultLocalization: "en",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "Cairn", targets: ["Cairn"]),
    ],
    targets: [
        // Cœur sans interface : modèle, analyse, configuration, sauvegarde… testable sans SwiftUI.
        .target(
            name: "CairnCore",
            path: "Sources/CairnCore",
            resources: [.process("Resources")]
        ),
        // Binaire unique : interface SwiftUI, ou ligne de commande quand une sous-commande est passée.
        .executableTarget(
            name: "Cairn",
            dependencies: ["CairnCore"],
            path: "Sources/Cairn"
        ),
        // Tests (Swift Testing, Xcode requis) : `swift test`, ou `just test [filtre]`.
        .testTarget(
            name: "CairnTests",
            dependencies: ["CairnCore"],
            path: "Tests/CairnTests"
        ),
        // Processus auxiliaire lancé par certains tests (verrou, journal d'activité concurrent).
        .executableTarget(
            name: "CairnTestHelper",
            dependencies: ["CairnCore"],
            path: "Tests/CairnTestHelper"
        ),
    ]
)
