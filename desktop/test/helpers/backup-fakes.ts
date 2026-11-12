// Faux processus pour les tests de sauvegarde : hdiutil simulé (l'« image » est un dossier temporaire) et rsync
// enveloppé (journal des appels, sortie d'erreur et code imposés). Jamais de vraie destination.
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { HdiutilRunner } from "../../src/core/backup/image.ts";

/** hdiutil simulé : `attach` monte l'image sur `mountPoint` (un dossier ordinaire). */
export function fakeImageHdiutil(mountPoint: string): { runner: HdiutilRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: HdiutilRunner = async (args) => {
    calls.push([...args]);
    switch (args[0]) {
      case "create":
        mkdirSync(args[9]!, { recursive: true }); // create -size S -type SPARSEBUNDLE -fs APFS -volname Cairn <chemin>
        return { code: 0, output: "created" };
      case "attach":
        mkdirSync(mountPoint, { recursive: true });
        return {
          code: 0,
          output:
            '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>system-entities</key><array>' +
            `<dict><key>mount-point</key><string>${mountPoint}</string></dict></array></dict></plist>`,
        };
      case "isencrypted":
        return { code: 0, output: "encrypted: YES" };
      default:
        return { code: 0, output: "" };
    }
  };
  return { runner, calls };
}

/**
 * rsync enveloppé dans un script : chaque appel est noté dans `<dir>/calls.log` (un appel par ligne, arguments séparés
 * par des tabulations), `-H` est retiré avant d'appeler openrsync (pour simuler GNU rsync), et si `<dir>/fail` existe,
 * le script écrit 25 lignes d'erreur et sort avec le code qu'il contient.
 */
export function wrappedRsync(dir: string): {
  path: string;
  calls: () => string[][];
  failWith: (code: number | null) => void;
} {
  mkdirSync(dir, { recursive: true });
  const script = path.join(dir, "rsync");
  const log = path.join(dir, "calls.log");
  const fail = path.join(dir, "fail");
  writeFileSync(
    script,
    `#!/bin/sh
# Une seule écriture par appel : les rsync -n du comptage tournent en même temps que la copie, deux printf
# séparés s'entrelaceraient sur une même ligne.
line=$(printf '%s\\t' "$@")
printf '%s\\n' "$line" >> '${log}'
if [ -f '${fail}' ]; then
  i=1
  while [ $i -le 25 ]; do echo "rsync: error line $i" >&2; i=$((i+1)); done
  exit $(cat '${fail}')
fi
for a in "$@"; do shift; [ "$a" = "-H" ] || set -- "$@" "$a"; done
exec /usr/bin/rsync "$@"
`,
  );
  chmodSync(script, 0o755);
  return {
    path: script,
    calls: () => {
      try {
        return readFileSync(log, "utf8")
          .split("\n")
          .filter((l) => l.length > 0)
          .map((l) => l.split("\t").filter((a) => a.length > 0));
      } catch {
        return [];
      }
    },
    failWith: (code) => {
      if (code === null) rmSync(fail, { force: true });
      else writeFileSync(fail, String(code));
    },
  };
}
