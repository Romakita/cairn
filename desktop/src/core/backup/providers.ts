// Fournisseurs de destination (port de `BackupProvider`, `LocalProvider`, `SMBProvider`, `Reachability`,
// Providers.swift) : rendent un dossier local monté où écrire, puis nettoient.
// - local : joignable si le volume `/Volumes/X` est monté, sinon si le dossier parent existe ;
// - smb : joignable si le port (445 par défaut) répond en moins de 3 s ; un partage déjà monté (type `smbfs`, hôte et
//   partage comparés en minuscules) est réutilisé et jamais démonté ; sinon montage NetFS (sans interface, souple)
//   avec le mot de passe du Trousseau, démonté à la fin.
import { Socket } from "node:net";
import path from "node:path";
import type { DestinationConfig } from "../config.ts";
import { smbAccount } from "../config-secrets.ts";
import { mkdir, stat } from "../fs-promises.ts";
import { native } from "../native.ts";
import { expandTilde } from "../paths.ts";
import { run } from "../process.ts";
import type { BackupSecrets } from "./secrets.ts";
import { ProviderError } from "./types.ts";

export const MOUNT = "/sbin/mount";
export const UMOUNT = "/sbin/umount";
export const SMB_PORT = 445;
export const REACH_TIMEOUT_MS = 3000;

export interface BackupProvider {
  readonly destination: DestinationConfig;
  /** Joignable maintenant (sans rien monter) ? */
  isReachable(): Promise<boolean>;
  /** Dossier local où écrire. `create: false` (simulation, restauration) ne crée rien sur la destination. */
  prepare(create: boolean): Promise<string>;
  finish(): Promise<void>;
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Dossier local ou disque externe. */
export class LocalProvider implements BackupProvider {
  constructor(readonly destination: DestinationConfig) {}

  get path(): string {
    return expandTilde(this.destination.path ?? "");
  }

  async isReachable(): Promise<boolean> {
    const p = this.path;
    if (!p) return false;
    // Disque externe : le volume doit être monté (le dossier lui-même peut ne pas encore exister).
    if (p.startsWith("/Volumes/")) {
      const name =
        p
          .slice("/Volumes/".length)
          .split("/")
          .find((s) => s.length > 0) ?? "";
      return exists(`/Volumes/${name}`);
    }
    return exists(path.dirname(p));
  }

  async prepare(create: boolean): Promise<string> {
    if (!(await this.isReachable())) throw ProviderError.unreachable(this.destination.id);
    const p = this.path;
    if (!(await exists(p))) {
      if (!create) throw ProviderError.notCreated(this.destination.id);
      await mkdir(p, { recursive: true });
    }
    return p;
  }

  async finish(): Promise<void> {}
}

/** Connexion TCP avec délai (sonde de joignabilité, sans rien envoyer). */
export function tcpReachable(host: string, port: number, timeoutMs: number = REACH_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Socket();
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    socket.connect(port, host);
  });
}

/** Une ligne de la table des montages. */
export interface MountEntry {
  /** `//user@host/share` pour un partage SMB. */
  from: string;
  on: string;
  type: string;
}

/** Lignes de `/sbin/mount` : `<from> on <point> (<type>, options…)`. */
export function parseMountTable(text: string): MountEntry[] {
  const out: MountEntry[] = [];
  for (const line of text.split("\n")) {
    const m = /^(.+?) on (.+) \(([^,()]+)(?:,[^()]*)?\)\s*$/.exec(line);
    if (m) out.push({ from: m[1]!, on: m[2]!, type: m[3]!.trim() });
  }
  return out;
}

export type MountTableReader = () => Promise<MountEntry[]>;

/** Table des montages (équivalent de `getmntinfo(MNT_NOWAIT)`). */
export const readMountTable: MountTableReader = async () => {
  try {
    const r = await run(MOUNT, [], { stderr: "ignore", timeoutMs: 10_000 });
    return parseMountTable(r.stdout);
  } catch {
    return [];
  }
};

/** Hôte d'une ligne `//user@host/share` (ou `//host/share`), en minuscules. */
function mountHost(from: string): string | null {
  const m = /^\/\/(?:[^@/]*@)?([^/]+)\//.exec(from);
  return m ? m[1]!.toLowerCase() : null;
}

/**
 * Serveur SMB joignable : un partage de cet hôte est déjà monté (Finder, autre session), sinon son port répond.
 * Le montage passe par le système et reste utilisable même quand macOS refuse à l'app l'accès au réseau local
 * (Confidentialité › Réseau local) : sans ce test, un NAS ouvert dans le Finder paraissait injoignable.
 */
export async function smbReachable(
  host: string,
  port: number = SMB_PORT,
  deps: { mountTable?: MountTableReader; reachable?: (host: string, port: number) => Promise<boolean> } = {},
): Promise<boolean> {
  const wanted = host.toLowerCase();
  const mounts = await (deps.mountTable ?? readMountTable)();
  if (mounts.some((m) => m.type === "smbfs" && mountHost(m.from) === wanted)) return true;
  return (deps.reachable ?? ((h, p) => tcpReachable(h, p)))(host, port);
}

