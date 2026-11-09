// Fournisseurs, image, rsync et formats sur disque de la sauvegarde : arguments exacts des processus (parity/platform.md
// §2.1), montage SMB (réutilisé, jamais démonté s'il n'est pas à Cairn), `runs.json` et manifest au format de la 0.8.0.
import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import {
  generateImagePassword,
  type HdiutilRunner,
  IMAGE_PASSWORD_PATTERN,
  SparseImage,
} from "../../src/core/backup/image.ts";
import { manifestJSON } from "../../src/core/backup/manifest.ts";
import {
  findSMBMount,
  LocalProvider,
  parseMountTable,
  parseSMBURL,
  SMBProvider,
  tcpReachable,
} from "../../src/core/backup/providers.ts";
import { isPartialTransfer, parseOutLine, rsyncArgs, worstStatus } from "../../src/core/backup/rsync.ts";
import { decodeRunState, emptyDestinationState, encodeRunState } from "../../src/core/backup/run-state.ts";
import { MemorySecrets } from "../../src/core/backup/secrets.ts";
import { DestinationSession } from "../../src/core/backup/session.ts";
import { backupPart, type ProviderError } from "../../src/core/backup/types.ts";
import { dateOfVersion, versionName } from "../../src/core/backup/versions.ts";
import { destination, RECOMMENDED_RETENTION } from "../../src/core/config.ts";
import { withTempDir } from "../helpers/backup-env.ts";

const PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>system-entities</key><array>
<dict><key>dev-entry</key><string>/dev/disk9</string></dict>
<dict><key>dev-entry</key><string>/dev/disk9s1</string><key>mount-point</key><string>/Volumes/Cairn 1</string></dict>
</array></dict></plist>`;

/** hdiutil simulé : enregistre les arguments et l'entrée standard. */
function fakeHdiutil(
  reply: (args: readonly string[]) => { code: number; output: string } = () => ({ code: 0, output: "" }),
) {
  const calls: Array<{ args: readonly string[]; stdin?: string }> = [];
  const runner: HdiutilRunner = async (args, stdin) => {
    calls.push({ args, stdin });
    return reply(args);
  };
  return { calls, runner };
}

describe("backup-providers", () => {
  describe("rsync", () => {
    test("arguments exacts, dans l'ordre de la 0.8.0", () => {
      const openrsync = { path: "/usr/bin/rsync", gnu: false };
      expect(
        rsyncArgs(
          openrsync,
          {
            source: "/src",
            dest: "/d/.incomplete-x/folders/src",
            linkDest: "/d/v1/folders/src",
            dryRun: false,
            filters: ["--include=/a", "--include=/a/**", "--exclude=*"],
            deleteExcluded: false,
          },
          { excludeFrom: "/tmp/c/exclude.txt" },
        ),
      ).toEqual([
        "-a",
        "--out-format=%i|%n",
        "--partial-dir=.cairn-partial",
        "--delete",
        "--exclude-from=/tmp/c/exclude.txt",
        "--include=/a",
        "--include=/a/**",
        "--exclude=*",
        "--link-dest=/d/v1/folders/src",
        "/src/",
        "/d/.incomplete-x/folders/src/",
      ]);
      // GNU rsync : -H en 2e position ; partie entière avec --delete-excluded ; simulation ; liste de fichiers.
      expect(
        rsyncArgs(
          { path: "/opt/homebrew/bin/rsync", gnu: true },
          {
            source: "/Users/me/",
            dest: "/d/home",
            linkDest: null,
            dryRun: true,
            extraArgs: ["--existing", "--ignore-existing"],
          },
          { excludeFrom: "/t/exclude.txt", filesFrom: "/t/files.txt" },
        ),
      ).toEqual([
        "-a",
        "-H",
        "--out-format=%i|%n",
        "--partial-dir=.cairn-partial",
        "--delete",
        "--delete-excluded",
        "-n",
        "--exclude-from=/t/exclude.txt",
        "--existing",
        "--ignore-existing",
        "-r",
        "--files-from=/t/files.txt",
        "/Users/me/",
        "/d/home/",
      ]);
    });

    test("lecture de --out-format=%i|%n : fichiers copiés, liés, dossiers ignorés", () => {
      expect(parseOutLine(">f+++++++++|a/b.txt")).toEqual({ name: "a/b.txt", transferred: true });
      expect(parseOutLine("<f.st......|x")).toEqual({ name: "x", transferred: true });
      expect(parseOutLine("hf          |linked|with bar")).toEqual({ name: "linked|with bar", transferred: false });
      expect(parseOutLine("cd+++++++++|dir/")).toBeNull();
      expect(parseOutLine("*deleting   old")).toBeNull();
      expect(parseOutLine("no bar")).toBeNull();
    });

    test("codes 23 et 24 : avertissement ; le code le plus grave l'emporte", () => {
      expect(isPartialTransfer(23)).toBe(true);
      expect(isPartialTransfer(24)).toBe(true);
      expect(isPartialTransfer(12)).toBe(false);
      expect(worstStatus(0, 23)).toBe(23);
      expect(worstStatus(23, 12)).toBe(12);
      expect(worstStatus(12, 23)).toBe(12);
      expect(worstStatus(24, 0)).toBe(24);
    });
  });

  describe("local", () => {
    test("joignable si le volume est monté (le dossier peut manquer) ou si le parent existe", async () => {
      await withTempDir(async (dir) => {
        const d = (p: string) => destination("x", "local", { path: p, encrypted: false });
        expect(await new LocalProvider(d(path.join(dir, "dest"))).isReachable()).toBe(true);
        expect(await new LocalProvider(d(path.join(dir, "absent/dest"))).isReachable()).toBe(false);
        expect(await new LocalProvider(d("/Volumes/cairn-absent-volume/a/b")).isReachable()).toBe(false);
        expect(await new LocalProvider(d("")).isReachable()).toBe(false);
        const p = new LocalProvider(d(path.join(dir, "dest")));
        const error = await p.prepare(false).catch((e: unknown) => e);
        expect((error as ProviderError).reason).toBe("notCreated"); // simulation : rien n'est créé
        expect(await p.prepare(true)).toBe(path.join(dir, "dest"));
      });
    });
  });

  describe("smb", () => {
    test("adresse, table des montages et partage déjà monté", () => {
      expect(parseSMBURL("smb://NAS.local/home/Backups/Cairn%20Mac")).toEqual({
        host: "NAS.local",
        port: 445,
        share: "home",
        sub: "Backups/Cairn Mac",
      });
      expect(parseSMBURL("smb://syno:1445/share")?.port).toBe(1445);
      expect(parseSMBURL("pas une url")).toBeNull();
      const table = parseMountTable(
        [
          "/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)",
          "//romain@NAS._smb._tcp.local/Home on /Volumes/Home 1 (smbfs, nodev, nosuid, mounted by romain)",
          "map auto_home on /System/Volumes/Data/home (autofs, automounted, nobrowse)",
        ].join("\n"),
      );
      expect(table[1]).toEqual({ from: "//romain@NAS._smb._tcp.local/Home", on: "/Volumes/Home 1", type: "smbfs" });
      const address = parseSMBURL("smb://nas._smb._tcp.local/home/cairn")!;
      expect(findSMBMount(table, address)).toBe("/Volumes/Home 1"); // minuscules des deux côtés
      expect(findSMBMount(table, parseSMBURL("smb://other/home")!)).toBeNull();
      expect(findSMBMount(table, parseSMBURL("smb://nas._smb._tcp.local/media")!)).toBeNull();
    });

    test("partage déjà monté : réutilisé, jamais démonté", async () => {
      await withTempDir(async (dir) => {
        const unmounted: string[] = [];
        const mounted: string[] = [];
        const p = new SMBProvider(destination("nas", "smb", { url: "smb://nas/home/cairn" }), {
          secrets: new MemorySecrets(),
          reachable: async () => true,
          mountTable: async () => [{ from: "//me@nas/home", on: dir, type: "smbfs" }],
          mount: async (url) => {
            mounted.push(url);
            return { mountPoint: "/never" };
          },
          unmount: async (m) => {
            unmounted.push(m);
          },
        });
        expect(await p.prepare(true)).toBe(path.join(dir, "cairn"));
        await p.finish();
        expect(mounted).toEqual([]);
        expect(unmounted).toEqual([]);
      });
    });

    test("montage NetFS avec le mot de passe du Trousseau, démonté à la fin ; erreurs", async () => {
      const secrets = new MemorySecrets();
      const d = destination("nas", "smb", { url: "smb://nas.local/My%20Share/sub", username: "romain" });
      const calls: Array<[string, string, string | null]> = [];
      const unmounted: string[] = [];
      const deps = {
        secrets,
        reachable: async () => true,
        mountTable: async () => [],
        mount: async (url: string, user: string, password: string | null) => {
          calls.push([url, user, password]);
          return { mountPoint: "/Volumes/My Share" };
        },
        unmount: async (m: string) => {
          unmounted.push(m);
        },
      };
      const missing = await new SMBProvider(d, deps).prepare(true).catch((e: unknown) => e);
      expect((missing as ProviderError).reason).toBe("missingPassword");
      secrets.internet.set("nas.local|romain", "s3cret");
      const p = new SMBProvider(d, deps);
      expect(await p.prepare(true)).toBe("/Volumes/My Share/sub");
      expect(calls).toEqual([["smb://nas.local/My%20Share", "romain", "s3cret"]]);
      await p.finish();
      expect(unmounted).toEqual(["/Volumes/My Share"]);
      // Code NetFS rendu dans l'erreur.
      const failing = new SMBProvider(d, {
        ...deps,
        mount: async () => {
          throw Object.assign(new Error("auth"), { code: -5045 });
        },
      });
      const error = await failing.prepare(true).catch((e: unknown) => e);
      expect((error as ProviderError).reason).toBe("mountFailed");
      expect((error as ProviderError).code).toBe(-5045);
      // Injoignable.
      const down = new SMBProvider(d, { ...deps, reachable: async () => false });
      expect(((await down.prepare(true).catch((e: unknown) => e)) as ProviderError).reason).toBe("unreachable");
    });

    test("joignabilité TCP en moins de 3 s", async () => {
      const server = createServer((s) => s.destroy());
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
      const port = (server.address() as { port: number }).port;
      try {
        expect(await tcpReachable("127.0.0.1", port, 3000)).toBe(true);
      } finally {
        server.close();
      }
      expect(await tcpReachable("127.0.0.1", port, 3000)).toBe(false); // refusé
      const start = Date.now();
      expect(await tcpReachable("10.255.255.1", 445, 300)).toBe(false); // sans réponse : délai
      expect(Date.now() - start).toBeLessThan(2000);
    });

    test("une destination SMB passe toujours par une image (même sans chiffrement)", async () => {
      await withTempDir(async (dir) => {
        const fake = fakeHdiutil((args) =>
          args[0] === "attach" ? { code: 0, output: PLIST } : { code: 0, output: "" },
        );
        const session = new DestinationSession(destination("nas", "smb", { url: "smb://nas/home", encrypted: false }), {
          secrets: new MemorySecrets(),
          machine: "Mac",
          reachable: async () => true,
          mountTable: async () => [{ from: "//me@nas/home", on: dir, type: "smbfs" }],
          hdiutil: fake.runner,
        });
        expect(session.usesImage).toBe(true);
        expect(await session.open(true)).toBe("/Volumes/Cairn 1");
        expect(fake.calls[0]!.args).toEqual([
          "create",
          "-size",
          "4t",
          "-type",
          "SPARSEBUNDLE",
          "-fs",
          "APFS",
          "-volname",
          "Cairn",
          path.join(dir, "cairn-Mac.sparsebundle"),
        ]);
        expect(fake.calls[1]!.args).toEqual([
          "attach",
          "-nobrowse",
          "-noautoopen",
          "-plist",
          path.join(dir, "cairn-Mac.sparsebundle"),
        ]);
        expect(session.newImagePassword).toBeNull(); // image en clair : pas de mot de passe
        await session.close(true);
        expect(fake.calls.slice(2).map((c) => c.args)).toEqual([
          ["detach", "/Volumes/Cairn 1"],
          ["compact", "-batteryallowed", path.join(dir, "cairn-Mac.sparsebundle")],
        ]);
      });
    });
  });

  describe("image", () => {
    test("mot de passe sur stdin seulement, jamais en argument ; rangé au Trousseau avant la création", async () => {
      await withTempDir(async (dir) => {
        const secrets = new MemorySecrets();
        const fake = fakeHdiutil((args) =>
          args.includes("attach") ? { code: 0, output: PLIST } : { code: 0, output: "" },
        );
        const img = SparseImage.forMachine(dir, "main", true, "Mac", { secrets, hdiutil: fake.runner });
        const pw = (await img.create())!;
        expect(pw).toMatch(IMAGE_PASSWORD_PATTERN);
        expect(await secrets.imagePassword("main", "Mac")).toBe(pw);
        expect(fake.calls[0]!.args.slice(-3)).toEqual(["-encryption", "AES-256", "-stdinpass"]);
        expect(fake.calls[0]!.stdin).toBe(pw);
        await img.attach();
        expect(fake.calls[1]!.args).toEqual(["attach", "-stdinpass", "-nobrowse", "-noautoopen", "-plist", img.path]);
        await img.verify();
        expect(fake.calls[2]!.args).toEqual(["verify", "-stdinpass", img.path]);
        await img.compact();
        expect(fake.calls[3]!.args).toEqual(["compact", "-batteryallowed", img.path, "-stdinpass"]);
        for (const c of fake.calls) expect(c.args.join(" ")).not.toContain(pw);
        expect(fake.calls.every((c) => c.stdin === pw)).toBe(true);
      });
    });

    test("détachement : detach, sinon detach -force ; « has no checksum » est une réussite", async () => {
      const fake = fakeHdiutil((args) =>
        args[0] === "attach"
          ? { code: 0, output: PLIST }
          : args[0] === "detach" && args[1] !== "-force"
            ? { code: 16, output: "busy" }
            : args[0] === "verify"
              ? { code: 1, output: 'hdiutil: verify: checksum of "x" failed: image has no checksum' }
              : { code: 0, output: "" },
      );
      const img = SparseImage.forMachine("/d", "main", false, "Mac", {
        secrets: new MemorySecrets(),
        hdiutil: fake.runner,
      });
      await img.attach();
      await img.detach();
      expect(fake.calls.slice(1).map((c) => c.args)).toEqual([
        ["detach", "/Volumes/Cairn 1"],
        ["detach", "-force", "/Volumes/Cairn 1"],
      ]);
      expect((await img.verify()).ok).toBe(true);
    });

    test("format du mot de passe d'une nouvelle image", () => {
      for (let i = 0; i < 200; i++) {
        const pw = generateImagePassword();
        expect(pw).toMatch(IMAGE_PASSWORD_PATTERN);
        expect(pw).not.toMatch(/[0O1lI]/);
      }
    });

    test("image chiffrée sans mot de passe : demandé, rien n'est créé", async () => {
      await withTempDir(async (dir) => {
        mkdirSync(path.join(dir, "cairn-Old.sparsebundle"));
        const fake = fakeHdiutil((args) => ({ code: 0, output: args[0] === "isencrypted" ? "encrypted: YES" : "" }));
        const session = new DestinationSession(
          { id: "main", provider: "local", path: dir, encrypted: true, retention: RECOMMENDED_RETENTION },
          { secrets: new MemorySecrets(), machine: "New", hdiutil: fake.runner },
        );
        const error = await session.open(false).catch((e: unknown) => e);
        expect((error as ProviderError).reason).toBe("missingImagePassword");
        expect(fake.calls.some((c) => c.args[0] === "create")).toBe(false);
      });
    });
  });

  describe("formats", () => {
    test("runs.json octet pour octet comme JSONEncoder (.iso8601, .prettyPrinted, .sortedKeys)", () => {
      const ds = emptyDestinationState();
      ds.lastSuccess = new Date("2026-11-08T11:00:05.789Z"); // millisecondes tronquées
      ds.lastAttempt = new Date("2026-11-08T10:59:00Z");
      ds.lastBytesTransferred = 1234;
      ds.lastDuration = 61.5;
      ds.fileCounts = { "folders/src": 30, home: 2 };
      ds.keptLogs = ["backup-20261108-110000.log"];
      ds.damagedVersions = [];
      const text = encodeRunState({
        destinations: { main: ds, nas: { ...emptyDestinationState(), lastImageCheckOK: false } },
      });
      expect(text).toBe(
        [
          "{",
          '  "destinations" : {',
          '    "main" : {',
          '      "damagedVersions" : [',
          "",
          "      ],",
          '      "fileCounts" : {',
          '        "folders\\/src" : 30,',
          '        "home" : 2',
          "      },",
          '      "keptLogs" : [',
          '        "backup-20261108-110000.log"',
          "      ],",
          '      "lastAttempt" : "2026-11-08T10:59:00Z",',
          '      "lastBytesTransferred" : 1234,',
          '      "lastDuration" : 61.5,',
          '      "lastSuccess" : "2026-11-08T11:00:05Z"',
          "    },",
          '    "nas" : {',
          '      "damagedVersions" : [',
          "",
          "      ],",
          '      "lastBytesTransferred" : 0,',
          '      "lastDuration" : 0,',
          '      "lastImageCheckOK" : false',
          "    }",
          "  }",
          "}",
        ].join("\n"),
      );
      const back = decodeRunState(text);
      expect(back.destinations.main!.lastSuccess!.toISOString()).toBe("2026-11-08T11:00:05.000Z");
      expect(back.destinations.main!.fileCounts).toEqual({ "folders/src": 30, home: 2 });
      expect(back.destinations.nas!.lastImageCheckOK).toBe(false);
      // Fichier écrit par la 0.8.0 (champs inconnus, dates sans fraction) : relu ; un champ illisible est ignoré seul.
      const swift = decodeRunState(
        '{"destinations":{"d":{"damagedVersions":["2026-01-01T000000"],"lastBytesTransferred":5,"lastDuration":1.25,' +
          '"lastFailure":"2026-02-03T04:05:06Z","lastSuccess":"pas une date","future":1}}}',
      );
      expect(swift.destinations.d).toEqual({
        damagedVersions: ["2026-01-01T000000"],
        lastBytesTransferred: 5,
        lastDuration: 1.25,
        lastFailure: new Date("2026-02-03T04:05:06Z"),
      });
      expect(decodeRunState("pas du json")).toEqual({ destinations: {} });
    });

    test("manifest.json : champs et format de la 0.8.0", () => {
      const json = manifestJSON({
        extra: { cairn: "0.9.0", destination: "main", config_version: 1, log: "backup-20261108-120000.log" },
        date: new Date("2026-11-08T11:00:00.500Z"),
        machine: "Mac-de-Romain",
        macos: "Version 15.1 (Build 24B83)",
        parts: [
          backupPart("folder", "folders/src", "/Users/me/src", { excludes: ["x"] }),
          backupPart("home", "home", "/Users/me"),
        ],
        bytesTransferred: 42,
        partial: false,
      });
      const m = JSON.parse(json);
      expect(Object.keys(m)).toEqual([
        "arch",
        "bytes_transferred",
        "cairn",
        "config_version",
        "date",
        "destination",
        "format",
        "log",
        "machine",
        "macos",
        "partial",
        "parts",
      ]);
      expect(m.format).toBe(1);
      expect(m.date).toBe("2026-11-08T11:00:00Z");
      expect(m.parts).toEqual([
        { kind: "folder", source: "/Users/me/src", target: "folders/src" },
        { kind: "home", source: "/Users/me", target: "home" },
      ]);
      expect(json).toContain('"source" : "\\/Users\\/me\\/src"'); // `/` échappé comme Foundation
    });

    test("noms de version : heure locale, refus des dates impossibles", () => {
      const d = new Date(2026, 10, 8, 9, 5, 7);
      expect(versionName(d)).toBe("2026-11-08T090507");
      expect(dateOfVersion("2026-11-08T090507")?.getTime()).toBe(d.getTime());
      expect(dateOfVersion("2026-13-01T000000")).toBeNull();
      expect(dateOfVersion("2026-02-30T000000")).toBeNull();
      expect(dateOfVersion("latest")).toBeNull();
      expect(dateOfVersion(".incomplete-2026-11-08T090507")).toBeNull();
    });
  });
});
