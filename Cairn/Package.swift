// swift-tools-version:5.10
import PackageDescription

let package = Package(
    name: "Cairn",
    defaultLocalization: "en",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "Cairn", targets: ["Cairn"]),
        .executable(name: "cairn-selftest", targets: ["CairnSelfTest"]),
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
        // Les Command Line Tools n'ont ni XCTest ni le plugin de swift-testing : tests dans un exécutable.
        .executableTarget(
            name: "CairnSelfTest",
            dependencies: ["CairnCore"],
            path: "Tests/CairnSelfTest"
        ),
    ]
)
