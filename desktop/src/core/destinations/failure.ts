// Échecs et résultats de la vérification d'une destination (port de `ProbeFailure`, `ProbeResult`, `ExistingImage`
// et `FolderEntry`, DestinationProbe.swift).
import { t } from "../l10n.ts";

export type InvalidName = "empty" | "forbiddenCharacter" | "exists";

export type ProbeFailure =
  /** Adresse SMB illisible (pas de la forme `smb://hôte/partage`). */
  | { kind: "invalidAddress"; address: string }
  /** Le serveur ne répond pas sur le port SMB. */
  | { kind: "unreachable"; host: string }
  /** Ni mot de passe saisi ni entrée dans le Trousseau. */
  | { kind: "passwordRequired" }
  | { kind: "authenticationFailed" }
  | { kind: "mountFailed"; code: number }
  | { kind: "notFound"; path: string }
  | { kind: "readOnly"; path: string }
  | { kind: "volumeMissing"; volume: string }
  /** Contenu d'un dossier illisible (navigateur). */
  | { kind: "accessDenied"; path: string }
  | { kind: "invalidName"; reason: InvalidName };

/** Résultat d'une opération qui peut échouer avec un `ProbeFailure`. */
export type ProbeOutcome<T> = { ok: true; value: T } | { ok: false; failure: ProbeFailure };

export function succeeded<T>(value: T): ProbeOutcome<T> {
  return { ok: true, value };
}

export function failed<T = never>(failure: ProbeFailure): ProbeOutcome<T> {
  return { ok: false, failure };
}

/** Texte de l'échec. */
export function describeProbeFailure(f: ProbeFailure): string {
  switch (f.kind) {
    case "invalidAddress":
      return t("probe.error.invalid_address", f.address);
    case "unreachable":
      return t("probe.error.unreachable", f.host);
    case "passwordRequired":
      return t("probe.error.password_required");
    case "authenticationFailed":
      return t("probe.error.authentication");
    case "mountFailed":
      return t("probe.error.mount", f.code);
    case "notFound":
      return t("probe.error.not_found", f.path);
    case "readOnly":
      return t("probe.error.read_only", f.path);
    case "volumeMissing":
      return t("probe.error.volume_missing", f.volume);
    case "accessDenied":
      return t("probe.error.access_denied", f.path);
    case "invalidName":
      return f.reason === "empty"
        ? t("probe.error.name_empty")
        : f.reason === "forbiddenCharacter"
          ? t("probe.error.name_character")
          : t("probe.error.name_exists");
  }
}

/** Ce qu'il faut faire pour s'en sortir (vide pour un nom refusé). */
export function probeFailureHint(f: ProbeFailure): string {
  switch (f.kind) {
    case "invalidAddress":
      return t("probe.hint.address");
    case "unreachable":
      return t("probe.hint.unreachable");
    case "passwordRequired":
    case "authenticationFailed":
      return t("probe.hint.password");
    case "mountFailed":
      return t("probe.hint.retry");
    case "notFound":
    case "readOnly":
    case "accessDenied":
      return t("probe.hint.other_folder");
    case "volumeMissing":
      return t("probe.hint.volume");
    case "invalidName":
      return "";
  }
}

/** Sauvegarde Cairn trouvée dans un dossier (`cairn-<machine>.sparsebundle`). */
export interface ExistingImage {
  machine: string;
  path: string;
  isThisMac: boolean;
}

export type ProbeResult =
  | { kind: "ok"; freeBytes: number | null; existingImages: ExistingImage[] }
  | { kind: "failed"; failure: ProbeFailure };

/** Dossier proposé par le navigateur. */
export interface FolderEntry {
  name: string;
  path: string;
}
