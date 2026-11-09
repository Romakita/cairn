// Image disque sparsebundle APFS posée sur la destination, chiffrée en AES-256 si demandé (port de `SparseImage`,
// Providers.swift). Commandes exactes de la 0.8.0 (parity/platform.md §2.1) : `/usr/bin/hdiutil`, `LC_ALL=C LANG=C`,
// mot de passe sur stdin terminé par `\0`, jamais en argument.
import { randomInt } from "node:crypto";
import path from "node:path";
import { readdir, stat } from "../fs-promises.ts";
import { run } from "../process.ts";
import type { BackupSecrets } from "./secrets.ts";
import { ProviderError } from "./types.ts";

export const HDIUTIL = "/usr/bin/hdiutil";
export const PLUTIL = "/usr/bin/plutil";

/** Résultat d'une commande hdiutil : code et sortie (stdout puis stderr, comme un seul tuyau en Swift). */
export interface HdiutilResult {
  code: number;
  output: string;
}

export type HdiutilRunner = (args: readonly string[], stdin?: string) => Promise<HdiutilResult>;

/** L'avertissement « -nobrowse is deprecated » n'apporte rien au message d'erreur. */
export function cleanHdiutilOutput(text: string): string {
  return text
    .split("\n")
    .filter((l) => !l.includes("WARNING:") || !l.includes("deprecated"))
    .join("\n");
}

/** hdiutil réel : messages en anglais, mot de passe sur stdin terminé par `\0`. */
export const runHdiutil: HdiutilRunner = async (args, stdin) => {
  try {
    const r = await run(HDIUTIL, args, {
      extraEnv: { LC_ALL: "C", LANG: "C" },
      stdin: stdin === undefined ? undefined : `${stdin}\0`,
    });
    const output = [r.stdout, r.stderrTail.join("\n")].filter((s) => s.length > 0).join("\n");
    return { code: r.code ?? 127, output: cleanHdiutilOutput(output) };
  } catch {
    return { code: 127, output: "" };
  }
};

/** Points de montage d'une sortie `hdiutil attach -plist` (converti par `plutil`). */
export async function mountPointsFromPlist(plist: string): Promise<string[]> {
  const start = plist.indexOf("<?xml");
  const xml = start >= 0 ? plist.slice(start) : plist;
  try {
    const r = await run(PLUTIL, ["-convert", "json", "-o", "-", "-"], { stdin: xml, stderr: "ignore" });
    if (r.code !== 0) return [];
    const value = JSON.parse(r.stdout) as { "system-entities"?: Array<{ "mount-point"?: unknown }> };
    return (value["system-entities"] ?? [])
      .map((e) => e["mount-point"])
      .filter((m): m is string => typeof m === "string");
  } catch {
    return [];
  }
}

/** Erreur d'un `hdiutil attach` raté. EAGAIN : le verrou de l'image est tenu par un autre processus. */
export function attachFailure(output: string, imagePath: string): ProviderError {
  // hdiutil répond parfois dans la langue du Mac malgré LC_ALL : message anglais et français.
  const busy = ["Resource temporarily unavailable", "Ressources temporairement indisponibles"];
  if (busy.some((b) => output.includes(b))) return ProviderError.imageBusy(imagePath);
  return ProviderError.image(output.trim());
}

const PASSWORD_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

/** Mot de passe d'une nouvelle image : `XXXXXX-XXXXXX-XXXXXX-XXXXXX`, sans 0/O/1/l/I. */
export function generateImagePassword(): string {
  const group = () => Array.from({ length: 6 }, () => PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)]).join("");
  return [group(), group(), group(), group()].join("-");
}

export const IMAGE_PASSWORD_PATTERN = /^[A-HJ-NP-Za-km-z2-9]{6}(-[A-HJ-NP-Za-km-z2-9]{6}){3}$/;

/** Images Cairn posées sur une destination (une par machine), triées. */
export async function imagesAt(base: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(base);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.startsWith("cairn-") && n.endsWith(".sparsebundle"))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((n) => path.join(base, n));
}

export interface ImageCheck {
  ok: boolean;
  output: string;
}

export interface SparseImageOptions {
  secrets: BackupSecrets;
  hdiutil?: HdiutilRunner;
}

export class SparseImage {
  readonly path: string;
  readonly destinationId: string;
  /** Compte du mot de passe dans le Trousseau : la machine de l'image. */
  readonly machine: string;
  private mountPoint: string | null = null;
  private readonly hdiutil: HdiutilRunner;
  private readonly secrets: BackupSecrets;

  private constructor(
    imagePath: string,
    destinationId: string,
    machine: string,
    readonly encrypted: boolean,
    options: SparseImageOptions,
  ) {
    this.path = imagePath;
    this.destinationId = destinationId;
    this.machine = machine;
    this.hdiutil = options.hdiutil ?? runHdiutil;
    this.secrets = options.secrets;
  }

