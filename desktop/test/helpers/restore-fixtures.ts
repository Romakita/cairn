// Outils des tests de restauration : sauvegardes héritées (scripts/backup.sh) minimales, exécuteurs factices (rien
// n'est installé, ni Terminal ni diskutil lancés) et horloge simulée (attentes de 2 s à 1 h instantanées).
// Tout se passe dans des dossiers temporaires : jamais le vrai home ni le vrai ~/.cairn.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { CommandRunner } from "../../src/core/inventory/collector.ts";
import type { Clock } from "../../src/core/restore/system.ts";
import { writeFile } from "./backup-env.ts";

/** Fichier texte (dossiers parents créés). */
export function put(text: string, file: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/** Sauvegarde héritée de RestoreTests.swift : home, clés SSH, workspaces, Codex et listes d'outils. */
export function legacyBackup(dir: string): string {
  const bk = path.join(dir, "legacy");
  writeFile(path.join(bk, "home/.zshrc"), 120);
  writeFile(path.join(bk, "home/.ssh/id_ed25519"), 400);
  writeFile(path.join(bk, "home/.ssh/id_ed25519.pub"), 100);
  writeFile(path.join(bk, "workspaces/proj/a.txt"), 10);
  writeFile(path.join(bk, "home/.codex/config.toml"), 10);
  put(
    "date=2026-11-01 10:00:00\nhost=Old Mac\nuser=r\nhome=/Users/old\nworkspace=/Volumes/workspaces\narch=arm64\n",
    path.join(bk, "manifest/system.txt"),
  );
  put('tap "hashicorp/tap"\nbrew "gh"\nbrew "just"\n', path.join(bk, "manifest/Brewfile"));
  put("@openai/codex\n", path.join(bk, "manifest/npm-globals.txt"));
  put("ruff[lsp]|3.12\n", path.join(bk, "manifest/uv-tools.txt"));
  return bk;
}

/** Sauvegarde héritée de RestoreWarningTests.swift, avec des données des trois outils IA. */
export function legacyBackupWithAI(dir: string): string {
  const bk = path.join(dir, "legacy");
  writeFile(path.join(bk, "home/.zshrc"), 100);
  writeFile(path.join(bk, "home/.claude/projects/p/s.jsonl"), 200_000);
  writeFile(path.join(bk, "home/.codex/config.toml"), 50_000);
  writeFile(path.join(bk, "ai/claude-desktop/Claude/config.json"), 30_000);
  put("date=2026-11-01 10:00:00\nhost=Old Mac\nhome=/Users/old\narch=arm64\n", path.join(bk, "manifest/system.txt"));
  put('brew "gh"\n', path.join(bk, "manifest/Brewfile"));
  return bk;
}

/** Exécuteur factice qui note les commandes. */
export class FakeRunner {
  readonly commands: string[][] = [];

  constructor(private readonly respond: (command: readonly string[]) => number) {}

  readonly run: CommandRunner = async (command) => {
    this.commands.push([...command]);
    return { status: this.respond(command), output: "" };
  };
}

/** RestoreTests : `command -v` échoue (rien d'installé), npm échoue, le reste réussit. */
export function recordingRunner(): FakeRunner {
  return new FakeRunner((c) => (c[0] === "/bin/sh" ? 1 : c.includes("npm") ? 1 : 0));
}

/** RestoreWarningTests : `xcode-select -p` selon `cltInstalled`, `command -v` échoue, le reste réussit. */
export function cltRunner(cltInstalled: boolean): FakeRunner {
  return new FakeRunner((c) =>
    c[0] === "/usr/bin/xcode-select" ? (cltInstalled ? 0 : 2) : c[0] === "/bin/sh" ? 1 : 0,
  );
}

/** Horloge simulée : `sleep` avance le temps sans attendre. */
export class FakeClock implements Clock {
  readonly sleeps: number[] = [];
  constructor(public current = 0) {}
  now = (): number => this.current;
  sleep = async (ms: number): Promise<void> => {
    this.sleeps.push(ms);
    this.current += ms;
  };
}
