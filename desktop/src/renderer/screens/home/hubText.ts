// Libellés de l'accueil (port de `HubText`, AppModel+Hub.swift) : titre de l'état global, problèmes, cartes de
// module et activité récente. Décisions dans `core/hub-state.ts`, textes ici.
import {
  ArrowDownToLine,
  CloudAlert,
  CloudCheck,
  CloudUpload,
  GitBranch,
  HardDrive,
  ListChecks,
  type LucideIcon,
  RotateCcw,
  Sparkles,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { Fmt } from "../../../core/format.ts";
import type {
  HubAction,
  HubDetail,
  HubFigure,
  HubIssue,
  HubModule,
  HubState,
  HubTone,
} from "../../../core/hub-state.ts";
import { t } from "../../../core/l10n.ts";
import type { ActivityView, AppSnapshot } from "../../../shared/contract.ts";
import type { Tone } from "../../ui/Banner.tsx";
import { isToday, relativeDate, timeOfDay, toDate } from "../shell/format.ts";

export function hubTitle(hub: HubState): string {
  switch (hub.overall) {
    case "ok":
      return t("hub.title.ok");
    case "attention":
      return t("hub.title.attention", hub.causes.length);
    case "error":
      return t(
        "hub.title.error",
        hub.causes.filter((c) => c.kind === "configInvalid" || c.kind === "backupFailed").length,
      );
  }
}

export function issueText(i: HubIssue): string {
  switch (i.kind) {
    case "configInvalid":
      return t("hub.issue.config_invalid", i.detail ?? "");
    case "backupFailed":
      return t("hub.issue.backup_failed", i.subject);
    case "fullDiskAccess":
      return t("home.issue.full_disk_access");
    case "diskCritical":
      return t("hub.issue.disk_critical", i.subject, Fmt.bytes(i.bytes ?? 0));
    case "destinationOverdue":
      return t("hub.issue.destination_overdue", i.subject);
    case "diskLow":
      return t("hub.issue.disk_low", i.subject, Fmt.bytes(i.bytes ?? 0));
    case "folderUnavailable":
      return t("hub.issue.folder_unavailable", i.subject);
    case "versionsDamaged":
      return t("hub.issue.versions_damaged", i.subject);
  }
}

/** Erreur pour la configuration invalide et la sauvegarde en échec, attention sinon. */
export function issueTone(i: HubIssue): Tone {
  return i.kind === "configInvalid" || i.kind === "backupFailed" ? "danger" : "warning";
}

/** Badge d'une carte (aucun tant que le module n'a pas de données). */
export function toneBadge(tone: HubTone): { text: string; tone: Tone } | null {
  switch (tone) {
    case "ok":
      return { text: t("hub.badge.ok"), tone: "success" };
    case "info":
      return { text: t("hub.badge.info"), tone: "info" };
    case "attention":
      return { text: t("hub.badge.attention"), tone: "warning" };
    case "error":
      return { text: t("hub.badge.error"), tone: "danger" };
    case "unknown":
      return null;
  }
}

export const MODULE_ICONS: Record<HubModule, LucideIcon> = {
  storage: HardDrive,
  backup: CloudUpload,
  git: GitBranch,
  ai: Sparkles,
  restore: RotateCcw,
};

/** Couleur de module (accueil seulement). */
export function moduleColor(m: HubModule): string {
  return `var(--module-${m})`;
}

export function figureText(f: HubFigure): string {
  switch (f.kind) {
    case "notAnalyzed":
      return t("hub.figure.not_analyzed");
    case "free":
      return t("hub.figure.free", Fmt.bytes(f.bytes));
    case "noDestination":
      return t("hub.figure.no_destination");
    case "backingUp":
      return t("hub.figure.backing_up");
    case "failed":
      return t("hub.figure.failed", f.label);
    case "unreachable":
      return t("hub.figure.unreachable", f.label);
    case "lastBackup":
      return relativeDate(f.date, true);
    case "neverBackedUp":
      return t("hub.figure.never_backed_up");
    case "gitCandidates":
      return t("hub.figure.git_candidates", f.count);
    case "gitClean":
      return t("hub.figure.git_clean");
    case "aiTools":
      return t("hub.figure.ai_tools", f.count);
    case "noAITool":
      return t("hub.figure.no_ai_tool");
    case "versions":
      return t("hub.figure.versions", f.count);
    case "lastVersion":
      return relativeDate(f.date, true);
    case "noVersion":
      return t("hub.figure.no_version");
  }
}

export function detailText(d: HubDetail): string | null {
  switch (d.kind) {
    case "none":
      return null;
    case "reclaimable":
      return t("hub.detail.reclaimable", Fmt.bytes(d.bytes));
    case "nextBackup":
      return isToday(d.date)
        ? t("hub.detail.next_today", timeOfDay(d.date))
        : t("hub.detail.next_date", Fmt.date(toDate(d.date)));
    case "backupDue":
      return t("hub.detail.backup_due");
    case "manualSchedule":
      return t("hub.detail.manual");
    case "gitReclaimable":
      return t("hub.detail.git_reclaimable", Fmt.bytes(d.bytes));
    case "aiLastBackup":
      return t("hub.detail.ai_last_backup", relativeDate(d.date));
    case "destinations":
      return t("hub.detail.destinations", d.count);
    case "damaged":
      return t("hub.detail.damaged", d.count);
    case "latestVersion":
      return t("hub.detail.latest_version");
  }
}

export function actionText(a: HubAction): string {
  switch (a) {
    case "clean":
      return t("action.clean");
    case "analyze":
    case "analyzeGit":
      return t("action.analyze");
    case "backupNow":
      return t("action.backup_now");
    case "addDestination":
      return t("sidebar.add_destination");
    case "openBackup":
    case "viewAI":
      return t("hub.action.view");
    case "openGit":
      return t("hub.action.optimize");
    case "restore":
      return t("action.restore");
  }
}

export function activityText(e: ActivityView, labels: Record<string, string>): string {
  const subject = e.subject ? (labels[e.subject] ?? e.subject) : "";
  switch (e.kind) {
    case "backupSucceeded":
      return t("hub.activity.backup_succeeded", subject);
    case "backupFailed":
      return t("hub.activity.backup_failed", subject);
    case "cleanup":
      return t("hub.activity.cleanup", Fmt.bytes(e.bytes ?? 0));
    case "gitCleanup":
      return t("hub.activity.git_cleanup", e.count ?? 0);
    case "diskAlert":
      return t(e.level === "critical" ? "hub.activity.disk_critical" : "hub.activity.disk_alert", subject);
    case "check":
      return (e.count ?? 0) === 0 ? t("hub.activity.check_ok") : t("hub.activity.check_issues", e.count ?? 0);
    default:
      return "";
  }
}

export function activityIcon(kind: string): LucideIcon {
  switch (kind) {
    case "backupSucceeded":
      return CloudCheck;
    case "backupFailed":
      return CloudAlert;
    case "cleanup":
      return Trash2;
    case "gitCleanup":
      return GitBranch;
    case "diskAlert":
      return TriangleAlert;
    case "check":
      return ListChecks;
    default:
      return ArrowDownToLine;
  }
}

/** Raison pour laquelle « Sauvegarder maintenant » ne peut pas aboutir, ou `undefined`. */
export function backupNowBlocker(s: AppSnapshot): string | undefined {
  if (s.backup.running) return t("backup.unavailable.running");
  if (s.config.hasErrors) return t("home.backup_blocked.config");
  if (s.lock.byOther) return t("home.backup_blocked.lock");
  if (s.destinations.length === 0) return t("home.no_destination");
  const reasons = s.destinations.map((d) => d.unavailable.backup);
  if (reasons.every((r) => r !== null)) return t(reasons[0]!);
  return undefined;
}
