// Confirmations de l'écran Git (feuille de 520) : suppression d'une branche ou d'un worktree, compactage, mise à la
// corbeille d'un dépôt. Une branche non fusionnée, un worktree ou un dépôt à risque demandent une case dédiée.
// Le main redemande la confirmation avant d'agir.
import { TriangleAlert } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Fmt } from "../../../core/format.ts";
import type { GoneBranch, WorktreeInfo } from "../../../core/git/types.ts";
import { t } from "../../../core/l10n.ts";
import type { RepoReport } from "../../../shared/contract.ts";
import { Button } from "../../ui/Button.tsx";
import { Checkbox } from "../../ui/Checkbox.tsx";
import { Icon } from "../../ui/Icon.tsx";
import { MiddleText } from "../../ui/MiddleText.tsx";
import { Sheet } from "../../ui/Sheet.tsx";
import { atRisk, baseName, repoAtRisk, shortDate } from "./common.ts";
import styles from "./GitSheets.module.css";

export type GitAction =
  | { kind: "branch"; branch: GoneBranch }
  | { kind: "worktree"; worktree: WorktreeInfo; report: RepoReport }
  | { kind: "compact"; report: RepoReport }
  | { kind: "trash"; report: RepoReport };

export interface GitSheetProps {
  action: GitAction | null;
  busy: boolean;
  onCancel: () => void;
  /** `withBranch` : supprimer aussi la branche du worktree. */
  onConfirm: (action: GitAction, options: { withBranch: boolean }) => void;
}

function Risk({ children, ack, onAck }: { children: ReactNode; ack: boolean; onAck: (v: boolean) => void }) {
  return (
    <div className={styles.risk} role="alert">
      <div className={styles.riskText}>
        <Icon icon={TriangleAlert} size={16} />
        <span>{children}</span>
      </div>
      <Checkbox checked={ack} onChange={onAck}>
        {t("git.delete.ack")}
      </Checkbox>
    </div>
  );
}

function Detail({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className={styles.detailRow}>
      <span className={styles.detailLabel}>{label}</span>
      <MiddleText text={value} className={mono ? styles.mono : styles.value} />
    </div>
  );
}

export function GitSheet({ action, busy, onCancel, onConfirm }: GitSheetProps) {
  const [ack, setAck] = useState(false);
  const [withBranch, setWithBranch] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: cases remises à zéro à chaque nouvelle feuille.
  useEffect(() => {
    setAck(false);
    setWithBranch(false);
  }, [action]);
  if (!action) return null;

  let heading = "";
  let description: string | undefined;
  let body: ReactNode = null;
  let needsAck = false;
  let confirmLabel = t("git.apply");
  let danger = true;

  switch (action.kind) {
    case "branch": {
      const b = action.branch;
      heading = t("git.delete.branch.title", b.name);
      needsAck = b.status === "unmerged";
      body = (
        <>
          <div className={styles.details}>
            <Detail label={t("col.repo")} value={b.repo} mono />
            <Detail label={t("git.col.last_commit")} value={`${b.sha} · ${shortDate(b.date)}`} mono />
            <Detail label={t("git.col.subject")} value={b.subject} />
          </div>
          {needsAck && (
            <Risk ack={ack} onAck={setAck}>
              {t("git.delete.unmerged")} {t("git.page.lost", t("git.delete.lost"))}
            </Risk>
          )}
          <p className={styles.note}>{t("git.confirm.log")}</p>
        </>
      );
      break;
    }
    case "worktree": {
      const w = action.worktree;
      const branch = w.branch ? action.report.branches.find((b) => b.name === w.branch) : undefined;
      heading = t("git.delete.worktree.title", baseName(w.path));
      needsAck = atRisk(w);
      body = (
        <>
          <p className={styles.text}>
            {t(
              "git.delete.worktree.detail",
              w.branch ?? "—",
              w.exists ? Fmt.bytes(w.size) : t("worktree.status.orphan"),
            )}
          </p>
          <div className={styles.details}>
            <Detail label={t("git.col.worktree")} value={w.path} mono />
            <Detail label={t("col.repo")} value={w.repo} mono />
          </div>
          {w.branch && (
            <Checkbox checked={withBranch} onChange={setWithBranch}>
              {t(
                "git.delete.with_branch",
                w.branch,
                t(`branch.status.${branch?.status ?? w.branchStatus ?? "unmerged"}`),
              )}
            </Checkbox>
          )}
          {needsAck && (
            <Risk ack={ack} onAck={setAck}>
              {t("git.risk_detail", w.modifiedFiles + w.untrackedFiles, w.unpushedCommits)}.{" "}
              {t("git.page.lost", t("git.delete.lost"))}
            </Risk>
          )}
          <p className={styles.note}>{t("git.confirm.log")}</p>
        </>
      );
      break;
    }
    case "compact": {
      const r = action.report;
      heading = t("git.compact.title", baseName(r.path));
      description = t("git.compact.detail", Fmt.bytes(r.gitBytes), Fmt.bytes(r.looseBytes));
      confirmLabel = t("git.compact.confirm");
      danger = false;
      body = (
        <div className={styles.details}>
          <Detail label={t("col.repo")} value={r.path} mono />
        </div>
      );
      break;
    }
    case "trash": {
      const r = action.report;
      const outside = r.worktrees.filter((w) => w.exists && !w.path.startsWith(`${r.path}/`)).map((w) => w.path);
      heading = t("git.trash.title", baseName(r.path));
      description = t("git.trash.detail", shortDate(r.lastModified));
      confirmLabel = t("action.trash");
      needsAck = repoAtRisk(r);
      danger = needsAck;
      body = (
        <>
          <div className={styles.details}>
            <Detail label={t("col.repo")} value={r.path} mono />
            <Detail label={t("col.size")} value={Fmt.bytes(r.gitBytes)} />
          </div>
          {outside.length > 0 && <p className={styles.text}>{t("git.trash.worktrees", outside.join(", "))}</p>}
          {needsAck && (
            <Risk ack={ack} onAck={setAck}>
              {t("git.trash.risk", r.modifiedFiles, r.unpushedCommits)}
            </Risk>
          )}
        </>
      );
      break;
    }
  }

  const blocked = needsAck && !ack ? t("git.page.ack_required") : undefined;
  return (
    <Sheet
      open
      width={520}
      heading={heading}
      description={description}
      closeLabel={t("action.close")}
      onClose={busy ? undefined : onCancel}
      footer={
        <>
          <Button onClick={onCancel} disabledReason={busy ? t("git.action.busy") : undefined}>
            {t("action.cancel")}
          </Button>
          <Button
            variant={danger ? "danger" : "primary"}
            loading={busy}
            disabledReason={blocked}
            autoFocus={!needsAck}
            onClick={() => onConfirm(action, { withBranch })}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className={styles.body}>{body}</div>
    </Sheet>
  );
}
