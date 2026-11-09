// Vérification et parcours d'une destination avant son enregistrement (port de `DestinationProbe`,
// DestinationProbe.swift). Rien n'est écrit sur la destination hormis un fichier témoin supprimé aussitôt, et rien
// n'est enregistré dans le Trousseau.
import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { lstat, mkdir, readdir, readFile, realpath, rm, stat, statfs, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SMB_PORT, smbReachable } from "../backup/providers.ts";
import { type BackupSecrets, keychainSecrets } from "../backup/secrets.ts";
import { machineName } from "../machine.ts";
import { native } from "../native.ts";
import { localizedStandardCompare } from "../path-completion.ts";
import { run } from "../process.ts";
import {
  type ExistingImage,
  type FolderEntry,
  failed,
  type ProbeFailure,
  type ProbeOutcome,
  type ProbeResult,
  succeeded,
} from "./failure.ts";

/** Préfixe du fichier témoin ; un reste d'une vérification interrompue est supprimé à la suivante. */
export const WRITE_TEST_PREFIX = ".cairn-write-test-";
/** Contenu exact du fichier témoin : seul un fichier identique est reconnu comme laissé par Cairn. */
export const WRITE_TEST_CONTENTS = "cairn";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

// MARK: Dossier

/** Volume externe d'un chemin `/Volumes/<nom>/…`. */
export function volumeName(p: string): string | null {
  if (!p.startsWith("/Volumes/")) return null;
  const first = p
    .slice("/Volumes/".length)
    .split("/")
    .find((s) => s !== "");
  return first ?? null;
}

/**
 * Supprime les fichiers témoins restés d'une vérification interrompue (plantage, partage coupé). Seuls les fichiers
 * ordinaires au nom `<préfixe><UUID>` et au contenu du témoin sont supprimés : un dossier, un lien ou un fichier de
 * l'utilisateur au nom semblable n'est jamais touché (156f978).
 */
export async function removeStaleWriteTests(folder: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(folder);
  } catch {
    return;
  }
  for (const n of names) {
    if (!n.startsWith(WRITE_TEST_PREFIX) || !UUID.test(n.slice(WRITE_TEST_PREFIX.length))) continue;
    const p = path.join(folder, n);
    try {
      const st = await lstat(p);
      if (!st.isFile() || st.size !== Buffer.byteLength(WRITE_TEST_CONTENTS)) continue;
      if ((await readFile(p, "utf8")) !== WRITE_TEST_CONTENTS) continue;
      await rm(p);
    } catch {
      // illisible ou disparu : laissé tel quel
    }
  }
}

/** Espace disponible du volume qui porte `p` (module natif, repli sur `statfs` pour les partages réseau). */
export async function freeSpace(p: string): Promise<number | null> {
  try {
    const c = native().volumeImportantCapacity(p);
    if (c !== null && c > 0) return c;
  } catch {
    // module natif absent : statfs
  }
  try {
    const s = await statfs(p);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}

/** Images `cairn-*.sparsebundle` d'un dossier, triées (`SparseImage.images`). */
export async function imagePaths(folder: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(folder);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.startsWith("cairn-") && n.endsWith(".sparsebundle"))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((n) => path.join(folder, n));
}

/** Sauvegardes Cairn du dossier, celle de ce Mac repérée. */
export async function existingImages(folder: string, machine: string): Promise<ExistingImage[]> {
  return (await imagePaths(folder)).map((p) => {
    const name = path.basename(p);
    const m = name.slice("cairn-".length, name.length - ".sparsebundle".length);
    return { machine: m, path: p, isThisMac: m === machine };
  });
}

/**
 * Image à ouvrir dans un dossier de destination (port du choix de `DestinationSession.open`) :
 * 1. `preferred`, le nom choisi par l'utilisateur (« Restaurer cette sauvegarde »), s'il existe (156f978) ;
 * 2. l'image de ce Mac ;
 * 3. sans création : la première image trouvée (restauration depuis un autre Mac), sinon rien.
 * Renvoie le chemin, `"create"` (créer celle de ce Mac) ou `null` (rien sur la destination).
 */
export function chooseImage(
  images: readonly string[],
  options: { machine: string; preferred?: string | null; createIfMissing: boolean },
): string | "create" | null {
  if (options.preferred) {
    const chosen = images.find((p) => path.basename(p) === options.preferred);
    if (chosen) return chosen;
  }
  const mine = images.find((p) => path.basename(p) === `cairn-${options.machine}.sparsebundle`);
  if (mine) return mine;
  if (options.createIfMissing) return "create";
  return images[0] ?? null;
}

