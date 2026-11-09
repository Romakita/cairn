// Destinations dans l'app : vérification (dossier local, partage SMB par une session de sonde), navigateur de
// dossiers, enregistrement (le Trousseau n'est écrit qu'après `config.toml`), suppression (plan puis exécution
// confirmée par le main, sous le verrou) et changement de rétention (versions en trop confirmées puis supprimées).
import { randomUUID } from "node:crypto";
import path from "node:path";
import { keychainSecrets } from "../core/backup/secrets.ts";
import { DestinationSession } from "../core/backup/session.ts";
import { versionsDir } from "../core/backup/versions.ts";
import type { DestinationConfig, Retention } from "../core/config.ts";
import { saveEditedDestination, saveNewDestination } from "../core/destinations/edit.ts";
import {
  describeProbeFailure,
  type FolderEntry,
  type ProbeResult,
  probeFailureHint,
} from "../core/destinations/failure.ts";
import { checkFolder, createFolder, listFolders, listShares, localRoots } from "../core/destinations/probe.ts";
import {
  canExecuteRemoval,
  planRemoval,
  type RemovalPlan,
  removalBackupBytes,
  removeDestination,
} from "../core/destinations/removal.ts";
import { ProbeSession } from "../core/destinations/session.ts";
import { Fmt } from "../core/format.ts";
import { t } from "../core/l10n.ts";
import { deleteExcessVersions, excessVersions, retentionChangeDecision, uniqueBytes } from "../core/retention.ts";
import { fileRunStatePort } from "../core/schedule/index.ts";
import type {
  Confirmed,
  NewDestination,
  RemovalPlanView,
  RetentionPlanView,
  SavedDestinationView,
  SMBConnectResult,
} from "../shared/contract.ts";
import { itemList } from "./confirm.ts";
import { ApiError } from "./errors.ts";
import type { Host } from "./host.ts";

interface RetentionPlan {
  view: RetentionPlanView;
  retention: Retention;
}

/** Les plans gardés par le main expirent (un plan ancien ne doit pas être exécuté à l'aveugle). */
const PLAN_TTL_MS = 30 * 60_000;

export class DestinationsService {
  private probe: ProbeSession | null = null;
  private readonly removals = new Map<string, { plan: RemovalPlan; at: number }>();
  private readonly retentions = new Map<string, { plan: RetentionPlan; at: number }>();

  constructor(private readonly host: Host) {}

  private destination(id: string): DestinationConfig {
    const d = this.host.config().destinations.find((x) => x.id === id);
    if (!d) throw new ApiError("notFound", `unknown destination ${id}`);
    return d;
  }

  // MARK: Vérification

  async probeLocal(folder: string): Promise<ProbeResult> {
    return checkFolder(folder, await this.host.machine());
  }

  private async session(): Promise<ProbeSession> {
    this.probe ??= new ProbeSession(undefined, await this.host.machine());
    return this.probe;
  }

  async connectSMB(address: string, username: string, password: string | null): Promise<SMBConnectResult> {
    const s = await this.session();
    const r = await s.connect(address, username, password);
    if (r.ok) return { ok: true, failure: null, message: null, hint: null, root: r.value };
    return {
      ok: false,
      failure: r.failure,
      message: describeProbeFailure(r.failure),
      hint: probeFailureHint(r.failure),
      root: null,
    };
  }

  async checkSMB(address: string, username: string, password: string | null): Promise<ProbeResult> {
    return (await this.session()).check(address, username, password);
  }

  async listShares(host: string, username: string, password: string | null): Promise<string[]> {
    const r = await listShares(host, username, password);
    if (!r.ok) throw new ApiError("failed", describeProbeFailure(r.failure));
    return r.value;
  }

  /** Démonte seulement ce que la session de sonde a monté. */
  async closeProbe(): Promise<void> {
    const s = this.probe;
    this.probe = null;
    await s?.close();
  }

  localRoots(): Promise<FolderEntry[]> {
    return localRoots();
  }

  async listFolders(folder: string): Promise<FolderEntry[]> {
    const r = await listFolders(folder);
    if (!r.ok) throw new ApiError("failed", describeProbeFailure(r.failure));
    return r.value;
  }

  async createFolder(parent: string, name: string): Promise<string> {
    const r = await createFolder(name, parent);
    if (!r.ok) throw new ApiError("failed", describeProbeFailure(r.failure));
    return r.value;
  }

  // MARK: Enregistrement

  async add(destination: NewDestination, password: string | undefined): Promise<SavedDestinationView> {
    const saved = await saveNewDestination(this.host.store, destination, password ?? "");
    return saved;
  }

  async edit(id: string, destination: NewDestination, password: string | undefined): Promise<SavedDestinationView> {
    const original = this.destination(id);
    return saveEditedDestination(this.host.store, original, { ...destination, id }, password ?? "");
  }

  // MARK: Suppression

  private prune(): void {
    const now = Date.now();
    for (const [k, v] of this.removals) if (now - v.at > PLAN_TTL_MS) this.removals.delete(k);
    for (const [k, v] of this.retentions) if (now - v.at > PLAN_TTL_MS) this.retentions.delete(k);
  }

