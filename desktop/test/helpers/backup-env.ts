// Outils des tests de sauvegarde : dossiers temporaires, fichiers de test, configuration et dépendances du service.
// Tout se passe dans des dossiers temporaires : jamais le vrai home, ~/.cairn, le Trousseau ni une vraie destination.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { regenerableRules } from "../../src/core/backup/defaults.ts";
import type { BackupServiceDependencies } from "../../src/core/backup/run.ts";
import { MemorySecrets } from "../../src/core/backup/secrets.ts";
import { dateOfVersion } from "../../src/core/backup/versions.ts";
import { type CairnConfig, type DestinationConfig, defaultConfig, destination, folder } from "../../src/core/config.ts";
import { CairnPaths } from "../../src/core/paths.ts";
import { keepVersions } from "../../src/core/retention.ts";

/** Dossier temporaire (chemin résolu : `/private/var/…`), supprimé après `work`. */
export async function withTempDir<T>(work: (dir: string) => Promise<T>): Promise<T> {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "cairn-backup-test-")));
  try {
    return await work(dir);
  } finally {
    try {
      execFileSync("/bin/chmod", ["-R", "u+rwx", dir], { stdio: "ignore" });
    } catch {
      // rien à rétablir
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Fichier de `size` octets nuls (dossiers parents créés). */
export function writeFile(file: string, size: number): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, Buffer.alloc(size));
}

/** Date d'un nom de version (`2026-11-01T120000`). */
export function at(name: string): Date {
  const d = dateOfVersion(name);
  if (!d) throw new Error(`bad version name ${name}`);
  return d;
}

/** `~/.cairn` de test dans `dir`. */
export function testPaths(dir: string): CairnPaths {
  return new CairnPaths(path.join(dir, ".cairn"));
}

/** Configuration : un dossier suivi `src` et des destinations locales en clair. */
export function testConfig(
  folders: readonly string[],
  destinations: ReadonlyArray<Partial<DestinationConfig> & { id: string }>,
): CairnConfig {
  const c = defaultConfig();
  c.folders = folders.map((f) => folder(f));
  c.destinations = destinations.map((d) => destination(d.id, d.provider ?? "local", { encrypted: false, ...d }));
  return c;
}

export interface TestDeps extends BackupServiceDependencies {
  secrets: MemorySecrets;
}

/** Dépendances du service pour les tests : machine « m », Trousseau en mémoire, home simulé, vraie rétention. */
export function testDeps(overrides: Partial<BackupServiceDependencies> = {}): TestDeps {
  return {
    regenerable: regenerableRules(),
    home: path.join(os.tmpdir(), "cairn-no-home"),
    machine: "m",
    secrets: new MemorySecrets(),
    retentionKeep: keepVersions,
    macos: async () => "Version 15.0 (Build 24A335)",
    imageSize: "200m",
    progressThrottleMs: 0,
    ...overrides,
  } as TestDeps;
}

/** `du -sk` en octets. */
export function du(p: string): number {
  const out = execFileSync("/usr/bin/du", ["-sk", p], { encoding: "utf8" });
  return Number(out.split("\t")[0]) * 1024;
}

/** Horloge réglable (noms de version et de journal distincts sans attendre). */
export class TestClock {
  constructor(public current: Date) {}
  now = (): Date => new Date(this.current.getTime());
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

/** Détache toutes les images montées sous `dir` (nettoyage garanti après un test qui a échoué). */
export function detachImagesUnder(dir: string): void {
  let out = "";
  try {
    out = execFileSync("/usr/bin/hdiutil", ["info"], { encoding: "utf8" });
  } catch {
    return;
  }
  const blocks = out.split("================================================");
  for (const b of blocks) {
    if (!b.includes(dir)) continue;
    for (const line of b.split("\n")) {
      const m = /^(\/dev\/disk\d+)\s/.exec(line);
      if (m) {
        try {
          execFileSync("/usr/bin/hdiutil", ["detach", "-force", m[1]!], { stdio: "ignore" });
        } catch {
          // déjà détachée
        }
        break;
      }
    }
  }
}
