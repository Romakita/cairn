// Hooks React de l'API : `useApi()` (méthodes métier), `useSnapshot()` (dernier état poussé par le main, `null` avant
// le premier), `useNavigation()` (navigation demandée par le main : notification « Nettoyer », barre des menus…).
import { useEffect, useSyncExternalStore } from "react";
import type { AppSnapshot, CairnApi, NavigationRequest } from "../../shared/contract.ts";
import { getApi } from "./client.ts";

export function useApi(): CairnApi {
  return getApi();
}

/** Un seul abonnement par page, partagé par tous les composants. */
const store = (() => {
  let current: AppSnapshot | null = null;
  const listeners = new Set<() => void>();
  let unsubscribe: (() => void) | null = null;
  const ensure = () => {
    if (unsubscribe) return;
    unsubscribe = getApi().subscribe((snapshot) => {
      if (current && snapshot.revision < current.revision) return;
      current = snapshot;
      for (const l of listeners) l();
    });
  };
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      ensure();
      return () => {
        listeners.delete(listener);
      };
    },
    get(): AppSnapshot | null {
      ensure();
      return current;
    },
  };
})();

export function useSnapshot(): AppSnapshot | null {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

export function useNavigation(listener: (request: NavigationRequest) => void): void {
  useEffect(() => getApi().onNavigate(listener), [listener]);
}
