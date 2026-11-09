// Worker d'analyse (port de `Scanner.scanTree` et `Scanner.measure`) et pool qui les fait tourner.
//
// Choix : le worker est créé depuis une chaîne de code (`new Worker(code, { eval: true })`), construite à partir du
// texte de `scanWorkerMain` et de `classifyWith`. Il n'y a donc pas de fichier séparé à retrouver à l'exécution :
// le même code marche sous `bun test`, sous Node et une fois bundlé par `bun build` en CJS (minifié ou non) pour
// Electron. Contrainte : `scanWorkerMain` ne doit utiliser QUE ses paramètres (aucun import, aucune variable du module),
// ce que vérifie le test « bundled worker » de test/core/scanner.test.ts.
//
// Dans le worker, le parcours est synchrone (`readdirSync`/`lstatSync`, le plus rapide en Node) : il ne bloque que son
// propre thread. Le process principal ne fait aucun appel synchrone.
import os from "node:os";
import { Worker } from "node:worker_threads";
import {
  CATEGORIES,
  type Category,
  CLASSIFICATION_RULES,
  classifyWith,
  REGENERABLE_CATEGORIES,
} from "./regenerable.ts";

/** Nœud tel que construit par le worker (sans `parent` ni totaux : le process principal les calcule). */
export interface RawNode {
  name: string;
  path: string;
  isDirectory: boolean;
  category: Category;
  ownBytes: number;
  ownFileCount: number;
  size: number;
  fileCount: number;
  breakdown: number[];
  children: RawNode[];
  isGitRepo: boolean;
}

export interface RawBigFile {
  path: string;
  size: number;
  category: Category;
}

/**
 * Fichier à plusieurs liens physiques vu pour la première fois par ce worker. Le process principal garde la première
 * occurrence globale (entre workers et entre dossiers suivis) et retire les autres (taille 0, comme la 0.8.0).
 */
export interface LinkRecord {
  key: string;
  size: number;
  /** Dossier qui a reçu les octets (ou le nœud fichier). */
  node: RawNode;
  /** Nœud fichier listé (≥ 10 Mio), le cas échéant. */
  file: RawNode | null;
  /** Entrée « gros fichier », le cas échéant. */
  big: RawBigFile | null;
}

export interface WorkerJob {
  id: number;
  mode: "tree" | "measure";
  path: string;
}

export interface TreeResult {
  tree: RawNode | null;
  big: RawBigFile[];
  links: LinkRecord[];
}

export interface MeasureResult {
  size: number;
  regenerable: number;
}

export interface WorkerData {
  rules: typeof CLASSIFICATION_RULES;
  categories: readonly Category[];
  regenerable: readonly Category[];
  listedThreshold: number;
  bigThreshold: number;
}

type WorkerMessage =
  | { type: "progress"; files: number; bytes: number; errors: number; current: string | null }
  | ({ type: "done"; id: number } & Partial<TreeResult> & Partial<MeasureResult>)
  | { type: "failed"; id: number; message: string };

/**
 * Corps du worker. N'utilise que ses paramètres (voir l'en-tête). `fts(3)` avec `FTS_PHYSICAL | FTS_NOCHDIR |
 * FTS_XDEV` : liens symboliques non suivis (comptés pour leur propre taille), un dossier sur un autre volume est compté
 * pour lui-même sans être parcouru, taille = blocs alloués × 512.
 */
