// Schémas zod des arguments de chaque méthode de `CairnMethods` (contract.ts). Utilisés par le main uniquement :
// tout appel dont les arguments ne passent pas est refusé (`invalidArguments`) avant d'atteindre le core.
// Les objets sont stricts (clé inconnue refusée) et les tailles bornées.
import { z } from "zod";
import { CONFIRMED_METHODS, type MethodArgs, type MethodName } from "./contract.ts";

const MAX_PATH = 4096;
const MAX_LIST = 10_000;

/** Texte court sans caractère nul (identifiants, noms). */
const text = (max = 256) =>
  z
    .string()
    .max(max)
    .refine((s) => !s.includes("\0"), "NUL character");

/** Chemin absolu (ou `~/…`), sans caractère nul. */
const absolutePath = text(MAX_PATH).refine((s) => s.startsWith("/") || s.startsWith("~/") || s === "~", {
  message: "absolute path expected",
});

const password = z.string().min(1).max(1024).optional();
/** Jeton de `prepareConfirmation` (UUID). */
const confirmation = z
  .string()
  .regex(/^[0-9a-f-]{36}$/)
  .optional();
const id = text(128).min(1);
const nodeId = z.number().int().nonnegative();
const weekday = z.enum(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]);
const frequency = z.enum(["daily", "weekly", "manual"]);
const part = z.enum(["folder", "home", "ai", "tools"]);
const restorePart = z.enum(["tools", "home", "ai", "folders"]);
const route = z.enum([
  "home",
  "storage",
  "clean",
  "explorer",
  "backup",
  "restore",
  "git",
  "tools",
  "ai",
  "settings",
  "onboarding",
]);

const retention = z.discriminatedUnion("mode", [
  z.strictObject({
    mode: z.literal("tiered"),
    days: z.number().int().min(0).max(3650),
    weeks: z.number().int().min(0).max(520),
  }),
  z.strictObject({ mode: z.literal("count"), count: z.number().int().min(1).max(520) }),
]);

const newDestination = z.strictObject({
  provider: z.enum(["local", "smb"]),
  path: absolutePath.optional(),
  url: text(2048)
    .refine((s) => s.startsWith("smb://"), "smb:// expected")
    .optional(),
  username: text(256).optional(),
  keychain: text(512).optional(),
  encrypted: z.boolean(),
  retention,
});

const folderConfig = z.strictObject({
  path: absolutePath,
  backup: z.boolean(),
  exclude: z.array(text(1024)).max(1000),
});

const aiTool = z.strictObject({
  id,
  categories: z.array(z.enum(["conversations", "config", "memories", "credentials"])),
});

const configPatch = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("language"), language: z.enum(["auto", "en-US", "fr-FR", "en", "fr"]) }),
  z.strictObject({
    kind: z.literal("analysis"),
    analysis: z.strictObject({
      bigFileThresholdMB: z.number().positive().max(1_000_000).optional(),
      bigFolderThresholdGB: z.number().positive().max(100_000).optional(),
    }),
  }),
  z.strictObject({ kind: z.literal("folders"), folders: z.array(folderConfig).max(200) }),
  z.strictObject({
    kind: z.literal("home"),
    home: z.strictObject({
      include: z.array(text(1024)).max(MAX_LIST).optional(),
      exclude: z.array(text(1024)).max(MAX_LIST).optional(),
    }),
  }),
  z.strictObject({ kind: z.literal("ai"), ai: z.array(aiTool).max(100) }),
  z.strictObject({
    kind: z.literal("schedule"),
    schedule: z.strictObject({
      frequency: frequency.optional(),
      time: z
        .string()
        .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
        .optional(),
      weekday: weekday.optional(),
      background: z.boolean().optional(),
      onBatteryMinPercent: z.number().int().min(0).max(100).optional(),
    }),
  }),
  z.strictObject({
    kind: z.literal("alerts"),
    alerts: z.strictObject({
      lowPercent: z.number().min(0).max(100).optional(),
      lowGB: z.number().min(0).max(1_000_000).optional(),
      criticalPercent: z.number().min(0).max(100).optional(),
      criticalGB: z.number().min(0).max(1_000_000).optional(),
    }),
  }),
  z.strictObject({
    kind: z.literal("git"),
    git: z.strictObject({
      fetchBefore: z.boolean().optional(),
      gc: z.boolean().optional(),
      worktreeStaleDays: z.number().int().min(1).max(36500).optional(),
    }),
  }),
  z.strictObject({ kind: z.literal("updates"), check: z.boolean() }),
  z.strictObject({ kind: z.literal("excludedTools"), excludedTools: z.array(text(512)).max(MAX_LIST) }),
  z.strictObject({ kind: z.literal("logRetentionDays"), days: z.number().int().min(1).max(36500) }),
]);

