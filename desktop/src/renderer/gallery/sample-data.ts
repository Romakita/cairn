// Données factices des stories : rien n'est lu sur le disque, rien n'appelle le preload.
import { ArrowDownToLine, Copy, FolderOpen, PlayCircle, RefreshCw, Trash2 } from "lucide-react";
import { Fmt } from "../../core/format.ts";
import { CATEGORIES, CATEGORY_KEYS, type CategoryKey, type MenuEntry, type PathSuggestion } from "../ui/index.ts";
import { s } from "./sample-text.ts";

const noop = () => undefined;

/** Menu « … » d'une destination : actions, une indisponible avec sa raison, la destructive en dernier. */
export function sampleMenu(): MenuEntry[] {
  return [
    { id: "backup", icon: PlayCircle, label: s("action.backup_now"), onSelect: noop },
    { id: "refresh", icon: RefreshCw, label: s("gallery.sample.refresh"), onSelect: noop },
    {
      id: "verify",
      icon: ArrowDownToLine,
      label: s("gallery.sample.verify"),
      disabledReason: s("gallery.sample.reason_no_backup"),
      onSelect: noop,
    },
    { id: "delete", icon: Trash2, label: s("action.delete"), destructive: true, onSelect: noop },
    { kind: "separator" },
    { id: "copy", icon: Copy, label: s("destination.copy_address"), onSelect: noop },
  ];
}

/** Menu d'une ligne de fichier. */
export function fileMenu(): MenuEntry[] {
  return [
    { id: "reveal", icon: FolderOpen, label: s("gallery.sample.reveal"), onSelect: noop },
    { id: "copy", icon: Copy, label: s("gallery.sample.copy_path"), onSelect: noop },
    { id: "trash", icon: Trash2, label: s("gallery.sample.trash"), destructive: true, onSelect: noop },
  ];
}

/** Répartition d'un dossier analysé fictif, en octets. */
export const SAMPLE_BREAKDOWN: Readonly<Record<CategoryKey, number>> = {
  source: 18_400_000_000,
  git: 9_100_000_000,
  deps: 31_600_000_000,
  build: 12_200_000_000,
  ios: 4_300_000_000,
  python: 2_700_000_000,
  cache: 6_900_000_000,
  trash: 800_000_000,
};
export const SAMPLE_TOTAL = Object.values(SAMPLE_BREAKDOWN).reduce((a, b) => a + b, 0);
export const SAMPLE_FILES = 412_380;

export function breakdownParts() {
  return CATEGORY_KEYS.map((key) => ({ key, value: SAMPLE_BREAKDOWN[key], color: CATEGORIES[key].color }));
}

export function breakdownItems() {
  return CATEGORY_KEYS.map((key) => ({
    key,
    label: s(`category.${key}.label`),
    value: SAMPLE_BREAKDOWN[key],
    valueLabel: Fmt.bytes(SAMPLE_BREAKDOWN[key]),
    color: CATEGORIES[key].color,
  }));
}

/** Arborescence fictive pour la complétion de `PathField`. */
const SAMPLE_PATHS: readonly PathSuggestion[] = [
  { path: "Desktop", isDirectory: true },
  { path: "Developer", isDirectory: true },
  { path: "Developer/cairn", isDirectory: true },
  { path: "Developer/notes.md", isDirectory: false },
  { path: "Documents", isDirectory: true },
  { path: "Downloads", isDirectory: true },
];

export function suggestPaths(text: string): readonly PathSuggestion[] {
  const query = text.toLowerCase();
  const depth = query.split("/").length;
  return SAMPLE_PATHS.filter(
    (p) =>
      p.path.toLowerCase().startsWith(query) && p.path.split("/").length === depth && p.path.toLowerCase() !== query,
  );
}

export interface SampleFile {
  name: string;
  path: string;
  size: number;
  kind: "file" | "folder";
}

export const SAMPLE_FILES_ROWS: readonly SampleFile[] = [
  { name: "DerivedData", path: "~/Library/Developer/Xcode", size: 24_600_000_000, kind: "folder" },
  { name: "node_modules", path: "~/workspaces/cairn/web", size: 1_820_000_000, kind: "folder" },
  { name: "backup-2024.sparsebundle", path: "~/Archives", size: 12_100_000_000, kind: "file" },
  { name: "recording.mov", path: "~/Movies", size: 3_400_000_000, kind: "file" },
];
