// `config.toml` dans l'app : chargement, rechargement à chaud (dernière configuration valide gardée, planification
// bloquée tant que le fichier est invalide), enregistrement par patchs typés (refusé si le fichier sur disque est
// invalide : ConfigWarningTests), et assistant du premier lancement.
import { type CairnConfig, type ConfigIssue, defaultConfig } from "../core/config.ts";
import { type ConfigStore, type FileWatcher, ConfigStore as Store } from "../core/config-store.ts";
import { makeConfig, type OnboardingDraft } from "../core/onboarding.ts";
import { applyPatches } from "../shared/config-patch.ts";
import type { ConfigPatch, ConfigView, IssueView, OnboardingDraftWire } from "../shared/contract.ts";
import { ApiError } from "./errors.ts";

function issueView(i: ConfigIssue): IssueView {
  return { severity: i.severity, key: i.key, line: i.line, message: i.message, description: i.description };
}

/** Brouillon reçu de l'interface → brouillon du core (les catégories redeviennent des ensembles). */
export function draftFromWire(d: OnboardingDraftWire): OnboardingDraft {
  return { ...d, ai: d.ai.map((a) => ({ ...a, categories: new Set(a.categories) })) };
}

export function draftToWire(d: OnboardingDraft): OnboardingDraftWire {
  return { ...d, ai: d.ai.map((a) => ({ ...a, categories: [...a.categories].sort() })) };
}

export class ConfigService {
  private current: CairnConfig = defaultConfig();
  private issues: IssueView[] = [];
  private exists = false;
  private hasErrors = false;
  private hasValid = false;
  private watcher: FileWatcher | null = null;

  constructor(
    readonly store: ConfigStore,
    private readonly onChange: (previous: CairnConfig) => void,
  ) {}

  get config(): CairnConfig {
    return this.current;
  }

  get invalid(): boolean {
    return this.hasErrors;
  }

  get firstLaunch(): boolean {
    return !this.exists;
  }

  view(): ConfigView {
    return {
      file: this.store.file,
      exists: this.exists,
      config: this.current,
      issues: this.issues,
      hasErrors: this.hasErrors,
      usingLastValid: this.hasErrors && this.hasValid,
    };
  }

  /** Relit le fichier ; une erreur garde la dernière configuration valide. */
  async load(): Promise<void> {
    const previous = this.current;
    this.exists = await this.store.exists();
    if (!this.exists) {
      this.issues = [];
      this.hasErrors = false;
      if (!this.hasValid) this.current = defaultConfig();
      this.onChange(previous);
      return;
    }
    try {
      const loaded = await this.store.load();
      this.issues = loaded.issues.map(issueView);
      this.hasErrors = loaded.hasErrors;
      // Premier chargement d'un fichier invalide : sa lecture partielle sert d'affichage, sans être « valide ».
      if (!loaded.hasErrors || !this.hasValid) this.current = loaded.config;
      if (!loaded.hasErrors) this.hasValid = true;
    } catch (error) {
      this.issues = Store.issuesFor(error).map(issueView);
      this.hasErrors = true;
    }
    this.onChange(previous);
  }

  /** Surveille le fichier (dossier parent + sondage d'une seconde). */
  async watch(): Promise<void> {
    this.watcher ??= await this.store.watch(() => void this.load());
  }

  stop(): void {
    this.watcher?.cancel();
    this.watcher = null;
  }

  /** Enregistre des patchs sur la dernière configuration valide ; refusé si le fichier sur disque est invalide. */
  async save(patches: readonly ConfigPatch[]): Promise<void> {
    if (!this.exists) throw new ApiError("invalidConfig", "config.toml does not exist yet");
    await this.store.save(applyPatches(this.current, patches));
    await this.load();
  }

  /** Remplace toute la configuration (destinations ajoutées par le core, assistant). */
  async saveConfig(config: CairnConfig): Promise<void> {
    await this.store.save(config);
    await this.load();
  }

  /** « Terminer » de l'assistant : rien n'est écrit avant (ni le Trousseau). */
  async finishOnboarding(draft: OnboardingDraftWire): Promise<CairnConfig> {
    if (this.exists) throw new ApiError("busy", "config.toml already exists");
    const config = makeConfig(draftFromWire(draft));
    await this.store.save(config);
    await this.load();
    await this.watch();
    return config;
  }
}
