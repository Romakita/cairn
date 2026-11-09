// Accès de l'interface à l'API : `window.cairn` (preload) dans l'app, sinon l'API d'exemple (navigateur, captures).
// Les erreurs du pont arrivent sous la forme `cairn:<code>:<message>` (une erreur perd ses propriétés en traversant
// `contextBridge`) : elles redeviennent des `CairnApiError` avec leur code.
import type { AppLanguage } from "../../core/l10n.ts";
import { type ApiErrorCode, type CairnApi, CairnApiError, METHOD_NAMES } from "../../shared/contract.ts";
import { createFixtureApi, isScenarioId, type ScenarioId } from "./fixtures/index.ts";

declare global {
  interface Window {
    cairn?: CairnApi;
  }
}

const CODES: readonly ApiErrorCode[] = [
  "invalidArguments",
  "forbidden",
  "notFound",
  "locked",
  "busy",
  "invalidConfig",
  "notImplemented",
  "failed",
];

/** Erreur du pont → `CairnApiError` (code `failed` si le message n'en porte pas). */
export function toApiError(error: unknown): CairnApiError {
  if (error instanceof CairnApiError) return error;
  const text = error instanceof Error ? error.message : String(error);
  // Electron préfixe le message (« Error invoking remote method… ») : on cherche le marqueur où qu'il soit.
  const m = /cairn:([A-Za-z]+):([\s\S]*)$/.exec(text);
  if (m && (CODES as readonly string[]).includes(m[1]!)) return new CairnApiError(m[1] as ApiErrorCode, m[2]!);
  return new CairnApiError("failed", text);
}

/** API du preload, avec des erreurs typées. */
export function wrapBridge(bridge: CairnApi): CairnApi {
  const api: Record<string, unknown> = {
    subscribe: bridge.subscribe,
    onNavigate: bridge.onNavigate,
  };
  for (const name of METHOD_NAMES) {
    const call = bridge[name] as (args?: unknown) => Promise<unknown>;
    api[name] = async (args?: unknown) => {
      try {
        return await call(args);
      } catch (error) {
        throw toApiError(error);
      }
    };
  }
  return api as CairnApi;
}

export interface ExampleSettings {
  scenario: ScenarioId;
  language: AppLanguage;
  startAt: number;
  frozen: boolean;
}

/** Réglages de l'API d'exemple lus dans l'URL : `?scenario=<id>&lang=fr-FR&t=<secondes>&frozen=1`. */
export function exampleSettings(
  search: string = typeof location === "undefined" ? "" : location.search,
): ExampleSettings {
  const params = new URLSearchParams(search);
  const scenario = params.get("scenario");
  const lang = params.get("lang");
  const t = Number(params.get("t") ?? "0");
  return {
    scenario: isScenarioId(scenario) ? scenario : "normal",
    language: lang?.toLowerCase().startsWith("fr") ? "fr-FR" : "en-US",
    startAt: Number.isFinite(t) && t > 0 ? t : 0,
    frozen: params.get("frozen") === "1",
  };
}

let instance: CairnApi | null = null;

/** L'API de l'interface (une seule par page). */
export function getApi(): CairnApi {
  if (instance) return instance;
  const bridge = typeof window === "undefined" ? undefined : window.cairn;
  if (bridge) {
    instance = wrapBridge(bridge);
  } else {
    const s = exampleSettings();
    instance = createFixtureApi({ scenario: s.scenario, language: s.language, startAt: s.startAt, frozen: s.frozen });
  }
  return instance;
}

/** L'interface tourne sur l'API d'exemple (navigateur, captures) et non dans l'app. */
export function usingExampleApi(): boolean {
  return typeof window === "undefined" || window.cairn === undefined;
}

/** Remplace l'API (tests de composants, galerie). */
export function setApi(api: CairnApi | null): void {
  instance = api;
}
