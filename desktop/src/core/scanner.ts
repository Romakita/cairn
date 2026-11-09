// Analyse du disque en lecture seule (port de Scanner.swift, Model.swift et `Scanner.scanFolders`/`measure`
// d'Analysis.swift). Les deux premiers niveaux sont listés ici (fs/promises), puis chaque sous-arbre est parcouru en
// parallèle par un worker (scanner-worker.ts). Rien n'est jamais écrit sur le disque analysé.
import path from "node:path";
import type { Stats } from "./fs.ts";
import { lstat, readdir, stat } from "./fs-promises.ts";
import { expandTilde } from "./paths.ts";
import { CATEGORIES, type Category, categoryIndex, classify, isRegenerable } from "./regenerable.ts";
import { type LinkRecord, type RawBigFile, type RawNode, ScanPool, type TreeResult } from "./scanner-worker.ts";

/** Fichiers listés dans « Gros fichiers » (seuil par défaut, `big_file_threshold_mb` × 1 000 000). */
export const BIG_FILE_THRESHOLD = 50_000_000;
/** Fichiers affichés individuellement dans l'explorateur (10 Mio). */
export const LISTED_FILE_THRESHOLD = 10 * 1024 * 1024;

// MARK: Modèle

export interface Node {
  name: string;
  path: string;
  isDirectory: boolean;
  category: Category;
  /** Octets des fichiers directement dedans qui ne sont pas listés comme enfants (plus les blocs du dossier). */
  ownBytes: number;
  ownFileCount: number;
  size: number;
  fileCount: number;
  /** Octets par catégorie, dans l'ordre de `CATEGORIES`. */
  breakdown: number[];
  children: Node[];
  /** Parent (propriété non énumérable : l'arbre se sérialise sans cycle). */
  parent: Node | null;
  isGitRepo: boolean;
}

export interface BigFile {
  path: string;
  size: number;
  category: Category;
}

export interface ScanResult {
  root: Node;
  bigFiles: BigFile[];
  errors: number;
  /** Durée en secondes. */
  duration: number;
}

/** Résultat de l'analyse d'un dossier suivi (`result` nul si le dossier est indisponible ou l'analyse arrêtée). */
export interface FolderScan {
  folder: string;
  result: ScanResult | null;
}

function setParent(node: Node | RawNode, parent: Node | null): void {
  Object.defineProperty(node, "parent", { value: parent, writable: true, enumerable: false, configurable: true });
}

export function makeNode(name: string, nodePath: string, isDirectory: boolean, category: Category): Node {
  const node = {
    name,
    path: nodePath,
    isDirectory,
    category,
    ownBytes: 0,
    ownFileCount: 0,
    size: 0,
    fileCount: 0,
    breakdown: new Array<number>(CATEGORIES.length).fill(0),
    children: [],
    isGitRepo: false,
  } as unknown as Node;
  setParent(node, null);
  return node;
}

export function bytes(node: Node, category: Category): number {
  return node.breakdown[categoryIndex(category)] ?? 0;
}

export function regenerableBytes(node: Node): number {
  let total = 0;
  for (const c of CATEGORIES) if (isRegenerable(c)) total += bytes(node, c);
  return total;
}

const bySizeDesc = (a: Node, b: Node) => b.size - a.size;

/** Recalcule taille et répartition à partir des enfants et des fichiers propres (`Node.finalize`). */
export function finalizeNode(node: Node): void {
  const b = new Array<number>(CATEGORIES.length).fill(0);
  b[categoryIndex(node.category)] = node.ownBytes;
  let size = node.ownBytes;
  let files = node.ownFileCount;
  for (const c of node.children) {
    size += c.size;
    files += c.fileCount;
    for (let i = 0; i < b.length; i++) b[i] = (b[i] as number) + (c.breakdown[i] ?? 0);
  }
  node.size = size;
  node.fileCount = files;
  node.breakdown = b;
  node.children.sort(bySizeDesc);
}

/** Pose les parents et finalise un arbre de bas en haut (les nœuds fichiers gardent leur taille). */
function finalizeTree(node: Node, parent: Node | null): void {
  setParent(node, parent);
  if (!node.isDirectory) return;
  for (const c of node.children) finalizeTree(c, node);
  finalizeNode(node);
}

/** Retire ce nœud de l'arbre et met à jour les totaux des parents, sans nouvelle analyse (`Node.detach`). */
export function detach(node: Node): void {
  const p = node.parent;
  if (!p) return;
  p.children = p.children.filter((c) => c !== node);
  for (let n: Node | null = p; n; n = n.parent) {
    n.size -= node.size;
    n.fileCount -= node.fileCount;
    for (let i = 0; i < n.breakdown.length; i++) n.breakdown[i] = (n.breakdown[i] as number) - (node.breakdown[i] ?? 0);
    n.children.sort(bySizeDesc);
  }
  setParent(node, null);
}

