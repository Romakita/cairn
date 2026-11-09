// Destination prête à l'emploi : fournisseur + image éventuelle (port de `DestinationSession`, Providers.swift).
// Une destination SMB passe toujours par une image (liens physiques et droits fiables), une destination chiffrée
// aussi (`usesImage = smb || encrypted`).
import type { DestinationConfig } from "../config.ts";
import type { HdiutilRunner, ImageCheck } from "./image.ts";
import { imagesAt, SparseImage } from "./image.ts";
import { type BackupProvider, LocalProvider, type SMBDependencies, SMBProvider } from "./providers.ts";
import type { BackupSecrets } from "./secrets.ts";
import { ProviderError } from "./types.ts";

export interface SessionDependencies extends Omit<SMBDependencies, "secrets"> {
  secrets: BackupSecrets;
  /** Nom de cette machine (image `cairn-<machine>.sparsebundle`, compte du mot de passe). */
  machine: string;
  hdiutil?: HdiutilRunner;
  /** Taille d'une nouvelle image (`-size`), `4t` par défaut. */
  imageSize?: string;
}

export function providerFor(d: DestinationConfig, deps: SessionDependencies): BackupProvider {
  return d.provider === "smb" ? new SMBProvider(d, deps) : new LocalProvider(d);
}

export class DestinationSession {
  readonly provider: BackupProvider;
  private image: SparseImage | null = null;
  root: string | null = null;
  imageBase: string | null = null;
  /** Mot de passe généré à la création de l'image (à montrer une fois). */
  newImagePassword: string | null = null;
  /** Mot de passe de l'image saisi pour cette session (le Trousseau d'un Mac neuf est vide). */
  imagePassword: string | null = null;

  constructor(
    readonly destination: DestinationConfig,
    private readonly deps: SessionDependencies,
  ) {
    this.provider = providerFor(destination, deps);
  }

  /** Une image est utilisée sur un NAS ou si le chiffrement est demandé. */
  get usesImage(): boolean {
    return this.destination.provider === "smb" || this.destination.encrypted;
  }

  /** Mot de passe du partage SMB saisi pour cette session. */
  set sharePassword(value: string | null) {
    if (this.provider instanceof SMBProvider) this.provider.password = value;
  }

  get mountedImage(): SparseImage | null {
    return this.image;
  }

  /**
   * Ouvre la destination. `createIfMissing: false` (simulation, restauration) n'écrit rien : sans image ni dossier,
   * l'erreur est `notCreated`. En restauration, l'image d'une autre machine est reprise si celle de ce Mac n'existe
   * pas ; `preferredImage` (nom choisi par l'utilisateur) est prise si elle existe (156f978).
   */
  async open(createIfMissing = true, preferredImage?: string): Promise<string> {
    const base = await this.provider.prepare(createIfMissing);
    this.imageBase = base;
    if (!this.usesImage) {
      this.root = base;
      return base;
    }
    const options = { secrets: this.deps.secrets, hdiutil: this.deps.hdiutil };
    if (preferredImage) {
      const chosen = (await imagesAt(base)).find((p) => p.endsWith(`/${preferredImage}`));
      if (chosen) return this.attach(await SparseImage.existing(chosen, this.destination.id, options));
    }
    let img = SparseImage.forMachine(base, this.destination.id, this.destination.encrypted, this.deps.machine, options);
    if (!(await img.exists())) {
      if (createIfMissing) {
        this.newImagePassword = await img.create(this.deps.imageSize ?? "4t");
        return this.attach(img);
      }
      const other = (await imagesAt(base))[0];
      if (!other) throw ProviderError.notCreated(this.destination.id);
      img = await SparseImage.existing(other, this.destination.id, options);
    }
    return this.attach(img);
  }

  private async attach(img: SparseImage): Promise<string> {
    const mp = await img.attach(this.imagePassword);
    this.image = img;
    this.root = mp;
    return mp;
  }

  /** Détache l'image (puis la compacte si demandé) et démonte ce que Cairn a monté. */
  async close(compact = false): Promise<void> {
    try {
      await this.image?.detach();
      if (compact) await this.image?.compact(this.imagePassword);
    } finally {
      await this.provider.finish();
    }
  }

  /**
   * `hdiutil verify` de l'image utilisée (`null` sans image). À appeler avant `close` : l'image est détachée pour le
   * contrôle, le partage qui la porte reste monté jusqu'à `close`.
   */
  async verifyImage(): Promise<ImageCheck | null> {
    const image = this.image;
    if (!image) return null;
    await image.detach();
    return image.verify(this.imagePassword);
  }
}
