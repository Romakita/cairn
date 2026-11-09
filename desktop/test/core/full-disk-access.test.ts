// Accès complet au disque (spec `backup`, « Accès complet au disque ») : détection avec un lecteur injecté, lignes
// d'erreur de rsync (openrsync de macOS et rsync GNU), et vrais rsync sur des éléments illisibles (`chmod 000`).
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { BackupEngine } from "../../src/core/backup/engine.ts";
import { type BackupNotification, BackupService } from "../../src/core/backup/run.ts";
import { backupPart } from "../../src/core/backup/types.ts";
import { listVersions, versionsDir } from "../../src/core/backup/versions.ts";
import { RECOMMENDED_RETENTION } from "../../src/core/config.ts";
import {
  DeniedCounter,
  fullDiskAccess,
  MAX_DENIED_EXAMPLES,
  PROTECTED_PROBES,
  permissionDenied,
} from "../../src/core/full-disk-access.ts";
import { hubInputs, hubIssues } from "../../src/core/hub-state.ts";
import { configureLanguage } from "../../src/core/l10n.ts";
import { testConfig, testDeps, testPaths, withTempDir, writeFile } from "../helpers/backup-env.ts";
import { nativeAvailable } from "../helpers/native.ts";

const native = nativeAvailable();

function errno(code: string): Error {
  return Object.assign(new Error(code), { code });
}

/** Lecteur qui répond selon la fin du chemin lu, et garde la trace des lectures. */
function reader(answers: Record<string, "ok" | string>) {
  const read: string[] = [];
  const fn = async (dir: string) => {
    read.push(dir);
    const key = Object.keys(answers).find((k) => dir.endsWith(k));
    const a = key ? answers[key] : "ENOENT";
    if (a !== "ok") throw errno(a ?? "ENOENT");
    return [];
  };
  return { fn, read };
}