export function relativePath(node: Node, root: Node): string {
  if (node.path === root.path) return "/";
  const prefix = root.path.endsWith("/") ? root.path : `${root.path}/`;
  return node.path.startsWith(prefix) ? node.path.slice(prefix.length) : node.path;
}

export function walk(node: Node, body: (n: Node) => void): void {
  body(node);
  for (const c of node.children) walk(c, body);
}

// MARK: Contexte partagé

export interface ScanProgress {
  files: number;
  bytes: number;
  current: string;
  errors: number;
}

/**
 * État partagé d'une analyse (progression, liens physiques déjà vus, annulation). Le même contexte passé à plusieurs
 * analyses compte une seule fois un fichier lié entre dossiers suivis.
 */
export class ScanContext {
  /** Seuil des « gros fichiers » (octets). */
  readonly bigFileThreshold: number;
  private files = 0;
  private bytesSeen = 0;
  private current = "";
  private errors = 0;
  private readonly seen = new Set<string>();
  private readonly controller = new AbortController();

  constructor(options: { bigFileThreshold?: number; signal?: AbortSignal } = {}) {
    this.bigFileThreshold = options.bigFileThreshold ?? BIG_FILE_THRESHOLD;
    const external = options.signal;
    if (external?.aborted) this.controller.abort();
    external?.addEventListener("abort", () => this.controller.abort(), { once: true });
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get cancelled(): boolean {
    return this.controller.signal.aborted;
  }

  cancel(): void {
    this.controller.abort();
  }

  report(files: number, bytes: number, errors: number, current: string | null): void {
    this.files += files;
    this.bytesSeen += bytes;
    this.errors += errors;
    if (current !== null) this.current = current;
  }

  snapshot(): ScanProgress {
    return { files: this.files, bytes: this.bytesSeen, current: this.current, errors: this.errors };
  }

  /** Les fichiers avec plusieurs liens physiques (pnpm…) ne sont comptés qu'une fois : `true` à la première vue. */
  firstSeen(key: string): boolean {
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }
}

// MARK: Analyse

/** Dossier situé sur un autre volume que la racine (point de montage) : ignoré par l'analyse. */
export function isOtherVolume(st: { dev: number | bigint }, rootDevice: number | bigint): boolean {
  return st.dev !== rootDevice;
}

async function hardLinkKey(file: string, st: Stats): Promise<string> {
  if (Number.isSafeInteger(st.ino)) return `${st.dev}:${st.ino}`;
  const big = await lstat(file, { bigint: true });
  return `${big.dev}:${big.ino}`;
}

async function fileSize(file: string, st: Stats, ctx: ScanContext): Promise<number> {
  if (st.isFile() && st.nlink > 1 && !ctx.firstSeen(await hardLinkKey(file, st))) return 0;
  return st.blocks * 512;
}

function addFile(name: string, file: string, size: number, to: Node, ctx: ScanContext, big: BigFile[]): void {
  if (size >= LISTED_FILE_THRESHOLD) {
    const f = makeNode(name, file, false, "source");
    f.size = size;
    f.fileCount = 1;
    f.breakdown[categoryIndex("source")] = size;
    to.children.push(f);
  } else {
    to.ownBytes += size;
    to.ownFileCount += 1;
  }
  if (size >= ctx.bigFileThreshold) big.push({ path: file, size, category: "source" });
}

/** Retire les occurrences en double d'un lien physique déjà compté ailleurs (taille 0, comme la 0.8.0). */
function resolveLinks(links: LinkRecord[], big: RawBigFile[], ctx: ScanContext): RawBigFile[] {
  const dropped = new Set<RawBigFile>();
  for (const link of links) {
    if (ctx.firstSeen(link.key)) continue;
    if (link.file) {
      const file = link.file;
      link.node.children = link.node.children.filter((c) => c !== file);
      link.node.ownFileCount += 1;
    } else {
      link.node.ownBytes -= link.size;
    }
    if (link.big) dropped.add(link.big);
    ctx.report(0, -link.size, 0, null);
  }
  return dropped.size === 0 ? big : big.filter((b) => !dropped.has(b));
}

function compareBigFiles(a: BigFile, b: BigFile): number {
  return b.size - a.size;
}

export interface ScanOptions {
  /** Pool de workers à réutiliser (sinon un pool est créé pour cette analyse, puis arrêté). */
  pool?: ScanPool;
  /** Nombre de workers (par défaut : nombre de cœurs, au plus 8). */
  workers?: number;
}

function newPool(ctx: ScanContext, workers?: number): ScanPool {
  return new ScanPool(
    ctx,
    { bigFileThreshold: ctx.bigFileThreshold, listedThreshold: LISTED_FILE_THRESHOLD, signal: ctx.signal },
    workers,
  );
}

/**
 * Analyse complète d'un dossier. Une analyse arrêtée (`ctx.cancel()`) se termine vite avec un résultat partiel :
 * `scanFolders` le remplace par `null`.
 */
export async function scan(root: string, ctx: ScanContext, options: ScanOptions = {}): Promise<ScanResult> {
  const start = Date.now();
  const errorsBefore = ctx.snapshot().errors;
  const rootNode = makeNode(path.basename(root), root, true, "source");
  // `fanOut` : nombre de liens du dossier (sous-dossiers + 2 sur APFS), pour lancer d'abord les plus gros.
  const jobs: { path: string; parent: Node; fanOut: number }[] = [];
  const bigFiles: BigFile[] = [];

  // Volume de la racine : comme fts(3) avec FTS_XDEV, on ne franchit pas les points de montage.
  const rootDevice = await stat(root).then(
    (s) => s.dev,
    () => null,
  );

  // Les deux premiers niveaux sont listés ici, puis chaque dossier de niveau 2 est analysé en parallèle.
  const expand = async (node: Node, depth: number): Promise<void> => {
    let names: string[];
    try {
      names = await readdir(node.path);
    } catch {
      return;
    }
    const stats = await Promise.all(names.map((name) => lstat(`${node.path}/${name}`).catch(() => null)));
    for (const [i, name] of names.entries()) {
      const st = stats[i];
      if (!st) continue;
      const file = `${node.path}/${name}`;
      if (st.isDirectory()) {
        if (rootDevice !== null && isOtherVolume(st, rootDevice)) continue;
        const category = await classify(name, node.path);
        if (name === ".git") node.isGitRepo = true;
        if (depth === 1 && category === "source") {
          const child = makeNode(name, file, true, "source");
          child.ownBytes = st.blocks * 512;
          node.children.push(child);
          await expand(child, 2);
        } else {
          jobs.push({ path: file, parent: node, fanOut: st.nlink });
        }
      } else {
        const size = await fileSize(file, st, ctx);
        addFile(name, file, size, node, ctx, bigFiles);
        ctx.report(1, size, 0, null);
      }
    }
  };
  await expand(rootNode, 1);

  const pool = options.pool ?? newPool(ctx, options.workers);
  let results: (TreeResult | null)[];
  try {
    // Les sous-arbres les plus ramifiés partent en premier (le plus gros ne finit pas seul en dernier) ; les
    // résultats sont rattachés dans l'ordre de la liste.
    const order = jobs.map((_, i) => i).sort((a, b) => (jobs[b]?.fanOut ?? 0) - (jobs[a]?.fanOut ?? 0));
    const pending = new Array<Promise<TreeResult | null>>(jobs.length);
    if (!ctx.cancelled) for (const i of order) pending[i] = pool.tree((jobs[i] as (typeof jobs)[number]).path);
    results = ctx.cancelled ? [] : await Promise.all(pending);
  } finally {
    if (!options.pool) pool.close();
  }

  for (const [i, job] of jobs.entries()) {
    const r = results[i];
    if (!r?.tree) continue;
    const big = resolveLinks(r.links, r.big, ctx);
    job.parent.children.push(r.tree as unknown as Node);
    bigFiles.push(...big);
  }
  finalizeTree(rootNode, null);
  bigFiles.sort(compareBigFiles);
  return {
    root: rootNode,
    bigFiles,
    errors: ctx.snapshot().errors - errorsBefore,
    duration: (Date.now() - start) / 1000,
  };
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Analyse chaque dossier suivi ; les liens physiques partagés entre dossiers ne sont comptés qu'une fois. */
export async function scanFolders(
  folders: readonly string[],
  ctx: ScanContext,
  options: Omit<ScanOptions, "pool"> = {},
): Promise<FolderScan[]> {
  const pool = newPool(ctx, options.workers);
  const out: FolderScan[] = [];
  try {
    for (const f of folders) {
      const folder = expandTilde(f);
      if (ctx.cancelled || !(await exists(folder))) {
        out.push({ folder, result: null });
        continue;
      }
      const r = await scan(folder, ctx, { pool });
      out.push({ folder, result: ctx.cancelled ? null : r });
    }
  } finally {
    pool.close();
  }
  return out;
}

/**
 * Taille totale et part régénérable d'un dossier, sans construire d'arbre (mémoire constante, `Scanner.measure`).
 * Comme la 0.8.0 : les liens physiques ne sont pas dédoublonnés, la part régénérable exclut `.git` et la corbeille.
 */
export async function measure(
  root: string,
  options: { signal?: AbortSignal } = {},
): Promise<{
  size: number;
  regenerable: number;
}> {
  const pool = new ScanPool(
    { report: () => {} },
    { bigFileThreshold: BIG_FILE_THRESHOLD, listedThreshold: LISTED_FILE_THRESHOLD, signal: options.signal },
    1,
  );
  try {
    const r = await pool.measure(root);
    return { size: r?.size ?? 0, regenerable: r?.regenerable ?? 0 };
  } finally {
    pool.close();
  }
}
