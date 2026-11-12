// `config.toml` dans l'app : chargement, rechargement à chaud (dernière configuration valide gardée, planification
// bloquée tant que le fichier est invalide), enregistrement par patchs typés (refusé si le fichier sur disque est
// invalide : ConfigWarningTests), et assistant du premier lancement.
import { BUNDLED_PROFILES, offeredCategories, profileName } from "../core/ai/profiles.ts";
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
/** Brouillon du core ; `notifications` (autorisation demandée par le main) ne va pas dans `config.toml`. */
export function draftFromWire(d: OnboardingDraftWire): OnboardingDraft {
  const { notifications: _n, ...rest } = d;
  return {
    ...rest,
    ai: d.ai.map((a) => ({ id: a.id, detected: a.detected, categories: new Set(a.categories) })),
  };
}

/** Brouillon pour l'interface, avec le nom et les catégories proposées de chaque outil IA (profils embarqués). */
export function draftToWire(d: OnboardingDraft, notifications = true): OnboardingDraftWire {
  return {
    ...d,
    ai: d.ai.map((a) => {
      const profile = BUNDLED_PROFILES.find((p) => p.id === a.id);
      return {
        id: a.id,
        name: profileName(a.id),
        detected: a.detected,
        categories: [...a.categories].sort(),
        offeredCategories: profile ? offeredCategories(profile) : [...a.categories].sort(),
      };
    }),
    notifications,
  };
}

export class ConfigService {
  private current: CairnConfig = defaultConfig();
  private issues: IssueView[] = [];
  private exists = false;
  private hasErrors = false;
  private hasValid = false;
  private watcher: FileWatcher | null = null;
  private writes: Promise<unknown> = Promise.resolve();

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

  /**
   * Écritures l'une après l'autre (lecture, patch, écriture, relecture) : deux réglages changés coup sur coup
   * partiraient sinon de la même configuration, et la seconde écriture annulerait la première.
   */
  private serial<T>(write: () => Promise<T>): Promise<T> {
    const run = this.writes.then(write, write);
    this.writes = run.catch(() => {});
    return run;
  }

  /** Enregistre des patchs sur la dernière configuration valide ; refusé si le fichier sur disque est invalide. */
  save(patches: readonly ConfigPatch[]): Promise<void> {
    return this.serial(async () => {
      if (!this.exists) throw new ApiError("invalidConfig", "config.toml does not exist yet");
      await this.store.save(applyPatches(this.current, patches));
      await this.load();
    });
  }

  /** Remplace toute la configuration (destinations ajoutées par le core, assistant). */
  saveConfig(config: CairnConfig): Promise<void> {
    return this.serial(async () => {
      await this.store.save(config);
      await this.load();
    });
  }

  /** « Terminer » de l'assistant : rien n'est écrit avant (ni le Trousseau). */
  finishOnboarding(draft: OnboardingDraftWire): Promise<CairnConfig> {
    return this.serial(async () => {
      if (this.exists) throw new ApiError("busy", "config.toml already exists");
      const config = makeConfig(draftFromWire(draft));
      await this.store.save(config);
      await this.load();
      await this.watch();
      return config;
    });
  }
}
