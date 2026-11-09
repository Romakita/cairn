import { describe, expect, test } from "bun:test";
import os from "node:os";
import {
  arch,
  machineName,
  readComputerName,
  resolveMachineName,
  sanitizeMachineName,
  setMachineName,
} from "../../src/core/machine.ts";

describe("machine", () => {
  test("nom nettoyé comme la 0.8.0 (un `-` par scalaire hors [A-Za-z0-9._-])", () => {
    expect(sanitizeMachineName("MacBook Pro de Romain")).toBe("MacBook-Pro-de-Romain");
    expect(sanitizeMachineName("Romain’s Mac.mini_2-x")).toBe("Romain-s-Mac.mini_2-x");
    // Attendus copiés de `replacingOccurrences(of:with:options: .regularExpression)` (Swift).
    expect(sanitizeMachineName("Mac 🙂 é")).toBe("Mac----");
    expect(sanitizeMachineName("e\u{301}")).toBe("e-");
    expect(sanitizeMachineName("👨‍👩‍👧")).toBe("-----");
  });

  test("ComputerName lu par scutil, repli sur le nom d'hôte", async () => {
    expect(await resolveMachineName(async () => "Mac de test")).toBe("Mac-de-test");
    expect(await resolveMachineName(async () => null)).toBe(sanitizeMachineName(os.hostname()));
  });

  test("machineName() : même valeur que scutil, gardée en cache", async () => {
    setMachineName(null);
    const raw = await readComputerName();
    const name = await machineName();
    expect(name).toBe(sanitizeMachineName(raw ?? os.hostname()));
    expect(name).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(machineName()).toBe(machineName());
    setMachineName("Fixe");
    expect(await machineName()).toBe("Fixe");
    setMachineName(null);
  });

  test("arch : arm64 ou x86_64", () => {
    expect(arch("arm64")).toBe("arm64");
    expect(arch("x86_64")).toBe("x86_64");
    expect(["arm64", "x86_64"]).toContain(arch());
  });
});
