// Secrets des destinations, dans le Trousseau macOS (jamais dans config.toml) : port de `Keychain` (ConfigStore.swift)
// et des usages de Providers.swift.
// - NAS (smb) : mot de passe Internet, serveur = hôte de `url`, compte = `username` ou l'utilisateur courant ;
//   l'entrée créée par le Finder est réutilisée.
// - Image chiffrée : mot de passe générique, service `fr.lenzotti.cairn.image.<destId>`, compte = nom de la machine,
//   libellé `Cairn — <service>`.
// L'ancienne clé `keychain` de config.toml est lue et conservée, mais jamais utilisée ni écrite.
import os from "node:os";
import type { DestinationConfig } from "./config.ts";
import { machineName } from "./machine.ts";
import { native } from "./native.ts";

export const KEYCHAIN_SERVICE_PREFIX = "fr.lenzotti.cairn.";

/** Libellé affiché par Trousseaux pour un mot de passe générique ajouté par Cairn. */
export function keychainLabel(service: string): string {
  return `Cairn — ${service}`;
}

/** Service du mot de passe de l'image d'une destination. */
export function imagePasswordService(destinationId: string): string {
  return `${KEYCHAIN_SERVICE_PREFIX}image.${destinationId}`;
}

/** Mot de passe générique (image chiffrée, jeton…). */
export function genericPassword(service: string, account: string): string | null {
  return native().keychainGetGeneric({ service, account });
}

/** Ajoute ou met à jour un mot de passe générique (libellé `Cairn — <service>` à l'ajout). */
export function setGenericPassword(password: string, service: string, account: string): void {
  native().keychainSetGeneric({ service, account }, password, keychainLabel(service));
}

/** Mot de passe de l'image d'une destination pour une machine (ce Mac par défaut). */
export async function imagePassword(destinationId: string, machine?: string): Promise<string | null> {
  return genericPassword(imagePasswordService(destinationId), machine ?? (await machineName()));
}

export async function setImagePassword(destinationId: string, password: string, machine?: string): Promise<void> {
  setGenericPassword(password, imagePasswordService(destinationId), machine ?? (await machineName()));
}

/** Hôte d'une adresse `smb://hôte/partage`, ou `null`. */
export function smbHost(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const host = new URL(url).hostname;
    return host ? host : null;
  } catch {
    return null;
  }
}

/** Compte SMB : `username` de la destination, sinon l'utilisateur courant (`NSUserName()`). */
export function smbAccount(dest: Pick<DestinationConfig, "username">): string {
  return dest.username ?? os.userInfo().username;
}

/** Mot de passe Internet d'un serveur (NAS en SMB) : réutilise l'entrée créée par le Finder si elle existe. */
export function internetPassword(server: string, account: string): string | null {
  return native().keychainGetInternet({ server, account, protocol: "smb" });
}

export function setInternetPassword(password: string, server: string, account: string): void {
  native().keychainSetInternet({ server, account, protocol: "smb" }, password);
}

/** Mot de passe du NAS d'une destination smb, ou `null` (pas d'adresse ou pas d'entrée). */
export function smbPassword(dest: Pick<DestinationConfig, "url" | "username">): string | null {
  const host = smbHost(dest.url);
  return host ? internetPassword(host, smbAccount(dest)) : null;
}

/** Range le mot de passe du NAS d'une destination smb ; `false` si l'adresse n'a pas d'hôte. */
export function setSmbPassword(dest: Pick<DestinationConfig, "url" | "username">, password: string): boolean {
  const host = smbHost(dest.url);
  if (!host) return false;
  setInternetPassword(password, host, smbAccount(dest));
  return true;
}
