// Mises à jour de l'app depuis les releases GitHub (port de Updater.swift). Logique pure et testable : le main
// (src/main/updates.ts) planifie les contrôles, bloque l'installation pendant une sauvegarde et quitte l'app.
//
// - flux : `releases/latest` de GitHub (`CAIRN_UPDATE_URL` le remplace pour les tests), brouillons et préversions
//   refusés, assets `Cairn-<version>-<arch>.zip` et `.zip.sha256` ;
// - vérification : SHA-256 de l'archive calculé EN FLUX pendant le téléchargement (100 à 150 Mo, jamais en mémoire),
//   comparé au premier champ du fichier `.sha256` ; puis `ditto -x -k` dans `<parent>/.cairn-update`, contrôle de
//   `CFBundleIdentifier` et `CFBundleShortVersionString` (lus avec `plutil`), `xattr -dr com.apple.quarantine` ;
// - remplacement : script `/bin/sh` détaché, qui attend la fin du processus, remet l'ancienne app en cas d'échec et
//   relance. Le format du zip et ce script restent ceux de la 0.8.0 (migration depuis l'app Swift).
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, constants, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { t } from "./l10n.ts";
import { arch as machineArch } from "./machine.ts";
import { run } from "./process.ts";

export const BUNDLE_IDENTIFIER = "fr.lenzotti.cairn";
export const RELEASES_PAGE = "https://github.com/Romakita/cairn/releases";
export const LATEST_RELEASE_URL = "https://api.github.com/repos/Romakita/cairn/releases/latest";
/** Premier contrôle après le lancement, puis intervalle des contrôles automatiques. */
export const FIRST_CHECK_DELAY_MS = 5000;
export const CHECK_INTERVAL_MS = 6 * 3600 * 1000;
const CHECK_TIMEOUT_MS = 20_000;
const ARCHIVE_TIMEOUT_MS = 300_000;
const CHECKSUM_TIMEOUT_MS = 30_000;

const DITTO = "/usr/bin/ditto";
const PLUTIL = "/usr/bin/plutil";
const XATTR = "/usr/bin/xattr";
const SH = "/bin/sh";

/** Release publiée sur GitHub qui peut remplacer l'app installée. */
export interface AppRelease {
  version: string;
  notes: string;
  pageURL: string;
  archiveURL: string;
  checksumURL: string;
}

export type UpdateErrorKind = "network" | "checksumMismatch" | "invalidArchive" | "wrongBundle" | "notInstallable";

export class UpdateError extends Error {
  constructor(
    readonly kind: UpdateErrorKind,
    readonly detail = "",
  ) {
    super(UpdateError.text(kind, detail));
    this.name = "UpdateError";
  }

  private static text(kind: UpdateErrorKind, detail: string): string {
    switch (kind) {
      case "network":
        return t("update.error.network", detail);
      case "checksumMismatch":
        return t("update.error.checksum");
      case "invalidArchive":
        return t("update.error.archive");
      case "wrongBundle":
        return t("update.error.bundle", detail);
      case "notInstallable":
        return t("update.error.not_installable");
    }
  }
}

/** Adresse du flux : `CAIRN_UPDATE_URL` (tests) ou la dernière release GitHub. */
export function latestURL(env: NodeJS.ProcessEnv = process.env): string {
  const custom = env.CAIRN_UPDATE_URL;
  if (custom) {
    try {
      return new URL(custom).toString();
    } catch {
      // adresse invalide : flux officiel
    }
  }
  return LATEST_RELEASE_URL;
}

/** Architecture des assets publiés : `arm64` ou `x86_64` (jamais `x64`). */
export function releaseArch(): string {
  return machineArch();
}

// MARK: Versions

const numericCollator = new Intl.Collator("en", { numeric: true });

