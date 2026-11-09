// Jetons de confirmation des actions destructives (voir « Confirmation des actions destructives », contract.ts).
// Sans Electron : testé par `bun test` (test/core/confirmation.test.ts).
import { randomUUID } from "node:crypto";
import { compactJSON, type JSONValue } from "../core/json.ts";
import { CONFIRMED_METHODS, type ConfirmationToken, type ConfirmedMethod } from "../shared/contract.ts";
import { validateArgs } from "../shared/schemas.ts";
import { ApiError } from "./errors.ts";

/** Durée de validité d'un jeton : le temps de passer de la feuille à l'appel, pas plus. */
export const CONFIRMATION_TTL_MS = 2 * 60 * 1000;

export function isConfirmedMethod(method: string): method is ConfirmedMethod {
  return (CONFIRMED_METHODS as readonly string[]).includes(method);
}

/** Arguments sans le jeton, sous une forme canonique (clés triées) : deux appels identiques ont la même clé. */
function actionKey(method: ConfirmedMethod, args: unknown): string {
  const { confirmation: _c, ...rest } = (args ?? {}) as Record<string, unknown>;
  return `${method}:${compactJSON(rest as JSONValue)}`;
}

/**
 * Jetons de confirmation émis quand la feuille de l'interface a été confirmée : aléatoires, à usage unique, valables
 * 2 minutes, liés à la fenêtre appelante, à la méthode et à ses arguments exacts. Un appel qui en présente un valide
 * n'ouvre pas la boîte native ; tous les autres (sans jeton, expiré, déjà servi, autre fenêtre, autres arguments) la
 * voient, comme avant.
 */
export class ConfirmationTokens {
  private readonly tokens = new Map<string, { sender: number; key: string; expires: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Émet un jeton pour `method(args)` ; les arguments doivent passer le schéma de la méthode. */
  issue(sender: number, method: ConfirmedMethod, args: unknown): ConfirmationToken {
    const parsed = validateArgs(method, args ?? {});
    if (!parsed.ok) throw new ApiError("invalidArguments", parsed.message);
    this.purge();
    const token = randomUUID();
    this.tokens.set(token, { sender, key: actionKey(method, parsed.value), expires: this.now() + CONFIRMATION_TTL_MS });
    return { token, expiresIn: CONFIRMATION_TTL_MS };
  }

  /** Le jeton confirme cet appel précis (il est consommé dans tous les cas). */
  consume(token: string | undefined, sender: number, method: ConfirmedMethod, args: unknown): boolean {
    if (!token) return false;
    const entry = this.tokens.get(token);
    this.tokens.delete(token);
    if (!entry) return false;
    return entry.sender === sender && entry.expires > this.now() && entry.key === actionKey(method, args);
  }

  private purge(): void {
    const now = this.now();
    for (const [k, v] of this.tokens) if (v.expires <= now) this.tokens.delete(k);
  }
}
