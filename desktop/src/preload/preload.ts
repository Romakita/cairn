// API exposée à l'interface (`window.cairn`) : seulement les méthodes métier du contrat, jamais `ipcRenderer`, `fs`
// ou `shell`. Chaque méthode passe par `ipcRenderer.invoke("cairn:<nom>")` ; le main valide les arguments et l'origine.
// L'état arrive par un seul canal (`cairn:snapshot`), la navigation par `cairn:navigate`.
import { contextBridge, type IpcRendererEvent, ipcRenderer } from "electron";
import {
  type AppSnapshot,
  CHANNEL_PREFIX,
  type Envelope,
  METHOD_NAMES,
  NAVIGATE_CHANNEL,
  type NavigationRequest,
  SNAPSHOT_CHANNEL,
} from "../shared/contract.ts";

/** Une erreur traverse le pont sans ses propriétés : le code est porté par le message (`cairn:<code>:<texte>`). */
function unwrap<T>(envelope: Envelope<T>): T {
  if (envelope.ok) return envelope.value;
  throw new Error(`cairn:${envelope.error.code}:${envelope.error.message}`);
}

const api: Record<string, unknown> = {};
for (const name of METHOD_NAMES) {
  api[name] = async (args?: unknown) => unwrap(await ipcRenderer.invoke(`${CHANNEL_PREFIX}${name}`, args));
}

let latest: AppSnapshot | null = null;
const snapshotListeners = new Set<(s: AppSnapshot) => void>();
const navigateListeners = new Set<(n: NavigationRequest) => void>();
let subscribed = false;

ipcRenderer.on(SNAPSHOT_CHANNEL, (_event: IpcRendererEvent, snapshot: AppSnapshot) => {
  if (latest && snapshot.revision <= latest.revision) return;
  latest = snapshot;
  for (const l of snapshotListeners) l(snapshot);
});

ipcRenderer.on(NAVIGATE_CHANNEL, (_event: IpcRendererEvent, request: NavigationRequest) => {
  for (const l of navigateListeners) l(request);
});

api.subscribe = (listener: (s: AppSnapshot) => void) => {
  snapshotListeners.add(listener);
  if (latest) listener(latest);
  if (!subscribed) {
    subscribed = true;
    // Le main pousse l'état à cette fenêtre à partir de maintenant ; le premier état arrive tout de suite.
    void ipcRenderer.invoke(`${CHANNEL_PREFIX}getSnapshot`).then((envelope: Envelope<AppSnapshot>) => {
      if (!envelope.ok) return;
      const s = envelope.value;
      if (latest && s.revision <= latest.revision) return;
      latest = s;
      for (const l of snapshotListeners) l(s);
    });
  }
  return () => {
    snapshotListeners.delete(listener);
  };
};

api.onNavigate = (listener: (n: NavigationRequest) => void) => {
  navigateListeners.add(listener);
  return () => {
    navigateListeners.delete(listener);
  };
};

contextBridge.exposeInMainWorld("cairn", api);