  /** Image de cette machine sur la destination : `<racine>/cairn-<machine>.sparsebundle`. */
  static forMachine(
    root: string,
    destinationId: string,
    encrypted: boolean,
    machine: string,
    options: SparseImageOptions,
  ): SparseImage {
    return new SparseImage(
      path.join(root, `cairn-${machine}.sparsebundle`),
      destinationId,
      machine,
      encrypted,
      options,
    );
  }

  /** Image existante (d'une autre machine pour une restauration) ; le chiffrement est lu sur l'image elle-même. */
  static async existing(imagePath: string, destinationId: string, options: SparseImageOptions): Promise<SparseImage> {
    const name = path.basename(imagePath);
    const machine = name.slice("cairn-".length, name.length - ".sparsebundle".length);
    const hdiutil = options.hdiutil ?? runHdiutil;
    const encrypted = (await hdiutil(["isencrypted", imagePath])).output.includes("encrypted: YES");
    return new SparseImage(imagePath, destinationId, machine, encrypted, options);
  }

  get mounted(): string | null {
    return this.mountPoint;
  }

  async exists(): Promise<boolean> {
    try {
      await stat(this.path);
      return true;
    } catch {
      return false;
    }
  }

  /** Mot de passe de l'image (Trousseau). */
  password(): Promise<string | null> {
    return this.secrets.imagePassword(this.destinationId, this.machine);
  }

  /**
   * Crée l'image ; renvoie son mot de passe (à montrer une seule fois) si elle est chiffrée. Un mot de passe déjà rangé
   * pour cette destination et cette machine est repris, jamais remplacé : il ouvre peut-être une image laissée à
   * l'ancien emplacement de la destination (76e40ec).
   */
  async create(size = "4t", provided?: string): Promise<string | null> {
    const args = ["create", "-size", size, "-type", "SPARSEBUNDLE", "-fs", "APFS", "-volname", "Cairn", this.path];
    let pw: string | null = null;
    if (this.encrypted) {
      const existing = await this.password();
      pw = provided ?? existing ?? generateImagePassword();
      args.push("-encryption", "AES-256", "-stdinpass");
      if (pw !== existing) await this.secrets.setImagePassword(this.destinationId, this.machine, pw);
    }
    const r = await this.hdiutil(args, pw ?? undefined);
    if (r.code !== 0) throw ProviderError.image(r.output.trim());
    return pw;
  }

  /** Monte l'image (invisible dans le Finder) et renvoie son point de montage. */
  async attach(provided?: string | null): Promise<string> {
    const args = ["attach", "-nobrowse", "-noautoopen", "-plist", this.path];
    let pw: string | null = null;
    if (this.encrypted) {
      pw = provided ?? (await this.password());
      if (pw === null) throw ProviderError.missingImagePassword(this.path);
      args.splice(1, 0, "-stdinpass");
    }
    const r = await this.hdiutil(args, pw ?? undefined);
    const mp = r.code === 0 ? (await mountPointsFromPlist(r.output))[0] : undefined;
    if (!mp) throw attachFailure(r.output, this.path);
    this.mountPoint = mp;
    return mp;
  }

  async detach(): Promise<void> {
    const mp = this.mountPoint;
    if (!mp) return;
    if ((await this.hdiutil(["detach", mp])).code !== 0) await this.hdiutil(["detach", "-force", mp]);
    this.mountPoint = null;
  }

  /**
   * Contrôle de l'image avec `hdiutil verify` (image détachée). Un sparsebundle n'a pas de somme de contrôle globale :
   * « has no checksum » veut dire que l'image s'ouvre et compte comme réussi ; toute autre erreur est un échec.
   */
  async verify(provided?: string | null): Promise<ImageCheck> {
    const args = ["verify", this.path];
    let pw: string | null = null;
    if (this.encrypted) {
      pw = provided ?? (await this.password());
      if (pw === null) return { ok: false, output: ProviderError.missingImagePassword(this.path).message };
      args.splice(1, 0, "-stdinpass");
    }
    const r = await this.hdiutil(args, pw ?? undefined);
    const text = r.output.trim();
    return { ok: r.code === 0 || text.includes("has no checksum"), output: text };
  }

  /** Récupère l'espace libéré par la rétention. */
  async compact(provided?: string | null): Promise<void> {
    const pw = this.encrypted ? (provided ?? (await this.password())) : null;
    await this.hdiutil(
      ["compact", "-batteryallowed", this.path, ...(this.encrypted ? ["-stdinpass"] : [])],
      pw ?? undefined,
    );
  }
}
