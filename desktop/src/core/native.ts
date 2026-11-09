// Contrat du module natif (desktop/native, N-API) : ce que Node ne sait pas faire sur macOS.
// Le main et la CLI chargent le module avec `loadNative(chemin)` au démarrage ; les tests aussi (test/setup.ts).
import { createRequire } from "node:module";

/** Entrée « mot de passe Internet » du Trousseau (partagée avec le Finder pour SMB). */
export interface InternetPasswordQuery {
  server: string;
  account: string;
  /** Protocole Trousseau ; `smb` pour les partages. */
  protocol: "smb";
}

/** Entrée « mot de passe générique » du Trousseau (mot de passe d'image : service `fr.lenzotti.cairn.image.<id>`). */
export interface GenericPasswordQuery {
  service: string;
  account: string;
}

export interface MountResult {
  /** Point de montage, par exemple `/Volumes/home`. */
  mountPoint: string;
}

export interface NativeBinding {
  /** Mot de passe générique, ou `null` s'il n'existe pas. */
  keychainGetGeneric(query: GenericPasswordQuery): string | null;
  /** Ajoute ou met à jour un mot de passe générique ; `label` est le libellé affiché par Trousseaux. */
  keychainSetGeneric(query: GenericPasswordQuery, password: string, label: string): void;
  keychainGetInternet(query: InternetPasswordQuery): string | null;
  keychainSetInternet(query: InternetPasswordQuery, password: string): void;

  /**
   * Monte `smb://host/share` sans interface (montage souple). Rejette une erreur dont `code` est le code NetFS
   * (80, 13, -5045… : authentification ; 2, -5998… : introuvable ; voir parity/behavior.md §1.1).
   */
  netfsMount(url: string, user: string, password: string | null): Promise<MountResult>;

  /** `flock` exclusif non bloquant sur un descripteur : `true` si le verrou est pris, `false` s'il est tenu ailleurs. */
  flockTryExclusive(fd: number): boolean;
  /** `flock` exclusif bloquant (journal d'activité). Asynchrone : n'immobilise pas la boucle d'événements. */
  flockExclusive(fd: number): Promise<void>;
  flockUnlock(fd: number): void;

  /** Espace libre « pour usage important » du volume (inclut le purgeable APFS), en octets, ou `null`. */
  volumeImportantCapacity(path: string): number | null;
}

let binding: NativeBinding | null = null;

/** Charge le module natif compilé (`cairn_native.node`). À appeler une fois au démarrage. */
export function loadNative(file: string): NativeBinding {
  const require = createRequire(file);
  binding = require(file) as NativeBinding;
  return binding;
}

/** Remplace le module natif (tests). */
export function setNative(value: NativeBinding | null): void {
  binding = value;
}

/** Module natif chargé ; lève une erreur claire s'il ne l'est pas. */
export function native(): NativeBinding {
  if (!binding) throw new Error("Cairn native module is not loaded");
  return binding;
}