/** Adresse `smb://hôte/partage/sous/dossier` découpée (segments décodés, comme `URL.path`). */
export interface SMBAddress {
  host: string;
  port: number;
  share: string;
  /** Sous-chemin dans le partage (`sous/dossier`), vide à la racine. */
  sub: string;
}

export function parseSMBURL(url: string | undefined): SMBAddress | null {
  if (!url) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!u.hostname) return null;
  const segments = u.pathname
    .split("/")
    .filter((s) => s.length > 0)
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
  return {
    host: u.hostname,
    port: u.port ? Number(u.port) : SMB_PORT,
    share: segments[0] ?? "",
    sub: segments.slice(1).join("/"),
  };
}

/** Point de montage existant du partage (`smbfs`, hôte et partage comparés en minuscules), s'il est monté. */
export function findSMBMount(entries: readonly MountEntry[], address: SMBAddress): string | null {
  const host = address.host.toLowerCase();
  const share = address.share.toLowerCase();
  for (const m of entries) {
    if (m.type !== "smbfs") continue;
    const from = m.from.toLowerCase();
    let decoded = from;
    try {
      decoded = decodeURIComponent(from);
    } catch {
      decoded = from;
    }
    if (
      (from.includes(host) || decoded.includes(host)) &&
      (from.endsWith(`/${share}`) || decoded.endsWith(`/${share}`))
    ) {
      return m.on;
    }
  }
  return null;
}

export interface SMBDependencies {
  secrets: BackupSecrets;
  mountTable?: MountTableReader;
  reachable?: (host: string, port: number, timeoutMs: number) => Promise<boolean>;
  /** Montage NetFS (module natif) ; rejette une erreur dont `code` est le code NetFS. */
  mount?: (url: string, user: string, password: string | null) => Promise<{ mountPoint: string }>;
  unmount?: (mountPoint: string) => Promise<void>;
}

/** Démontage de ce que Cairn a monté (`unmount(2)` en Swift). */
export async function unmountPath(mountPoint: string): Promise<void> {
  try {
    await run(UMOUNT, [mountPoint], { stderr: "ignore", timeoutMs: 30_000 });
  } catch {
    // déjà démonté
  }
}

/** Partage SMB (NAS) : monté avec les identifiants du Trousseau, démonté s'il a été monté par Cairn. */
export class SMBProvider implements BackupProvider {
  /** Mot de passe saisi pour cette session (restauration sur un Mac neuf, Trousseau vide). */
  password: string | null = null;
  private mountedByUs: string | null = null;

  constructor(
    readonly destination: DestinationConfig,
    private readonly deps: SMBDependencies,
  ) {}

  get address(): SMBAddress | null {
    return parseSMBURL(this.destination.url);
  }

  async isReachable(): Promise<boolean> {
    const a = this.address;
    if (!a) return false;
    // Un partage déjà monté est utilisable tel quel (réutilisé par prepare), même sans accès réseau de l'app.
    if (await this.existingMount()) return true;
    return (this.deps.reachable ?? tcpReachable)(a.host, a.port, REACH_TIMEOUT_MS);
  }

  /** Point de montage existant du partage, s'il est déjà monté. */
  async existingMount(): Promise<string | null> {
    const a = this.address;
    if (!a) return null;
    return findSMBMount(await (this.deps.mountTable ?? readMountTable)(), a);
  }

  async prepare(_create: boolean): Promise<string> {
    const a = this.address;
    if (!a) throw ProviderError.unreachable(this.destination.id);
    if (!(await this.isReachable())) throw ProviderError.unreachable(this.destination.id);
    const existing = await this.existingMount();
    if (existing) return path.join(existing, a.sub);
    const user = smbAccount(this.destination);
    const password = this.password ?? (await this.deps.secrets.internetPassword(a.host, user));
    if (password === null) throw ProviderError.missingPassword(this.destination.id);
    const share = `smb://${a.host}/${encodeURIComponent(a.share)}`;
    const mount = this.deps.mount ?? ((url, u, p) => native().netfsMount(url, u, p));
    let mountPoint: string;
    try {
      mountPoint = (await mount(share, user, password)).mountPoint;
    } catch (error) {
      const code = Number((error as { code?: unknown }).code);
      throw ProviderError.mountFailed(this.destination.id, Number.isFinite(code) ? code : -1);
    }
    this.mountedByUs = mountPoint;
    return path.join(mountPoint, a.sub);
  }

  async finish(): Promise<void> {
    const m = this.mountedByUs;
    if (!m) return;
    this.mountedByUs = null;
    await (this.deps.unmount ?? unmountPath)(m);
  }
}
