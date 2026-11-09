// Canaux IPC : un `ipcMain.handle("cairn:<méthode>")` par méthode du contrat. Avant d'atteindre le service :
// 1. l'appel doit venir d'une page de l'app (`app://cairn`, cadre principal) ;
// 2. les arguments doivent passer le schéma zod de la méthode (objets stricts, tailles bornées).
// La réponse est une enveloppe `{ ok, value | error }` que le preload déballe.
import { type IpcMainInvokeEvent, ipcMain } from "electron";
import {
  APP_ORIGIN,
  CHANNEL_PREFIX,
  type Envelope,
  METHOD_NAMES,
  type MethodArgs,
  type MethodName,
  type MethodResult,
} from "../shared/contract.ts";
import { validateArgs } from "../shared/schemas.ts";
import { describeApiError } from "./errors.ts";

export type Handler<M extends MethodName> = (
  args: MethodArgs<M>,
  event: IpcMainInvokeEvent,
) => MethodResult<M> | Promise<MethodResult<M>>;

export type Handlers = { [M in MethodName]: Handler<M> };

/** L'appel vient d'une page servie par `app://cairn` (pas d'un cadre tiers ni d'une page naviguée ailleurs). */
export function trustedSender(event: Pick<IpcMainInvokeEvent, "senderFrame">): boolean {
  const frame = event.senderFrame;
  if (!frame || frame.parent !== null) return false;
  try {
    const url = new URL(frame.url);
    return `${url.protocol}//${url.host}` === APP_ORIGIN;
  } catch {
    return false;
  }
}

/** Appels refusés (tests, journal). */
export const refusals: { method: string; reason: string }[] = [];

function refuse<T>(method: string, code: "forbidden" | "invalidArguments", message: string): Envelope<T> {
  refusals.push({ method, reason: message });
  if (refusals.length > 100) refusals.shift();
  return { ok: false, error: { code, message } };
}

async function dispatch<M extends MethodName>(
  method: M,
  handler: Handler<M>,
  event: IpcMainInvokeEvent,
  raw: unknown,
): Promise<Envelope<MethodResult<M>>> {
  if (!trustedSender(event)) return refuse(method, "forbidden", `refused ${method}: untrusted sender`);
  const parsed = validateArgs(method, raw);
  if (!parsed.ok) return refuse(method, "invalidArguments", parsed.message);
  try {
    return { ok: true, value: await handler(parsed.value, event) };
  } catch (error) {
    return { ok: false, error: describeApiError(error) };
  }
}

/** Enregistre un gestionnaire par méthode ; renvoie la fonction qui les retire. */
export function registerHandlers(handlers: Handlers): () => void {
  for (const name of METHOD_NAMES) {
    const handler = handlers[name] as Handler<typeof name>;
    ipcMain.handle(`${CHANNEL_PREFIX}${name}`, (event, raw: unknown) => dispatch(name, handler, event, raw));
  }
  return () => {
    for (const name of METHOD_NAMES) ipcMain.removeHandler(`${CHANNEL_PREFIX}${name}`);
  };
}
