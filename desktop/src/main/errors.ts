// Erreurs renvoyées à l'interface : un code stable et un message déjà traduit.

import { ConfigSaveError } from "../core/config-store.ts";
import { OperationLockError } from "../core/lock.ts";
import type { ApiErrorCode } from "../shared/contract.ts";

export class ApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Code et message d'une erreur quelconque (verrou tenu, configuration refusée…). */
export function describeApiError(error: unknown): { code: ApiErrorCode; message: string } {
  if (error instanceof ApiError) return { code: error.code, message: error.message };
  if (error instanceof OperationLockError) return { code: "locked", message: error.message };
  if (error instanceof ConfigSaveError) return { code: "invalidConfig", message: error.message };
  return { code: "failed", message: error instanceof Error ? error.message : String(error) };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
