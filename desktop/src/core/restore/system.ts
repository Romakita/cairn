// Gestes système de la restauration (port de Restore.swift) : droits des secrets restaurés, cible absente, volume APFS
// `workspaces`, Terminal pour les étapes administrateur, attentes. Tout ce qui lance un processus passe par une fonction
// injectable : les tests n'ouvrent jamais Terminal, ne lancent ni diskutil ni osascript et n'installent rien.
import { constants } from "node:fs";
import { access, chmod, lstat, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { CommandRunner } from "../inventory/collector.ts";
import { expandTilde } from "../paths.ts";
import { ProcessLaunchError, run } from "../process.ts";

// MARK: Droits des secrets

/** Fichiers d'authentification remis en 600 après une restauration (relatifs au home). */
export const SECRET_FILES: readonly string[] = [
  ".netrc",
  ".codex/auth.json",
  ".codex/.credentials.json",
  ".aws/credentials",
];

async function existsFollowing(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Droits des secrets restaurés : `~/.ssh` en 700 ; dans `~/.ssh`, 644 pour `*.pub`, `known_hosts` et `config`, 600
 * pour le reste ; `.netrc`, `.codex/auth.json`, `.codex/.credentials.json` et `.aws/credentials` en 600.
 */
export async function fixSecretPermissions(home: string): Promise<void> {
  const ssh = path.join(home, ".ssh");
  if (await existsFollowing(ssh)) {
    await chmod(ssh, 0o700).catch(() => {});
    let names: string[] = [];
    try {
      names = await readdir(ssh);
    } catch {
      names = [];
    }
    for (const f of names) {
      const p = path.join(ssh, f);
      // Un sous-dossier n'est pas une clé : en 600 il deviendrait illisible (écart volontaire avec la 0.8.0).
      const st = await lstat(p).catch(() => null);
      if (!st || st.isDirectory()) continue;
      const mode = f.endsWith(".pub") || f === "known_hosts" || f === "config" ? 0o644 : 0o600;
      await chmod(p, mode).catch(() => {});
    }
  }
  for (const f of SECRET_FILES) {
    const p = path.join(home, f);
    if (await existsFollowing(p)) await chmod(p, 0o600).catch(() => {});
  }
}

// MARK: Cible absente et volume `workspaces`

export type PathExists = (p: string) => boolean | Promise<boolean>;

/** `standardizingPath` : `~` développé, `.`/`..` résolus, sans `/` final. */
function standardize(p: string): string {
  const n = path.normalize(expandTilde(p));
  return n.length > 1 && n.endsWith("/") ? n.slice(0, -1) : n;
}

/**
 * Le dossier cible d'une restauration est-il absent ? Sous `/Volumes/<nom>/…`, c'est le volume lui-même qui doit
 * exister (`/Volumes` existe toujours, RestoreWarningTests) ; ailleurs, le dossier parent (le dossier sera créé).
 */
export async function targetIsMissing(target: string, exists: PathExists = existsFollowing): Promise<boolean> {
  const p = standardize(target);
  if (p.startsWith("/Volumes/")) {
    const name = p
      .slice("/Volumes/".length)
      .split("/")
      .find((s) => s !== "");
    if (name === undefined) return true;
    return !(await exists(`/Volumes/${name}`));
  }
  return !(await exists(path.dirname(p)));
}

export const DISKUTIL = "/usr/sbin/diskutil";
export const WORKSPACES_VOLUME = "workspaces";

/** Lance diskutil (arguments) ; injectable pour les tests (jamais de vrai volume créé par un test). */
export type DiskutilRunner = (args: readonly string[]) => Promise<{ status: number; output: string }>;

export const systemDiskutil: DiskutilRunner = async (args) => {
  try {
    const r = await run(DISKUTIL, args, { stderr: "ignore" });
    return { status: r.code ?? 1, output: r.stdout };
  } catch (error) {
    if (error instanceof ProcessLaunchError) return { status: 127, output: "" };
    throw error;
  }
};

/** Conteneur APFS du disque de démarrage : valeur de la ligne « Part of Whole » de `diskutil info /`. */
export function partOfWhole(info: string): string | null {
  const line = info.split("\n").find((l) => l.includes("Part of Whole"));
  if (line === undefined) return null;
  const value = line.split(":").at(-1)?.trim();
  return value ? value : null;
}

/**
 * Crée le volume APFS `workspaces` dans le conteneur du disque de démarrage (`diskutil info /`, puis
 * `diskutil apfs addVolume <conteneur> APFS workspaces`). Geste irréversible : l'appelant ne l'appelle qu'après une
 * confirmation explicite de l'utilisateur ; la restauration ne l'appelle jamais d'elle-même.
 */
export async function createWorkspacesVolume(
  diskutil: DiskutilRunner = systemDiskutil,
): Promise<{ ok: boolean; output: string }> {
  const info = await diskutil(["info", "/"]);
  const container = partOfWhole(info.output);
  if (container === null) return { ok: false, output: info.output };
  const r = await diskutil(["apfs", "addVolume", container, "APFS", WORKSPACES_VOLUME]);
  return { ok: r.status === 0, output: r.output };
}

// MARK: Terminal et attentes

/** Horloge et sommeil injectables (attentes de 2 s à 1 h sans attendre pour de vrai dans les tests). */
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** Vérifie `check` toutes les `intervalMs` jusqu'à `timeoutMs` ; vrai dès qu'il réussit. */
export async function waitUntil(
  check: () => boolean | Promise<boolean>,
  options: { intervalMs: number; timeoutMs: number; clock?: Clock; signal?: AbortSignal },
): Promise<boolean> {
  const clock = options.clock ?? systemClock;
  const deadline = clock.now() + options.timeoutMs;
  while (clock.now() < deadline) {
    if (options.signal?.aborted) return false;
    if (await check()) return true;
    await clock.sleep(options.intervalMs);
  }
  return false;
}

/** Commande des Command Line Tools (fenêtre système, ouverte depuis Terminal). */
export const COMMAND_LINE_TOOLS_INSTALL = "xcode-select --install";
/** Installation officielle de Homebrew (demande le mot de passe administrateur : dans Terminal, jamais dans Cairn). */
export const HOMEBREW_INSTALL =
  '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"';
export const XCODE_SELECT = "/usr/bin/xcode-select";
export const OSASCRIPT = "/usr/bin/osascript";
/** Emplacements de `brew` attendus après l'installation (Apple Silicon, Intel). */
export const BREW_LOCATIONS: readonly string[] = ["/opt/homebrew/bin", "/usr/local/bin"];

/** Arguments d'osascript pour ouvrir `command` dans Terminal (`\` et `"` échappés pour la chaîne AppleScript). */
export function terminalScript(command: string): string[] {
  const escaped = command.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  return [
    "-e",
    `tell application "Terminal" to do script "${escaped}"`,
    "-e",
    'tell application "Terminal" to activate',
  ];
}

/** Lance osascript (arguments) ; injectable pour les tests. */
export type OsascriptRunner = (args: readonly string[]) => Promise<void>;

export const systemOsascript: OsascriptRunner = async (args) => {
  try {
    await run(OSASCRIPT, args, { stderr: "ignore", timeoutMs: 30_000 });
  } catch {
    // comme `try? p.run()` : Terminal indisponible, l'attente qui suit finira en échec
  }
};

/** Ouvre une commande dans Terminal (étapes qui demandent le mot de passe administrateur). */
export async function openInTerminal(command: string, osascript: OsascriptRunner = systemOsascript): Promise<void> {
  await osascript(terminalScript(command));
}

export async function commandLineToolsInstalled(runner: CommandRunner): Promise<boolean> {
  return (await runner([XCODE_SELECT, "-p"])).status === 0;
}

async function isExecutable(p: string): Promise<boolean> {
  try {
    await access(p, constants.X_OK);
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

export interface AdminWaitOptions {
  runner: CommandRunner;
  clock?: Clock;
  osascript?: OsascriptRunner;
  /** Fichier exécutable ? (attente de `brew`) */
  isExecutable?: (p: string) => Promise<boolean>;
  signal?: AbortSignal;
  /** Délais : Command Line Tools 1 h, Homebrew 30 min, vérification toutes les 5 s. */
  commandLineToolsTimeoutMs?: number;
  brewTimeoutMs?: number;
  intervalMs?: number;
}

/** Attend que `xcode-select -p` réussisse (toutes les 5 s, 1 h au plus). */
export function waitForCommandLineTools(options: AdminWaitOptions): Promise<boolean> {
  return waitUntil(() => commandLineToolsInstalled(options.runner), {
    intervalMs: options.intervalMs ?? 5000,
    timeoutMs: options.commandLineToolsTimeoutMs ?? 3_600_000,
    clock: options.clock,
    signal: options.signal,
  });
}

/** Attend qu'une commande apparaisse dans `/opt/homebrew/bin` ou `/usr/local/bin` (toutes les 5 s, 30 min au plus). */
export function waitForBrewCommand(command: string, options: AdminWaitOptions): Promise<boolean> {
  const executable = options.isExecutable ?? isExecutable;
  return waitUntil(
    async () => {
      for (const dir of BREW_LOCATIONS) if (await executable(path.join(dir, command))) return true;
      return false;
    },
    {
      intervalMs: options.intervalMs ?? 5000,
      timeoutMs: options.brewTimeoutMs ?? 1_800_000,
      clock: options.clock,
      signal: options.signal,
    },
  );
}

/** Attente après une étape ouverte dans Terminal : Command Line Tools ou Homebrew selon la commande. */
export function waitAfterAdmin(command: string, options: AdminWaitOptions): Promise<boolean> {
  return command === COMMAND_LINE_TOOLS_INSTALL
    ? waitForCommandLineTools(options)
    : waitForBrewCommand("brew", options);
}

/**
 * `waitForAdmin` de la restauration pour la CLI et l'app : ouvre la commande dans Terminal (`onOpen` prévient
 * l'utilisateur), puis attend la fin de l'étape.
 */
export function terminalAdminWaiter(
  options: AdminWaitOptions & { onOpen?: (command: string) => void },
): (command: string) => Promise<boolean> {
  return async (command) => {
    options.onOpen?.(command);
    await openInTerminal(command, options.osascript ?? systemOsascript);
    return waitAfterAdmin(command, options);
  };
}