const onboardingDraft = z.strictObject({
  folders: z.array(z.strictObject({ path: absolutePath, selected: z.boolean() })).max(200),
  home: z.array(z.strictObject({ path: text(1024), selected: z.boolean() })).max(MAX_LIST),
  ai: z
    .array(
      z.strictObject({
        id,
        name: text(128),
        detected: z.boolean(),
        categories: z.array(text(64)).max(16),
        offeredCategories: z.array(text(64)).max(16),
      }),
    )
    .max(100),
  destination: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("later") }),
    z.strictObject({ kind: z.literal("local"), path: absolutePath }),
    z.strictObject({
      kind: z.literal("smb"),
      url: text(2048).refine((s) => s.startsWith("smb://"), "smb:// expected"),
      username: text(256),
    }),
  ]),
  encrypted: z.boolean(),
  frequency,
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  weekday,
  background: z.boolean(),
  language: z.enum(["auto", "en-US", "fr-FR", "en", "fr"]),
  notifications: z.boolean(),
});

const restoreSource = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("destination"),
    destination: id,
    image: z
      .string()
      .regex(/^cairn-[^/]{1,200}\.sparsebundle$/)
      .optional(),
  }),
  z.strictObject({ kind: z.literal("folder"), path: absolutePath }),
]);

const smbCredentials = z.strictObject({
  address: text(2048).refine((s) => s.startsWith("smb://"), "smb:// expected"),
  username: text(256),
  password,
});

const none = z.undefined();

