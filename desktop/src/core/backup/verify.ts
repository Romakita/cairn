// Vérification à la demande d'une destination (port de `BackupService.verify` et `recordVerification`) : la dernière
// version (échantillon), toutes les versions (`full`) ou une version donnée. Prend le verrou d'opération et note le
// résultat dans `runs.json` (`lastVerification`, `damagedVersions` sans doublon), comme l'app et `cairn verify`.
import path from "node:path";
import type { DestinationConfig } from "../config.ts";
import { t } from "../l10n.ts";
import { OperationLock } from "../lock.ts";
import type { CairnPaths } from "../paths.ts";
import { type VerifyReport, verifyVersion } from "./integrity.ts";
import { destinationState, updateRunState } from "./run-state.ts";
import { DestinationSession, type SessionDependencies } from "./session.ts";
import { listVersions, versionsDir } from "./versions.ts";

export class VerifyError extends Error {
  constructor(readonly version: string) {
    super(t("cli.verify.unknown_version", version));
    this.name = "VerifyError";
  }
}

export interface VerifyRequest {
  version?: string;
  full: boolean;
  now?: Date;
  /** Mots de passe saisis pour cette session (Mac neuf). */
  imagePassword?: string | null;
  sharePassword?: string | null;
  /** `(version, vérifiés, à vérifier)`. */
  progress?: (version: string, done: number, total: number) => void;
}

/** Vérifie une destination sous le verrou d'opération et note le résultat. */
export async function verifyDestination(
  d: DestinationConfig,
  paths: CairnPaths,
  deps: SessionDependencies,
  request: VerifyRequest,
): Promise<VerifyReport[]> {
  const lock = new OperationLock({ stateDir: paths.state });
  await lock.acquire("verify");
  try {
    const session = new DestinationSession(d, deps);
    session.imagePassword = request.imagePassword ?? null;
    session.sharePassword = request.sharePassword ?? null;
    let reports: VerifyReport[];
    try {
      const root = await session.open(false);
      const dir = versionsDir(root, deps.machine);
      const all = await listVersions(dir);
      if (request.version !== undefined && !all.includes(request.version)) throw new VerifyError(request.version);
      const targets = request.version !== undefined ? [request.version] : request.full ? all : all.slice(-1);
      reports = [];
      for (const v of targets) {
        reports.push(
          await verifyVersion(path.join(dir, v), {
            full: request.full,
            progress: (done, total) => request.progress?.(v, done, total),
          }),
        );
      }
    } finally {
      await session.close();
    }
    await recordVerification(reports, d.id, paths, request.now ?? new Date());
    return reports;
  } finally {
    await lock.release();
  }
}

/** Note une vérification dans l'état : date et versions abîmées (sans doublon). Rien si tout était en attente. */
export async function recordVerification(
  reports: readonly VerifyReport[],
  destination: string,
  paths: CairnPaths,
  now: Date = new Date(),
): Promise<void> {
  if (!reports.some((r) => !r.missingChecksums)) return;
  await updateRunState(paths, (s) => {
    const ds = destinationState(s, destination);
    ds.lastVerification = now;
    for (const r of reports) {
      if (r.damaged.length > 0 && !ds.damagedVersions.includes(r.version)) ds.damagedVersions.push(r.version);
    }
    s.destinations[destination] = ds;
  });
}
