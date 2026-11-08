// swift-tools-version:5.10
import PackageDescription

let package = Package(
    name: "WorkspaceStorage",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "WorkspaceStorage",
            path: "Sources/WorkspaceStorage",
            swiftSettings: [.unsafeFlags(["-Ounchecked"])]
        )
    ]
)
