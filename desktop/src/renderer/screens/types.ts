import type { NavigationRequest, Route } from "../../shared/contract.ts";

/** Props communes des écrans : la route active (onglet compris) et la dernière demande de navigation. */
export interface ScreenProps {
  route: Route;
  request?: NavigationRequest;
  navigate: (request: NavigationRequest) => void;
}
