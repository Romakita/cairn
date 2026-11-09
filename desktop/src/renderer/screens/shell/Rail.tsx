import {
  ChartPie,
  CloudUpload,
  GitBranch,
  House,
  RotateCcw,
  SlidersHorizontal,
  Sparkles,
  Terminal,
} from "lucide-react";
import { t } from "../../../core/l10n.ts";
import type { NavigationRequest, Route } from "../../../shared/contract.ts";
import type { LucideIcon } from "../../ui/Icon.tsx";
import { RailButton } from "../../ui/RailButton.tsx";
import styles from "./Rail.module.css";

interface RailItem {
  route: Route;
  icon: LucideIcon;
  label: string;
  /** Routes qui sont des onglets de la même section. */
  also?: readonly Route[];
}

/** Sections du rail, dans l'ordre de la 0.8.0 ; Réglages en bas. */
export function railItems(): { top: RailItem[]; bottom: RailItem[] } {
  return {
    top: [
      { route: "home", icon: House, label: t("section.home") },
      { route: "storage", icon: ChartPie, label: t("section.analysis"), also: ["clean", "explorer"] },
      { route: "backup", icon: CloudUpload, label: t("section.backup") },
      { route: "ai", icon: Sparkles, label: t("section.ai") },
      { route: "tools", icon: Terminal, label: t("section.cli") },
      { route: "git", icon: GitBranch, label: t("section.git") },
      { route: "restore", icon: RotateCcw, label: t("section.restore") },
    ],
    bottom: [{ route: "settings", icon: SlidersHorizontal, label: t("section.settings") }],
  };
}

export function Rail({ route, navigate }: { route: Route; navigate: (request: NavigationRequest) => void }) {
  const { top, bottom } = railItems();
  const button = (item: RailItem) => (
    <RailButton
      key={item.route}
      icon={item.icon}
      label={item.label}
      selected={item.route === route || (item.also?.includes(route) ?? false)}
      onClick={() => navigate({ route: item.route })}
    />
  );
  return (
    <nav className={styles.rail} aria-label={t("shell.sections")}>
      <div className={styles.group}>{top.map(button)}</div>
      <div className={styles.group}>{bottom.map(button)}</div>
    </nav>
  );
}
