// API d'exemple (sans disque) et ses scénarios : voir api.ts et scenarios.ts.
export { createFixtureApi, type FixtureApi, type FixtureOptions } from "./api.ts";
export { SIMULATION_SECONDS, simulatedProgress } from "./backup-simulation.ts";
export { FIXTURE_NOW, normalSnapshot } from "./base.ts";
export { isScenarioId, SCENARIO_IDS, SCENARIOS, type Scenario, type ScenarioId } from "./scenarios.ts";
