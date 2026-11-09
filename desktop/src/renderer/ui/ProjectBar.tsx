import { BreakdownBar } from "./BreakdownBar.tsx";

export interface ProjectBarProps {
  /** Tailles en octets : sources, historique git, régénérable, worktrees hors du dépôt. */
  sources: number;
  git: number;
  regenerable: number;
  externalWorktrees?: number;
  /** Taille du plus gros projet de la liste (toute la largeur). */
  scale: number;
  label?: string;
}

/** Barre d'un projet : sources, .git, régénérable, worktrees externes (couleurs de catégorie). */
export function ProjectBar({ sources, git, regenerable, externalWorktrees = 0, scale, label }: ProjectBarProps) {
  return (
    <BreakdownBar
      scale={scale}
      label={label}
      parts={[
        { key: "sources", value: sources, color: "var(--category-source)" },
        { key: "git", value: git, color: "var(--category-git)" },
        { key: "regenerable", value: regenerable, color: "var(--category-deps)" },
        { key: "worktrees", value: externalWorktrees, color: "var(--category-ios)" },
      ]}
    />
  );
}
