// Empreintes SHA-256 des versions (`checksums.tsv`), vérification et fichiers abîmés (`damaged.tsv`)
// (port de `Integrity`, Integrity.swift ; parity/behavior.md §3.3).
// - `checksums.tsv` : `chemin\ttaille\tmtime\tsha256`, trié par chemin, `\n` final ; mêmes octets que la 0.8.0.
// - Hachage en flux par blocs de 1 Mio : mémoire constante quelle que soit la taille (593f593).
// - Racine résolue une seule fois (`/var` → `/private/var`), puis aucune résolution de lien par fichier (46a9475).
import { createHash, randomBytes, randomInt } from "node:crypto";
import { once } from "node:events";
import { createReadStream, createWriteStream } from "node:fs";
import { open, opendir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { BackupError, type BackupPart } from "./types.ts";
import { compareNames, listVersions } from "./versions.ts";

export const CHECKSUMS_FILE = "checksums.tsv";
export const DAMAGED_FILE = "damaged.tsv";
/** Taille des blocs lus pour le hachage. */
export const HASH_BLOCK = 1 << 20;

export interface ChecksumEntry {
  size: number;
  /** Secondes entières depuis 1970 (tronquées). */
  mtime: number;
  sha256: string;
}

export interface VerifyReport {
  version: string;
  checked: number;
  damaged: string[];
  /** Pas de `checksums.tsv` : empreintes en attente, ce n'est pas une vérification. */
  missingChecksums: boolean;
}

/**
 * SHA-256 d'un fichier, lu par blocs de 1 Mio dans un seul tampon réutilisé : aucune allocation par bloc, la mémoire
 * reste stable quelle que soit la taille du fichier (593f593 ; un flux allouerait un tampon par bloc, rendu au
 * ramasse-miettes trop tard : +150 Mo pour 512 Mo sous Node).
 */
export async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.allocUnsafe(HASH_BLOCK);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, HASH_BLOCK, null);
      if (bytesRead === 0) break;
      hash.update(bytesRead === HASH_BLOCK ? buffer : buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

/** Empreintes d'une version (vide si le fichier est absent). Lu ligne à ligne. */
export async function readChecksums(version: string): Promise<Map<string, ChecksumEntry>> {
  const out = new Map<string, ChecksumEntry>();
  let input: ReturnType<typeof createReadStream>;
  try {
    await stat(path.join(version, CHECKSUMS_FILE));
    input = createReadStream(path.join(version, CHECKSUMS_FILE), { encoding: "utf8" });
  } catch {
    return out;
  }
  const rl = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  try {
    for await (const line of rl) {
      const f = line.split("\t");
      if (f.length !== 4) continue;
      if (!/^-?\d+$/.test(f[1]!) || !/^-?\d+$/.test(f[2]!)) continue;
      out.set(f[0]!, { size: Number(f[1]), mtime: Number(f[2]), sha256: f[3]! });
    }
  } catch {
    // fichier illisible en cours de lecture : ce qui a été lu reste
  }
  return out;
}

export interface VersionFile {
  rel: string;
  size: number;
  mtime: number;
}

const OWN_FILES = new Set([CHECKSUMS_FILE, DAMAGED_FILE, "manifest.json"]);

/** Fichiers ordinaires d'une version (chemins relatifs), hors fichiers de Cairn et `.cairn-partial`. */
export async function versionFiles(version: string): Promise<VersionFile[]> {
  let root: string;
  try {
    root = await realpath(version);
  } catch {
    return [];
  }
  const out: VersionFile[] = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    let handle: Awaited<ReturnType<typeof opendir>>;
    try {
      handle = await opendir(dir);
    } catch {
      return; // dossier illisible : ignoré, comme l'énumérateur de la 0.8.0
    }
    for await (const entry of handle) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, rel);
      } else if (entry.isFile()) {
        if (OWN_FILES.has(rel) || rel.includes("/.cairn-partial/")) continue;
        try {
          const s = await stat(full, { bigint: true });
          out.push({ rel, size: Number(s.size), mtime: Number(s.mtimeNs / 1_000_000_000n) });
        } catch {
          // disparu entre la liste et le stat
        }
      }
    }
  };
  await walk(root, "");
  return out;
}

export type ChecksumProgress = (hashed: number, toHash: number, current: string) => void;

/**
 * Écrit `checksums.tsv` : chaque partie reprend les empreintes de la version qui lui sert de base (`linkSources`) ;
 * seuls les fichiers nouveaux, modifiés ou abîmés dans la base sont hachés. Annulable entre deux fichiers ;
 * `progress` au plus dix fois par seconde.
 */
