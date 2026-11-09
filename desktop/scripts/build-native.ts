// Compile le module natif (native/ → native/build/Release/cairn_native.node) avec node-gyp et les seules
// Command Line Tools. Le module est en N-API pur (ABI stable) : le même binaire se charge sous Bun (tests) et sous
// le Node d'Electron, sans recompilation par version. Usage : `bun scripts/build-native.ts [--arch=x64|arm64]`.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const gyp = path.join(root, "node_modules/node-gyp/bin/node-gyp.js");
if (!existsSync(gyp)) {
  console.error("node-gyp is missing: run `bun install` first");
  process.exit(1);
}

const extra = process.argv.slice(2);
const result = spawnSync(process.execPath, [gyp, "rebuild", "--directory", path.join(root, "native"), ...extra], {
  cwd: root,
  stdio: "inherit",
});
if (result.status !== 0) {
  console.error("native module build failed (Command Line Tools installed? `xcode-select --install`)");
  process.exit(result.status ?? 1);
}
console.log(path.join(root, "native/build/Release/cairn_native.node"));