export function scanWorkerMain(
  wt: typeof import("node:worker_threads"),
  fs: typeof import("node:fs"),
  classifyWith: (
    rules: WorkerData["rules"],
    exists: (file: string) => boolean,
    name: string,
    parentPath: string,
  ) => Category,
): void {
  const data = wt.workerData as WorkerData;
  const port = wt.parentPort;
  if (!port) return;
  const nCategories = data.categories.length;
  const minThreshold = Math.min(data.listedThreshold, data.bigThreshold);
  const exists = (file: string) => fs.existsSync(file);
  const classify = (name: string, parentPath: string) => classifyWith(data.rules, exists, name, parentPath);
  // Liens physiques déjà vus par ce worker (tous ses travaux) : une seule occurrence est remontée par worker.
  const seen = new Set<string>();

  let pendingFiles = 0;
  let pendingBytes = 0;
  let pendingErrors = 0;
  const flush = (current: string | null) => {
    port.postMessage({ type: "progress", files: pendingFiles, bytes: pendingBytes, errors: pendingErrors, current });
    pendingFiles = 0;
    pendingBytes = 0;
    pendingErrors = 0;
  };

  const lstat = (p: string): import("node:fs").Stats | null => {
    try {
      return fs.lstatSync(p, { throwIfNoEntry: false }) ?? null;
    } catch {
      return null;
    }
  };
  const list = (p: string): string[] | null => {
    try {
      return fs.readdirSync(p);
    } catch {
      return null;
    }
  };
  /** Clé `(dev, ino)` exacte : l'inode est relu en bigint s'il dépasse 2^53. */
  const linkKey = (p: string, st: import("node:fs").Stats): string => {
    if (Number.isSafeInteger(st.ino)) return `${st.dev}:${st.ino}`;
    const big = fs.lstatSync(p, { bigint: true });
    return `${big.dev}:${big.ino}`;
  };
  const makeNode = (name: string, path: string, isDirectory: boolean, category: Category): RawNode => ({
    name,
    path,
    isDirectory,
    category,
    ownBytes: 0,
    ownFileCount: 0,
    size: 0,
    fileCount: 0,
    breakdown: [],
    children: [],
    isGitRepo: false,
  });

  const tree = (root: string): TreeResult => {
    const big: RawBigFile[] = [];
    const links: LinkRecord[] = [];
    const rootStat = lstat(root);
    if (!rootStat?.isDirectory()) {
      pendingErrors += 1;
      flush(null);
      return { tree: null, big, links };
    }
    const rootDev = rootStat.dev;

    const file = (p: string, name: string, st: import("node:fs").Stats, top: RawNode, collapsed: Category | null) => {
      let bytes = st.blocks * 512;
      let key: string | null = null;
      if (st.isFile() && st.nlink > 1) {
        const k = linkKey(p, st);
        if (seen.has(k)) bytes = 0;
        else {
          seen.add(k);
          key = k;
        }
      }
      pendingFiles += 1;
      pendingBytes += bytes;
      let fileNode: RawNode | null = null;
      let bigEntry: RawBigFile | null = null;
      if (collapsed === null && bytes < minThreshold) {
        top.ownBytes += bytes;
        top.ownFileCount += 1;
      } else {
        const category = collapsed ?? "source";
        if (collapsed === null && bytes >= data.listedThreshold) {
          fileNode = makeNode(name, p, false, category);
          fileNode.size = bytes;
          fileNode.fileCount = 1;
          fileNode.breakdown = new Array(nCategories).fill(0);
          fileNode.breakdown[data.categories.indexOf(category)] = bytes;
          top.children.push(fileNode);
        } else {
          top.ownBytes += bytes;
          top.ownFileCount += 1;
        }
        if (bytes >= data.bigThreshold) {
          bigEntry = { path: p, size: bytes, category };
          big.push(bigEntry);
        }
      }
      if (key !== null) links.push({ key, size: bytes, node: top, file: fileNode, big: bigEntry });
      if (pendingFiles >= 5000) flush(null);
    };

    // Sous-arbre d'un dossier classé (node_modules, .git…) : compté en bloc dans `top`, sans nœud.
    const collapsedWalk = (p: string, top: RawNode, category: Category) => {
      const names = list(p);
      if (names === null) {
        pendingErrors += 1;
        return;
      }
      for (const name of names) {
        const child = `${p}/${name}`;
        const st = lstat(child);
        if (!st) {
          pendingErrors += 1;
          continue;
        }
        if (st.isDirectory()) {
          const blocks = st.blocks * 512;
          top.ownBytes += blocks;
          pendingBytes += blocks;
          if (st.dev === rootDev) collapsedWalk(child, top, category);
        } else {
          file(child, name, st, top, category);
        }
      }
    };

    const visit = (
      p: string,
      name: string,
      st: import("node:fs").Stats,
      level: number,
      parent: RawNode | null,
      parentPath: string,
    ): RawNode => {
      const blocks = st.blocks * 512;
      const category = classify(name, parentPath);
      const node = makeNode(name, p, true, category);
      node.ownBytes = blocks;
      pendingBytes += blocks;
      if (parent) {
        parent.children.push(node);
        if (name === ".git") parent.isGitRepo = true;
      }
      if (pendingFiles > 2000 || level <= 2) flush(p);
      if (st.dev !== rootDev) return node; // point de montage : compté, pas parcouru
      if (category !== "source") {
        collapsedWalk(p, node, category);
        return node;
      }
      const names = list(p);
      if (names === null) {
        pendingErrors += 1; // FTS_DNR
        return node;
      }
      for (const childName of names) {
        const child = `${p}/${childName}`;
        const cst = lstat(child);
        if (!cst) {
          pendingErrors += 1; // FTS_NS
          continue;
        }
        if (cst.isDirectory()) visit(child, childName, cst, level + 1, node, p);
        else file(child, childName, cst, node, null);
      }
      return node;
    };

    const slash = root.lastIndexOf("/");
    const node = visit(root, root.slice(slash + 1), rootStat, 0, null, slash > 0 ? root.slice(0, slash) : "/");
    flush(null);
    return { tree: node, big, links };
  };

  const measure = (root: string): MeasureResult => {
    let size = 0;
    let regenerable = 0;
    const rootStat = lstat(root);
    if (!rootStat) return { size, regenerable };
    const rootDev = rootStat.dev;
    const walk = (p: string, name: string, st: import("node:fs").Stats, parentPath: string, inRegen: boolean) => {
      const blocks = st.blocks * 512;
      const regen = inRegen || data.regenerable.includes(classify(name, parentPath));
      size += blocks;
      if (regen) regenerable += blocks;
      if (st.dev !== rootDev) return;
      const names = list(p);
      if (names === null) return;
      for (const childName of names) {
        const child = `${p}/${childName}`;
        const cst = lstat(child);
        if (!cst) continue;
        if (cst.isDirectory()) walk(child, childName, cst, p, regen);
        else {
          const b = cst.blocks * 512;
          size += b;
          if (regen) regenerable += b;
        }
      }
    };
    if (!rootStat.isDirectory()) return { size: rootStat.blocks * 512, regenerable: 0 };
    const slash = root.lastIndexOf("/");
    walk(root, root.slice(slash + 1), rootStat, slash > 0 ? root.slice(0, slash) : "/", false);
    return { size, regenerable };
  };

  port.on("message", (job: WorkerJob) => {
    try {
      const result = job.mode === "measure" ? measure(job.path) : tree(job.path);
      port.postMessage({ type: "done", id: job.id, ...result });
    } catch (error) {
      port.postMessage({ type: "failed", id: job.id, message: String(error) });
    }
  });
}

