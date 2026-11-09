// Analyse du disque dans l'app (lecture seule), registre des nœuds montrés à l'interface, suppression confirmée par le
// main (corbeille par défaut), et relevé des alertes de stockage (15 min, puis après une analyse, une suppression,
// une opération git ou une sauvegarde).
import { shell } from "electron";
import {
  type AnalysisSummary,
  findBigObjects,
  findProjects,
  loadSummary,
  preselectCleanup,
  regenerableNodes,
  removeNodes,
  saveSummary,
  summaryFromRoots,
} from "../core/analysis.ts";
import { folderExpandedPath } from "../core/config.ts";
import { Fmt } from "../core/format.ts";
import { analysisIsStale } from "../core/health.ts";
import { t } from "../core/l10n.ts";
import { isRegenerable } from "../core/regenerable.ts";
import { type FolderScan, type Node, ScanContext, type ScanProgress, scanFolders } from "../core/scanner.ts";
import { AlertLevel, checkStorage, type StorageAlert, snoozeVolume, volumeInfo } from "../core/storage-alerts.ts";
import type { AnalysisView, NodeView, RemovalOutcome, StorageView, VolumeView } from "../shared/contract.ts";
import { itemList } from "./confirm.ts";
import { ApiError } from "./errors.ts";
import type { Host } from "./host.ts";

export const STORAGE_INTERVAL_MS = 15 * 60_000;
const PROGRESS_INTERVAL_MS = 250;

export class AnalysisService {
  private scans: FolderScan[] = [];
  private readonly ids = new WeakMap<Node, number>();
  private readonly nodes = new Map<number, WeakRef<Node>>();
  private nextId = 1;
  private ctx: ScanContext | null = null;
  private progress: ScanProgress | null = null;
  private startedAt: number | null = null;
  private finishedAt: number | null = null;
  private summary: AnalysisSummary | null = null;
  private error: string | null = null;
  private preselection: number[] = [];
  private cache: Pick<AnalysisView, "bigObjects" | "projects" | "regenerable"> = {
    bigObjects: [],
    projects: [],
    regenerable: [],
  };

  constructor(private readonly host: Host) {}

  async loadSummary(): Promise<void> {
    this.summary = await loadSummary(this.host.paths).catch(() => null);
    this.host.changed();
  }

  get running(): boolean {
    return this.ctx !== null;
  }

  get lastSummary(): AnalysisSummary | null {
    return this.summary;
  }

  // MARK: Nœuds

  private idOf(node: Node): number {
    let id = this.ids.get(node);
    if (id === undefined) {
      id = this.nextId++;
      this.ids.set(node, id);
      this.nodes.set(id, new WeakRef(node));
    }
    return id;
  }

  /** Nœud du dernier état connu (un identifiant inconnu ou d'une analyse remplacée est refusé). */
  node(id: number): Node {
    const n = this.nodes.get(id)?.deref();
    if (!n) throw new ApiError("notFound", `unknown node ${id}`);
    return n;
  }

  nodeView(n: Node): NodeView {
    return {
      id: this.idOf(n),
      name: n.name,
      path: n.path,
      isDirectory: n.isDirectory,
      category: n.category,
      size: n.size,
      fileCount: n.fileCount,
      breakdown: [...n.breakdown],
      childCount: n.children.length,
      isGitRepo: n.isGitRepo,
      regenerable: n.isDirectory && isRegenerable(n.category),
    };
  }

  children(id: number): NodeView[] {
    return this.node(id).children.map((c) => this.nodeView(c));
  }

  // MARK: Analyse

  /** Analyse les dossiers suivis (ou ceux donnés). Rien n'est écrit sur le disque analysé. */
  async scan(folders?: readonly string[]): Promise<void> {
    if (this.ctx) throw new ApiError("busy", t("hub.checking"));
    const config = this.host.config();
    const targets = folders ?? config.folders.map(folderExpandedPath);
    if (targets.length === 0) throw new ApiError("notFound", "no folder to analyze");
    const ctx = new ScanContext({ bigFileThreshold: Math.trunc(config.analysis.bigFileThresholdMB * 1_000_000) });
    this.ctx = ctx;
    this.error = null;
    this.startedAt = Date.now();
    this.progress = ctx.snapshot();
    this.host.changed();
    const timer = setInterval(() => {
      this.progress = ctx.snapshot();
      this.host.changed();
    }, PROGRESS_INTERVAL_MS);
    try {
      const scans = await scanFolders(targets, ctx);
      if (ctx.cancelled) return;
      this.scans = scans;
      this.nodes.clear();
      await this.recompute();
      const roots = scans.flatMap((s) => (s.result ? [s.result.root] : []));
      if (roots.length > 0) {
        this.summary = summaryFromRoots(roots, this.summary?.obsoleteWorktreeBytes ?? 0);
        await saveSummary(this.summary, this.host.paths).catch(() => {});
      }
      void this.host.checkStorage();
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      clearInterval(timer);
      this.ctx = null;
      this.progress = null;
      this.finishedAt = Date.now();
      this.host.changed();
    }
  }

