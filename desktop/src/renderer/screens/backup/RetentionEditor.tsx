// Choix de la rétention (page d'une destination et formulaire d'ajout) : `TabBar` Recommandée / Nombre fixe /
// Personnalisée, steppers aux bornes de `config.toml`, couverture estimée.
import { useState } from "react";
import type { Retention } from "../../../core/config.ts";
import { t } from "../../../core/l10n.ts";
import { NumberStepper } from "../../ui/NumberStepper.tsx";
import { TabBar } from "../../ui/TabBar.tsx";
import { RECOMMENDED, RETENTION_LIMITS, type RetentionChoice, retentionChoice, retentionCoverage } from "./model.ts";
import styles from "./RetentionEditor.module.css";

export interface RetentionEditorProps {
  value: Retention;
  onChange: (value: Retention) => void;
}

function Stepper({
  label,
  value,
  limits,
  format,
  onChange,
}: {
  label: string;
  value: number;
  limits: readonly [number, number];
  format: (v: number) => string;
  onChange: (v: number) => void;
}) {
  return (
    <div className={styles.row}>
      <span className={styles.label}>{format(value)}</span>
      <NumberStepper
        value={value}
        onChange={onChange}
        min={limits[0]}
        max={limits[1]}
        label={label}
        decrementLabel={t("backup.ui.retention.less")}
        incrementLabel={t("backup.ui.retention.more")}
        minReason={t("backup.ui.retention.min", limits[0])}
        maxReason={t("backup.ui.retention.max", limits[1])}
        format={(v) => String(v)}
      />
    </div>
  );
}

export function RetentionEditor({ value, onChange }: RetentionEditorProps) {
  // « Personnalisée » reste choisie même si les valeurs retombent sur celles de la recommandation.
  const [custom, setCustom] = useState(() => retentionChoice(value) === "custom");
  const choice: RetentionChoice = value.mode === "count" ? "count" : custom ? "custom" : retentionChoice(value);
  const select = (c: RetentionChoice) => {
    setCustom(c === "custom");
    if (c === "recommended") onChange(RECOMMENDED);
    else if (c === "count") onChange(value.mode === "count" ? value : { mode: "count", count: 12 });
    else if (value.mode === "count") onChange(RECOMMENDED);
  };
  return (
    <div className={styles.root}>
      <TabBar
        label={t("backup.retention")}
        value={choice}
        onChange={select}
        options={[
          { value: "recommended", label: t("backup.retention.recommended") },
          { value: "count", label: t("backup.retention.count") },
          { value: "custom", label: t("backup.retention.custom") },
        ]}
      />
      {choice === "recommended" && <p className={styles.note}>{t("backup.retention.recommended_detail")}</p>}
      {value.mode === "count" && (
        <Stepper
          label={t("backup.ui.retention.versions_label")}
          value={value.count}
          limits={RETENTION_LIMITS.count}
          format={(v) => t("backup.retention.versions", v)}
          onChange={(count) => onChange({ mode: "count", count })}
        />
      )}
      {choice === "custom" && value.mode === "tiered" && (
        <>
          <Stepper
            label={t("backup.ui.retention.days_label")}
            value={value.days}
            limits={RETENTION_LIMITS.days}
            format={(v) => t("backup.retention.days", v)}
            onChange={(days) => onChange({ ...value, days })}
          />
          <Stepper
            label={t("backup.ui.retention.weeks_label")}
            value={value.weeks}
            limits={RETENTION_LIMITS.weeks}
            format={(v) => t("backup.retention.weeks", v)}
            onChange={(weeks) => onChange({ ...value, weeks })}
          />
        </>
      )}
      <p className={styles.coverage}>{retentionCoverage(value)}</p>
    </div>
  );
}
