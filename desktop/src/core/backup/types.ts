// Parties d'une version et erreurs de la sauvegarde (port de `BackupPart`, `BackupError` et `ProviderError`,
// BackupEngine.swift et Providers.swift).
import path from "node:path";
import { t } from "../l10n.ts";

export const PART_KINDS = ["folder", "home", "ai", "tools"] as const;
export type PartKind = (typeof PART_KINDS)[number];

/** Une partie copiée dans une version (`folders/<nom>`, `home`, `ai/<outil>/<catégorie>`, `tools`…). */
export interface BackupPart {
  kind: PartKind;
  /** Chemin de la partie dans la version (ex. « folders/workspaces »). */
  target: string;
  source: string;
  /** Motifs rsync (`--exclude-from`). */
  excludes: string[];
  /** Copie limitée à ces chemins relatifs (`--files-from`), sinon tout le dossier. */
  filesFrom: string[] | null;
}

export function backupPart(
  kind: PartKind,
  target: string,
  source: string,
  options: { excludes?: string[]; filesFrom?: string[] | null } = {},
): BackupPart {
  return { kind, target, source, excludes: options.excludes ?? [], filesFrom: options.filesFrom ?? null };
}

export type BackupErrorReason = "rsyncFailed" | "cancelled" | "destination";

/** Erreur de la sauvegarde ; `message` est le texte traduit (journal, état, notification). */
export class BackupError extends Error {
  private constructor(
    readonly reason: BackupErrorReason,
    message: string,
    readonly part?: string,
    readonly status?: number,
    /** Dernières lignes d'erreur de rsync (cause de l'échec). */
    readonly detail: string = "",
  ) {
    super(message);
    this.name = "BackupError";
  }

  static rsyncFailed(part: string, status: number, detail = ""): BackupError {
    const text = t("backup.error.rsync", part, status) + (detail ? `\n${detail}` : "");
    return new BackupError("rsyncFailed", text, part, status, detail);
  }

  static cancelled(): BackupError {
    return new BackupError("cancelled", t("backup.error.cancelled"));
  }

  static destination(message: string): BackupError {
    return new BackupError("destination", message);
  }

  override toString(): string {
    return this.message;
  }
}

export function isCancelled(error: unknown): boolean {
  return error instanceof BackupError && error.reason === "cancelled";
}

export type ProviderErrorReason =
  | "unreachable"
  | "missingPassword"
  | "missingImagePassword"
  | "mountFailed"
  | "image"
  | "imageBusy"
  | "notCreated";

/** Erreur d'un fournisseur de destination (montage, image, joignabilité). */
export class ProviderError extends Error {
  private constructor(
    readonly reason: ProviderErrorReason,
    /** Destination, chemin de l'image ou message de hdiutil selon le cas. */
    readonly subject: string,
    readonly code?: number,
  ) {
    super(ProviderError.describe(reason, subject, code));
    this.name = "ProviderError";
  }

  private static describe(reason: ProviderErrorReason, subject: string, code?: number): string {
    switch (reason) {
      case "unreachable":
        return t("destination.error.unreachable", subject);
      case "missingPassword":
        return t("destination.error.password", subject);
      case "missingImagePassword":
        return t("destination.error.image_password", path.basename(subject));
      case "notCreated":
        return t("destination.error.not_created", subject);
      case "mountFailed":
        return t("destination.error.mount", subject, code ?? 0);
      case "image":
        return t("destination.error.image", subject);
      case "imageBusy":
        return t("destination.error.image_busy", path.basename(subject));
    }
  }

  static unreachable(destination: string): ProviderError {
    return new ProviderError("unreachable", destination);
  }
  static missingPassword(destination: string): ProviderError {
    return new ProviderError("missingPassword", destination);
  }
  static missingImagePassword(imagePath: string): ProviderError {
    return new ProviderError("missingImagePassword", imagePath);
  }
  static mountFailed(destination: string, code: number): ProviderError {
    return new ProviderError("mountFailed", destination, code);
  }
  static image(message: string): ProviderError {
    return new ProviderError("image", message);
  }
  static imageBusy(imagePath: string): ProviderError {
    return new ProviderError("imageBusy", imagePath);
  }
  static notCreated(destination: string): ProviderError {
    return new ProviderError("notCreated", destination);
  }

  override toString(): string {
    return this.message;
  }
}

/** Texte d'une erreur, comme `String(describing:)` : le message traduit. */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
