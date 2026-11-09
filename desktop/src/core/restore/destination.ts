// Ouverture d'une destination pour la restauration (port de la boucle de `CLI.restore` et de l'écran Restauration).
// Jamais de création : `open(createIfMissing: false)` (ni image, ni dossier, 3692993). Sur un Mac neuf le Trousseau
// est vide : le mot de passe du partage puis celui de l'image sont demandés (`ask`), une seule fois chacun.
import type { DestinationSession } from "../backup/session.ts";
import { ProviderError } from "../backup/types.ts";
import { type RestoreVersion, versionsOnDestination } from "./source.ts";

export type PasswordKind = "share" | "image";

/** Demande un mot de passe (sans écho en CLI, champ dans l'app) ; `null` : abandon. */
export type PasswordPrompt = (kind: PasswordKind) => Promise<string | null>;

export interface OpenedDestination {
  root: string;
  versions: RestoreVersion[];
}

/**
 * Ouvre `session` sans rien créer et liste les versions de toutes les machines. Renvoie `null` si l'utilisateur
 * abandonne la saisie d'un mot de passe ; toute autre erreur (destination injoignable, `notCreated`…) est relancée.
 * L'appelant ferme la session (`close()`) après la restauration.
 */
export async function openForRestore(
  session: DestinationSession,
  ask: PasswordPrompt,
  preferredImage?: string,
): Promise<OpenedDestination | null> {
  let shareAsked = false;
  let imageAsked = false;
  for (;;) {
    try {
      const root = await session.open(false, preferredImage);
      return { root, versions: await versionsOnDestination(root) };
    } catch (error) {
      if (!(error instanceof ProviderError)) throw error;
      if (error.reason === "missingPassword" && !shareAsked) {
        shareAsked = true;
        const pw = await ask("share");
        if (pw === null) return null;
        session.sharePassword = pw;
      } else if (error.reason === "missingImagePassword" && !imageAsked) {
        imageAsked = true;
        // Le partage reste à démonter avant de recommencer (comme `s.close()` de la 0.8.0).
        await session.close();
        const pw = await ask("image");
        if (pw === null) return null;
        session.imagePassword = pw;
      } else {
        throw error;
      }
    }
  }
}