function splitVersion(v: string): { nums: number[]; pre: string | null } {
  let s = v.trim();
  if (s.startsWith("v")) s = s.slice(1);
  const dash = s.indexOf("-");
  const main = dash >= 0 ? s.slice(0, dash) : s;
  const pre = dash >= 0 ? s.slice(dash + 1) : null;
  const nums = main.split(".").map((p) => {
    const n = /^\d+$/.test(p) ? Number(p) : 0;
    return Number.isFinite(n) ? n : 0;
  });
  return { nums, pre };
}

/** `a` est strictement plus récente que `b` (« v » initial ignoré ; « 1.0.0-beta » < « 1.0.0 »). */
export function isNewer(a: string, b: string): boolean {
  const x = splitVersion(a);
  const y = splitVersion(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const p = x.nums[i] ?? 0;
    const q = y.nums[i] ?? 0;
    if (p !== q) return p > q;
  }
  if (x.pre === null) return y.pre !== null;
  if (y.pre === null) return false;
  return numericCollator.compare(x.pre, y.pre) > 0;
}

// MARK: Lecture de la release

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function validURL(v: unknown): string | null {
  if (typeof v !== "string") return null;
  try {
    return new URL(v).toString();
  } catch {
    return null;
  }
}

/** Lit la réponse de `releases/latest` ; `null` si ce n'est pas une release utilisable pour cette architecture. */
export function parseRelease(data: unknown, arch: string = releaseArch()): AppRelease | null {
  let json: unknown = data;
  if (typeof data === "string") {
    try {
      json = JSON.parse(data);
    } catch {
      return null;
    }
  }
  if (!isObject(json)) return null;
  const tag = json.tag_name;
  if (typeof tag !== "string" || json.draft === true || json.prerelease === true) return null;
  const page = validURL(json.html_url);
  if (!page) return null;
  const version = tag.startsWith("v") ? tag.slice(1) : tag;
  const assets = new Map<string, string>();
  for (const a of Array.isArray(json.assets) ? json.assets : []) {
    if (!isObject(a) || typeof a.name !== "string") continue;
    const url = validURL(a.browser_download_url);
    if (url) assets.set(a.name, url);
  }
  const name = `Cairn-${version}-${arch}.zip`;
  const archive = assets.get(name);
  const sum = assets.get(`${name}.sha256`);
  if (!archive || !sum) return null;
  const body = typeof json.body === "string" ? json.body.trim() : "";
  return { version, notes: body, pageURL: page, archiveURL: archive, checksumURL: sum };
}

export type Fetcher = typeof fetch;

async function request(url: string, timeoutMs: number, headers: Record<string, string>, fetcher: Fetcher) {
  let response: Response;
  try {
    response = await fetcher(url, { headers, signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });
  } catch (error) {
    throw new UpdateError("network", error instanceof Error ? error.message : String(error));
  }
  if (!response.ok) throw new UpdateError("network", `HTTP ${response.status}`);
  return response;
}

export interface CheckOptions {
  current: string;
  url?: string;
  arch?: string;
  fetcher?: Fetcher;
}

/** Release plus récente que `current`, ou `null` si Cairn est à jour. */
export async function checkForUpdate(options: CheckOptions): Promise<AppRelease | null> {
  const fetcher = options.fetcher ?? fetch;
  const response = await request(
    options.url ?? latestURL(),
    CHECK_TIMEOUT_MS,
    { Accept: "application/vnd.github+json", "User-Agent": `Cairn/${options.current}` },
    fetcher,
  );
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    throw new UpdateError("network", error instanceof Error ? error.message : String(error));
  }
  const r = parseRelease(text, options.arch ?? releaseArch());
  return r && isNewer(r.version, options.current) ? r : null;
}

// MARK: Installation

/** Bundle `.app` qui contient l'exécutable (`…/Cairn.app/Contents/MacOS/Cairn`), sinon `null`. */
export function bundleOf(executable: string): string | null {
  let dir = path.resolve(executable);
  while (dir !== path.dirname(dir)) {
    if (dir.endsWith(".app")) return dir;
    dir = path.dirname(dir);
  }
  return null;
}