export async function writeChecksums(
  version: string,
  sources: Readonly<Record<string, string>>,
  options: { isCancelled?: () => boolean; progress?: ChecksumProgress } = {},
): Promise<void> {
  const prev = new Map<string, ChecksumEntry>();
  const damaged = new Set<string>();
  for (const [target, base] of Object.entries(sources)) {
    for (const [rel, e] of await readChecksums(base)) if (rel.startsWith(`${target}/`)) prev.set(rel, e);
    for (const rel of await readDamaged(base)) if (rel.startsWith(`${target}/`)) damaged.add(rel);
  }
  await writeChecksumsWith(version, prev, damaged, options);
}

/** Variante à une seule base (tests, outils). */
export async function writeChecksumsFrom(version: string, previous: string | null): Promise<void> {
  await writeChecksumsWith(
    version,
    previous ? await readChecksums(previous) : new Map(),
    previous ? await readDamaged(previous) : new Set(),
  );
}

async function writeChecksumsWith(
  version: string,
  prev: ReadonlyMap<string, ChecksumEntry>,
  damagedBefore: ReadonlySet<string>,
  options: { isCancelled?: () => boolean; progress?: ChecksumProgress } = {},
): Promise<void> {
  const all = (await versionFiles(version)).sort((a, b) => compareNames(a.rel, b.rel));
  const reuse = (f: VersionFile): ChecksumEntry | null => {
    const p = prev.get(f.rel);
    if (!p || p.size !== f.size || p.mtime !== f.mtime || damagedBefore.has(f.rel)) return null;
    return p;
  };
  const toHash = all.reduce((n, f) => (reuse(f) ? n : n + 1), 0);
  let hashed = 0;
  let last = 0;
  options.progress?.(0, toHash, "");
  const file = path.join(version, CHECKSUMS_FILE);
  const tmp = path.join(version, `.${CHECKSUMS_FILE}.${randomBytes(6).toString("hex")}.tmp`);
  const out = createWriteStream(tmp, { encoding: "utf8" });
  // Une erreur du flux (disque plein, ou écriture en vol quand un arrêt le détruit) ne doit jamais rester sans
  // écouteur : elle ferait tomber tout le process. Elle est gardée et relevée à la prochaine écriture.
  let streamError: Error | null = null;
  out.on("error", (error) => {
    streamError ??= error;
  });
  // Contre-pression : on attend `drain` (rejeté si le flux passe en erreur).
  const write = async (text: string): Promise<void> => {
    if (streamError) throw streamError;
    if (!out.write(text)) await once(out, "drain");
  };
  try {
    for (const f of all) {
      const p = reuse(f);
      if (p) {
        await write(`${f.rel}\t${f.size}\t${f.mtime}\t${p.sha256}\n`);
        continue;
      }
      if (options.isCancelled?.()) throw BackupError.cancelled();
      const now = Date.now();
      if (now - last >= 100) {
        last = now;
        options.progress?.(hashed, toHash, f.rel);
      }
      const h = await sha256File(path.join(version, f.rel));
      hashed += 1;
      await write(`${f.rel}\t${f.size}\t${f.mtime}\t${h}\n`);
    }
    // Version vide : `"" + "\n"` comme la 0.8.0.
    if (all.length === 0) await write("\n");
    await new Promise<void>((resolve, reject) =>
      out.end((error?: Error | null) => (error ? reject(error) : resolve())),
    );
    await rename(tmp, file);
    options.progress?.(hashed, toHash, "");
  } catch (error) {
    out.destroy();
    await rm(tmp, { force: true });
    throw error;
  }
}

/** Mélange de Fisher-Yates (aléa cryptographique, comme `shuffle()`). */
function shuffle<T>(items: T[], random: (n: number) => number): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = random(i + 1);
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
  return items;
}

export interface VerifyOptions {
  /** Tous les fichiers ; sinon un échantillon. */
  full: boolean;
  fraction?: number;
  minFiles?: number;
  maxBytes?: number;
  /** Entier aléatoire dans [0, n) (tests). */
  random?: (n: number) => number;
  /** `(vérifiés, à vérifier)`, au plus dix fois par seconde. */
  progress?: (done: number, total: number) => void;
}

/**
 * Vérifie une version : tous les fichiers (`full`) ou un échantillon aléatoire (2 %, au moins 500, au plus 5 Go lus ;
 * un fichier qui dépasse est sauté, sauf si rien n'a encore été choisi). Les abîmés vont dans `damaged.tsv`.
 */
