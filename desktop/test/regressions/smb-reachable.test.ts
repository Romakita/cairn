import { describe, expect, test } from "bun:test";
import { SMBProvider, smbReachable } from "../../src/core/backup/providers.ts";
import type { DestinationConfig } from "../../src/core/config.ts";

// Validation réelle (2026-11-09) : le NAS ouvert dans le Finder paraissait « injoignable » dans l'app, car macOS
// refusait à l'app l'accès au réseau local (TCP 445) alors que le partage monté par le système restait utilisable.
describe("validation: un NAS déjà monté est joignable sans test du port", () => {
  const mounted = async () => [{ from: "//romain.lenzotti@syno/home", on: "/Volumes/home", type: "smbfs" }];
  const portClosed = async () => false;

  test("smbReachable : un partage du même hôte est monté", async () => {
    expect(await smbReachable("syno", 445, { mountTable: mounted, reachable: portClosed })).toBe(true);
    expect(await smbReachable("SYNO", 445, { mountTable: mounted, reachable: portClosed })).toBe(true);
    expect(await smbReachable("autre", 445, { mountTable: mounted, reachable: portClosed })).toBe(false);
    expect(await smbReachable("syno", 445, { mountTable: async () => [], reachable: portClosed })).toBe(false);
  });

  test("SMBProvider.isReachable réutilise le montage existant", async () => {
    const destination = { id: "main", provider: "smb", url: "smb://syno/home/cairn" } as DestinationConfig;
    const deps = { mountTable: mounted, reachable: portClosed } as unknown as ConstructorParameters<
      typeof SMBProvider
    >[1];
    expect(await new SMBProvider(destination, deps).isReachable()).toBe(true);
  });
});