  /** Simulation : ce que la suppression retirerait (monte la destination si besoin, sans rien créer). */
  async planRemoval(id: string, includeBackups: boolean): Promise<RemovalPlanView> {
    this.prune();
    const plan = await planRemoval(this.destination(id), includeBackups, { machine: await this.host.machine() });
    const planId = randomUUID();
    this.removals.set(planId, { plan, at: Date.now() });
    return {
      planId,
      destination: id,
      includeBackups,
      items: plan.items,
      backupsUnavailable: plan.backupsUnavailable,
      canExecute: canExecuteRemoval(plan),
      backupBytes: removalBackupBytes(plan),
    };
  }

  /** Exécute un plan après confirmation (les mots de passe du Trousseau ne sont jamais supprimés). */
  async remove(planId: string): Promise<Confirmed> {
    const entry = this.removals.get(planId);
    if (!entry) throw new ApiError("notFound", "unknown or expired removal plan");
    const { plan } = entry;
    if (!canExecuteRemoval(plan)) {
      throw new ApiError("failed", t("destination.delete.error.unavailable", plan.backupsUnavailable ?? ""));
    }
    const label = this.host.destinationLabel(plan.destination);
    const bytes = removalBackupBytes(plan);
    const items = plan.items.map((i) =>
      i.kind === "backups"
        ? `${i.path} (${Fmt.bytes(i.bytes)})`
        : i.kind === "configuration"
          ? "config.toml"
          : "runs.json",
    );
    const ok = await this.host.confirm({
      message: t("destination.delete.title", label),
      detail: [t("destination.delete.text"), itemList(items), bytes > 0 ? t("confirm.irreversible") : ""]
        .filter((x) => x !== "")
        .join("\n\n"),
      confirm: bytes > 0 ? t("destination.delete.confirm_all", Fmt.bytes(bytes)) : t("destination.delete.confirm"),
      destructive: bytes > 0,
    });
    if (!ok) return { cancelled: true };
    this.removals.delete(planId);
    await removeDestination(plan, {
      store: this.host.store,
      paths: { stateDir: this.host.paths.state },
      runState: fileRunStatePort(this.host.paths),
    });
    this.host.message("success", t("destination.delete.done", label));
    return { cancelled: false };
  }

  // MARK: Rétention

  /** Versions en trop avec la nouvelle rétention (destination montée puis démontée, sans rien créer). */
  async planRetention(id: string, retention: Retention): Promise<RetentionPlanView> {
    this.prune();
    const d = this.destination(id);
    const machine = await this.host.machine();
    let excess: { names: string[]; bytes: number } | null = null;
    const session = new DestinationSession(d, { secrets: keychainSecrets, machine });
    try {
      const dir = versionsDir(await session.open(false), machine);
      const names = await excessVersions(dir, retention, new Date());
      excess = { names, bytes: await uniqueBytes(names.map((n) => path.join(dir, n))) };
    } catch {
      excess = null;
    } finally {
      await session.close().catch(() => {});
    }
    const planId = randomUUID();
    const view: RetentionPlanView = {
      planId,
      destination: id,
      decision: retentionChangeDecision(retention, d.retention, excess),
      excess,
    };
    this.retentions.set(planId, { plan: { view, retention }, at: Date.now() });
    return view;
  }

  /**
   * Applique un plan : enregistre la rétention, et supprime d'abord les versions en trop après confirmation (sous le
   * verrou d'opération, puis compactage de l'image). Une destination illisible avec une rétention plus courte est
   * refusée.
   */
  async applyRetention(planId: string): Promise<Confirmed<{ deleted: string[]; failed: string[] }>> {
    const entry = this.retentions.get(planId);
    if (!entry) throw new ApiError("notFound", "unknown or expired retention plan");
    const { view, retention } = entry.plan;
    if (view.decision === "unreachable") throw new ApiError("failed", t("backup.retention.unreachable"));
    const d = this.destination(view.destination);
    let deleted: { deleted: string[]; failed: string[] } = { deleted: [], failed: [] };
    if (view.decision === "confirm" && view.excess) {
      const ok = await this.host.confirm({
        message: t("backup.retention.confirm_title", view.excess.names.length, Fmt.bytes(view.excess.bytes)),
        detail: [itemList(view.excess.names), t("confirm.irreversible")].join("\n\n"),
        confirm: t("action.delete"),
        destructive: true,
      });
      if (!ok) return { cancelled: true };
      const machine = await this.host.machine();
      deleted = await deleteExcessVersions({ stateDir: this.host.paths.state }, view.excess.names, async () => {
        const session = new DestinationSession(d, { secrets: keychainSecrets, machine });
        const root = await session.open(false);
        return {
          versionsDir: versionsDir(root, machine),
          close: ({ compact }) => session.close(compact),
        };
      });
    }
    this.retentions.delete(planId);
    const config = structuredClone(this.host.config());
    const target = config.destinations.find((x) => x.id === d.id);
    if (target) target.retention = retention;
    await this.host.saveConfig(config);
    return { cancelled: false, value: deleted };
  }
}
