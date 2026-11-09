import { describe, expect, test } from "bun:test";
import { CONFIRMATION_TTL_MS, ConfirmationTokens, isConfirmedMethod } from "../../src/main/confirmation-tokens.ts";
import { CONFIRMED_METHODS, METHOD_NAMES } from "../../src/shared/contract.ts";
import { ARG_SCHEMAS } from "../../src/shared/schemas.ts";

describe("confirmation des actions destructives", () => {
  const args = { nodeIds: [3, 1], permanently: true };

  test("un jeton confirme une fois l'appel préparé, depuis la même fenêtre", () => {
    const tokens = new ConfirmationTokens();
    const { token } = tokens.issue(7, "removeNodes", args);
    expect(tokens.consume(token, 7, "removeNodes", { permanently: true, nodeIds: [3, 1] })).toBe(true);
    // Usage unique.
    expect(tokens.consume(token, 7, "removeNodes", args)).toBe(false);
  });

  test("sans jeton, autre fenêtre, autre méthode ou autres arguments : la boîte du main s'ouvrira", () => {
    const tokens = new ConfirmationTokens();
    expect(tokens.consume(undefined, 7, "removeNodes", args)).toBe(false);
    const a = tokens.issue(7, "removeNodes", args).token;
    expect(tokens.consume(a, 8, "removeNodes", args)).toBe(false);
    const b = tokens.issue(7, "removeNodes", args).token;
    expect(tokens.consume(b, 7, "removeNodes", { nodeIds: [3, 1, 9], permanently: true })).toBe(false);
    const c = tokens.issue(7, "gitTrashRepo", { repo: "/r" }).token;
    expect(tokens.consume(c, 7, "gitCompact", { repo: "/r" })).toBe(false);
    expect(tokens.consume("00000000-0000-4000-8000-000000000000", 7, "removeNodes", args)).toBe(false);
  });

  test("un jeton expire au bout de deux minutes", () => {
    let now = 1_000;
    const tokens = new ConfirmationTokens(() => now);
    const { token, expiresIn } = tokens.issue(1, "applyRestore", { planId: "p" });
    expect(expiresIn).toBe(CONFIRMATION_TTL_MS);
    now += CONFIRMATION_TTL_MS + 1;
    expect(tokens.consume(token, 1, "applyRestore", { planId: "p" })).toBe(false);
  });

  test("les arguments préparés passent le schéma de la méthode", () => {
    const tokens = new ConfirmationTokens();
    expect(() => tokens.issue(1, "removeNodes", { nodeIds: [] })).toThrow();
    expect(() => tokens.issue(1, "gitCompact", { repo: "relative/path" })).toThrow();
  });

  test("chaque méthode destructive existe et accepte un jeton", () => {
    for (const method of CONFIRMED_METHODS) {
      expect(METHOD_NAMES).toContain(method);
      expect(isConfirmedMethod(method)).toBe(true);
      const schema = ARG_SCHEMAS[method];
      const base = method === "removeNodes" ? { nodeIds: [1] } : {};
      // Un jeton qui n'a pas la forme d'un UUID est refusé par le schéma.
      expect(schema.safeParse({ ...base, confirmation: "x" }).success).toBe(false);
    }
    expect(isConfirmedMethod("scan")).toBe(false);
  });
});
