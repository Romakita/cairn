// Icône d'un élément du home (assistant, réglages) déduite de son nom : historique, clés, nuages, conteneurs…
import {
  Cloud,
  Container,
  File,
  Folder,
  GitBranch,
  History,
  KeyRound,
  type LucideIcon,
  Package,
  Settings,
  Terminal,
} from "lucide-react";

export function homeIcon(item: string): LucideIcon {
  const name = item.toLowerCase();
  if (name.includes("history")) return History;
  if (name.startsWith(".ssh") || name.includes("netrc") || name.includes("gnupg")) return KeyRound;
  if (name.startsWith(".aws") || name.includes("gcloud") || name.includes("azure")) return Cloud;
  if (name.startsWith(".docker") || name.includes("kube")) return Container;
  if (name.startsWith(".git")) return GitBranch;
  if (/^\.(zsh|bash|profile|zprofile|inputrc)/.test(name)) return Terminal;
  if (name.startsWith(".npm") || name.includes("yarn") || name.includes("cargo")) return Package;
  if (name.startsWith(".config")) return Settings;
  if (name.endsWith("/") || !name.includes(".")) return Folder;
  return File;
}
