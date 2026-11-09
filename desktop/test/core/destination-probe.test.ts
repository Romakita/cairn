// Vérification et parcours d'une destination (port de DestinationProbeTests.swift), plus la session SMB avec un
// montage simulé (pas de NAS en test) : rien n'est monté ni écrit dans le Trousseau.
import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, realpath, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { MountEntry } from "../../src/core/backup/providers.ts";
import { MemorySecrets } from "../../src/core/backup/secrets.ts";
import { newDestinationID } from "../../src/core/destinations/edit.ts";
import {
  checkFolder,
  createFolder,
  failureForMountStatus,
  listFolders,
  localRoots,
  parseShares,
  smbAddress,
  smbHostOf,
  smbParts,
  WRITE_TEST_PREFIX,
} from "../../src/core/destinations/probe.ts";
import { ProbeSession, smbShareProvider } from "../../src/core/destinations/session.ts";

async function withTempDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "cairn-probe-")));
  await body(dir);
}

async function names(dir: string): Promise<string[]> {
  return (await readdir(dir)).sort();
}

async function writeSized(file: string, size: number): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, Buffer.alloc(size, 1));
}

const uuid = () => crypto.randomUUID().toUpperCase();

/** Montage simulé : un dossier temporaire tient lieu de partage. */
function fakeSMB(mountPoint: string, options: { existing?: MountEntry[]; failCode?: number } = {}) {
  const secrets = new MemorySecrets();
  const calls = { mount: [] as Array<{ url: string; user: string; password: string | null }>, unmount: [] as string[] };
  const deps = {
    secrets,
    reachable: async () => true,
    mountTable: async () => options.existing ?? [],
    mount: async (url: string, user: string, password: string | null) => {
      calls.mount.push({ url, user, password });
      if (options.failCode !== undefined) throw Object.assign(new Error("mount"), { code: options.failCode });
      return { mountPoint };
    },
    unmount: async (mp: string) => void calls.unmount.push(mp),
  };
  return { secrets, calls, deps };
}

