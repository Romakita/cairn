// Module natif (desktop/native) : Trousseau, flock, NetFS, espace libre du volume.
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, mkdtempSync, openSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { native } from "../../src/core/native.ts";
import { nativeAvailable } from "../helpers/native.ts";

const available = nativeAvailable();
const id = randomBytes(6).toString("hex");
// Entrées de test seulement : le module ne sait pas supprimer, `security` les retire à la fin.
const service = `fr.lenzotti.cairn.test.${id}`;
const cliService = `fr.lenzotti.cairn.test.cli.${id}`;
const server = `cairn-test-${id}.invalid`;

function security(...args: string[]) {
  return spawnSync("/usr/bin/security", args, { encoding: "utf8", timeout: 15_000 });
}

describe.skipIf(!available)("native", () => {
  afterAll(() => {
    security("delete-generic-password", "-s", service, "-a", "tester");
    security("delete-generic-password", "-s", service, "-a", "async");
    security("delete-generic-password", "-s", cliService);
    security("delete-internet-password", "-s", server, "-a", "u1");
    security("delete-internet-password", "-s", server, "-a", "u2");
  });

  test("generic password: absent, added, updated", async () => {
    const q = { service, account: "tester" };
    expect(await native().keychainGetGeneric(q)).toBeNull();
    await native().keychainSetGeneric(q, "first", `Cairn — ${service}`);
    expect(await native().keychainGetGeneric(q)).toBe("first");
    await native().keychainSetGeneric(q, "sécond ✓", `Cairn — ${service}`);
    expect(await native().keychainGetGeneric(q)).toBe("sécond ✓");
    // Une seule entrée, avec le libellé de l'ajout, lisible par les autres outils.
    const found = security("find-generic-password", "-s", service, "-a", "tester");
    expect(found.status).toBe(0);
    expect(found.stdout).toContain(`"svce"<blob>="${service}"`);
    expect(await native().keychainGetGeneric({ service, account: "other" })).toBeNull();
  });

  test("internet SMB password: absent, added, updated, with the SMB protocol", async () => {
    const q1 = { server, account: "u1", protocol: "smb" as const };
    expect(await native().keychainGetInternet(q1)).toBeNull();
    await native().keychainSetInternet(q1, "first");
    expect(await native().keychainGetInternet(q1)).toBe("first");
    await native().keychainSetInternet(q1, "updated");
    expect(await native().keychainGetInternet(q1)).toBe("updated");
    expect(await native().keychainGetInternet({ server, account: "u2", protocol: "smb" })).toBeNull();
    // Attributs seulement (sans -w) : aucune demande d'autorisation.
    const found = security("find-internet-password", "-s", server, "-a", "u1");
    expect(found.stdout).toContain('"ptcl"<uint32>="smb "');
  });

  // Une entrée écrite par un autre programme (la 0.8.0, le Finder, `security`) appartient à sa liste de partitions :
  // la lire depuis Bun ouvre une fenêtre d'autorisation du Trousseau. Test interactif, à lancer à la main :
  // CAIRN_TEST_KEYCHAIN_INTEROP=1 bun test test/core/native.test.ts (puis « Autoriser »).
  test.skipIf(!process.env.CAIRN_TEST_KEYCHAIN_INTEROP)(
    "entries written by another program (0.8.0, Finder) are read and updated",
    async () => {
      const add = security(
        "add-generic-password",
        "-s",
        cliService,
        "-a",
        "machine",
        "-l",
        `Cairn — ${cliService}`,
        "-w",
        "from-cli",
      );
      expect(add.status).toBe(0);
      expect(await native().keychainGetGeneric({ service: cliService, account: "machine" })).toBe("from-cli");
      const inet = security("add-internet-password", "-s", server, "-a", "u2", "-r", "smb ", "-w", "finder");
      expect(inet.status).toBe(0);
      const q2 = { server, account: "u2", protocol: "smb" as const };
      expect(await native().keychainGetInternet(q2)).toBe("finder");
      await native().keychainSetInternet(q2, "updated");
      expect(await native().keychainGetInternet(q2)).toBe("updated");
    },
    300_000,
  );

  test("keychain calls answer with a Promise: the main thread never waits for an unlock prompt", async () => {
    const q = { service, account: "async" };
    const pending = native().keychainGetGeneric(q);
    expect(pending).toBeInstanceOf(Promise);
    expect(await pending).toBeNull();
    const write = native().keychainSetGeneric(q, "x", `Cairn — ${service}`);
    expect(write).toBeInstanceOf(Promise);
    await write;
    expect(await native().keychainGetGeneric(q)).toBe("x");
  });

  test("keychain arguments are validated", () => {
    expect(() => native().keychainGetGeneric({ service: 1 } as never)).toThrow(TypeError);
    expect(() => native().keychainGetInternet({ server, account: "u", protocol: "ftp" } as never)).toThrow();
  });

  test("flock: exclusive between two descriptors, released by unlock", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cairn-flock-"));
    const file = path.join(dir, "x.lock");
    const a = openSync(file, "w+", 0o600);
    const b = openSync(file, "r");
    try {
      expect(native().flockTryExclusive(a)).toBe(true);
      expect(native().flockTryExclusive(b)).toBe(false);
      // Le verrou bloquant attend la libération, sans bloquer la boucle d'événements.
      let acquired = false;
      const waiting = native()
        .flockExclusive(b)
        .then(() => {
          acquired = true;
        });
      await new Promise((r) => setTimeout(r, 100));
      expect(acquired).toBe(false);
      native().flockUnlock(a);
      await waiting;
      expect(acquired).toBe(true);
      expect(native().flockTryExclusive(a)).toBe(false);
      native().flockUnlock(b);
      expect(native().flockTryExclusive(a)).toBe(true);
      native().flockUnlock(a);
    } finally {
      closeSync(a);
      closeSync(b);
    }
  });

  test("flock on an invalid descriptor fails with errno", async () => {
    expect(() => native().flockTryExclusive(987_654)).toThrow();
    await expect(native().flockExclusive(987_654)).rejects.toMatchObject({ code: 9 }); // EBADF
    expect(() => native().flockTryExclusive(-1)).toThrow(RangeError);
  });

  test("volume important capacity matches diskutil (purgeable included)", () => {
    const value = native().volumeImportantCapacity("/");
    expect(value).toBeNumber();
    const info = spawnSync("/usr/sbin/diskutil", ["info", "-plist", "/"], { encoding: "utf8" });
    // `APFSContainerFree` : espace libre du conteneur, sans le purgeable ; la valeur « importante » l'inclut.
    const free = Number(/<key>APFSContainerFree<\/key>\s*<integer>(\d+)<\/integer>/.exec(info.stdout)?.[1]);
    expect(Number.isFinite(free)).toBe(true);
    expect(value!).toBeGreaterThanOrEqual(free * 0.9);
    const total = Number(/<key>TotalSize<\/key>\s*<integer>(\d+)<\/integer>/.exec(info.stdout)?.[1]);
    expect(value!).toBeLessThanOrEqual(total);
    expect(native().volumeImportantCapacity("/nonexistent/cairn/path")).toBeNull();
  });

  test("netfs mount of an unreachable host rejects with a numeric code", async () => {
    const error = (await native()
      .netfsMount("smb://cairn-unreachable.invalid/share", "nobody", "secret")
      .catch((e: unknown) => e)) as { code?: unknown };
    expect(error).toBeInstanceOf(Error);
    expect(typeof error.code).toBe("number");
    expect(error.code).not.toBe(0);
  }, 60_000);

  test("netfs mount without a password and an invalid URL reject", async () => {
    const error = (await native()
      .netfsMount("not a url", "", null)
      .catch((e: unknown) => e)) as { code?: unknown };
    expect(typeof error.code).toBe("number");
  }, 60_000);
});
