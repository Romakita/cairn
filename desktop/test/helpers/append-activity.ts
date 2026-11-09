// Processus auxiliaire : ajoute N événements au journal d'activité de `<stateDir>` (régression 85501aa).
// Usage : bun test/helpers/append-activity.ts <stateDir> <n>
import { ActivityLog } from "../../src/core/activity-log.ts";
import { loadNative } from "../../src/core/native.ts";
import { NATIVE_MODULE } from "./native.ts";

const [stateDir, count] = process.argv.slice(2);
if (!stateDir || !count) {
  console.error("usage: append-activity.ts <stateDir> <n>");
  process.exit(2);
}
loadNative(NATIVE_MODULE);
const log = new ActivityLog({ stateDir });
for (let n = 0; n < Number(count); n++) await log.append({ date: new Date(), kind: "check", count: n });
