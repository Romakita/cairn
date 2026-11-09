// Processus auxiliaire : prend le verrou d'opération de `<stateDir>`, l'annonce (« held »), attend puis se termine
// brutalement sans le libérer (le système doit le libérer). Code 3 si le verrou est déjà tenu.
// Usage : bun test/helpers/hold-lock.ts <stateDir> <secondes>
import { OperationLock } from "../../src/core/lock.ts";
import { loadNative } from "../../src/core/native.ts";
import { NATIVE_MODULE } from "./native.ts";

const [stateDir, seconds] = process.argv.slice(2);
if (!stateDir) {
  console.error("usage: hold-lock.ts <stateDir> [seconds]");
  process.exit(2);
}
loadNative(NATIVE_MODULE);
const lock = new OperationLock({ stateDir });
try {
  await lock.acquire("backup");
} catch {
  process.exit(3);
}
process.stdout.write("held\n");
setTimeout(() => process.kill(process.pid, "SIGKILL"), Number(seconds ?? 0) * 1000);
