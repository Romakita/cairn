// Dernière étape de `bun run dist` : signature ad hoc de Cairn.app (APRÈS l'écriture des fuses par electron-builder)
// puis archive au contrat de l'updater de la 0.8.x (parity/platform.md §3) :
//   release/Cairn-<version>-<arch>.zip (arch = arm64 | x86_64), Cairn.app à la racine (`ditto -c -k --keepParent`),
//   release/Cairn-<version>-<arch>.zip.sha256 au format `shasum -a 256` (« <empreinte>  <nom du zip> »).
// Usage : bun scripts/zip.ts [<dossier release>]
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const release = path.resolve(process.argv[2] ?? path.join(root, "release"));
const { version } = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as { version: string };

function run(command: string, args: string[], cwd?: string): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    console.error(`${command} ${args.join(" ")} a échoué (code ${result.status})\n${result.stdout}${result.stderr}`);
    process.exit(1);
  }
  return result.stdout;
}

// Dossiers d'electron-builder : mac-arm64 (Apple Silicon), mac (Intel, x64 → x86_64 comme `uname -m`), mac-universal.
const ARCH: Record<string, string> = { "mac-arm64": "arm64", mac: "x86_64", "mac-x64": "x86_64" };
const outputs = (await readdir(release, { withFileTypes: true })).filter(
  (entry) => entry.isDirectory() && ARCH[entry.name] && existsSync(path.join(release, entry.name, "Cairn.app")),
);
if (outputs.length === 0) {
  console.error(`aucune Cairn.app dans ${release}/mac-*/ : lancer electron-builder d'abord (bun run dist)`);
  process.exit(1);
}

for (const output of outputs) {
  const arch = ARCH[output.name] as string;
  const app = path.join(release, output.name, "Cairn.app");

  // Contrat de l'updater : identifiant et version lus dans l'Info.plist.
  const plist = JSON.parse(
    run("/usr/bin/plutil", ["-convert", "json", "-o", "-", path.join(app, "Contents/Info.plist")]),
  );
  if (plist.CFBundleIdentifier !== "fr.lenzotti.cairn" || plist.CFBundleShortVersionString !== version) {
    console.error(
      `Info.plist inattendu : ${plist.CFBundleIdentifier} ${plist.CFBundleShortVersionString} (attendu ${version})`,
    );
    process.exit(1);
  }

  // Signature ad hoc de tout le bundle (frameworks, helpers, module natif), puis vérification stricte.
  run("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", app]);
  run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);

  const name = `Cairn-${version}-${arch}.zip`;
  const archive = path.join(release, name);
  await rm(archive, { force: true });
  await rm(`${archive}.sha256`, { force: true });
  run("/usr/bin/ditto", ["-c", "-k", "--keepParent", app, archive]);
  // Même format que `shasum -a 256 <nom>` lancé dans release/ (nom seul, deux espaces).
  const sum = run("/usr/bin/shasum", ["-a", "256", name], release);
  await writeFile(`${archive}.sha256`, sum);
  console.log(
    `✔ ${path.relative(root, archive)} (${plist.CFBundleShortVersionString}, build ${plist.CFBundleVersion})`,
  );
}
