import { type CSSProperties, useRef } from "react";
import { moveEnabledIndex } from "./floating.ts";
import styles from "./PillPicker.module.css";
import { Tooltip } from "./Tooltip.tsx";

export interface PickerOption<V extends string | number | boolean> {
  value: V;
  label: string;
  /** Raison pour laquelle cette option ne peut pas être choisie : désactivée, raison en infobulle. */
  disabledReason?: string;
}

export interface PillPickerProps<V extends string | number | boolean> {
  options: ReadonlyArray<PickerOption<V>>;
  value: V;
  onChange: (value: V) => void;
  /** Nom accessible du groupe d'onglets. */
  label: string;
}

/**
 * Onglets d'une page (bascule « Chat / Work » de Codex) : piste grise, segments de même largeur, segment choisi
 * blanc ombré qui glisse. Un onglet indisponible est désactivé avec sa raison (`disabledReason` de l'option) ; les
 * flèches le sautent. Dans une carte ou un tableau, utiliser `TabBar`.
 */
export function PillPicker<V extends string | number | boolean>({
  options,
  value,
  onChange,
  label,
}: PillPickerProps<V>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const index = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );
  const enabled = options.map((o) => !o.disabledReason);
  const style = { "--pill-index": index, "--pill-count": options.length } as CSSProperties;
  return (
    <div className={styles.track} role="tablist" aria-label={label} style={style}>
      <span className={styles.thumb} aria-hidden="true" />
      {options.map((option, i) => (
        <Tooltip key={String(option.value)} content={option.disabledReason} block>
          <button
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            aria-selected={i === index}
            aria-disabled={option.disabledReason ? true : undefined}
            aria-description={option.disabledReason}
            tabIndex={i === index ? 0 : -1}
            className={styles.segment}
            onClick={() => !option.disabledReason && onChange(option.value)}
            onKeyDown={(event) => {
              const next = moveEnabledIndex(event.key, i, enabled, "horizontal");
              if (next === null) return;
              event.preventDefault();
              onChange(options[next]!.value);
              refs.current[next]?.focus();
            }}
          >
            {option.label}
          </button>
        </Tooltip>
      ))}
    </div>
  );
}
