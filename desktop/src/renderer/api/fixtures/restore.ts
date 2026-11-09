// Restauration de l'API d'exemple : versions d'une destination, plan, simulation et restauration appliquée qui avance
// dans le temps (même modèle que le main, `restore/service.ts`). Sans disque : tailles et étapes sont inventées.
//   0 – 2 s   home ;  2 – 6 s  dossiers ;  6 – 8 s  outils IA (attente que Claude quitte l'outil, 6 – 7 s) ;
//   8 – 12 s  outils CLI ;  12 – 13 s  vérification finale ; puis terminé.
import type { RestoreProgress, RestoreStep } from "../../../core/restore/service.ts";
import type {
  AppSnapshot,
  RestorePart,
  RestorePlanArgs,
  RestorePlanView,
  RestoreSourceView,
  RestoreVersionView,
} from "../../../shared/contract.ts";
import { daysAgo, GB } from "./base.ts";

export const RESTORE_SECONDS = 13;
/** Machine de l'ancien Mac (scénario « restore » : Mac neuf). */
export const OLD_MAC = "MacBook-Pro-2019";
const THIS_MAC = "MacBook-Pro";

const pad = (n: number) => String(n).padStart(2, "0");
function versionName(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}00`;
}

/** Versions de la destination : celles de ce Mac (historique), ou celles de l'ancien Mac sur un Mac neuf. */
export function fixtureVersions(state: AppSnapshot, destination: string, newMac: boolean): RestoreVersionView[] {
  if (newMac) {
    return [0, 1, 2, 3, 9, 16].map((days, i) => {
      const date = daysAgo(days + 1, 2);
      return { name: versionName(date), machine: OLD_MAC, date: date.getTime(), partial: i === 2, thisMac: false };
    });
  }
  const d = state.destinations.find((x) => x.id === destination);
  return (d?.history.versions ?? []).map((v) => ({
    name: v.name,
    machine: THIS_MAC,
    date: v.date,
    partial: v.partial,
    thisMac: true,
  }));
}

const SIZES: Record<string, number> = {
  home: 1.24 * GB,
  "folders/workspaces": 182 * GB,
  "folders/Documents": 38.2 * GB,
  "ai/claude-code": 0.82 * GB,
  "ai/codex": 0.12 * GB,
};

function details(newMac: boolean, targets: Record<string, string>): RestoreSourceView {
  const folder = (name: string, originalPath: string) => {
    const target = targets[name] ?? originalPath;
    // Sur le Mac neuf, le volume « workspaces » n'existe pas encore.
    return { name, originalPath, target, targetMissing: newMac && target.startsWith("/Volumes/workspaces") };
  };
  return {
    kind: "cairn",
    path: "/Volumes/backups/cairn/MacBook-Pro/versions/latest",
    date: null,
    machine: newMac ? OLD_MAC : THIS_MAC,
    arch: newMac ? "x86_64" : "arm64",
    currentArch: "arm64",
    archMatches: !newMac,
    home: true,
    folders: [folder("workspaces", "/Volumes/workspaces"), folder("Documents", "/Users/demo/Documents")],
    aiTools: [
      { id: "claude-code", name: "Claude Code" },
      { id: "codex", name: "Codex" },
    ],
    tools: true,
  };
}

/** Étapes de la simulation des outils CLI (mêmes textes que le core). */
function toolSteps(t: (key: string, ...args: Array<string | number>) => string): RestoreStep[] {
  return [
    { step: "command-line-tools", ok: true, detail: t("restore.detail.present") },
    { step: "tool:ripgrep", ok: true, detail: t("restore.detail.present") },
    { step: "tool:node", ok: true, detail: t("restore.detail.would_install", "mise use -g node@22.12.0") },
    { step: "tool:pnpm", ok: true, detail: t("restore.detail.would_install", "npm install -g pnpm@9.15.0") },
    {
      step: "tool:gopls",
      ok: false,
      detail: `${t("restore.detail.manual")} (v0.16.2)`,
      manual: { source: "go", name: "gopls", version: "v0.16.2" },
    },
    {
      step: "tool:llm-helper",
      ok: false,
      detail: t("restore.detail.manual"),
      manual: { source: "local-bin", name: "llm-helper", version: null },
    },
  ];
}

export type FixturePlan = RestorePlanView;

/**
 * Plan de l'API d'exemple. Mac neuf : le Trousseau n'a pas le mot de passe de l'image, demandé une fois
 * (`needsPassword: "image"`), puis les versions de l'ancien Mac.
 */
export function fixturePlan(
  state: AppSnapshot,
  args: RestorePlanArgs,
  newMac: boolean,
  t: (key: string, ...args: Array<string | number>) => string,
  planId: string,
): RestorePlanView {
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
  if (args.source.kind === "destination" && newMac && !args.imagePassword) return { ...empty, needsPassword: "image" };
  const versions = args.source.kind === "destination" ? fixtureVersions(state, args.source.destination, newMac) : [];
  const chosen =
    args.version !== undefined
      ? versions.find((v) => v.name === args.version)
      : (versions.find((v) => !v.partial && v.thisMac) ?? versions.find((v) => !v.partial) ?? versions[0]);
  if (args.source.kind === "destination" && !chosen) return { ...empty, versions };
  const info = details(newMac, args.targets ?? {});
  info.date = chosen?.date ?? daysAgo(1).getTime();
  const want = (p: RestorePart) => (args.parts ?? ["tools", "home"]).includes(p);
  const ai = want("ai") ? info.aiTools.map((x) => x.id).filter((id) => !args.tools || args.tools.includes(id)) : [];
  const folders = want("folders") ? info.folders.filter((f) => !args.folders || args.folders.includes(f.name)) : [];
  const parts = (["tools", "home", "ai", "folders"] as const).filter((p) =>
    p === "ai" ? ai.length > 0 : p === "folders" ? folders.length > 0 : want(p),
  );
  const warnings: string[] = [];
  if (!info.archMatches) warnings.push(t("cli.restore.arch_warning", info.arch, info.currentArch));
  for (const f of folders) if (f.targetMissing) warnings.push(t("cli.restore.missing_target", f.name, f.target));
  const view: RestorePlanView = {
    ...empty,
    versions,
    version: chosen?.name ?? null,
    details: info,
    parts,
    ai,
    replaceDatabases: args.replaceDatabases ?? false,
    warnings,
  };
  if (!args.simulate || parts.length === 0) return view;
  const sizes: Record<string, number> = {};
  const steps: RestoreStep[] = [];
  if (parts.includes("home")) {
    sizes.home = SIZES.home!;
    steps.push({ step: "home", ok: true, detail: "" });
  }
  for (const f of folders) {
    sizes[`folders/${f.name}`] = SIZES[`folders/${f.name}`] ?? GB;
    steps.push({ step: `folders/${f.name}`, ok: true, detail: "" });
  }
  for (const id of ai) sizes[`ai/${id}`] = SIZES[`ai/${id}`] ?? 0;
  if (ai.length > 0) steps.push({ step: "ai", ok: true, detail: ai.join(", ") });
  if (parts.includes("tools")) steps.push(...toolSteps(t));
  return { ...view, sizes, steps, simulated: true };
}

/** Restauration appliquée à l'instant `t` (secondes) du plan `plan`. */
export function restoreProgressAt(
  plan: RestorePlanView,
  at: number,
  t: (key: string, ...args: Array<string | number>) => string,
): RestoreProgress {
  const parts: { id: string; phase: RestoreProgress["phase"]; start: number; end: number }[] = [];
  if (plan.parts.includes("home")) parts.push({ id: "home", phase: "home", start: 0, end: 2 });
  for (const [i, s] of plan.steps.filter((x) => x.step.startsWith("folders/")).entries())
    parts.push({ id: s.step, phase: "folders", start: 2 + i * 2, end: 4 + i * 2 });
  if (plan.ai.length > 0) parts.push({ id: "ai", phase: "ai", start: 6, end: 8 });
  if (plan.parts.includes("tools")) {
    parts.push({ id: "tools", phase: "tools", start: 8, end: 12 });
    parts.push({ id: "check", phase: "check", start: 12, end: RESTORE_SECONDS });
  }
  const steps: RestoreStep[] = [];
  let current: (typeof parts)[number] | undefined;
  for (const p of parts) {
    if (at >= p.end) {
      if (p.id === "tools") {
        for (const s of toolSteps(t)) {
          if (s.manual) steps.push(s);
          else
            steps.push({
              ...s,
              detail: s.detail.startsWith(t("restore.detail.present")) ? s.detail : t("restore.detail.installed"),
            });
        }
      } else if (p.id === "check") {
        steps.push({ step: "check", ok: false, detail: `${t("cli.restore.check", 46, 2)} — gopls, llm-helper` });
      } else {
        steps.push({ step: p.id, ok: true, detail: p.id === "ai" ? plan.ai.join(", ") : "rsync 0" });
      }
    } else if (at >= p.start && !current) {
      current = p;
    }
  }
  const finished = at >= (parts.at(-1)?.end ?? 0);
  const quitting = current?.id === "ai" && at < 7;
  return {
    apply: true,
    phase: finished ? null : (current?.phase ?? null),
    current: finished ? null : (current?.id ?? null),
    done: parts.filter((p) => at >= p.end).length,
    total: parts.length,
    steps,
    waiting: quitting ? { kind: "quit", tool: "claude-code", name: "Claude Code" } : null,
    finished,
  };
}
