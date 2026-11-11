// Restauration depuis l'interface (écran Restauration) : plan, simulation, puis application confirmée par le main.
// Port de l'écran Restauration de la 0.8.0 au-dessus de `src/core/restore` (mêmes règles que `cairn restore`) :
// - la destination est ouverte sans rien créer ; sur un Mac neuf, les mots de passe du partage et de l'image sont
//   demandés à l'interface (`needsPassword`), utilisés pour cette restauration seulement, jamais enregistrés ;
// - `planRestore` ne copie rien : il liste les versions, ouvre la version choisie, calcule les tailles et lance la
//   simulation (`simulate`) ; `applyRestore` exige un plan simulé, demande confirmation, puis tourne en tâche de fond
//   (verrou `restore`) avec sa progression dans `restore.progress` ;
// - les étapes administrateur (Homebrew, Command Line Tools) s'ouvrent dans Terminal ; un outil IA ouvert doit être
//   quitté (l'interface affiche l'attente).
import { randomUUID } from "node:crypto";
import { BUNDLED_PROFILES, displayName } from "../core/ai/profiles.ts";
import { keychainSecrets } from "../core/backup/secrets.ts";
import { DestinationSession } from "../core/backup/session.ts";
import { ProviderError } from "../core/backup/types.ts";
import { dateOfVersion } from "../core/backup/versions.ts";
import { systemRunner } from "../core/inventory/collector.ts";
import { t } from "../core/l10n.ts";
import { OperationLockError } from "../core/lock.ts";
import { openForRestore, type PasswordKind } from "../core/restore/destination.ts";
import { defaultPlan, quitWaiter, type RestorePlan, RestoreService } from "../core/restore/service.ts";
import {
  archMatches,
  type RestoreSource as CoreSource,
  chooseVersion,
  currentArch,
  openRestoreSource,
  type RestoreVersion,
  versionsOnDestination,
} from "../core/restore/source.ts";
import {
  createWorkspacesVolume,
  targetIsMissing,
  terminalAdminWaiter,
  WORKSPACES_VOLUME,
} from "../core/restore/system.ts";
import type {
  Confirmed,
  RestorePart,
  RestorePlanArgs,
  RestorePlanView,
  RestoreProgressView,
  RestoreSourceView,
  RestoreView,
} from "../shared/contract.ts";
import { ApiError, errorMessage } from "./errors.ts";
import type { Host } from "./host.ts";

const ALL_PARTS: readonly RestorePart[] = ["tools", "home", "ai", "folders"];
/** Plans gardés (le dernier compte ; les précédents restent valides le temps d'un aller-retour de l'interface). */
const MAX_PLANS = 4;

/** Demande d'un mot de passe pendant l'ouverture : interrompt `openForRestore` pour le demander à l'interface. */
class PasswordNeeded extends Error {
  constructor(readonly kind: PasswordKind) {
    super(`password needed: ${kind}`);
  }
}

interface OpenedSource {
  /** `destination:<id>` ou `folder:<chemin>`. */
  key: string;
  session: DestinationSession | null;
  versions: RestoreVersion[];
  /** Dossier ouvert directement (version ou sauvegarde héritée), sans liste de versions. */
  direct: string | null;
}

interface StoredPlan {
  view: RestorePlanView;
  source: CoreSource;
  plan: RestorePlan;
}

function sourceKey(source: RestorePlanArgs["source"]): string {
  return source.kind === "destination"
    ? `destination:${source.destination}:${source.image ?? ""}`
    : `folder:${source.path}`;
}

export class RestoreController {
  private opened: OpenedSource | null = null;
  private readonly plans = new Map<string, StoredPlan>();
  private lastPlan: RestorePlanView | null = null;
  private running = false;
  private progress: RestoreProgressView | null = null;
  private ok: boolean | null = null;
  private error: string | null = null;

  constructor(private readonly host: Host) {}

  view(): RestoreView {
    return {
      available: true,
      running: this.running,
      plan: this.lastPlan,
      progress: this.progress,
      ok: this.ok,
      error: this.error,
    };
  }

  /** Ferme la destination ouverte pour la restauration (démonte ce que Cairn a monté). */
  async close(): Promise<void> {
    const opened = this.opened;
    this.opened = null;
    await opened?.session?.close().catch(() => {});
  }

  // MARK: Plan

