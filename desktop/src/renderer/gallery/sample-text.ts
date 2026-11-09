// Textes de la galerie. Les clés existantes viennent des catalogues (`t()`, locales/*.json) ; les clés ajoutées pour
// les nouvelles stories de l'app Electron ont leur texte ici tant qu'elles ne sont pas dans les catalogues.
import { currentLanguage, t } from "../../core/l10n.ts";

/** Clés propres à la galerie Electron, absentes des catalogues de la 0.8.0 : [anglais, français]. */
export const GALLERY_EXTRA_TEXT: Readonly<Record<string, readonly [string, string]>> = {
  "gallery.story.fields.password": ["Password field", "Champ de mot de passe"],
  "gallery.story.fields.toggle": ["Toggle", "Interrupteur"],
  "gallery.story.fields.checkbox": ["Checkbox", "Case à cocher"],
  "gallery.story.fields.number_stepper": ["Number stepper", "Sélecteur de nombre"],
  "gallery.story.feedback.progress_bar": ["Progress bar", "Barre de progression"],
  "gallery.story.feedback.spinner": ["Spinner", "Roue d'attente"],
  "gallery.story.feedback.stat": ["Key figures", "Chiffres clés"],
  "gallery.story.containers.sheet": ["Sheet", "Feuille"],
  "gallery.story.containers.table": ["Table", "Tableau"],
  "gallery.story.charts.project_bar": ["Project bar", "Barre de projet"],
  "gallery.state.normal": ["Normal", "Normal"],
  "gallery.state.hover": ["Hover", "Survol"],
  "gallery.state.disabled": ["Disabled", "Désactivé"],
  "gallery.state.loading": ["Loading", "Chargement"],
  "gallery.state.destructive": ["Destructive", "Destructif"],
  "gallery.state.invalid": ["Rejected", "Refusé"],
  "gallery.state.checked": ["Checked", "Coché"],
  "gallery.state.unchecked": ["Unchecked", "Non coché"],
  "gallery.state.mixed": ["Mixed", "Mixte"],
  "gallery.state.indeterminate": ["Indeterminate", "Indéterminé"],
  "gallery.state.selected": ["Selected", "Sélectionné"],
  "gallery.control.loading": ["Loading", "Chargement"],
  "gallery.control.indeterminate": ["Indeterminate", "Indéterminé"],
  "gallery.option.danger_button": ["Danger", "Danger"],
  "gallery.export.subtitle_themes": ["Each story in light and dark.", "Chaque story en clair et en sombre."],
  "gallery.toolbar.theme": ["Theme", "Thème"],
  "gallery.toolbar.language": ["Language", "Langue"],
  "gallery.stories": ["Stories", "Stories"],
  "gallery.sample.verify": ["Verify integrity", "Vérifier l'intégrité"],
  "gallery.sample.reason_no_backup": [
    "Nothing to verify: this destination has no backup yet.",
    "Rien à vérifier : cette destination n'a encore aucune sauvegarde.",
  ],
  "gallery.sample.reason_backup_running": [
    "Available once the current backup is finished.",
    "Disponible dès la fin de la sauvegarde en cours.",
  ],
  "gallery.sample.install_update": ["Install update", "Installer la mise à jour"],
  "gallery.sample.password": ["Password", "Mot de passe"],
  "gallery.sample.show_password": ["Show password", "Afficher le mot de passe"],
  "gallery.sample.hide_password": ["Hide password", "Masquer le mot de passe"],
  "gallery.sample.retention": ["Versions kept", "Versions gardées"],
  "gallery.sample.decrease": ["Fewer", "Moins"],
  "gallery.sample.increase": ["More", "Plus"],
  "gallery.sample.versions": ["{1} versions", "{1} versions"],
  "gallery.sample.min_versions": ["At least one version is kept.", "Au moins une version est gardée."],
  "gallery.sample.max_versions": ["At most 30 versions are kept.", "30 versions au plus sont gardées."],
  "gallery.sample.copying": ["Copying files", "Copie des fichiers"],
  "gallery.sample.counting": ["Counting files", "Comptage des fichiers"],
  "gallery.sample.loading": ["Loading…", "Chargement…"],
  "gallery.sample.in_progress": ["In progress", "En cours"],
  "gallery.sample.repositories": ["Repositories", "Dépôts"],
  "gallery.sample.freeable": ["Can be freed", "Libérable"],
  "gallery.sample.last_backup": ["Last backup", "Dernière sauvegarde"],
  "gallery.sample.today": ["Today, 09:12", "Aujourd'hui, 09:12"],
  "gallery.sample.in_repos": ["in {1} repositories", "dans {1} dépôts"],
  "gallery.sample.sheet_title": ["Delete 3 merged branches?", "Supprimer 3 branches fusionnées ?"],
  "gallery.sample.sheet_text": [
    "They are deleted from this Mac only; the remote keeps them.",
    "Elles sont supprimées de ce Mac seulement ; le dépôt distant les garde.",
  ],
  "gallery.sample.cancel": ["Cancel", "Annuler"],
  "gallery.sample.open_sheet": ["Open as a modal", "Ouvrir en modale"],
  "gallery.sample.reveal": ["Show in Finder", "Afficher dans le Finder"],
  "gallery.sample.copy_path": ["Copy path", "Copier le chemin"],
  "gallery.sample.trash": ["Move to Trash", "Mettre à la corbeille"],
  "gallery.sample.steps": ["Setup steps", "Étapes de configuration"],
  "gallery.sample.breadcrumb": ["Folder path", "Chemin du dossier"],
  "gallery.sample.suggestions": ["Suggestions", "Suggestions"],
  "gallery.sample.path_label": ["Folder to back up", "Dossier à sauvegarder"],
  "gallery.sample.disk_used": ["Disk used", "Espace utilisé"],
  "gallery.sample.options": ["Options", "Options"],
  "gallery.sample.frequency": ["Frequency", "Fréquence"],
  "gallery.sample.filters": ["Categories", "Catégories"],
  "gallery.sample.destination_type": ["Destination type", "Type de destination"],
  "gallery.sample.run_in_background": ["Run in the background", "Tourner en arrière-plan"],
};

/** Texte de la galerie : catalogue d'abord, puis les textes ajoutés ci-dessus, puis la clé. */
export function s(key: string, ...args: Array<string | number>): string {
  const text = t(key, ...args);
  if (text !== key) return text;
  const extra = GALLERY_EXTRA_TEXT[key];
  if (!extra) return key;
  const template = currentLanguage() === "fr-FR" ? extra[1] : extra[0];
  return template.replace(/\{(\d+)\}/g, (match, index: string) => {
    const arg = args[Number(index) - 1];
    return arg === undefined ? match : String(arg);
  });
}

/** Noms de branches d'exemple (contenu de la feuille) : des données, pas des textes à traduire. */
export const SAMPLE_BRANCHES = ["feat/in-app-updates", "fix/ai-wal-database-backup", "ci/semver-release"] as const;
