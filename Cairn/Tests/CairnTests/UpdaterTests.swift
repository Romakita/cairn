import CairnCore
import CryptoKit
import Foundation
import Testing

private func releaseJSON(tag: String, assets: [String], draft: Bool = false, prerelease: Bool = false) -> Data {
    let list = assets.map { ["name": $0, "browser_download_url": "https://example.com/\($0)"] }
    return try! JSONSerialization.data(withJSONObject: [
        "tag_name": tag, "draft": draft, "prerelease": prerelease, "html_url": "https://example.com/release",
        "body": "### Added\n- Updates\n", "assets": list,
    ] as [String: Any])
}

/// Faux `Cairn.app` zippé comme le fait `build-app.sh` ; renvoie (archive, empreinte au format shasum).
private func makeArchive(in dir: URL, id: String = Updater.bundleIdentifier, version: String) throws -> (URL, String) {
    let app = dir.appendingPathComponent("src/Cairn.app")
    try FileManager.default.createDirectory(at: app.appendingPathComponent("Contents"), withIntermediateDirectories: true)
    let plist: NSDictionary = ["CFBundleIdentifier": id, "CFBundleShortVersionString": version]
    try #require(plist.write(to: app.appendingPathComponent("Contents/Info.plist"), atomically: true))
    let zip = dir.appendingPathComponent("Cairn-\(version)-arm64.zip")
    try #require(try shell("/usr/bin/ditto", ["-c", "-k", "--keepParent", app.path, zip.path]).0 == 0)
    let sum = SHA256.hash(data: try Data(contentsOf: zip)).map { String(format: "%02x", $0) }.joined()
    return (zip, "\(sum)  \(zip.lastPathComponent)\n")
}

private func version(of app: URL) -> String? {
    NSDictionary(contentsOf: app.appendingPathComponent("Contents/Info.plist"))?["CFBundleShortVersionString"] as? String
}

extension CairnTests {
    @Suite struct UpdaterTests {
        @Test func version_comparison() {
            #expect(Updater.isNewer("0.2.0", than: "0.1.1"))
            #expect(Updater.isNewer("v0.1.10", than: "0.1.9"))
            #expect(Updater.isNewer("1.0.0", than: "1.0.0-beta.2"))
            #expect(Updater.isNewer("1.0.0-beta.10", than: "1.0.0-beta.2"))
            #expect(!Updater.isNewer("0.1.1", than: "0.1.1"))
            #expect(!Updater.isNewer("0.1", than: "0.1.0"))
            #expect(!Updater.isNewer("0.1.0", than: "0.1.1"))
        }

        @Test func parse_release_for_arch() {
            let data = releaseJSON(tag: "v0.2.0", assets: ["Cairn-0.2.0-arm64.zip", "Cairn-0.2.0-arm64.zip.sha256",
                                                           "Cairn-0.2.0-x86_64.zip", "Cairn-0.2.0-x86_64.zip.sha256"])
            let r = Updater.parseRelease(data, arch: "arm64")
            #expect(r?.version == "0.2.0")
            #expect(r?.archiveURL.lastPathComponent == "Cairn-0.2.0-arm64.zip")
            #expect(r?.checksumURL.lastPathComponent == "Cairn-0.2.0-arm64.zip.sha256")
            #expect(r?.notes == "### Added\n- Updates")
            #expect(Updater.parseRelease(data, arch: "x86_64")?.archiveURL.lastPathComponent
                    == "Cairn-0.2.0-x86_64.zip")
        }

        @Test func parse_release_rejects_incomplete() {
            typealias U = Updater
            // Archive sans empreinte, autre architecture, préversion, brouillon : rien n'est proposé.
            #expect(U.parseRelease(releaseJSON(tag: "v0.2.0", assets: ["Cairn-0.2.0-arm64.zip"]), arch: "arm64") == nil)
            let other = ["Cairn-0.2.0-x86_64.zip", "Cairn-0.2.0-x86_64.zip.sha256"]
            #expect(U.parseRelease(releaseJSON(tag: "v0.2.0", assets: other), arch: "arm64") == nil)
            let both = ["Cairn-0.2.0-arm64.zip", "Cairn-0.2.0-arm64.zip.sha256"]
            #expect(U.parseRelease(releaseJSON(tag: "v0.2.0", assets: both, prerelease: true), arch: "arm64") == nil)
            #expect(U.parseRelease(releaseJSON(tag: "v0.2.0", assets: both, draft: true), arch: "arm64") == nil)
            #expect(U.parseRelease(Data("{}".utf8), arch: "arm64") == nil)
        }

        @Test func installable_bundle() throws {
            try withTempDir { dir in
                #expect(Updater.installableBundle(dir.appendingPathComponent("Cairn.app").path) != nil)
                #expect(Updater.installableBundle(dir.appendingPathComponent("debug/Cairn").path) == nil)
            }
        }