  /** Ouvre la source (versions de la destination, ou dossier) ; réutilise la session tant que la source ne change pas. */
  private async open(args: RestorePlanArgs): Promise<OpenedSource | PasswordKind> {
    const key = sourceKey(args.source);
    if (this.opened?.key === key) return this.opened;
    if (this.running) throw new ApiError("busy", t("cli.busy"));
    await this.close();
    if (args.source.kind === "folder") {
      const dir = args.source.path;
      // Une version (ou une sauvegarde héritée) ouverte directement, sinon la racine d'une destination.
      if (await openRestoreSource(dir)) {
        this.opened = { key, session: null, versions: [], direct: dir };
      } else {
        this.opened = { key, session: null, versions: await versionsOnDestination(dir), direct: null };
      }
      return this.opened;
    }
    const id = args.source.destination;
    const d = this.host.config().destinations.find((x) => x.id === id);
    if (!d) throw new ApiError("notFound", t("cli.backup.no_destination"));
    const machine = await this.host.machine();
    const session = new DestinationSession(d, { secrets: keychainSecrets, machine });
    if (args.sharePassword !== undefined) session.sharePassword = args.sharePassword;
    if (args.imagePassword !== undefined) session.imagePassword = args.imagePassword;
    try {
      const opened = await openForRestore(
        session,
        async (kind) => {
          // Mot de passe déjà saisi et refusé, ou pas encore saisi : l'interface le demande.
          throw new PasswordNeeded(kind);
        },
        args.source.image,
      );
      if (!opened) throw new PasswordNeeded("share");
      this.opened = { key, session, versions: opened.versions, direct: null };
      return this.opened;
    } catch (error) {
      await session.close().catch(() => {});
      if (error instanceof PasswordNeeded) return error.kind;
      if (error instanceof ProviderError) throw new ApiError("failed", error.message);
      throw error;
    }
  }

  async plan(args: RestorePlanArgs): Promise<RestorePlanView> {
    const opened = await this.open(args);
    const planId = randomUUID();
    const empty: RestorePlanView = {
      planId,
      source: args.source,
      needsPassword: null,
      versions: [],
      version: null,
      details: null,
      parts: [],
      ai: [],
      replaceDatabases: false,
      sizes: {},
      steps: [],
      warnings: [],
      simulated: false,
    };
    if (typeof opened === "string") return this.remember({ ...empty, needsPassword: opened }, null);

    const machine = await this.host.machine();
    const versions = opened.versions.map((v) => ({
      name: v.version,
      machine: v.machine,
      date: dateOfVersion(v.version)?.getTime() ?? null,
      partial: v.partial,
      thisMac: v.machine === machine,
    }));
    let dir: string;
    let version: string | null = null;
    if (opened.direct !== null) {
      dir = opened.direct;
    } else {
      const choice = chooseVersion(opened.versions, machine, args.version);
      if ("error" in choice) {
        if (choice.error === "unknownVersion")
          throw new ApiError("notFound", t("cli.verify.unknown_version", args.version ?? ""));
        return this.remember({ ...empty, versions }, null);
      }
      dir = choice.path;
      version = opened.versions.find((v) => v.path === dir)?.version ?? null;
    }
    const source = await openRestoreSource(dir);
    if (!source) throw new ApiError("failed", t("cli.restore.unknown_format", dir));

    const want = (p: RestorePart) => (args.parts ?? ["tools", "home"]).includes(p);
    const plan: RestorePlan = {
      ...defaultPlan(),
      tools: want("tools") && source.toolsDir !== null,
      home: want("home") && source.home !== null,
      ai: want("ai") ? source.aiTools.filter((id) => args.tools === undefined || args.tools.includes(id)) : [],
      replaceDatabases: args.replaceDatabases ?? false,
      folders: {},
    };
    const folders = [];
    for (const f of source.folders) {
      const target = args.targets?.[f.name] ?? f.originalPath;
      const chosen = want("folders") && (args.folders === undefined || args.folders.includes(f.name));
      if (chosen) plan.folders[f.name] = target;
      folders.push({
        name: f.name,
        originalPath: f.originalPath,
        target,
        targetMissing: await targetIsMissing(target),
      });
    }
    const parts = ALL_PARTS.filter(
      (p) =>
        (p === "tools" && plan.tools) ||
        (p === "home" && plan.home) ||
        (p === "ai" && plan.ai.length > 0) ||
        (p === "folders" && Object.keys(plan.folders).length > 0),
    );
    const warnings: string[] = [];
    if (!archMatches(source)) warnings.push(t("cli.restore.arch_warning", source.arch, currentArch()));
    for (const f of folders) {
      if (f.targetMissing && plan.folders[f.name] !== undefined)
        warnings.push(t("cli.restore.missing_target", f.name, f.target));
    }
    const details: RestoreSourceView = {
      kind: source.kind,
      path: source.root,
      date: source.date?.getTime() ?? null,
      machine: source.machine,
      arch: source.arch,
      currentArch: currentArch(),
      archMatches: archMatches(source),
      home: source.home !== null,
      folders,
      aiTools: source.aiTools.map((id) => {
        const p = BUNDLED_PROFILES.find((x) => x.id === id);
        return { id, name: p ? displayName(p) : id };
      }),
      tools: source.toolsDir !== null,
    };
    const view: RestorePlanView = {
      ...empty,
      versions,
      version,
      details,
      parts,
      ai: plan.ai,
      replaceDatabases: plan.replaceDatabases,
      warnings,
    };
    if (args.simulate && parts.length > 0) {
      const service = this.service(source);
      view.sizes = await service.sizes(plan);
      view.steps = await service.run(plan, { apply: false });
      view.simulated = true;
    }
    return this.remember(view, { source, plan });
  }

