// Options de l'analyse git : réglages `[git]` de config.toml (mise à jour des branches distantes, délai d'inactivité
// d'un worktree), enregistrés tout de suite ; et options de la prochaine analyse (comme `cairn git`), gardées par
// l'écran le temps de la session.
import { t } from "../../../core/l10n.ts";
import type { AppSnapshot, GitAnalyzeArgs } from "../../../shared/contract.ts";
import { useApi } from "../../api/hooks.ts";
import { Button } from "../../ui/Button.tsx";
import { Card } from "../../ui/Card.tsx";
import { NumberStepper } from "../../ui/NumberStepper.tsx";
import { RowDivider } from "../../ui/RowDivider.tsx";
import { SectionTitle } from "../../ui/SectionTitle.tsx";
import { SettingsRow } from "../../ui/SettingsRow.tsx";
import { Sheet } from "../../ui/Sheet.tsx";
import { Toggle } from "../../ui/Toggle.tsx";
import styles from "./GitSheets.module.css";

/** Options de la prochaine analyse. */
export type AnalysisOptions = Required<Pick<GitAnalyzeArgs, "includeUnmerged" | "worktreesOnly" | "includeAtRisk">>;

export interface OptionsSheetProps {
  open: boolean;
  onClose: () => void;
  snapshot: AppSnapshot;
  analysis: AnalysisOptions;
  onAnalysisChange: (options: AnalysisOptions) => void;
}

const ANALYSIS_ROWS = [
  { key: "includeUnmerged", label: "git.page.option.unmerged" },
  { key: "includeAtRisk", label: "git.page.option.at_risk" },
  { key: "worktreesOnly", label: "git.page.option.worktrees_only" },
] as const;

export function OptionsSheet({ open, onClose, snapshot, analysis, onAnalysisChange }: OptionsSheetProps) {
  const api = useApi();
  const config = snapshot.config;
  const g = config.config.git;
  const blocked = config.hasErrors ? t("settings.blocked") : undefined;
  const save = (git: Partial<typeof g>) => void api.saveConfig({ patches: [{ kind: "git", git }] }).catch(() => {});
  return (
    <Sheet
      open={open}
      width={560}
      heading={t("git.page.options.title")}
      closeLabel={t("action.close")}
      onClose={onClose}
      footer={
        <Button variant="primary" onClick={onClose}>
          {t("action.close")}
        </Button>
      }
    >
      <div className={styles.options}>
        <SectionTitle label={t("git.page.options.saved")} />
        <p className={styles.note}>{t("git.page.options.text")}</p>
        <Card flush>
          <SettingsRow label={t("git.page.option.fetch")} description={t("git.page.option.fetch.text")}>
            <Toggle
              checked={g.fetchBefore}
              onChange={(v) => save({ fetchBefore: v })}
              label={t("git.page.option.fetch")}
              disabledReason={blocked}
            />
          </SettingsRow>
          <RowDivider />
          <SettingsRow label={t("git.page.option.stale")} description={t("git.page.option.stale.text")}>
            <NumberStepper
              value={g.worktreeStaleDays}
              min={1}
              max={365}
              onChange={(v) => save({ worktreeStaleDays: v })}
              disabledReason={blocked}
              label={t("git.page.option.stale")}
              decrementLabel={t("git.page.option.less")}
              incrementLabel={t("git.page.option.more")}
              format={(v) => t("git.page.option.days", v)}
            />
          </SettingsRow>
        </Card>
        <SectionTitle label={t("git.page.options.next")} />
        <Card flush>
          {ANALYSIS_ROWS.map((row, i) => (
            <div key={row.key}>
              {i > 0 && <RowDivider />}
              <SettingsRow label={t(row.label)} description={t(`${row.label}.text`)}>
                <Toggle
                  checked={analysis[row.key]}
                  onChange={(v) => onAnalysisChange({ ...analysis, [row.key]: v })}
                  label={t(row.label)}
                />
              </SettingsRow>
            </div>
          ))}
        </Card>
      </div>
    </Sheet>
  );
}
