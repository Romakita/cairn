// Rétention des journaux de `~/.cairn/logs` (port de `LogJanitor`, ConfigStore.swift).
import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { CairnPaths } from "./paths.ts";

/** Supprime les journaux plus vieux que `retentionDays`, sauf ceux de `keep` (journaux de versions gardées). */
export async function pruneLogs(
  paths: CairnPaths,
  retentionDays: number,
  keep: ReadonlySet<string> = new Set(),
  now: Date = new Date(),
): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(paths.logs);
  } catch {
    return [];
  }
  const limit = now.getTime() - retentionDays * 86_400_000;
  const removed: string[] = [];
  for (const name of names) {
    if (!name.endsWith(".log") || keep.has(name)) continue;
    const file = path.join(paths.logs, name);
    try {
      if ((await stat(file)).mtimeMs >= limit) continue;
      await rm(file);
      removed.push(name);
    } catch {
      // fichier disparu ou non supprimable : ignoré
    }
  }
  return removed.sort();
}
