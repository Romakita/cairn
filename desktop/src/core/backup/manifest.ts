// `manifest.json` d'une version (port de `BackupEngine.finish`) : JSON indenté, clés triées, mêmes champs que la
// 0.8.0 (parity/behavior.md §3.9). La restauration lit `parts[].kind/target/source`.
import os from "node:os";
import path from "node:path";
import { isoDate } from "../dates.ts";
import { writeFile } from "../fs-promises.ts";
import { type JSONValue, prettyJSON } from "../json.ts";
import { run } from "../process.ts";
import type { BackupPart } from "./types.ts";
import { MANIFEST_FILE } from "./versions.ts";

export const MANIFEST_FORMAT = 1;

/** Champs ajoutés par le service : `cairn`, `destination`, `config_version`, `log`. */
export interface ManifestExtra {
  cairn?: string;
  destination?: string;
  config_version?: number;
  log?: string;
}

export interface ManifestInput {
  extra: ManifestExtra;
  date: Date;
  machine: string;
  macos: string;
  parts: readonly BackupPart[];
  bytesTransferred: number;
  partial: boolean;
}

export function manifestJSON(m: ManifestInput): string {
  const value: Record<string, JSONValue> = {};
  for (const [k, v] of Object.entries(m.extra)) if (v !== undefined) value[k] = v;
  value.format = MANIFEST_FORMAT;
  value.date = isoDate(m.date);
  value.machine = m.machine;
  value.arch = os.machine();
  value.macos = m.macos;
  value.parts = m.parts.map((p) => ({ kind: p.kind, target: p.target, source: p.source }));
  value.bytes_transferred = m.bytesTransferred;
  value.partial = m.partial;
  return prettyJSON(value);
}

export async function writeManifest(version: string, m: ManifestInput): Promise<void> {
  await writeFile(path.join(version, MANIFEST_FILE), manifestJSON(m), "utf8");
}

let macosCache: Promise<string> | null = null;

/** Version du système comme `operatingSystemVersionString` : « Version 15.1 (Build 24B83) ». */
export function macOSVersionString(): Promise<string> {
  macosCache ??= (async () => {
    const read = async (flag: string) => {
      try {
        return (await run("/usr/bin/sw_vers", [flag], { stderr: "ignore", timeoutMs: 5000 })).stdout.trim();
      } catch {
        return "";
      }
    };
    const [version, build] = await Promise.all([read("-productVersion"), read("-buildVersion")]);
    if (!version) return `Version ${os.release()}`;
    return build ? `Version ${version} (Build ${build})` : `Version ${version}`;
  })();
  return macosCache;
}