/** Bundle remplaçable : un `.app` dont le dossier parent est modifiable. `null` en exécution de développement. */
export async function installableBundle(bundle: string | null): Promise<string | null> {
  if (!bundle || path.extname(bundle) !== ".app") return null;
  try {
    await access(path.dirname(bundle), constants.W_OK);
    return bundle;
  } catch {
    return null;
  }
}

/** Dossier caché à côté du bundle : le remplacement reste un simple renommage sur le même volume. */
export function stagingDirectory(bundle: string): string {
  return path.join(path.dirname(bundle), ".cairn-update");
}

/** Empreinte attendue : premier champ du fichier au format `shasum`, en minuscules. */
export function parseChecksum(text: string): string {
  return (text.trim().split(/\s+/)[0] ?? "").toLowerCase();
}

/** SHA-256 d'un fichier, lu en flux. */
export async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

/** Télécharge `url` dans `file` en calculant son SHA-256 au passage (rien n'est gardé en mémoire). */
export async function downloadHashing(
  url: string,
  file: string,
  options: { fetcher?: Fetcher; timeoutMs?: number; userAgent?: string } = {},
): Promise<string> {
  const response = await request(
    url,
    options.timeoutMs ?? ARCHIVE_TIMEOUT_MS,
    { "User-Agent": options.userAgent ?? "Cairn", Accept: "application/octet-stream" },
    options.fetcher ?? fetch,
  );
  if (!response.body) throw new UpdateError("network", "empty response");
  const hash = createHash("sha256");
  const tee = new Transform({
    transform(chunk: Buffer, _enc, done) {
      hash.update(chunk);
      done(null, chunk);
    },
  });
  try {
    await pipeline(
      Readable.fromWeb(response.body as unknown as WebReadableStream<Uint8Array>),
      tee,
      createWriteStream(file),
    );
  } catch (error) {
    throw new UpdateError("network", error instanceof Error ? error.message : String(error));
  }
  return hash.digest("hex");
}

/** Lit `CFBundleIdentifier` et `CFBundleShortVersionString` d'un bundle (`plutil -convert json`). */
export async function bundleInfo(app: string): Promise<{ id: string | null; version: string | null }> {
  const plist = path.join(app, "Contents/Info.plist");
  try {
    const r = await run(PLUTIL, ["-convert", "json", "-o", "-", plist], { stderr: "ignore", timeoutMs: 10_000 });
    if (r.code !== 0) return { id: null, version: null };
    const info = JSON.parse(r.stdout) as Record<string, unknown>;
    const id = typeof info.CFBundleIdentifier === "string" ? info.CFBundleIdentifier : null;
    const version = typeof info.CFBundleShortVersionString === "string" ? info.CFBundleShortVersionString : null;
    return { id, version };
  } catch {
    return { id: null, version: null };
  }
}

export interface PrepareInput {
  archive: string;
  /** Contenu du fichier `.sha256` (format `shasum`). */
  checksum: string;
  version: string;
  staging: string;
  /** SHA-256 déjà calculé pendant le téléchargement (sinon relu en flux). */
  actualSHA256?: string;
}

/** Vérifie le SHA-256, extrait l'archive dans `staging` et contrôle le bundle obtenu ; renvoie l'app extraite. */
export async function prepare(input: PrepareInput): Promise<string> {
  const expected = parseChecksum(input.checksum);
  let actual = input.actualSHA256;
  if (actual === undefined) {
    try {
      actual = await sha256File(input.archive);
    } catch {
      throw new UpdateError("invalidArchive");
    }
  }
  if (expected === "" || actual.toLowerCase() !== expected) throw new UpdateError("checksumMismatch");

  await rm(input.staging, { recursive: true, force: true });
  await mkdir(input.staging, { recursive: true });
  const unzip = await run(DITTO, ["-x", "-k", input.archive, input.staging], { stderr: "ignore" }).catch(() => null);
  if (unzip?.code !== 0) {
    await rm(input.staging, { recursive: true, force: true });
    throw new UpdateError("invalidArchive");
  }
  const app = path.join(input.staging, "Cairn.app");
  const info = await bundleInfo(app);
  if (info.id !== BUNDLE_IDENTIFIER || info.version !== input.version) {
    await rm(input.staging, { recursive: true, force: true });
    throw new UpdateError("wrongBundle", `${info.id ?? "?"} ${info.version ?? "?"}`);
  }
  // App non notarisée : même consigne que les notes de release.
  await run(XATTR, ["-dr", "com.apple.quarantine", app], { stderr: "ignore" }).catch(() => null);
  return app;
}

