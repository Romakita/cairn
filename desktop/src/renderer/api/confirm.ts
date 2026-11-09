// Action destructive confirmée par une feuille de l'interface : jeton du main (`prepareConfirmation`), puis l'appel
// avec ce jeton. Le main n'ouvre alors pas sa boîte native (une seule confirmation, voir contract.ts).
import type { CairnApi, CairnMethods, ConfirmedArgs, ConfirmedMethod } from "../../shared/contract.ts";

/** Appelle `method(args)` après la confirmation de la feuille ; à n'appeler QUE depuis le bouton de confirmation. */
export async function confirmedCall<M extends ConfirmedMethod>(
  api: CairnApi,
  method: M,
  args: ConfirmedArgs<M>,
): Promise<CairnMethods[M]["result"]> {
  const { token } = await api.prepareConfirmation({ method, args });
  const call = api[method] as (a: CairnMethods[M]["args"]) => Promise<CairnMethods[M]["result"]>;
  return call({ ...args, confirmation: token } as CairnMethods[M]["args"]);
}