  cancel(): void {
    this.ctx?.cancel();
  }

  /** Gros objets, projets et dossiers régénérables, recalculés après une analyse ou une suppression. */
  private async recompute(): Promise<void> {
    const threshold = Math.trunc(this.host.config().analysis.bigFolderThresholdGB * 1_000_000_000);
    const byPath = new Map<string, Node>();
    const bigObjects: AnalysisView["bigObjects"] = [];
    const projects: AnalysisView["projects"] = [];
    const regenerable: Node[] = [];
    for (const s of this.scans) {
      const r = s.result;
      if (!r) continue;
      for (const n of regenerableNodes(r.root)) {
        regenerable.push(n);
        byPath.set(n.path, n);
      }
      for (const o of findBigObjects(r.root, r.bigFiles, threshold).slice(0, 50)) {
        const n = byPath.get(o.path) ?? findByPath(r.root, o.path);
        bigObjects.push({ ...o, nodeId: n ? this.idOf(n) : null });
      }
      projects.push(...(await findProjects(r.root)).slice(0, 50));
    }
    regenerable.sort((a, b) => b.size - a.size);
    bigObjects.sort((a, b) => b.size - a.size);
    this.cache = {
      bigObjects: bigObjects.slice(0, 50),
      projects: projects.sort((a, b) => b.size - a.size).slice(0, 50),
      regenerable: regenerable.slice(0, 200).map((n) => this.nodeView(n)),
    };
    this.preselection = preselectCleanup(regenerable).map((n) => this.idOf(n));
  }

  /** Présélection à appliquer en arrivant d'une alerte (« Nettoyer »). */
  get cleanupPreselection(): number[] {
    return [...this.preselection];
  }

  // MARK: Suppression

  /**
   * Corbeille (par défaut) ou suppression définitive, après confirmation : la feuille de l'interface (`confirmed`)
   * ou, à défaut, la boîte du main.
   */
  async remove(nodeIds: readonly number[], permanently: boolean, confirmed = false): Promise<RemovalOutcome> {
    if (this.ctx) throw new ApiError("busy", t("hub.checking"));
    const nodes = [...new Set(nodeIds)].map((id) => this.node(id));
    // Un élément dont un parent est aussi choisi est déjà compris.
    const chosen = nodes.filter((n) => !nodes.some((o) => o !== n && n.path.startsWith(`${o.path}/`)));
    const bytes = chosen.reduce((sum, n) => sum + n.size, 0);
    const ok =
      confirmed ||
      (await this.host.confirm({
        message: permanently
          ? t("confirm.delete.title", chosen.length, Fmt.bytes(bytes))
          : t("confirm.trash.title", chosen.length, Fmt.bytes(bytes)),
        detail: [
          itemList(chosen.map((n) => n.path)),
          permanently ? t("confirm.irreversible") : t("confirm.trash_note"),
        ].join("\n\n"),
        confirm: permanently ? t("action.delete") : t("action.trash"),
        destructive: permanently,
      }));
    if (!ok) return { cancelled: true, removed: 0, freed: 0, failures: [] };
    const result = await removeNodes(chosen, { permanently, trash: (file) => shell.trashItem(file) });
    // Gros fichiers retirés de chaque analyse concernée (plusieurs dossiers suivis possibles).
    const gone = result.removed.map((n) => n.path);
    for (const s of this.scans) {
      if (s.result)
        s.result.bigFiles = s.result.bigFiles.filter(
          (f) => !gone.some((p) => f.path === p || f.path.startsWith(`${p}/`)),
        );
    }
    for (const n of result.removed) {
      const id = this.ids.get(n);
      if (id !== undefined) this.nodes.delete(id);
    }
    await this.recompute();
    const roots = this.scans.flatMap((s) => (s.result ? [s.result.root] : []));
    if (roots.length > 0) {
      this.summary = summaryFromRoots(roots, this.summary?.obsoleteWorktreeBytes ?? 0);
      await saveSummary(this.summary, this.host.paths).catch(() => {});
    }
    if (result.removed.length > 0) {
      this.host.logActivity({ kind: "cleanup", count: result.removed.length, bytes: result.freed });
    }
    void this.host.checkStorage();
    this.host.changed();
    return {
      cancelled: false,
      removed: result.removed.length,
      freed: result.freed,
      failures: result.failures,
    };
  }

