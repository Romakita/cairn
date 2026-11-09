// Rapport TSV (port de `GitMaintenance.tsv`, colonnes de l'ancien git-cleanup.sh) : une ligne par branche du rapport
// (« gone », ou fusionnée d'un worktree). `root` : chemin des dépôts rendu relatif à ce dossier ("" : absolus).
import type { RepoReport } from "./types.ts";

export const TSV_HEADER = "repo\tbranche\tstatut\tsha\tdernier_commit\tsujet\n";

export function tsv(reports: readonly RepoReport[], root: string): string {
  let out = TSV_HEADER;
  for (const r of reports) {
    const rel = root !== "" && r.path.startsWith(`${root}/`) ? r.path.slice(root.length + 1) : r.path;
    for (const b of r.branches) out += `${[rel, b.name, b.status, b.sha, b.date, b.subject].join("\t")}\n`;
  }
  return out;
}