describe("accès complet au disque", () => {
  test("détection : refusé, accordé, inconnu", async () => {
    const tcc = PROTECTED_PROBES[0];
    const safari = PROTECTED_PROBES[1];
    const denied = reader({ [tcc]: "EPERM" });
    expect(await fullDiskAccess("/Users/x", denied.fn)).toBe("denied");
    expect(denied.read).toEqual(["/Users/x/Library/Application Support/com.apple.TCC"]);
    expect(await fullDiskAccess("/Users/x", reader({ [tcc]: "EACCES" }).fn)).toBe("denied");
    expect(await fullDiskAccess("/Users/x", reader({ [tcc]: "ok" }).fn)).toBe("granted");
    // Base TCC absente : Safari décide.
    expect(await fullDiskAccess("/Users/x", reader({ [safari]: "ok" }).fn)).toBe("granted");
    expect(await fullDiskAccess("/Users/x", reader({ [safari]: "EPERM" }).fn)).toBe("denied");
    const none = reader({});
    expect(await fullDiskAccess("/Users/x", none.fn)).toBe("unknown");
    expect(none.read).toHaveLength(2);
    expect(await fullDiskAccess("/Users/x", reader({ [tcc]: "ENOTDIR", [safari]: "EIO" }).fn)).toBe("unknown");
  });

  test("lignes d'openrsync (macOS) : dossier et fichier refusés", () => {
    expect(
      permissionDenied("rsync(92174): warning: /Users/x/Documents: unreadable directory: Operation not permitted"),
    ).toBe("/Users/x/Documents");
    expect(
      permissionDenied(
        "rsync(92178): error: /Users/x/Library/Preferences/com.apple.madrid.plist: open (2) in /Users/x: Operation not permitted",
      ),
    ).toBe("/Users/x/Library/Preferences/com.apple.madrid.plist");
    // Droits du fichier (EACCES) : compté pareil, l'élément n'a pas été lu.
    expect(permissionDenied("rsync(44661): warning: /tmp/src/d: unreadable directory: Permission denied")).toBe(
      "/tmp/src/d",
    );
    expect(permissionDenied("rsync(44661): error: /tmp/src/secret: open (2) in /tmp: Permission denied")).toBe(
      "/tmp/src/secret",
    );
  });

  test("lignes de rsync GNU : opendir et send_files", () => {
    expect(permissionDenied('rsync: opendir "/Users/x/Documents" failed: Operation not permitted (1)')).toBe(
      "/Users/x/Documents",
    );
    expect(
      permissionDenied('rsync: send_files failed to open "/Users/x/Library/Mail/a.emlx": Operation not permitted (1)'),
    ).toBe("/Users/x/Library/Mail/a.emlx");
    expect(permissionDenied('rsync: [sender] opendir "/Users/x/Downloads" failed: Permission denied (13)')).toBe(
      "/Users/x/Downloads",
    );
    expect(
      permissionDenied('rsync: [sender] send_files failed to open "/Users/x/a b.txt": Permission denied (13)'),
    ).toBe("/Users/x/a b.txt");
  });

  test("les autres lignes ne sont pas des refus", () => {
    for (const line of [
      "rsync error: some files/attrs were not transferred (see previous errors) (code 23) at main.c(1338) [sender=3.2.7]",
      'file has vanished: "/Users/x/tmp.lock"',
      'rsync: [receiver] mkstemp "/dest/.a.XYZ" failed: No space left on device (28)',
      "rsync(1): error: /Users/x/a: open (2) in /Users/x: No such file or directory",
      ">f+++++++|Documents/a.txt",
      "",
    ])
      expect(permissionDenied(line)).toBeNull();
  });

  test("compteur : tout est compté, dix chemins gardés", () => {
    const c = new DeniedCounter();
    for (let i = 0; i < 25; i++) c.add(`/p/${i}`);
    c.merge({ count: 3, examples: ["/q/0"] });
    const v = c.value();
    expect(v.count).toBe(28);
    expect(v.examples).toHaveLength(MAX_DENIED_EXAMPLES);
    expect(v.examples[0]).toBe("/p/0");
  });

  test("hub : problème quand la sauvegarde est configurée et l'accès refusé, juste après l'échec", () => {
    const d = { id: "nas", label: "nas.local", state: { lastError: "boom", lastFailure: new Date() }, waiting: false };
    expect(hubIssues(hubInputs({ fullDiskAccess: "denied" }))).toEqual([]);
    expect(hubIssues(hubInputs({ fullDiskAccess: "unknown", destinations: [d] })).map((i) => i.kind)).toEqual([
      "backupFailed",
    ]);
    const issues = hubIssues(
      hubInputs({
        fullDiskAccess: "denied",
        destinations: [d],
        configErrors: ["line 1"],
        volumeAlerts: [{ volume: "v", level: 2, available: 1 }],
      }),
    );
    expect(issues.map((i) => i.kind)).toEqual(["configInvalid", "backupFailed", "fullDiskAccess", "diskCritical"]);
  });

  test("vrai rsync : dossier et fichier illisibles comptés, la version est faite avec l'avertissement", async () => {
    await withTempDir(async (dir) => {
      const src = path.join(dir, "src");
      writeFile(path.join(src, "ok.bin"), 10);
      writeFile(path.join(src, "docs/a.bin"), 10);
      writeFile(path.join(src, "private/b.bin"), 10);
      const secret = path.join(src, "docs/secret.bin");
      writeFile(secret, 10);
      const locked = path.join(src, "private");
      chmodSync(secret, 0);
      chmodSync(locked, 0);
      try {
        const engine = new BackupEngine({ macos: async () => "Version 15.0" });
        const dest = path.join(dir, "dest");
        const r = await engine.run({
          parts: [backupPart("folder", "folders/src", src)],
          root: dest,
          retention: RECOMMENDED_RETENTION,
          dryRun: false,
          machine: "m",
        });
        expect(r.version).not.toBeNull();
        expect(r.permissionDenied.count).toBe(2);
        expect([...r.permissionDenied.examples].sort()).toEqual([locked, secret].sort());
        // Le transfert partiel est entièrement expliqué par les refus : pas d'avertissement générique en double.
        expect(r.warnings).toEqual([]);
        const version = path.join(versionsDir(dest, "m"), r.version!, "folders/src");
        expect(existsSync(path.join(version, "ok.bin"))).toBe(true);
        expect(existsSync(path.join(version, "docs/a.bin"))).toBe(true);
        expect(existsSync(path.join(version, "docs/secret.bin"))).toBe(false);
      } finally {
        chmodSync(locked, 0o755);
        chmodSync(secret, 0o600);
      }
    });
  }, 30_000);

  test.skipIf(!native)(
    "service : résultat, ligne du journal et notification",
    async () => {
      configureLanguage("en-US");
      await withTempDir(async (dir) => {
        const src = path.join(dir, "src");
        writeFile(path.join(src, "ok.bin"), 10);
        const locked = path.join(src, "Documents");
        writeFile(path.join(locked, "a.bin"), 10);
        chmodSync(locked, 0);
        try {
          const dest = path.join(dir, "dest");
          const config = testConfig([src], [{ id: "disk", path: dest }]);
          const service = new BackupService(testPaths(dir), config, testDeps());
          const notes: BackupNotification[] = [];
          service.on((e) => {
            if (e.type === "notification") notes.push(e.notification);
          });
          const [r] = await service.run({ only: ["folder"] });
          expect(r?.error).toBeNull();
          expect(r?.permissionDenied).toEqual({ count: 1, examples: [locked] });
          expect(await listVersions(versionsDir(dest, "m"))).toHaveLength(1);
          const summary = service.progress().find((p) => p.destination === "disk")?.result;
          expect(summary?.status).toBe("succeeded");
          expect(summary?.permissionDenied.count).toBe(1);
          const note = notes.find((n) => n.kind === "permissionDenied");
          expect(note?.title).toBe("Some items weren't backed up to disk");
          expect(note?.body).toContain("macOS denied access to 1 item");
          expect(note?.log).toBe(r!.log);
          const log = readFileSync(r!.log!, "utf8");
          expect(log).toContain("disk: permission denied by macOS for 1 item(s), not backed up (Full Disk Access)");
          expect(log).toContain(locked);
          // Une simulation compte aussi, sans notification.
          notes.length = 0;
          const [dry] = await service.run({ only: ["folder"], dryRun: true });
          expect(dry?.permissionDenied.count).toBe(1);
          expect(notes.filter((n) => n.kind === "permissionDenied")).toEqual([]);
        } finally {
          chmodSync(locked, 0o755);
        }
      });
    },
    60_000,
  );
});