  view(now: Date = new Date()): AnalysisView {
    return {
      running: this.ctx !== null,
      progress: this.progress,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      folders: this.scans.map((s) => ({
        folder: s.folder,
        available: s.result !== null,
        root: s.result ? this.nodeView(s.result.root) : null,
        errors: s.result?.errors ?? 0,
        duration: s.result?.duration ?? 0,
      })),
      ...this.cache,
      preselection: [...this.preselection],
      summary: this.summary,
      stale: analysisIsStale(this.summary?.date ?? null, now),
      error: this.error,
    };
  }
}

function findByPath(root: Node, target: string): Node | null {
  let node: Node | undefined = root;
  while (node && node.path !== target) {
    node = node.children.find((c) => target === c.path || target.startsWith(`${c.path}/`));
  }
  return node ?? null;
}

/** Relevé de la capacité des volumes suivis et notifications d'alerte (anti-harcèlement du core). */
export class StorageService {
  private alerts: StorageAlert[] = [];
  private freeBytes: number | null = null;
  private volumes: VolumeView[] = [];
  private lastCheck: number | null = null;
  private timer: NodeJS.Timeout | null = null;
  private checking: Promise<void> | null = null;

  constructor(
    private readonly host: Host,
    private readonly summary: () => AnalysisSummary | null,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.check(), STORAGE_INTERVAL_MS);
    void this.check();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get active(): StorageAlert[] {
    return this.alerts;
  }

  /** Relevé (un seul à la fois ; un appel pendant un relevé attend celui-ci). */
  check(): Promise<void> {
    this.checking ??= this.run().finally(() => {
      this.checking = null;
    });
    return this.checking;
  }

  private async run(): Promise<void> {
    const config = this.host.config();
    const folders = config.folders.map((f) => f.path);
    try {
      const result = await checkStorage({ paths: this.host.paths, folders, alerts: config.alerts });
      this.alerts = result.active;
      for (const a of result.notify) this.notify(a);
      const volumes: VolumeView[] = [];
      for (const f of config.folders) {
        const info = await volumeInfo(folderExpandedPath(f)).catch(() => null);
        if (info && !volumes.some((v) => v.volume === info.name))
          volumes.push({ volume: info.name, free: info.availableImportant, total: info.total });
      }
      this.volumes = volumes;
      this.freeBytes = volumes[0]?.free ?? null;
    } catch {
      // relevé impossible : on garde le précédent
    }
    this.lastCheck = Date.now();
    this.host.changed();
  }

  private notify(a: StorageAlert): void {
    this.host.logActivity({
      kind: "diskAlert",
      subject: a.volume,
      bytes: a.available,
      level: a.level === AlertLevel.critical ? "critical" : "low",
    });
    const title = t(a.level === AlertLevel.critical ? "alerts.critical_title" : "alerts.low_title", a.volume);
    let body = t("alerts.body", Fmt.bytes(a.available), Fmt.number(a.percentFree, 1));
    if (a.daysToFull !== null && a.daysToFull < 7) body += ` ${t("alerts.forecast", Fmt.number(a.daysToFull, 0))}`;
    const s = this.summary();
    if (s) {
      const reclaimable =
        Object.values(s.reclaimableByType).reduce((x, y) => x + y, 0) + s.obsoleteWorktreeBytes + s.trashBytes;
      if (reclaimable > 0) body += ` ${t("alert.reclaimable", Fmt.bytes(reclaimable))}`;
      if (s.trashBytes > 1_000_000_000) body += ` ${t("alerts.trash", Fmt.bytes(s.trashBytes))}`;
    }
    this.host.notifier.postDiskAlert(title, body, a.volume);
  }

  async snooze(volume: string): Promise<void> {
    await snoozeVolume(volume, this.host.paths);
    this.host.changed();
  }

  view(): StorageView {
    return { alerts: this.alerts, freeBytes: this.freeBytes, volumes: this.volumes, lastCheck: this.lastCheck };
  }
}
