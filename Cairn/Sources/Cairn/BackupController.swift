import AppKit
import CairnCore
import Network

/// Planificateur de l'app : échéances, veille, réseau, notifications. Ne tourne que pendant que l'app est ouverte.
@MainActor
final class BackupController {
    weak var model: AppModel?
    private var timer: Timer?
    private let monitor = NWPathMonitor()
    private var service: BackupService?
    private var observers: [NSObjectProtocol] = []
    /// Journal de la dernière sauvegarde ou simulation (bouton « Voir le journal »).
    private(set) var lastLog: URL?

    init() {}

    func start(model: AppModel) {
        self.model = model
        Notifier.setup()
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
                self.notifyOverdue(config: config)
                if !dueIDs.isEmpty { self.run(destinations: dueIDs, dryRun: false) }
            }
        }
    }

    func notifyOverdue(config: CairnConfig) {
        guard let model else { return }
        // Relu juste avant l'écriture : `state` date du début de tick(), avant les tests de joignabilité, et une
        // sauvegarde (app ou `cairn backup`) a pu écrire runs.json entre-temps.
        var s = RunState.load(model.paths)
        var changed = false
        for d in config.destinations where model.destinationWaiting[d.id] == true {
            let ds = s[d.id]
            if BackupSchedule.shouldNotifyOverdue(config.schedule, lastSuccess: ds.lastSuccess, lastNotice: ds.lastOverdueNotice, now: Date()) {
                let last = ds.lastSuccess.map(Self.relative) ?? T("backup.never")
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
    func run(destinations: [String]?, dryRun: Bool, only: Set<BackupPart.Kind>? = nil) {
        guard let model, let config = model.config, !model.isBackingUp else { return }
        let service = BackupService(paths: model.paths, config: config)
        service.extraParts = CLI.aiParts
        self.service = service
        model.isBackingUp = true
        model.backupProgress = nil
        var req = BackupService.Request()
        req.destinationIDs = destinations
        req.dryRun = dryRun
        req.only = only
        Task.detached(priority: .utility) {
            var results: [BackupService.Result] = []
            var failure: String?
            var busy = false
            do {
                results = try service.run(req) { dest, p in
                    Task { @MainActor in model.backupProgress = (dest, p) }
                }
            } catch OperationLock.Failure.alreadyHeld {
                failure = T("cli.busy")
                busy = true
            } catch {
                failure = String(describing: error)
            }
            let (r, f, log, wasBusy) = (results, failure, service.logURL, busy)
            await MainActor.run {
                model.isBackingUp = false
                model.backupProgress = nil
                self.service = nil
                model.runState = RunState.load(model.paths)
                self.lastLog = log
                model.lastBackupResults = r
                // Erreur levée avant les destinations (parties illisibles…) : notifiée aussi. Une autre opération
                // en cours (verrou pris) n'est pas un échec : simple message.
                if let f {
                    model.lastMessage = f
                    if !dryRun && !wasBusy { self.notify(title: T("backup.notify.failed_title"), body: f, log: log) }
                }
                for res in r {
                    if let pw = res.newImagePassword { model.newImagePassword = (res.destination, pw) }
                    let label = config.destinations.first { $0.id == res.destination }.map(model.destinationLabel) ?? res.destination
                    if let e = res.error, !res.waiting, !dryRun {
                        self.notify(title: T("backup.notify.failed_title"), body: e, log: res.log)
                    }
                    if !res.damagedFiles.isEmpty {
                        self.notify(title: T("backup.notify.damaged_title", label),
                                    body: T("backup.notify.damaged_body", res.damagedFiles.count), log: res.log)
                    }
                    if let c = res.imageCheck, !c.ok {
                        self.notify(title: T("backup.notify.image_failed_title", label), body: c.output, log: res.log)
                    }
                }
            }
        }
    }

    func cancel() { service?.cancel() }

    /// Fin de l'app : la sauvegarde en cours est annulée et on attend brièvement que rsync s'arrête
    /// (la version reste incomplète et sera reprise ; l'image est détachée, le verrou rendu).
    func terminate() {
        guard let service else { return }
        service.cancel()
        service.waitUntilFinished(timeout: 5)
    }

    /// « il y a 2 jours », dans la langue de l'app.
    static func relative(_ date: Date) -> String {
        let f = RelativeDateTimeFormatter()
        f.locale = L10n.locale
        f.unitsStyle = .full
        return f.localizedString(for: date, relativeTo: Date())
    }

    func notify(title: String, body: String, log: URL? = nil) {
        Notifier.post(title: title, body: body, log: log)
        model?.lastMessage = title + " — " + body
    }
}
