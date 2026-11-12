// Inventaire des outils et outils IA dans l'app : relevés à la demande (lecture seule) et exports choisis par
// l'utilisateur (dossier ou fichier désigné par une boîte de dialogue du main, jamais par l'interface).
import path from "node:path";
import { dialog } from "electron";
import {
  aiJSON,
  allToolStats,
  credentialsBlockText,
  displayName,
  lastBackup,
  type ToolStats,
} from "../core/ai/index.ts";
import { offeredCategories } from "../core/ai/profiles.ts";
import { stat, writeFile } from "../core/fs-promises.ts";
import { collect, writeInventory } from "../core/inventory/index.ts";
import type { Inventory } from "../core/inventory/types.ts";
import { expandTilde } from "../core/paths.ts";
import type { AIToolView, AIView, InventoryView } from "../shared/contract.ts";
import { ApiError, errorMessage } from "./errors.ts";
import type { Host } from "./host.ts";

export class ToolsService {
  private inventory: InventoryView = { status: "idle", inventory: null, error: null };
  private stats: ToolStats[] = [];
  private lastBackups: Record<string, number | null> = {};
  private aiStatus: AIView["status"] = "idle";
  private aiError: string | null = null;

  constructor(private readonly host: Host) {}

  async refreshInventory(): Promise<void> {
    if (this.inventory.status === "loading") return;
    this.inventory = { ...this.inventory, status: "loading", error: null };
    this.host.changed();
    try {
      const inv = await collect(this.host.config());
      this.inventory = { status: "loaded", inventory: inv, error: null };
    } catch (error) {
      this.inventory = { ...this.inventory, status: "failed", error: errorMessage(error) };
    }
    this.host.changed();
  }

  /** Exporte `tools.toml` et `Brewfile` dans `target` (dossier existant) ou dans un dossier choisi. */
  async exportInventory(target?: string): Promise<{ dir: string } | null> {
    let dir = target ? expandTilde(target) : undefined;
    if (dir) {
      const isDir = await stat(dir).then(
        (s) => s.isDirectory(),
        () => false,
      );
      if (!isDir) throw new ApiError("notFound", dir);
    } else {
      const r = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
      dir = r.canceled ? undefined : r.filePaths[0];
    }
    if (!dir) return null;
    const inv: Inventory = this.inventory.inventory ?? (await collect(this.host.config()));
    await writeInventory(inv, dir);
    return { dir };
  }

  async refreshAI(runState: Parameters<typeof lastBackup>[2]): Promise<void> {
    if (this.aiStatus === "loading") return;
    this.aiStatus = "loading";
    this.aiError = null;
    this.host.changed();
    try {
      const config = this.host.config();
      this.stats = await allToolStats();
      const machine = await this.host.machine();
      for (const s of this.stats) {
        this.lastBackups[s.profile.id] =
          (await lastBackup(s.profile.id, config, runState, machine).catch(() => null))?.getTime() ?? null;
      }
      this.aiStatus = "loaded";
    } catch (error) {
      this.aiStatus = "failed";
      this.aiError = errorMessage(error);
    }
    this.host.changed();
  }

  /** Écrit le relevé IA (`cairn ai --json`) dans un fichier choisi. */
  async exportAI(): Promise<{ file: string } | null> {
    const r = await dialog.showSaveDialog({ defaultPath: path.join(process.env.HOME ?? "/", "cairn-ai.json") });
    if (r.canceled || !r.filePath) return null;
    await writeFile(r.filePath, aiJSON(this.stats, this.host.config()), "utf8");
    return { file: r.filePath };
  }

  get detectedCount(): number | null {
    return this.aiStatus === "loaded" ? this.stats.filter((s) => s.detected).length : null;
  }

  get aiLastBackup(): Date | null {
    const dates = Object.values(this.lastBackups).filter((d): d is number => d !== null);
    return dates.length > 0 ? new Date(Math.max(...dates)) : null;
  }

  inventoryView(): InventoryView {
    return this.inventory;
  }

  aiView(): AIView {
    const config = this.host.config();
    const tools: AIToolView[] = this.stats.map((s) => ({
      id: s.profile.id,
      name: displayName(s.profile),
      detected: s.detected,
      root: s.profile.root,
      offeredCategories: offeredCategories(s.profile),
      credentialsInKeychain: s.profile.credentials_in_keychain,
      exclude: s.profile.exclude,
      notCopiedBytes: s.notCopiedBytes,
      bytesByCategory: s.bytesByCategory,
      totalBytes: s.totalBytes,
      conversations: s.conversations,
      latestConversation: s.latestConversation?.getTime() ?? null,
      lastBackup: this.lastBackups[s.profile.id] ?? null,
      categories: config.ai.find((a) => a.id === s.profile.id)?.categories ?? [],
    }));
    return { status: this.aiStatus, tools, credentialsBlock: credentialsBlockText(config), error: this.aiError };
  }
}