describe("destination-probe", () => {
  // MARK: Vérification d'un dossier local

  test("local_check_succeeds_and_leaves_no_trace", async () => {
    await withTempDir(async (dir) => {
      await writeSized(path.join(dir, "existant.txt"), 3);
      const r = await checkFolder(dir, "Ce-Mac");
      expect(r.kind).toBe("ok");
      if (r.kind !== "ok") return;
      expect(r.freeBytes ?? 0).toBeGreaterThan(0);
      expect(r.existingImages).toEqual([]);
      expect(await names(dir)).toEqual(["existant.txt"]); // le fichier témoin doit être supprimé
    });
  });

  test("local_check_missing_folder", async () => {
    await withTempDir(async (dir) => {
      const missing = path.join(dir, "absent");
      expect(await checkFolder(missing, "Ce-Mac")).toEqual({
        kind: "failed",
        failure: { kind: "notFound", path: missing },
      });
      expect(await stat(missing).catch(() => null)).toBeNull(); // la vérification ne crée rien
    });
  });

  test("local_check_missing_volume", async () => {
    const r = await checkFolder(`/Volumes/cairn-absent-${uuid()}/Sauvegardes`, "Ce-Mac");
    expect(r.kind === "failed" && r.failure.kind).toBe("volumeMissing");
  });

  test("local_check_read_only_folder", async () => {
    await withTempDir(async (dir) => {
      const ro = path.join(dir, "lecture-seule");
      await mkdir(ro);
      await chmod(ro, 0o555);
      try {
        expect(await checkFolder(ro, "Ce-Mac")).toEqual({ kind: "failed", failure: { kind: "readOnly", path: ro } });
      } finally {
        await chmod(ro, 0o755);
      }
    });
  });

  test("stale_write_test_files_are_removed", async () => {
    await withTempDir(async (dir) => {
      await writeFile(path.join(dir, WRITE_TEST_PREFIX + uuid()), "cairn");
      await writeSized(path.join(dir, ".autre-fichier-cache"), 1);
      await checkFolder(dir, "Ce-Mac");
      expect(await names(dir)).toEqual([".autre-fichier-cache"]);
    });
  });

  test("stale_cleanup_never_touches_user_entries", async () => {
    await withTempDir(async (dir) => {
      const p = WRITE_TEST_PREFIX;
      // Dossier au nom de témoin, avec du contenu : ne doit jamais être supprimé.
      const folder = path.join(dir, p + uuid());
      await writeSized(path.join(folder, "photo.jpg"), 5);
      // Nom sans UUID, ou contenu différent du témoin : fichiers de l'utilisateur.
      await writeFile(path.join(dir, `${p}archives`), "cairn");
      await writeFile(path.join(dir, p + uuid()), "autre");
      // Lien au nom de témoin vers un fichier au contenu du témoin : un lien n'est jamais suivi.
      await writeFile(path.join(dir, "cible"), "cairn");
      await symlink(path.join(dir, "cible"), path.join(dir, p + uuid()));
      const before = await names(dir);
      await checkFolder(dir, "Ce-Mac");
      expect(await names(dir)).toEqual(before);
      expect((await stat(path.join(folder, "photo.jpg"))).isFile()).toBe(true);
    });
  });

  // MARK: Sauvegardes existantes

  test("existing_backups_are_detected", async () => {
    await withTempDir(async (dir) => {
      for (const n of ["cairn-MacBook-Pro.sparsebundle", "cairn-Ce-Mac.sparsebundle", "autre.sparsebundle"]) {
        await mkdir(path.join(dir, n));
      }
      const r = await checkFolder(dir, "Ce-Mac");
      expect(r.kind).toBe("ok");
      if (r.kind !== "ok") return;
      expect(r.existingImages.map((i) => i.machine)).toEqual(["Ce-Mac", "MacBook-Pro"]);
      expect(r.existingImages.map((i) => i.isThisMac)).toEqual([true, false]);
    });
  });

  // MARK: Parcours

  test("list_folders_filters_and_sorts", async () => {
    await withTempDir(async (dir) => {
      for (const n of ["dossier10", "Dossier2", "dossier1", ".cache", "cairn-Mac.sparsebundle"]) {
        await mkdir(path.join(dir, n));
      }
      await writeSized(path.join(dir, "fichier.txt"), 1);
      const r = await listFolders(dir);
      expect(r.ok && r.value.map((e) => e.name)).toEqual(["dossier1", "Dossier2", "dossier10"]);
    });
  });

  test("list_folders_access_denied", async () => {
    await withTempDir(async (dir) => {
      const closed = path.join(dir, "ferme");
      await mkdir(closed);
      await chmod(closed, 0o000);
      try {
        expect(await listFolders(closed)).toEqual({ ok: false, failure: { kind: "accessDenied", path: closed } });
      } finally {
        await chmod(closed, 0o755);
      }
      const missing = path.join(dir, "absent");
      expect(await listFolders(missing)).toEqual({ ok: false, failure: { kind: "notFound", path: missing } });
    });
  });

  test("create_folder_valid_and_refused_names", async () => {
    await withTempDir(async (dir) => {
      const created = await createFolder("  Cairn ", dir);
      expect(created.ok && path.basename(created.value)).toBe("Cairn");
      expect((await stat(path.join(dir, "Cairn"))).isDirectory()).toBe(true);
      const refused = (n: string) => createFolder(n, dir).then((r) => (r.ok ? null : r.failure));
      expect(await refused("Cairn")).toEqual({ kind: "invalidName", reason: "exists" });
      expect(await refused("a/b")).toEqual({ kind: "invalidName", reason: "forbiddenCharacter" });
      expect(await refused("a:b")).toEqual({ kind: "invalidName", reason: "forbiddenCharacter" });
      expect(await refused("   ")).toEqual({ kind: "invalidName", reason: "empty" });
      expect(await refused("..")).toEqual({ kind: "invalidName", reason: "empty" });
      expect(await names(dir)).toEqual(["Cairn"]); // aucune écriture en cas de refus
    });
  });

  test("local_roots_skip_system_disk_and_end_with_home", async () => {
    await withTempDir(async (dir) => {
      const volumes = path.join(dir, "Volumes");
      await mkdir(path.join(volumes, "Externe"), { recursive: true });
      await mkdir(path.join(volumes, "Archives"), { recursive: true });
      await symlink("/", path.join(volumes, "Macintosh HD"));
      const roots = await localRoots(volumes, path.join(dir, "romain"));
      expect(roots.map((r) => r.name)).toEqual(["Archives", "Externe", "romain"]);
    });
  });

  // MARK: SMB (sans réseau)

  test("smb_mount_codes_are_translated", () => {
    const share = "smb://nas.local/backups";
    expect(failureForMountStatus(80, share)).toEqual({ kind: "authenticationFailed" });
    expect(failureForMountStatus(13, share)).toEqual({ kind: "authenticationFailed" });
    for (const code of [-5045, -5046, -5999])
      expect(failureForMountStatus(code, share).kind).toBe("authenticationFailed");
    expect(failureForMountStatus(2, share)).toEqual({ kind: "notFound", path: share });
    expect(failureForMountStatus(-5998, share)).toEqual({ kind: "notFound", path: share });
    expect(failureForMountStatus(-6003, share)).toEqual({ kind: "notFound", path: share });
    expect(failureForMountStatus(64, share)).toEqual({ kind: "mountFailed", code: 64 });
  });

  test("smb_address_parts_and_final_address", () => {
    expect(smbParts("smb://nas.local/backups/mac/2026")).toEqual({
      host: "nas.local",
      share: "backups",
      subpath: ["mac", "2026"],
    });
    expect(smbParts("smb://nas.local")).toBeNull(); // partage requis
    expect(smbParts("afp://nas.local/backups")).toBeNull(); // SMB seulement
    expect(smbAddress("nas.local", "backups", ["mac"])).toBe("smb://nas.local/backups/mac");
    const spaced = smbAddress("nas.local", "backups", ["Mon Mac"]);
    expect(spaced).toBe("smb://nas.local/backups/Mon%20Mac");
    // L'adresse finale est relue telle quelle par le fournisseur SMB (chemin décodé).
    expect(smbParts(spaced)?.subpath).toEqual(["Mon Mac"]);
    expect(smbAddress("nas.local", "Time Machine", ["été"])).toBe("smb://nas.local/Time%20Machine/%C3%A9t%C3%A9");
  });

  test("smb_host_only_address_lists_disk_shares", () => {
    expect(smbHostOf("smb://syno")).toBe("syno");
    expect(smbHostOf("smb://syno/home/cairn")).toBe("syno");
    expect(smbHostOf("smb://")).toBeNull(); // hôte requis
    expect(smbHostOf("afp://syno")).toBeNull(); // SMB seulement
    const output = [
      "Share                                           Type    Comments",
      "-------------------------------",
      "homes                                           Disk    user home",
      "Time Machine Folder                             Disk",
      "IPC$                                            Pipe    IPC Service ()",
      "home                                            Disk    Home directory of romain",
      "ADMIN$                                          Disk",
      "Plex                                            Disk    Plex Media Library",
      "",
      "4 shares listed",
    ].join("\n");
    expect(parseShares(output)).toEqual(["home", "homes", "Plex", "Time Machine Folder"]);
    expect(parseShares("smbutil: server rejected the authentication")).toEqual([]);
  });

  test("new_destination_ids_are_unique", () => {
    expect(newDestinationID("smb", [])).toBe("main");
    expect(newDestinationID("smb", ["main"])).toBe("nas");
    expect(newDestinationID("local", ["main", "disk", "disk-2"])).toBe("disk-3");
  });

  test("smb_invalid_address_fails_without_network", async () => {
    const s = new ProbeSession(smbShareProvider(fakeSMB("/nowhere").deps));
    expect(await s.check("smb://", "u", "p")).toEqual({
      kind: "failed",
      failure: { kind: "invalidAddress", address: "smb://" },
    });
    expect(s.isConnected).toBe(false);
  });

  // MARK: Session SMB, montage simulé

  test("session keeps the verified share mounted for browsing, then unmounts what it mounted", async () => {
    await withTempDir(async (share) => {
      await mkdir(path.join(share, "mac"));
      await mkdir(path.join(share, "cairn-Ce-Mac.sparsebundle"));
      const smb = fakeSMB(share);
      const s = new ProbeSession(smbShareProvider(smb.deps), "Ce-Mac");
      const r = await s.check("smb://nas.local/backups/mac", "romain", "secret");
      expect(r).toMatchObject({ kind: "ok", existingImages: [] });
      expect(smb.calls.mount).toEqual([{ url: "smb://nas.local/backups", user: "romain", password: "secret" }]);
      expect(s.isConnected).toBe(true);
      expect(s.folder([])).toBe(share);
      const browse = await listFolders(s.folder([])!);
      expect(browse.ok && browse.value.map((e) => e.name)).toEqual(["mac"]);
      expect(smb.calls.unmount).toEqual([]); // reste monté pour le parcours
      await s.close();
      expect(smb.calls.unmount).toEqual([share]);
      expect(s.isConnected).toBe(false);
      expect(await smb.secrets.internetPassword("nas.local", "romain")).toBeNull(); // rien au Trousseau
    });
  });

  test("a share already mounted in the Finder is reused and never unmounted", async () => {
    await withTempDir(async (share) => {
      const smb = fakeSMB("/never", {
        existing: [{ from: "//romain@nas.local/backups", on: share, type: "smbfs" }],
      });
      const s = new ProbeSession(smbShareProvider(smb.deps), "Ce-Mac");
      expect((await s.connect("smb://NAS.local/Backups", "romain", null)).ok).toBe(true);
      expect(s.mountRoot).toBe(share);
      await s.close();
      expect(smb.calls.mount).toEqual([]);
      expect(smb.calls.unmount).toEqual([]);
    });
  });

  test("password: session password, then keychain, else passwordRequired", async () => {
    const smb = fakeSMB("/mnt");
    const s = new ProbeSession(smbShareProvider(smb.deps));
    expect(await s.connect("smb://nas.local/backups", "romain", "")).toEqual({
      ok: false,
      failure: { kind: "passwordRequired" },
    });
    smb.secrets.internet.set("nas.local|romain", "from-keychain");
    expect((await s.connect("smb://nas.local/backups", "romain", "")).ok).toBe(true);
    expect(smb.calls.mount.at(-1)?.password).toBe("from-keychain");
    await s.close();
  });

  test("mount failures are explained", async () => {
    const auth = new ProbeSession(smbShareProvider(fakeSMB("/mnt", { failCode: 80 }).deps));
    expect(await auth.connect("smb://nas.local/backups", "romain", "pw")).toEqual({
      ok: false,
      failure: { kind: "authenticationFailed" },
    });
    const other = new ProbeSession(smbShareProvider(fakeSMB("/mnt", { failCode: 64 }).deps));
    expect(await other.connect("smb://nas.local/backups", "romain", "pw")).toEqual({
      ok: false,
      failure: { kind: "mountFailed", code: 64 },
    });
    const unreachable = fakeSMB("/mnt");
    unreachable.deps.reachable = async () => false;
    expect(await new ProbeSession(smbShareProvider(unreachable.deps)).connect("smb://nas.local/b", "", "pw")).toEqual({
      ok: false,
      failure: { kind: "unreachable", host: "nas.local" },
    });
  });
});