/** Code du worker : texte autonome, évalué par `new Worker(code, { eval: true })`. */
export function workerSource(): string {
  return [
    `const classifyWith = (${classifyWith.toString()});`,
    `(${scanWorkerMain.toString()})(require("node:worker_threads"), require("node:fs"), classifyWith);`,
  ].join("\n");
}

/** Progression remontée par les workers. */
export interface ProgressSink {
  report(files: number, bytes: number, errors: number, current: string | null): void;
}

interface Pending {
  job: WorkerJob;
  resolve: (value: WorkerMessage | null) => void;
}

interface Slot {
  worker: Worker;
  current: Pending | null;
}

/**
 * Pool de workers d'analyse. `run` rend `null` si le travail a échoué ou si le pool a été arrêté (annulation :
 * `close()` termine les workers immédiatement, l'analyse s'arrête donc bien en moins de 2 s).
 */
export class ScanPool {
  private readonly slots: Slot[] = [];
  private readonly queue: Pending[] = [];
  private nextId = 1;
  private closed = false;
  private readonly source = workerSource();
  private readonly workerData: WorkerData;

  constructor(
    private readonly sink: ProgressSink,
    options: { bigFileThreshold: number; listedThreshold: number; size?: number; signal?: AbortSignal },
    private readonly size = options.size ?? Math.max(1, Math.min(os.availableParallelism(), 8)),
  ) {
    this.workerData = {
      rules: CLASSIFICATION_RULES,
      categories: CATEGORIES,
      regenerable: REGENERABLE_CATEGORIES,
      listedThreshold: options.listedThreshold,
      bigThreshold: options.bigFileThreshold,
    };
    if (options.signal?.aborted) this.close();
    options.signal?.addEventListener("abort", () => this.close(), { once: true });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  tree(path: string): Promise<TreeResult | null> {
    return this.submit("tree", path) as Promise<TreeResult | null>;
  }

  measure(path: string): Promise<MeasureResult | null> {
    return this.submit("measure", path) as Promise<MeasureResult | null>;
  }

  private submit(mode: WorkerJob["mode"], path: string): Promise<unknown> {
    if (this.closed) return Promise.resolve(null);
    return new Promise<WorkerMessage | null>((resolve) => {
      this.queue.push({ job: { id: this.nextId++, mode, path }, resolve });
      this.dispatch();
    }).then((m) => (m && m.type === "done" ? m : null));
  }

  private dispatch(): void {
    while (!this.closed && this.queue.length > 0) {
      let slot = this.slots.find((s) => s.current === null);
      if (!slot && this.slots.length < this.size) slot = this.spawn();
      if (!slot) return;
      const pending = this.queue.shift() as Pending;
      slot.current = pending;
      slot.worker.postMessage(pending.job);
    }
  }

  private spawn(): Slot {
    const worker = new Worker(this.source, { eval: true, workerData: this.workerData });
    const slot: Slot = { worker, current: null };
    worker.on("message", (m: WorkerMessage) => {
      if (m.type === "progress") {
        this.sink.report(m.files, m.bytes, m.errors, m.current);
        return;
      }
      const pending = slot.current;
      slot.current = null;
      if (m.type === "failed") this.sink.report(0, 0, 1, null);
      pending?.resolve(m);
      this.dispatch();
    });
    const lost = () => {
      const index = this.slots.indexOf(slot);
      if (index >= 0) this.slots.splice(index, 1);
      const pending = slot.current;
      slot.current = null;
      if (pending) {
        if (!this.closed) this.sink.report(0, 0, 1, null);
        pending.resolve(null);
      }
      this.dispatch();
    };
    worker.on("error", lost);
    worker.on("exit", lost);
    this.slots.push(slot);
    return slot;
  }

  /** Arrête tout : travaux en cours et en attente rendus `null`. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.queue.splice(0)) p.resolve(null);
    for (const slot of this.slots.splice(0)) {
      const pending = slot.current;
      slot.current = null;
      pending?.resolve(null);
      void slot.worker.terminate();
    }
  }
}