/** Vérifie un dossier monté : volume présent, dossier existant, écriture possible, espace libre, sauvegardes. */
export async function checkFolder(folder: string, machine?: string): Promise<ProbeResult> {
  if (folder === "") return { kind: "failed", failure: { kind: "notFound", path: folder } };
  const volume = volumeName(folder);
  if (volume !== null && !(await exists(`/Volumes/${volume}`))) {
    return { kind: "failed", failure: { kind: "volumeMissing", volume } };
  }
  let isDir = false;
  try {
    isDir = (await stat(folder)).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) return { kind: "failed", failure: { kind: "notFound", path: folder } };
  await removeStaleWriteTests(folder);
  const probe = path.join(folder, WRITE_TEST_PREFIX + randomUUID().toUpperCase());
  try {
    await writeFile(probe, WRITE_TEST_CONTENTS, { flag: "wx" });
  } catch {
    return { kind: "failed", failure: { kind: "readOnly", path: folder } };
  }
  await rm(probe, { force: true });
  return {
    kind: "ok",
    freeBytes: await freeSpace(folder),
    existingImages: await existingImages(folder, machine ?? (await machineName())),
  };
}

// MARK: Parcours

/** Extensions des paquets courants (le Finder les montre comme des fichiers) : exclus du navigateur. */
const PACKAGE_EXTENSIONS = new Set([
  "app",
  "bundle",
  "framework",
  "plugin",
  "kext",
  "sparsebundle",
  "photoslibrary",
  "musiclibrary",
  "tvlibrary",
  "imovielibrary",
  "fcpbundle",
  "logicx",
  "band",
  "rtfd",
  "pages",
  "numbers",
  "key",
  "xcodeproj",
  "xcworkspace",
  "playground",
  "xcarchive",
  "pkg",
  "mpkg",
  "lpdf",
  "scptd",
  "wdgt",
  "prefPane",
  "saver",
  "qlgenerator",
  "mdimporter",
  "appex",
  "dSYM",
]);

function isPackageName(name: string): boolean {
  const dot = name.lastIndexOf(".");
  return dot > 0 && PACKAGE_EXTENSIONS.has(name.slice(dot + 1));
}

/** Sous-dossiers visibles, triés comme le Finder. Les paquets (images Cairn comprises) sont exclus. */
export async function listFolders(folder: string): Promise<ProbeOutcome<FolderEntry[]>> {
  let entries: Dirent[];
  try {
    entries = await readdir(folder, { withFileTypes: true });
  } catch {
    // Dossier présent mais illisible : droits insuffisants.
    return failed((await exists(folder)) ? { kind: "accessDenied", path: folder } : { kind: "notFound", path: folder });
  }
  return succeeded(
    entries
      .filter((e) => !e.name.startsWith(".") && e.isDirectory() && !isPackageName(e.name))
      .map((e) => ({ name: e.name, path: path.join(folder, e.name) }))
      .sort((a, b) => localizedStandardCompare(a.name, b.name)),
  );
}

/** Crée un dossier. Un nom vide, contenant `/` ou `:`, ou déjà pris est refusé sans rien écrire. */
export async function createFolder(raw: string, parent: string): Promise<ProbeOutcome<string>> {
  const name = raw.trim();
  if (name === "" || name === "." || name === "..") return failed({ kind: "invalidName", reason: "empty" });
  if (name.includes("/") || name.includes(":")) return failed({ kind: "invalidName", reason: "forbiddenCharacter" });
  const p = path.join(parent, name);
  if (await exists(p)) return failed({ kind: "invalidName", reason: "exists" });
  try {
    await mkdir(p);
  } catch {
    return failed({ kind: "readOnly", path: parent });
  }
  return succeeded(p);
}

/** Racines du navigateur local : volumes montés (hors disque système), puis le home. */
export async function localRoots(volumes = "/Volumes", home: string = os.homedir()): Promise<FolderEntry[]> {
  let names: string[];
  try {
    names = (await readdir(volumes)).filter((n) => !n.startsWith("."));
  } catch {
    names = [];
  }
  const vols: FolderEntry[] = [];
  for (const n of names) {
    const p = path.join(volumes, n);
    try {
      // Le disque système apparaît dans /Volumes comme un lien vers « / ».
      if ((await realpath(p)) === "/") continue;
      if (!(await stat(p)).isDirectory()) continue;
    } catch {
      continue;
    }
    vols.push({ name: n, path: p });
  }
  vols.sort((a, b) => localizedStandardCompare(a.name, b.name));
  return [...vols, { name: path.basename(home), path: home }];
}

// MARK: SMB

/** Compte par défaut : l'utilisateur courant (`NSUserName()`). */
export function defaultSMBUser(): string {
  return os.userInfo().username;
}

function percentEncode(ch: string): string {
  let out = "";
  for (const b of Buffer.from(ch, "utf8")) out += `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
  return out;
}

/** Segment d'URL encodé comme `.urlPathAllowed` sans `/`. */
export function encodePathSegment(segment: string): string {
  let out = "";
  for (const ch of segment) out += /^[A-Za-z0-9!$&'()*+,\-.:=@_~]$/.test(ch) ? ch : percentEncode(ch);
  return out;
}

/** Hôte, partage et sous-dossier (décodés) d'une adresse `smb://hôte/partage/sous/dossier`. */
export function smbParts(address: string): { host: string; share: string; subpath: string[] } | null {
  if (!address.toLowerCase().startsWith("smb://")) return null;
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return null;
  }
  if (url.hostname === "") return null;
  const parts = url.pathname
    .split("/")
    .filter((s) => s !== "")
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
  const share = parts[0];
  if (share === undefined) return null;
  return { host: url.hostname, share, subpath: parts.slice(1) };
}

