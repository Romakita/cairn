// Accès aux mots de passe de la sauvegarde (image chiffrée, partage SMB), par injection : le Trousseau en vrai
// (config-secrets.ts, module natif), une mémoire dans les tests (jamais le vrai Trousseau, qui n'a pas de
// suppression).
import { genericPassword, imagePasswordService, internetPassword, setGenericPassword } from "../config-secrets.ts";

export interface BackupSecrets {
  /** Mot de passe de l'image d'une destination pour une machine (service `fr.lenzotti.cairn.image.<id>`). */
  imagePassword(destinationId: string, machine: string): Promise<string | null>;
  setImagePassword(destinationId: string, machine: string, password: string): Promise<void>;
  /** Mot de passe Internet SMB (celui du Finder s'il existe). */
  internetPassword(server: string, account: string): Promise<string | null>;
}

/** Trousseau macOS, mêmes services et comptes que la 0.8.0. */
export const keychainSecrets: BackupSecrets = {
  async imagePassword(destinationId, machine) {
    return genericPassword(imagePasswordService(destinationId), machine);
  },
  async setImagePassword(destinationId, machine, password) {
    await setGenericPassword(password, imagePasswordService(destinationId), machine);
  },
  async internetPassword(server, account) {
    return internetPassword(server, account);
  },
};

/** Mots de passe en mémoire (tests, session sans Trousseau). */
export class MemorySecrets implements BackupSecrets {
  readonly images = new Map<string, string>();
  readonly internet = new Map<string, string>();

  async imagePassword(destinationId: string, machine: string): Promise<string | null> {
    return this.images.get(`${imagePasswordService(destinationId)}|${machine}`) ?? null;
  }
  async setImagePassword(destinationId: string, machine: string, password: string): Promise<void> {
    this.images.set(`${imagePasswordService(destinationId)}|${machine}`, password);
  }
  async internetPassword(server: string, account: string): Promise<string | null> {
    return this.internet.get(`${server}|${account}`) ?? null;
  }
}
