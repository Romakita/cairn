// Connexion ouverte pendant la saisie d'une destination (port de `ProbeSession`, DestinationProbe.swift) : le
// partage monté pour vérifier reste monté pour le parcours, puis `close()` démonte ce que la session a monté (un
// partage déjà monté dans le Finder est conservé, voir `SMBProvider`). Rien n'est écrit dans le Trousseau.
import path from "node:path";
import { type BackupProvider, type SMBDependencies, SMBProvider } from "../backup/providers.ts";
import { keychainSecrets } from "../backup/secrets.ts";
import { ProviderError } from "../backup/types.ts";
import { destination } from "../config.ts";
import { failed, type ProbeOutcome, type ProbeResult, succeeded } from "./failure.ts";
import { checkFolder, failureForMountStatus, smbParts } from "./probe.ts";

/** Fournisseur du partage vérifié : `SMBProvider` avec le mot de passe de session (sinon celui du Trousseau). */
export type ShareProviderFactory = (
  shareURL: string,
  username: string | undefined,
  password: string | null,
) => BackupProvider;

/** Fournisseur réel, avec des dépendances injectables (montage simulé en test). */
export function smbShareProvider(deps: SMBDependencies = { secrets: keychainSecrets }): ShareProviderFactory {
  return (shareURL, username, password) => {
    const p = new SMBProvider(destination("probe", "smb", { url: shareURL, ...(username ? { username } : {}) }), deps);
    p.password = password;
    return p;
  };
}

export class ProbeSession {
  private provider: BackupProvider | null = null;
  host: string | null = null;
  share: string | null = null;
  /** Point de montage du partage (racine du navigateur). */
  mountRoot: string | null = null;

  constructor(
    private readonly makeProvider: ShareProviderFactory = smbShareProvider(),
    /** Machine de ce Mac pour repérer son image (par défaut `machineName()`). */
    private readonly machine?: string,
  ) {}

  /**
   * Sonde TCP 445 (3 s), puis montage sans interface avec le mot de passe de session (ou celui du Trousseau).
   * Renvoie la racine du partage.
   */
  async connect(address: string, username: string, password: string | null): Promise<ProbeOutcome<string>> {
    await this.close();
    const parts = smbParts(address);
    if (!parts) return failed({ kind: "invalidAddress", address });
    const shareURL = `smb://${parts.host}/${parts.share}`;
    const p = this.makeProvider(shareURL, username === "" ? undefined : username, password ? password : null);
    try {
      const root = await p.prepare(false);
      this.provider = p;
      this.host = parts.host;
      this.share = parts.share;
      this.mountRoot = root;
      return succeeded(root);
    } catch (error) {
      await p.finish().catch(() => {});
      if (error instanceof ProviderError) {
        if (error.reason === "missingPassword") return failed({ kind: "passwordRequired" });
        if (error.reason === "mountFailed") return failed(failureForMountStatus(error.code ?? -1, shareURL));
      }
      return failed({ kind: "unreachable", host: parts.host });
    }
  }

  /** Chemin local d'un sous-dossier du partage monté. */
  folder(subpath: readonly string[]): string | null {
    return this.mountRoot === null ? null : path.join(this.mountRoot, ...subpath);
  }

  /** Vérification complète d'une adresse SMB : connexion puis contrôle du dossier. */
  async check(address: string, username: string, password: string | null): Promise<ProbeResult> {
    const c = await this.connect(address, username, password);
    if (!c.ok) return { kind: "failed", failure: c.failure };
    const folder = this.folder(smbParts(address)?.subpath ?? []);
    return folder === null
      ? { kind: "failed", failure: { kind: "notFound", path: address } }
      : checkFolder(folder, this.machine);
  }

  get isConnected(): boolean {
    return this.mountRoot !== null;
  }

  /** Démonte uniquement ce que la session a monté. */
  async close(): Promise<void> {
    const p = this.provider;
    this.provider = null;
    this.mountRoot = null;
    this.host = null;
    this.share = null;
    if (p) await p.finish().catch(() => {});
  }
}
