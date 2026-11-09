// Options de l'analyse git (réglages `[git]` de config.toml) : mise à jour des branches distantes avant l'analyse,
// délai d'inactivité d'un worktree. Enregistrées tout de suite ; la prochaine analyse les applique.
import { t } from "../../../core/l10n.ts";
import type { AppSnapshot } from "../../../shared/contract.ts";
import { useApi } from "../../api/hooks.ts";
import { Button } from "../../ui/Button.tsx";
import { Card } from "../../ui/Card.tsx";
import { NumberStepper } from "../../ui/NumberStepper.tsx";
import { RowDivider } from "../../ui/RowDivider.tsx";
import { SettingsRow } from "../../ui/SettingsRow.tsx";
import { Sheet } from "../../ui/Sheet.tsx";
import { Toggle } from "../../ui/Toggle.tsx";

export interface OptionsSheetProps {
  open: boolean;
  onClose: () => void;
  snapshot: AppSnapshot;
}

export function OptionsSheet({ open, onClose, snapshot }: OptionsSheetProps) {
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
      description={t("git.page.options.text")}
      closeLabel={t("action.close")}
      onClose={onClose}
      footer={
        <Button variant="primary" onClick={onClose}>
          {t("action.close")}
        </Button>
      }
    >
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
            onChange={(v) => !blocked && save({ worktreeStaleDays: v })}
            label={t("git.page.option.stale")}
            decrementLabel={t("git.page.option.less")}
            incrementLabel={t("git.page.option.more")}
            format={(v) => t("git.page.option.days", v)}
          />
        </SettingsRow>
      </Card>
    </Sheet>
  );
}
