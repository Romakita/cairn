import Darwin
import Foundation

/// Pool de workers git : un sous-processus `Cairn git-worker <dépôt>` par dépôt, surveillé par le parent.
/// Équivalent des child_process de Node : chaque worker rend sa mémoire en se terminant, un dépôt pathologique
/// (historique énorme, worktree géant) ne peut pas faire tomber l'analyse entière.
final class GitWorkerPool: @unchecked Sendable {
    let executable: String
    let options: GitOptions
    let parallel: Int
    let timeout: TimeInterval
    let memoryLimit: Int64

    private let lock = NSLock()
    private var running: [String: (Process, Date)] = [:]
    private var results: [String: RepoReport] = [:]
    private var failed: [String: String] = [:]
    private var done = 0

    init(executable: String, options: GitOptions, parallel: Int, timeout: TimeInterval, memoryLimit: Int64) {
        self.executable = executable
        self.options = options
        self.parallel = max(1, parallel)
        self.timeout = timeout
        self.memoryLimit = memoryLimit
    }

    /// Mémoire résidente d'un processus (octets).
    static func residentBytes(_ pid: pid_t) -> Int64 {
        var info = rusage_info_current()
        let r = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: rusage_info_t?.self, capacity: 1) { proc_pid_rusage(pid, RUSAGE_INFO_CURRENT, $0) }
        }
        return r == 0 ? Int64(info.ri_resident_size) : 0
    }

    func run(_ repos: [String], cancel: CancelToken? = nil, progress: @escaping (GitMaintenance.PoolProgress) -> Void) -> [RepoReport] {
        let optionsJSON = String(decoding: (try? JSONEncoder().encode(options)) ?? Data(), as: UTF8.self)
        let sem = DispatchSemaphore(value: parallel)
        let group = DispatchGroup()

        // Surveillance : durée et mémoire de chaque worker, une fois par seconde.
        let monitor = DispatchSource.makeTimerSource(queue: .global(qos: .utility))
        monitor.schedule(deadline: .now() + 1, repeating: 1)
        monitor.setEventHandler { [weak self] in
            guard let self else { return }
            var snapshot: [String: Int64] = [:]
            self.lock.withLock {
                for (repo, (p, start)) in self.running where p.isRunning {
                    if cancel?.isCancelled == true { p.terminate(); continue }
                    let mem = Self.residentBytes(p.processIdentifier)
                    snapshot[repo] = mem
                    if mem > self.memoryLimit {
                        self.failed[repo] = L10n.tr("git.worker.memory", Fmt.bytes(mem)); p.terminate()
                    } else if Date().timeIntervalSince(start) > self.timeout {
                        self.failed[repo] = L10n.tr("git.worker.timeout", Int(self.timeout)); p.terminate()
                    }
                }
            }
            progress(self.lock.withLock { .init(done: self.done, total: repos.count, running: snapshot, failed: self.failed) })
        }
        monitor.resume()

        for repo in repos {
            sem.wait()
            if cancel?.isCancelled == true { sem.signal(); break }
            group.enter()
            DispatchQueue.global(qos: .userInitiated).async {
                defer { sem.signal(); group.leave() }
                let p = Process()
                p.executableURL = URL(fileURLWithPath: self.executable)
                p.arguments = ["git-worker", repo, optionsJSON]
                let out = Pipe()
                p.standardOutput = out
                p.standardError = FileHandle.nullDevice
                do { try p.run() } catch {
                    self.lock.withLock { self.failed[repo] = String(describing: error); self.done += 1 }
                    return
                }
                self.lock.withLock { self.running[repo] = (p, Date()) }
                let data = out.fileHandleForReading.readDataToEndOfFile()
                p.waitUntilExit()
                let decoder = JSONDecoder()
                decoder.dateDecodingStrategy = .iso8601
                let report = p.terminationStatus == 0 ? try? decoder.decode(RepoReport.self, from: data) : nil
                self.lock.withLock {
                    self.running[repo] = nil
                    if let report { self.results[repo] = report }
                    else if self.failed[repo] == nil { self.failed[repo] = L10n.tr("git.worker.failed", Int(p.terminationStatus)) }
                    self.done += 1
                }
            }
        }
        group.wait()
        monitor.cancel()
        progress(lock.withLock { .init(done: done, total: repos.count, running: [:], failed: failed) })
        return lock.withLock { repos.compactMap { results[$0] } }
    }

    var failures: [String: String] { lock.withLock { failed } }
}

extension GitMaintenance {
    /// Point d'entrée d'un worker : analyse un dépôt et écrit le rapport en JSON sur la sortie standard.
    public static func workerMain(repo: String, optionsJSON: String) -> Int32 {
        guard let options = try? JSONDecoder().decode(GitOptions.self, from: Data(optionsJSON.utf8)) else { return 2 }
        let report = analyze(repo: repo, options: options)
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        guard let data = try? encoder.encode(report) else { return 1 }
        FileHandle.standardOutput.write(data)
        return 0
    }
}