/** Un schéma par méthode ; le type vérifie qu'il produit exactement les arguments de `CairnMethods`. */
export const ARG_SCHEMAS = {
  getSnapshot: none,

  startBackup: z.strictObject({
    destinations: z.array(id).max(100).optional(),
    dryRun: z.boolean().optional(),
    only: z.array(part).min(1).max(4).optional(),
    aiTools: z.array(id).max(100).optional(),
  }),
  stopBackup: z.strictObject({ destination: id.optional() }),
  acknowledgeImagePassword: z.strictObject({ destination: id }),
  verify: z.strictObject({
    destination: id,
    version: text(64).optional(),
    full: z.boolean().optional(),
    imagePassword: password,
    sharePassword: password,
  }),
  refreshHistory: z.strictObject({ destination: id }),

  scan: z.strictObject({ folders: z.array(absolutePath).min(1).max(200).optional() }),
  cancelScan: none,
  analysisChildren: z.strictObject({ nodeId }),
  removeNodes: z.strictObject({
    nodeIds: z.array(nodeId).min(1).max(MAX_LIST),
    permanently: z.boolean().optional(),
    confirmation,
  }),
  checkStorage: none,
  snoozeAlert: z.strictObject({ volume: text(512).min(1) }),
  checkAll: none,
  cancelCheckAll: none,

  gitAnalyze: z.strictObject({
    fullCheck: z.boolean().optional(),
    only: text(1024).optional(),
    includeUnmerged: z.boolean().optional(),
    worktreesOnly: z.boolean().optional(),
    includeAtRisk: z.boolean().optional(),
  }),
  gitCancel: none,
  gitApply: z.strictObject({
    selections: z
      .array(
        z.strictObject({
          repo: absolutePath,
          branches: z.array(text(1024)).max(MAX_LIST),
          worktrees: z.array(absolutePath).max(MAX_LIST),
        }),
      )
      .min(1)
      .max(MAX_LIST),
    confirmation,
  }),
  gitCompact: z.strictObject({ repo: absolutePath, pruneNow: z.boolean().optional(), confirmation }),
  gitTrashRepo: z.strictObject({ repo: absolutePath, confirmation }),

  toolsRefresh: none,
  toolsExport: z.strictObject({ dir: absolutePath.optional() }),
  aiRefresh: none,
  aiExport: none,

  saveConfig: z.strictObject({ patches: z.array(configPatch).min(1).max(50) }),
  homeChoices: none,
  completePath: z.strictObject({ input: text(MAX_PATH) }),
  onboardingDetect: none,
  onboardingFinish: z.strictObject({ draft: onboardingDraft, password }),

  probeLocal: z.strictObject({ path: absolutePath }),
  connectSMB: smbCredentials,
  checkSMB: smbCredentials,
  listShares: z.strictObject({ host: text(512).min(1), username: text(256), password }),
  closeProbe: none,
  localRoots: none,
  listFolders: z.strictObject({ path: absolutePath }),
  createFolder: z.strictObject({ parent: absolutePath, name: text(255) }),
  addDestination: z.strictObject({ destination: newDestination, password }),
  editDestination: z.strictObject({ id, destination: newDestination, password }),
  planDestinationRemoval: z.strictObject({ id, includeBackups: z.boolean() }),
  removeDestination: z.strictObject({ planId: id, confirmation }),
  planRetention: z.strictObject({ destination: id, retention }),
  applyRetention: z.strictObject({ planId: id, confirmation }),

  planRestore: z.strictObject({
    source: restoreSource,
    version: text(64).optional(),
    versionMachine: text(255).optional(),
    parts: z.array(restorePart).min(1).max(4).optional(),
    folders: z.array(text(255).min(1)).max(1000).optional(),
    targets: z.record(text(255), absolutePath).optional(),
    tools: z.array(id).max(100).optional(),
    replaceDatabases: z.boolean().optional(),
    simulate: z.boolean().optional(),
    imagePassword: password,
    sharePassword: password,
  }),
  applyRestore: z.strictObject({ planId: id, confirmation }),
  createWorkspacesVolume: z.strictObject({ confirmation }),
  // Les arguments de l'action sont validés par le schéma de `method` (sans `confirmation`) dans le main.
  prepareConfirmation: z.strictObject({ method: z.enum(CONFIRMED_METHODS), args: z.unknown() }),

  checkUpdates: none,
  installUpdate: none,

  openTarget: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("log"), file: absolutePath }),
    z.strictObject({ kind: z.literal("config") }),
    z.strictObject({ kind: z.literal("logs") }),
    z.strictObject({ kind: z.literal("node"), nodeId }),
    z.strictObject({ kind: z.literal("repo"), repo: absolutePath }),
  ]),
  showInFinder: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("node"), nodeId }),
    z.strictObject({ kind: z.literal("path"), path: absolutePath }),
  ]),
  openExternal: z.strictObject({ url: z.url({ protocol: /^https$/ }).max(2048) }),
  openPrivacySettings: none,
  copyText: z.strictObject({ text: z.string().max(100_000) }),
  chooseFolder: z.strictObject({ buttonLabel: text(64).optional(), defaultPath: absolutePath.optional() }),
  openWindow: z.strictObject({
    route,
    ref: text(1024).optional(),
    preselect: z.array(nodeId).max(MAX_LIST).optional(),
  }),
  hidePanel: none,
  dismissMessage: z.strictObject({ id: z.number().int().nonnegative() }),
  quit: none,
} satisfies { [M in MethodName]: z.ZodType<MethodArgs<M>> };

export type ValidationResult<M extends MethodName> =
  | { ok: true; value: MethodArgs<M> }
  | { ok: false; message: string };

/** Valide les arguments d'un appel ; le message ne contient que les chemins des champs fautifs. */
export function validateArgs<M extends MethodName>(method: M, args: unknown): ValidationResult<M> {
  const schema = ARG_SCHEMAS[method] as z.ZodType<MethodArgs<M>>;
  const parsed = schema.safeParse(args);
  if (parsed.success) return { ok: true, value: parsed.data };
  const fields = parsed.error.issues.map((i) => (i.path.length > 0 ? i.path.join(".") : "(root)"));
  return { ok: false, message: `invalid arguments for ${method}: ${[...new Set(fields)].join(", ")}` };
}

/** Le nom désigne une méthode du contrat. */
export function isMethodName(name: string): name is MethodName {
  return Object.hasOwn(ARG_SCHEMAS, name);
}