/** Adresse finale : partage + dossier choisi dans le navigateur, chaque segment encodé en pourcents. */
export function smbAddress(host: string, share: string, subpath: readonly string[]): string {
  return `smb://${host}/${[share, ...subpath].map(encodePathSegment).join("/")}`;
}

/** Hôte d'une adresse `smb://hôte` ou `smb://hôte/partage/…` (le partage est facultatif). */
export function smbHostOf(address: string): string | null {
  if (!address.toLowerCase().startsWith("smb://")) return null;
  try {
    const host = new URL(address).hostname;
    return host === "" ? null : host;
  } catch {
    return null;
  }
}

/**
 * Partages disque d'une sortie de `smbutil view` : colonne « Share » (noms avec espaces compris), type `Disk`, sans
 * les partages administratifs (`…$`). Triés par nom.
 */
export function parseShares(output: string): string[] {
  const lines = output.split(/\r?\n/);
  const header = lines.findIndex((l) => l.startsWith("Share") && l.includes("Type"));
  if (header < 0) return [];
  const typeColumn = lines[header]!.indexOf("Type");
  const out: string[] = [];
  for (const line of lines.slice(header + 1)) {
    if (line.length <= typeColumn) continue;
    const name = line.slice(0, typeColumn).trim();
    const type = line
      .slice(typeColumn)
      .split(" ")
      .find((s) => s !== "");
    if (type !== "Disk" || name === "" || name.endsWith("$")) continue;
    out.push(name);
  }
  return out.sort(localizedStandardCompare);
}

/** Compte encodé pour `//user@host` (lettres et chiffres, `-._~` gardés). */
export function encodeSMBUser(user: string): string {
  let out = "";
  for (const ch of user) out += /^[\p{L}\p{M}\p{N}\-._~]$/u.test(ch) ? ch : percentEncode(ch);
  return out;
}

export const SMBUTIL = "/usr/bin/smbutil";

/** Mot de passe du Trousseau, `null` s'il n'y en a pas ou s'il est illisible (comme `Keychain.internetPassword`). */
async function keychainPassword(
  secrets: Pick<BackupSecrets, "internetPassword">,
  host: string,
  account: string,
): Promise<string | null> {
  try {
    return await secrets.internetPassword(host, account);
  } catch {
    return null;
  }
}

export interface ListSharesDeps {
  reachable?: (host: string, port: number) => Promise<boolean>;
  /** Mot de passe du Trousseau à défaut d'un mot de passe saisi (jamais le vrai Trousseau en test). */
  secrets?: Pick<BackupSecrets, "internetPassword">;
  /** Lanceur (`process.run`) : injectable pour les tests. */
  run?: typeof run;
}

/**
 * Partages d'un serveur SMB (`smbutil view -f [-N] //user@host`), sans aucune fenêtre du système. Le mot de passe
 * (saisi, sinon celui du Trousseau) passe par l'entrée standard, jamais par la ligne de commande (0547a02).
 */
export async function listShares(
  host: string,
  username: string,
  password: string | null,
  deps: ListSharesDeps = {},
): Promise<ProbeOutcome<string[]>> {
  const reachable = deps.reachable ?? ((h, p) => smbReachable(h, p));
  if (!(await reachable(host, SMB_PORT))) return failed({ kind: "unreachable", host });
  const user = username === "" ? defaultSMBUser() : username;
  const pw = password ? password : await keychainPassword(deps.secrets ?? keychainSecrets, host, user);
  // -f : session à part, pour que le mot de passe soit vraiment contrôlé ; -N : ne rien demander sans mot de passe.
  const args = ["view", "-f", ...(pw === null ? ["-N"] : []), `//${encodeSMBUser(user)}@${host}`];
  let r: Awaited<ReturnType<typeof run>>;
  try {
    r = await (deps.run ?? run)(SMBUTIL, args, { stdin: pw === null ? undefined : `${pw}\n`, timeoutMs: 60_000 });
  } catch {
    return failed({ kind: "unreachable", host });
  }
  if (r.code !== 0) {
    const message = r.stderrTail.join("\n").toLowerCase();
    if (message.includes("authentication") || message.includes("password")) {
      return failed(pw === null ? { kind: "passwordRequired" } : { kind: "authenticationFailed" });
    }
    return failed({ kind: "unreachable", host });
  }
  const shares = parseShares(r.stdout);
  return shares.length === 0 ? failed({ kind: "notFound", path: `smb://${host}` }) : succeeded(shares);
}

/** Cause lisible d'un code renvoyé par `NetFSMountURLSync`. */
export function failureForMountStatus(status: number, share: string): ProbeFailure {
  switch (status) {
    // EAUTH, EACCES, mot de passe à changer, compte restreint.
    case 80:
    case 13:
    case -5045:
    case -5046:
    case -5999:
      return { kind: "authenticationFailed" };
    // ENOENT, aucun partage disponible (NetFS / NetAuth).
    case 2:
    case -5998:
    case -6003:
      return { kind: "notFound", path: share };
    default:
      return { kind: "mountFailed", code: status };
  }
}
