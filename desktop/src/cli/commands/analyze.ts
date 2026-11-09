// `cairn analyze [dossiers…] [--json]` (port de `CLI.analyze`). Lecture seule : rien n'est écrit, ni sur le disque
// analysé, ni dans `config.toml`, ni dans `~/.cairn` (pas de résumé d'analyse).
import { stat } from "node:fs/promises";
import { findBigObjects, findProjects, projectTotalSize, worktreeBytes } from "../../core/analysis.ts";
import { folderExpandedPath } from "../../core/config.ts";
import { Fmt } from "../../core/format.ts";
import type { JSONValue } from "../../core/json.ts";
import { t } from "../../core/l10n.ts";
import { expandTilde } from "../../core/paths.ts";
import { CATEGORIES, categoryLabel } from "../../core/regenerable.ts";
import { bytes, regenerableBytes, ScanContext, scanFolders } from "../../core/scanner.ts";
import { type CommandEnv, Exit, type ExitCode, pad, printJSON, readConfig, wantsHelp } from "../shared.ts";

/** Dossier analysé par défaut quand aucun dossier n'est suivi. */
export const DEFAULT_FOLDER = "/Volumes/workspaces";

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function analyze({ args, store, io }: CommandEnv): Promise<ExitCode> {
  if (wantsHelp(args)) {
    io.out(t("cli.analyze.help"));
    return Exit.ok;
  }
  let json = false;
  let folders: string[] = [];
  for (const a of args) {
    if (a === "--json") json = true;
    else if (a === "--yes" || a === "-y")
      continue; // rien à confirmer
    else if (a.startsWith("-")) {
      io.err(t("cli.unknown_option", a));
      return Exit.usage;
    } else folders.push(expandTilde(a));
  }
  // Par défaut : les dossiers suivis de config.toml (sans modifier le fichier), sinon /Volumes/workspaces.
  const config = await readConfig(store);
  const explicit = folders.length > 0;
  if (!explicit) folders = config.folders.map(folderExpandedPath);
  if (folders.length === 0) folders = [DEFAULT_FOLDER];
  if (explicit) {
    for (const f of folders) {
      if (!(await exists(f))) {
        io.err(t("cli.missing_folder", f));
        return Exit.failure;
      }
    }
  }

  const ctx = new ScanContext({ bigFileThreshold: Math.trunc(config.analysis.bigFileThresholdMB * 1_000_000) });
  const folderThreshold = Math.trunc(config.analysis.bigFolderThresholdGB * 1_000_000_000);
  const scans = await scanFolders(folders, ctx);
  const reports: JSONValue[] = [];
  let total = 0;
  for (const scan of scans) {
    const r = scan.result;
    if (!r) {
      if (json) reports.push({ path: scan.folder, available: false });
      else io.err(t("config.issue.folder_unavailable", scan.folder));
      continue;
    }
    total += r.root.size;
    const big = findBigObjects(r.root, r.bigFiles, folderThreshold);
    if (json) {
      const projects = await findProjects(r.root);
      const breakdown: Record<string, number> = {};
      for (const c of CATEGORIES) breakdown[c] = bytes(r.root, c);
      reports.push({
        path: scan.folder,
        available: true,
        size: r.root.size,
        files: r.root.fileCount,
        regenerable: regenerableBytes(r.root),
        breakdown,
        errors: r.errors,
        duration_seconds: r.duration,
        big_objects: big.slice(0, 50).map((o) => ({ kind: o.kind, path: o.path, size: o.size, category: o.category })),
        projects: projects.slice(0, 50).map((p) => ({
          path: p.path,
          size: projectTotalSize(p),
          git: p.git,
          regenerable: p.regenerable,
          worktrees: p.worktrees.length,
          worktree_bytes: worktreeBytes(p),
        })),
      });
      continue;
    }
    io.out(
      t(
        "cli.report.summary",
        scan.folder,
        Fmt.bytes(r.root.size),
        Fmt.count(r.root.fileCount),
        Fmt.duration(r.duration),
        r.errors,
      ),
    );
    for (const c of CATEGORIES) {
      const b = bytes(r.root, c);
      if (b > 0) io.out(`  ${pad(categoryLabel(c), 34)} ${Fmt.bytes(b)}`);
    }
    io.out(t("cli.report.folders"));
    for (const n of r.root.children.slice(0, 15)) {
      io.out(
        `  ${pad(n.name, 22)} ${pad(Fmt.bytes(n.size), 10)} ${t("cli.report.of_regenerable", Fmt.bytes(regenerableBytes(n)))}`,
      );
    }
    io.out(t("cli.report.big_objects"));
    for (const o of big.slice(0, 10)) {
      const kind = t(o.kind === "file" ? "cli.report.kind_file" : "cli.report.kind_folder");
      io.out(`  ${pad(Fmt.bytes(o.size), 10)} ${kind} ${o.path}`);
    }
  }
  if (json) printJSON({ folders: reports, total }, io);
  else if (scans.length > 1) io.out(t("cli.report.total", Fmt.bytes(total)));
  return scans.some((s) => s.result !== null) ? Exit.ok : Exit.failure;
}