  private remember(view: RestorePlanView, stored: { source: CoreSource; plan: RestorePlan } | null): RestorePlanView {
    if (stored && view.simulated) {
      this.plans.set(view.planId, { view, ...stored });
      while (this.plans.size > MAX_PLANS) this.plans.delete(this.plans.keys().next().value as string);
    }
    this.lastPlan = view;
    this.host.changed();
    return view;
  }

  private service(source: CoreSource): RestoreService {
    return new RestoreService(source, {
      statePaths: { stateDir: this.host.paths.state },
      waitForAdmin: terminalAdminWaiter({
        runner: systemRunner(),
        onOpen: () => this.host.message("info", t("cli.restore.terminal")),
      }),
      waitForQuit: quitWaiter(),
    });
  }

  // MARK: Volume workspaces

  /**
   * Crée le volume APFS `workspaces` (dossiers restaurés sous `/Volumes/workspaces` sur un Mac neuf), après
   * confirmation : geste irréversible, jamais fait d'office. Le plan est ensuite à refaire (cibles à revoir).
   */
  async createWorkspacesVolume(confirmed = false): Promise<Confirmed> {
    if (this.running) throw new ApiError("busy", t("cli.busy"));
    const ok =
      confirmed ||
      (await this.host.confirm({
        message: t("restore.create_volume"),
        detail: t("restore.missing_volume", `/Volumes/${WORKSPACES_VOLUME}`),
        confirm: t("restore.create_volume"),
      }));
    if (!ok) return { cancelled: true };
    const r = await createWorkspacesVolume();
    if (!r.ok) throw new ApiError("failed", r.output.trim() || t("restore.create_volume"));
    this.host.message("success", t("restore.ui.volume_created", WORKSPACES_VOLUME));
    this.host.changed();
    return { cancelled: false };
  }

  // MARK: Application

  /** Restauration réelle d'un plan simulé : confirmée (feuille ou boîte du main), puis lancée en tâche de fond. */
  async apply(planId: string, confirmed = false): Promise<Confirmed> {
    const stored = this.plans.get(planId);
    if (!stored) throw new ApiError("notFound", "unknown restore plan");
    if (this.running || this.host.isBackingUp()) throw new ApiError("busy", t("cli.busy"));
    const sizes = Object.values(stored.view.sizes).reduce((a, b) => a + b, 0);
    const ok =
      confirmed ||
      (await this.host.confirm({
        message: t("restore.run"),
        detail: [t("cli.restore.confirm"), ...stored.view.warnings].join("\n\n"),
        confirm: t("restore.run"),
        destructive: sizes > 0,
      }));
    if (!ok) return { cancelled: true };
    const service = this.service(stored.source);
    this.running = true;
    this.ok = null;
    this.error = null;
    this.progress = null;
    const off = service.on((event) => {
      if (event.type === "progress") {
        this.progress = event.progress;
        this.host.changed();
      }
    });
    this.host.changed(true);
    void service
      .run(stored.plan, { apply: true })
      .then((steps) => {
        this.ok = steps.every((s) => s.ok);
      })
      .catch((error) => {
        this.ok = false;
        this.error =
          error instanceof OperationLockError && error.reason === "alreadyHeld" ? t("cli.busy") : errorMessage(error);
      })
      .finally(async () => {
        off();
        this.running = false;
        this.plans.clear();
        await this.close();
        this.host.changed(true);
      });
    return { cancelled: false };
  }
}