export async function verifyVersion(version: string, options: VerifyOptions): Promise<VerifyReport> {
  const name = path.basename(version);
  const sums = await readChecksums(version);
  if (sums.size === 0) return { version: name, checked: 0, damaged: [], missingChecksums: true };
  let paths = [...sums.keys()];
  if (!options.full) {
    shuffle(paths, options.random ?? ((n) => randomInt(n)));
    const fraction = options.fraction ?? 0.02;
    const minFiles = options.minFiles ?? 500;
    const maxBytes = options.maxBytes ?? 5_000_000_000;
    const n = Math.min(paths.length, Math.max(minFiles, Math.trunc(paths.length * fraction)));
    const picked: string[] = [];
    let read = 0;
    for (const p of paths.slice(0, n)) {
      const s = sums.get(p)!.size;
      if (read + s > maxBytes && picked.length > 0) continue;
      read += s;
      picked.push(p);
    }
    paths = picked;
  }
  const damaged: string[] = [];
  let done = 0;
  let last = 0;
  for (const p of paths.sort(compareNames)) {
    let ok = false;
    try {
      ok = (await sha256File(path.join(version, p))) === sums.get(p)!.sha256;
    } catch {
      ok = false;
    }
    if (!ok) damaged.push(p);
    done += 1;
    const now = Date.now();
    if (options.progress && now - last >= 100) {
      last = now;
      options.progress(done, paths.length);
    }
  }
  if (damaged.length > 0) {
    try {
      await writeDamaged(version, damaged);
    } catch {
      // destination en lecture seule : le rapport reste
    }
  }
  return { version: name, checked: paths.length, damaged, missingChecksums: false };
}

/** Chemins abîmés d'une version (`damaged.tsv`), vide sans fichier. */
export async function readDamaged(version: string): Promise<Set<string>> {
  try {
    const text = await readFile(path.join(version, DAMAGED_FILE), "utf8");
    return new Set(text.split("\n").filter((l) => l.length > 0));
  } catch {
    return new Set();
  }
}

/** Ajoute des chemins à `damaged.tsv` (triés, sans doublon, un par ligne, `\n` final). */
export async function writeDamaged(version: string, paths: readonly string[]): Promise<void> {
  const all = [...new Set([...(await readDamaged(version)), ...paths])].sort(compareNames);
  await writeFile(path.join(version, DAMAGED_FILE), `${all.join("\n")}\n`, "utf8");
}

/** Fichiers à recopier depuis la source, par partie : les abîmés de la version qui sert de base à chaque partie. */
export async function recopyPlan(
  sources: Readonly<Record<string, string>>,
  parts: readonly BackupPart[],
): Promise<Record<string, string[]>> {
  const plan: Record<string, string[]> = {};
  for (const p of parts) {
    const base = sources[p.target];
    if (!base) continue;
    const list = [...(await readDamaged(base))]
      .filter((d) => d.startsWith(`${p.target}/`))
      .map((d) => d.slice(p.target.length + 1))
      .sort(compareNames);
    if (list.length > 0) plan[p.target] = list;
  }
  return plan;
}

/** Variante à une seule version précédente (`recopyPlan(previous:)`). */
export async function recopyPlanFrom(
  previous: string | null,
  parts: readonly BackupPart[],
): Promise<Record<string, string[]>> {
  if (!previous) return {};
  const plan: Record<string, string[]> = {};
  for (const d of await readDamaged(previous)) {
    for (const p of parts) {
      if (!d.startsWith(`${p.target}/`)) continue;
      const list = plan[p.target] ?? [];
      list.push(d.slice(p.target.length + 1));
      plan[p.target] = list;
    }
  }
  return plan;
}

/**
 * Versions encore abîmées : présentes sur la destination, avec des fichiers abîmés qui n'ont pas tous été recopiés
 * depuis la source par cette sauvegarde (`recopied` : partie → chemins relatifs à la partie). Sans doublon.
 */
export async function stillDamaged(
  versions: readonly string[],
  dir: string,
  recopied: Readonly<Record<string, readonly string[]>>,
): Promise<string[]> {
  const present = new Set(await listVersions(dir));
  const fixed = new Set(Object.entries(recopied).flatMap(([target, list]) => list.map((p) => `${target}/${p}`)));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of versions) {
    if (!present.has(v) || seen.has(v)) continue;
    seen.add(v);
    const damaged = await readDamaged(path.join(dir, v));
    if (damaged.size > 0 && ![...damaged].every((d) => fixed.has(d))) out.push(v);
  }
  return out;
}
