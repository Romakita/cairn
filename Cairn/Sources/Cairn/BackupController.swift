import AppKit
import CairnCore
import Network
import UserNotifications

/// Planificateur de l'app : échéances, veille, réseau, notifications. Ne tourne que pendant que l'app est ouverte.
@MainActor
final class BackupController {
    weak var model: AppModel?
    private var timer: Timer?
    private let monitor = NWPathMonitor()
    private var service: BackupService?
    private var observers: [NSObjectProtocol] = []

    init() {}

    func start(model: AppModel) {
        self.model = model
        timer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.tick() }
        }
        // Retour sur le réseau du NAS : on revérifie tout de suite.
        monitor.pathUpdateHandler = { [weak self] _ in
            DispatchQueue.main.asyncAfter(deadline: .now() + 5) { MainActor.assumeIsolated { self?.tick() } }
        }
        monitor.start(queue: .global(qos: .utility))
        let ws = NSWorkspace.shared.notificationCenter
        observers.append(ws.addObserver(forName: NSWorkspace.willSleepNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.service?.engine.suspend() }
        })
        observers.append(ws.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.service?.engine.resume()
                self?.tick()
            }
        })
        observers.append(ws.addObserver(forName: NSWorkspace.didMountNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.tick() }
        })
        tick()
    }

    /// Vérifie chaque destination : sauvegarde due, conditions d'alimentation, joignabilité, retard à signaler.
    func tick() {
        guard let model, let config = model.config, !config.destinations.isEmpty, !model.isBackingUp,
              !model.configIssues.contains(where: { $0.severity == .error }) else { return }
        let state = RunState.load(model.paths)
        let power = PowerState.current()
        let schedule = config.schedule
        let dests = config.destinations
        Task.detached(priority: .utility) {
            var due: [String] = []
            var waiting: [String: Bool] = [:]
            for d in dests {
                let reachable = DestinationSession.provider(for: d).isReachable()
                waiting[d.id] = !reachable
                let decision = BackupSchedule.decide(schedule, lastSuccess: state[d.id].lastSuccess, now: Date(),
                                                     running: false, power: power, reachable: reachable)
                if decision == .run { due.append(d.id) }
            }
            let dueIDs = due
            let waitingMap = waiting
            await MainActor.run {
                model.destinationWaiting = waitingMap
                self.notifyOverdue(config: config, state: state)
                if !dueIDs.isEmpty { self.run(destinations: dueIDs, dryRun: false) }
            }
        }
    }

    func notifyOverdue(config: CairnConfig, state: RunState) {
        guard let model else { return }
        var s = state
        var changed = false
        for d in config.destinations where model.destinationWaiting[d.id] == true {
            let ds = state[d.id]
            if BackupSchedule.shouldNotifyOverdue(config.schedule, lastSuccess: ds.lastSuccess, lastNotice: ds.lastOverdueNotice, now: Date()) {
                let last = ds.lastSuccess.map(Fmt.date) ?? T("backup.never")
                notify(title: T("backup.notify.overdue_title", model.destinationLabel(d)), body: T("backup.notify.overdue_body", last))
                var x = ds
                x.lastOverdueNotice = Date()
                s[d.id] = x
                changed = true
            }
        }
        if changed { try? s.save(model.paths) }
    }

    /// Lance une sauvegarde (ou une simulation) en arrière-plan.
    func run(destinations: [String]?, dryRun: Bool) {
        guard let model, let config = model.config, !model.isBackingUp else { return }
        let service = BackupService(paths: model.paths, config: config)
        service.extraParts = CLI.aiParts
        self.service = service
        model.isBackingUp = true
        model.backupProgress = nil
        var req = BackupService.Request()
        req.destinationIDs = destinations
        req.dryRun = dryRun
        Task.detached(priority: .utility) {
            var results: [BackupService.Result] = []
            var failure: String?
            do {
                results = try service.run(req) { dest, p in
                    Task { @MainActor in model.backupProgress = (dest, p) }
                }
            } catch OperationLock.Failure.alreadyHeld {
                failure = T("cli.busy")
            } catch {
                failure = String(describing: error)
            }
            let (r, f) = (results, failure)
            await MainActor.run {
                model.isBackingUp = false
                model.backupProgress = nil
                self.service = nil
                model.runState = RunState.load(model.paths)
                model.lastBackupResults = r
                if let f { model.lastMessage = f }
                for res in r {
                    if let pw = res.newImagePassword { model.newImagePassword = (res.destination, pw) }
                    if let e = res.error, !res.waiting, !dryRun {
                        self.notify(title: T("backup.notify.failed_title"), body: e)
                    }
                }
            }
        }
    }

    func cancel() { service?.cancel() }

    func notify(title: String, body: String) {
        let c = UNMutableNotificationContent()
        c.title = title
        c.body = body
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString, content: c, trigger: nil))
        model?.lastMessage = title + " — " + body
    }
}
