// Ajout et modification d'une destination vérifiée (port de `newDestinationID`, `updatingConnection` et de
// `saveNewDestination` / `saveEditedDestination`, DestinationProbe.swift, DestinationRemoval.swift,
// DestinationForm.swift). `config.toml` est écrit d'abord ; le Trousseau seulement après une écriture réussie (156f978).
import { type CairnConfig, type DestinationConfig, defaultConfig, type Provider } from "../config.ts";
import { setSmbPassword } from "../config-secrets.ts";
import type { ConfigStore } from "../config-store.ts";
import { ONBOARDING_DESTINATION_ID } from "../onboarding.ts";

/** Identifiant d'une nouvelle destination : `main` pour la première, puis `nas` / `disk`, `nas-2`… */
export function newDestinationID(provider: Provider, existing: readonly string[]): string {
  if (existing.length === 0) return ONBOARDING_DESTINATION_ID;
  const base = provider === "smb" ? "nas" : "disk";
  if (!existing.includes(base)) return base;
  let n = 2;
  while (existing.includes(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

/**
 * Destination modifiée : seule la connexion (chemin, adresse, identifiant de connexion) vient de `edited`.
 * L'identifiant, dont dépendent le mot de passe de l'image et l'état des sauvegardes, le type, le chiffrement, la
 * rétention et l'ancienne clé `keychain` sont conservés.
 */
export function updatingConnection(original: DestinationConfig, edited: DestinationConfig): DestinationConfig {
  const d: DestinationConfig = { ...original };
  for (const key of ["path", "url", "username"] as const) {
    if (edited[key] === undefined) delete d[key];
    else d[key] = edited[key];
  }
  return d;
}

/** Range le mot de passe d'un NAS (injectable : jamais le vrai Trousseau en test). */
export type SMBPasswordWriter = (d: DestinationConfig, password: string) => void;

const writeKeychain: SMBPasswordWriter = (d, password) => {
  setSmbPassword(d, password);
};

export interface SavedDestination {
  destination: DestinationConfig;
  /** La destination est enregistrée mais le mot de passe n'a pas pu être rangé (il sera redemandé). */
  keychainError: string | null;
}

async function currentConfig(store: ConfigStore): Promise<CairnConfig> {
  return (await store.exists()) ? (await store.load()).config : defaultConfig();
}

function storePassword(d: DestinationConfig, password: string, write: SMBPasswordWriter): string | null {
  if (d.provider !== "smb" || password === "") return null;
  try {
    write(d, password);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Enregistre une destination vérifiée sous un nouvel identifiant. Si l'écriture de `config.toml` échoue (erreur levée,
 * par exemple `ConfigSaveError`), rien n'est écrit au Trousseau.
 */
export async function saveNewDestination(
  store: ConfigStore,
  verified: Omit<DestinationConfig, "id">,
  password: string,
  writePassword: SMBPasswordWriter = writeKeychain,
): Promise<SavedDestination> {
  const config = await currentConfig(store);
  const id = newDestinationID(
    verified.provider,
    config.destinations.map((d) => d.id),
  );
  const d: DestinationConfig = { ...verified, id };
  config.destinations.push(d);
  await store.save(config);
  return { destination: d, keychainError: storePassword(d, password, writePassword) };
}

/**
 * Enregistre une destination modifiée et vérifiée : seule la connexion change. Un mot de passe vide garde celui du
 * Trousseau, qui n'est pas modifié ; sinon il est rangé après l'écriture de `config.toml`.
 */
export async function saveEditedDestination(
  store: ConfigStore,
  original: DestinationConfig,
  edited: DestinationConfig,
  password: string,
  writePassword: SMBPasswordWriter = writeKeychain,
): Promise<SavedDestination> {
  const config = await currentConfig(store);
  const index = config.destinations.findIndex((x) => x.id === original.id);
  if (index < 0) throw new Error(`unknown destination ${original.id}`);
  const d = updatingConnection(config.destinations[index]!, edited);
  config.destinations[index] = d;
  await store.save(config);
  return { destination: d, keychainError: storePassword(d, password, writePassword) };
}