export interface DownloadOptions {
  fetcher?: Fetcher;
  /** Version courante (`User-Agent`). */
  current?: string;
  /** Accepter des adresses `http:` (flux de test `CAIRN_UPDATE_URL` local). */
  allowInsecure?: boolean;
}

function checkScheme(url: string, allowInsecure: boolean): void {
  const scheme = new URL(url).protocol;
  if (scheme === "https:" || (allowInsecure && scheme === "http:")) return;
  throw new UpdateError("network", `refused ${scheme} URL`);
}

/** Télécharge, vérifie et prépare la release ; renvoie l'app extraite, prête à remplacer `bundle`. */
export async function downloadRelease(r: AppRelease, bundle: string, options: DownloadOptions = {}): Promise<string> {
  const allowInsecure = options.allowInsecure ?? false;
  checkScheme(r.archiveURL, allowInsecure);
  checkScheme(r.checksumURL, allowInsecure);
  const tmp = path.join(os.tmpdir(), `cairn-update-${randomUUID().toUpperCase()}`);
  await mkdir(tmp, { recursive: true });
  try {
    const archive = path.join(tmp, path.basename(new URL(r.archiveURL).pathname) || "Cairn.zip");
    const userAgent = `Cairn/${options.current ?? "?"}`;
    const actual = await downloadHashing(r.archiveURL, archive, { fetcher: options.fetcher, userAgent });
    const sumResponse = await request(
      r.checksumURL,
      CHECKSUM_TIMEOUT_MS,
      { "User-Agent": userAgent },
      options.fetcher ?? fetch,
    );
    const checksum = await sumResponse.text();
    return await prepare({
      archive,
      checksum,
      version: r.version,
      staging: stagingDirectory(bundle),
      actualSHA256: actual,
    });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/**
 * Script qui attend la fin de `pid`, remplace `$2` par `$3`, remet l'ancien en cas d'échec puis relance.
 * Arguments : pid, bundle installé, nouveau bundle, dossier de préparation, relance (1/0). Identique à la 0.8.0.
 */
export const SWAP_SCRIPT = `pid=$1; app=$2; new=$3; staging=$4; relaunch=$5
old="$staging/Cairn.previous.app"
i=0
while kill -0 "$pid" 2>/dev/null; do sleep 0.2; i=$((i+1)); [ $i -gt 300 ] && exit 1; done
rm -rf "$old"
if mv "$app" "$old"; then
  if mv "$new" "$app"; then rm -rf "$staging"; else mv "$old" "$app"; fi
fi
[ "$relaunch" = 1 ] && /usr/bin/open "$app"
exit 0`;

export interface SwapOptions {
  newApp: string;
  bundle: string;
  pid?: number;
  relaunch?: boolean;
}

/**
 * Lance le remplacement en arrière-plan (processus détaché, arguments positionnels, aucun texte de l'utilisateur dans
 * le script) ; l'appelant doit quitter ensuite. Renvoie une promesse résolue à la fin du script (tests).
 */
export function scheduleSwap(options: SwapOptions): { pid: number | undefined; exited: Promise<number | null> } {
  const child = spawn(
    SH,
    [
      "-c",
      SWAP_SCRIPT,
      "cairn-update",
      String(options.pid ?? process.pid),
      options.bundle,
      options.newApp,
      path.dirname(options.newApp),
      options.relaunch === false ? "0" : "1",
    ],
    { detached: true, stdio: "ignore" },
  );
  const exited = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => resolve(code));
    child.once("error", () => resolve(null));
  });
  child.unref();
  return { pid: child.pid, exited };
}
