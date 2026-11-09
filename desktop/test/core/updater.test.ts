// Mises à jour de l'app (port de UpdaterTests.swift) : semver, assets par architecture, SHA-256 et contrôle du bundle,
// script de remplacement, et un flux complet servi par un petit serveur http local (`CAIRN_UPDATE_URL`).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  BUNDLE_IDENTIFIER,
  bundleOf,
  checkForUpdate,
  downloadRelease,
  installableBundle,
  isNewer,
  latestURL,
  parseChecksum,
  parseRelease,
  prepare,
  scheduleSwap,
  stagingDirectory,
  UpdateError,
} from "../../src/core/updater.ts";

const exec = promisify(execFile);

function releaseJSON(tag: string, assets: string[], options: { draft?: boolean; prerelease?: boolean } = {}): string {
  return JSON.stringify({
    tag_name: tag,
    draft: options.draft ?? false,
    prerelease: options.prerelease ?? false,
    html_url: "https://example.com/release",
    body: "### Added\n- Updates\n",
    assets: assets.map((name) => ({ name, browser_download_url: `https://example.com/${name}` })),
  });
}

async function withTempDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "cairn-updater-")));
  try {
    await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function plist(id: string, version: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${id}</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
</dict></plist>
`;
}

/** Faux `Cairn.app` zippé comme le fait la release ; renvoie l'archive et l'empreinte au format shasum. */
async function makeArchive(
  dir: string,
  version: string,
  id: string = BUNDLE_IDENTIFIER,
): Promise<{ zip: string; sum: string; sha: string }> {
  const app = path.join(dir, `src-${version}-${id}`, "Cairn.app");
  await mkdir(path.join(app, "Contents"), { recursive: true });
  await writeFile(path.join(app, "Contents/Info.plist"), plist(id, version));
  const zip = path.join(dir, `Cairn-${version}-arm64.zip`);
  await exec("/usr/bin/ditto", ["-c", "-k", "--keepParent", app, zip]);
  const sha = createHash("sha256")
    .update(await readFile(zip))
    .digest("hex");
  return { zip, sum: `${sha}  ${path.basename(zip)}\n`, sha };
}

async function versionOf(app: string): Promise<string | null> {
  try {
    const { stdout } = await exec("/usr/bin/plutil", [
      "-extract",
      "CFBundleShortVersionString",
      "raw",
      path.join(app, "Contents/Info.plist"),
    ]);
    return stdout.trim();
  } catch {
    return null;
  }
}

describe("updater", () => {
  test("version_comparison", () => {
    expect(isNewer("0.2.0", "0.1.1")).toBe(true);
    expect(isNewer("v0.1.10", "0.1.9")).toBe(true);
    expect(isNewer("1.0.0", "1.0.0-beta.2")).toBe(true);
    expect(isNewer("1.0.0-beta.10", "1.0.0-beta.2")).toBe(true);
    expect(isNewer("0.1.1", "0.1.1")).toBe(false);
    expect(isNewer("0.1", "0.1.0")).toBe(false);
    expect(isNewer("0.1.0", "0.1.1")).toBe(false);
  });

  test("parse_release_for_arch", () => {
    const data = releaseJSON("v0.2.0", [
      "Cairn-0.2.0-arm64.zip",
      "Cairn-0.2.0-arm64.zip.sha256",
      "Cairn-0.2.0-x86_64.zip",
      "Cairn-0.2.0-x86_64.zip.sha256",
    ]);
    const r = parseRelease(data, "arm64");
    expect(r?.version).toBe("0.2.0");
    expect(r?.archiveURL.endsWith("/Cairn-0.2.0-arm64.zip")).toBe(true);
    expect(r?.checksumURL.endsWith("/Cairn-0.2.0-arm64.zip.sha256")).toBe(true);
    expect(r?.notes).toBe("### Added\n- Updates");
    expect(parseRelease(data, "x86_64")?.archiveURL.endsWith("/Cairn-0.2.0-x86_64.zip")).toBe(true);
  });

  test("parse_release_rejects_incomplete", () => {
    // Archive sans empreinte, autre architecture, préversion, brouillon : rien n'est proposé.
    expect(parseRelease(releaseJSON("v0.2.0", ["Cairn-0.2.0-arm64.zip"]), "arm64")).toBeNull();
    const other = ["Cairn-0.2.0-x86_64.zip", "Cairn-0.2.0-x86_64.zip.sha256"];
    expect(parseRelease(releaseJSON("v0.2.0", other), "arm64")).toBeNull();
    const both = ["Cairn-0.2.0-arm64.zip", "Cairn-0.2.0-arm64.zip.sha256"];
    expect(parseRelease(releaseJSON("v0.2.0", both, { prerelease: true }), "arm64")).toBeNull();
    expect(parseRelease(releaseJSON("v0.2.0", both, { draft: true }), "arm64")).toBeNull();
    expect(parseRelease("{}", "arm64")).toBeNull();
    expect(parseRelease("not json", "arm64")).toBeNull();
    // Assets à la mode electron-builder (`x64`) : refusés, l'updater 0.8.0 attend `x86_64`.
    expect(parseRelease(releaseJSON("v0.2.0", ["Cairn-0.2.0-x64.zip", "Cairn-0.2.0-x64.zip.sha256"]), "x86_64")).toBe(
      null,
    );
  });

  test("checksum_file_format", () => {
    expect(parseChecksum("ABCDEF  Cairn-0.2.0-arm64.zip\n")).toBe("abcdef");
    expect(parseChecksum("  \n")).toBe("");
  });

  test("installable_bundle", async () => {
    await withTempDir(async (dir) => {
      expect(await installableBundle(path.join(dir, "Cairn.app"))).toBe(path.join(dir, "Cairn.app"));
      expect(await installableBundle(path.join(dir, "debug/Cairn"))).toBeNull();
      expect(await installableBundle(null)).toBeNull();
      expect(bundleOf("/Applications/Cairn.app/Contents/MacOS/Cairn")).toBe("/Applications/Cairn.app");
      expect(bundleOf("/usr/local/bin/electron")).toBeNull();
    });
  });

  test("feed_url_override", () => {
    expect(latestURL({})).toBe("https://api.github.com/repos/Romakita/cairn/releases/latest");
    expect(latestURL({ CAIRN_UPDATE_URL: "http://127.0.0.1:9/latest" })).toBe("http://127.0.0.1:9/latest");
    expect(latestURL({ CAIRN_UPDATE_URL: "not a url" })).toBe(
      "https://api.github.com/repos/Romakita/cairn/releases/latest",
    );
  });

  test("prepare_valid_archive", async () => {
    await withTempDir(async (dir) => {
      const { zip, sum } = await makeArchive(dir, "0.2.0");
      const staging = path.join(dir, "Apps/.cairn-update");
      const app = await prepare({ archive: zip, checksum: sum, version: "0.2.0", staging });
      expect(app).toBe(path.join(staging, "Cairn.app"));
      expect(await versionOf(app)).toBe("0.2.0");
    });
  });

  test("prepare_rejects_bad_checksum_or_bundle", async () => {
    await withTempDir(async (dir) => {
      const { zip, sum } = await makeArchive(dir, "0.2.0");
      const staging = path.join(dir, "staging");
      const bad = prepare({ archive: zip, checksum: "0".repeat(64), version: "0.2.0", staging });
      await expect(bad).rejects.toMatchObject({ kind: "checksumMismatch" });
      expect(existsSync(staging)).toBe(false); // rien ne doit être extrait
      const wrongVersion = prepare({ archive: zip, checksum: sum, version: "0.3.0", staging });
      await expect(wrongVersion).rejects.toMatchObject({ kind: "wrongBundle", detail: "fr.lenzotti.cairn 0.2.0" });
      expect(existsSync(staging)).toBe(false);
      const other = path.join(dir, "other");
      await mkdir(other, { recursive: true });
      const evil = await makeArchive(other, "0.2.0", "com.example.evil");
      const wrongId = prepare({ archive: evil.zip, checksum: evil.sum, version: "0.2.0", staging });
      await expect(wrongId).rejects.toMatchObject({ kind: "wrongBundle", detail: "com.example.evil 0.2.0" });
      const garbage = path.join(dir, "garbage.zip");
      await writeFile(garbage, "not a zip");
      const gsum = createHash("sha256").update("not a zip").digest("hex");
      await expect(prepare({ archive: garbage, checksum: gsum, version: "0.2.0", staging })).rejects.toBeInstanceOf(
        UpdateError,
      );
    });
  });

  test("swap_replaces_bundle_after_exit", async () => {
    await withTempDir(async (dir) => {
      const apps = path.join(dir, "Applications");
      const old = await makeArchive(dir, "0.1.1");
      await mkdir(apps, { recursive: true });
      await exec("/usr/bin/ditto", ["-x", "-k", old.zip, apps]);
      const installed = path.join(apps, "Cairn.app");
      const newDir = path.join(dir, "new");
      await mkdir(newDir, { recursive: true });
      const next = await makeArchive(newDir, "0.2.0");
      const app = await prepare({
        archive: next.zip,
        checksum: next.sum,
        version: "0.2.0",
        staging: stagingDirectory(installed),
      });
      // Processus « app » déjà terminé : le script remplace aussitôt.
      const done = await exec("/bin/sh", ["-c", "echo $$"]);
      const pid = Number(done.stdout.trim());
      const swap = scheduleSwap({ newApp: app, bundle: installed, pid, relaunch: false });
      expect(await swap.exited).toBe(0);
      expect(await versionOf(installed)).toBe("0.2.0");
      expect(existsSync(stagingDirectory(installed))).toBe(false); // préparation nettoyée
    });
  });

  test("swap_keeps_old_bundle_on_failure", async () => {
    await withTempDir(async (dir) => {
      const apps = path.join(dir, "Applications");
      const old = await makeArchive(dir, "0.1.1");
      await mkdir(apps, { recursive: true });
      await exec("/usr/bin/ditto", ["-x", "-k", old.zip, apps]);
      const installed = path.join(apps, "Cairn.app");
      const staging = stagingDirectory(installed);
      await mkdir(staging, { recursive: true });
      // Nouveau bundle absent : le déplacement échoue et l'ancienne app doit revenir.
      const swap = scheduleSwap({
        newApp: path.join(staging, "Cairn.app"),
        bundle: installed,
        pid: 999_999,
        relaunch: false,
      });
      await swap.exited;
      expect(await versionOf(installed)).toBe("0.1.1");
    });
  });

  describe("flux de test (CAIRN_UPDATE_URL)", () => {
    let server: Server;
    let base = "";
    let dir = "";
    let archive: { zip: string; sum: string } = { zip: "", sum: "" };
    let corrupt = false;
    const requests: string[] = [];

    beforeAll(async () => {
      dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "cairn-feed-")));
      archive = await makeArchive(dir, "9.9.0");
      server = createServer(async (req, res) => {
        requests.push(`${req.url} ${req.headers["user-agent"] ?? ""}`);
        const url = req.url ?? "/";
        if (url === "/latest") {
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              tag_name: "v9.9.0",
              draft: false,
              prerelease: false,
              html_url: `${base}/release`,
              body: "notes",
              assets: [
                { name: "Cairn-9.9.0-arm64.zip", browser_download_url: `${base}/Cairn-9.9.0-arm64.zip` },
                { name: "Cairn-9.9.0-arm64.zip.sha256", browser_download_url: `${base}/Cairn-9.9.0-arm64.zip.sha256` },
                { name: "Cairn-9.9.0-x86_64.zip", browser_download_url: `${base}/Cairn-9.9.0-arm64.zip` },
                {
                  name: "Cairn-9.9.0-x86_64.zip.sha256",
                  browser_download_url: `${base}/Cairn-9.9.0-arm64.zip.sha256`,
                },
              ],
            }),
          );
        } else if (url.endsWith(".zip")) {
          const body = await readFile(archive.zip);
          res.end(corrupt ? Buffer.concat([body, Buffer.from("x")]) : body);
        } else if (url.endsWith(".sha256")) {
          res.end(archive.sum);
        } else if (url === "/down") {
          res.statusCode = 503;
          res.end("down");
        } else {
          res.statusCode = 404;
          res.end();
        }
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    });

    test("check_finds_newer_release", async () => {
      const r = await checkForUpdate({ current: "0.8.0", url: latestURL({ CAIRN_UPDATE_URL: `${base}/latest` }) });
      expect(r?.version).toBe("9.9.0");
      expect(requests.some((l) => l.startsWith("/latest Cairn/0.8.0"))).toBe(true);
      expect(await checkForUpdate({ current: "9.9.0", url: `${base}/latest` })).toBeNull();
      await expect(checkForUpdate({ current: "0.8.0", url: `${base}/down` })).rejects.toMatchObject({
        kind: "network",
      });
    });

    test("download_verifies_and_prepares", async () => {
      const r = await checkForUpdate({ current: "0.8.0", url: `${base}/latest` });
      if (!r) throw new Error("release attendue");
      const apps = path.join(dir, "Applications");
      await mkdir(apps, { recursive: true });
      const bundle = path.join(apps, "Cairn.app");
      // Adresses http refusées hors flux de test.
      await expect(downloadRelease(r, bundle)).rejects.toMatchObject({ kind: "network" });
      const app = await downloadRelease(r, bundle, { allowInsecure: true, current: "0.8.0" });
      expect(app).toBe(path.join(stagingDirectory(bundle), "Cairn.app"));
      expect(await versionOf(app)).toBe("9.9.0");
      corrupt = true;
      try {
        await expect(downloadRelease(r, bundle, { allowInsecure: true })).rejects.toMatchObject({
          kind: "checksumMismatch",
        });
      } finally {
        corrupt = false;
      }
    });
  });
});