        @Test func prepare_valid_archive() throws {
            try withTempDir { dir in
                let (zip, sum) = try makeArchive(in: dir, version: "0.2.0")
                let staging = dir.appendingPathComponent("Apps/.cairn-update")
                let app = try Updater.prepare(archive: zip, checksum: sum, version: "0.2.0", staging: staging)
                #expect(app.path == staging.appendingPathComponent("Cairn.app").path)
                #expect(version(of: app) == "0.2.0")
            }
        }

        @Test func prepare_rejects_bad_checksum_or_bundle() throws {
            typealias U = Updater
            try withTempDir { dir in
                let (zip, sum) = try makeArchive(in: dir, version: "0.2.0")
                let staging = dir.appendingPathComponent("staging")
                #expect(throws: UpdateError.checksumMismatch) {
                    _ = try U.prepare(archive: zip, checksum: String(repeating: "0", count: 64), version: "0.2.0",
                                      staging: staging)
                }
                #expect(!FileManager.default.fileExists(atPath: staging.path), "rien ne doit être extrait")
                #expect(throws: UpdateError.wrongBundle("fr.lenzotti.cairn 0.2.0")) {
                    _ = try U.prepare(archive: zip, checksum: sum, version: "0.3.0", staging: staging)
                }
                #expect(!FileManager.default.fileExists(atPath: staging.path))
                let other = dir.appendingPathComponent("other")
                try FileManager.default.createDirectory(at: other, withIntermediateDirectories: true)
                let (zip2, sum2) = try makeArchive(in: other, id: "com.example.evil", version: "0.2.0")
                #expect(throws: UpdateError.wrongBundle("com.example.evil 0.2.0")) {
                    _ = try U.prepare(archive: zip2, checksum: sum2, version: "0.2.0", staging: staging)
                }
            }
        }

        @Test func swap_replaces_bundle_after_exit() throws {
            typealias U = Updater
            try withTempDir { dir in
                let apps = dir.appendingPathComponent("Applications")
                let (oldZip, _) = try makeArchive(in: dir, version: "0.1.1")
                try FileManager.default.createDirectory(at: apps, withIntermediateDirectories: true)
                try #require(try shell("/usr/bin/ditto", ["-x", "-k", oldZip.path, apps.path]).0 == 0)
                let installed = apps.appendingPathComponent("Cairn.app")
                let newDir = dir.appendingPathComponent("new")
                try FileManager.default.createDirectory(at: newDir, withIntermediateDirectories: true)
                let (zip, sum) = try makeArchive(in: newDir, version: "0.2.0")
                let app = try U.prepare(archive: zip, checksum: sum, version: "0.2.0",
                                        staging: U.stagingDirectory(for: installed))
                // Processus « app » déjà terminé : le script remplace aussitôt.
                let done = Process()
                done.executableURL = URL(fileURLWithPath: "/usr/bin/true")
                try done.run(); done.waitUntilExit()
                let swap = try U.scheduleSwap(newApp: app, replacing: installed, after: done.processIdentifier,
                                              relaunch: false)
                swap.waitUntilExit()
                #expect(version(of: installed) == "0.2.0")
                #expect(!FileManager.default.fileExists(atPath: U.stagingDirectory(for: installed).path),
                        "préparation nettoyée")
            }
        }

        @Test func swap_keeps_old_bundle_on_failure() throws {
            typealias U = Updater
            try withTempDir { dir in
                let apps = dir.appendingPathComponent("Applications")
                let (oldZip, _) = try makeArchive(in: dir, version: "0.1.1")
                try FileManager.default.createDirectory(at: apps, withIntermediateDirectories: true)
                try #require(try shell("/usr/bin/ditto", ["-x", "-k", oldZip.path, apps.path]).0 == 0)
                let installed = apps.appendingPathComponent("Cairn.app")
                let staging = U.stagingDirectory(for: installed)
                try FileManager.default.createDirectory(at: staging, withIntermediateDirectories: true)
                // Nouveau bundle absent : le déplacement échoue et l'ancienne app doit revenir.
                let swap = try U.scheduleSwap(newApp: staging.appendingPathComponent("Cairn.app"), replacing: installed,
                                              after: 999_999, relaunch: false)
                swap.waitUntilExit()
                #expect(version(of: installed) == "0.1.1")
            }
        }

        @Test func config_updates_check() throws {
            let off = try ConfigDecoder.decode(TOMLDocument(parsing: "version = 1\n[updates]\ncheck = false\n")).0
            #expect(off.checkUpdates == false)
            let def = try ConfigDecoder.decode(TOMLDocument(parsing: "version = 1\n")).0
            #expect(def.checkUpdates == true)
            var doc = try TOMLDocument(parsing: "# garder\nversion = 1\n")
            var c = def
            c.checkUpdates = false
            ConfigWriter.apply(c, to: &doc)
            let text = doc.render()
            #expect(text.contains("# garder") && text.contains("[updates]") && text.contains("check = false"), "\(text)")
        }
    }
}
