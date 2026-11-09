import { useRef } from "react";
import { moveEnabledIndex } from "./floating.ts";
import type { PickerOption } from "./PillPicker.tsx";
import styles from "./TabBar.module.css";
import { Tooltip } from "./Tooltip.tsx";

export interface TabBarProps<V extends string | number> {
  options: ReadonlyArray<PickerOption<V>>;
  value: V;
  onChange: (value: V) => void;
  /** Nom accessible du groupe (« Rétention »). */
  label: string;
  /** Raison pour laquelle le choix ne peut pas changer (configuration invalide…) : tout le groupe est désactivé. */
  disabledReason?: string;
}

/**
 * Choix d'une option dans une carte ou un tableau (« Public  Personnel ») : texte gris sans conteneur, choix courant
 * dans une pilule grise. Une option indisponible a son propre `disabledReason`. Les onglets d'une page utilisent
 * `PillPicker`.
 */
export function TabBar<V extends string | number>({ options, value, onChange, label, disabledReason }: TabBarProps<V>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const index = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );
  const reasonOf = (o: PickerOption<V>) => disabledReason ?? o.disabledReason;
  const enabled = options.map((o) => !reasonOf(o));
  return (
    <Tooltip content={disabledReason}>
      <div
        className={styles.bar}
        role="radiogroup"
        aria-label={label}
        aria-disabled={disabledReason ? true : undefined}
        aria-description={disabledReason}
      >
        {options.map((option, i) => {
          const reason = reasonOf(option);
          return (
            <Tooltip key={String(option.value)} content={disabledReason ? undefined : option.disabledReason}>
              {/* biome-ignore lint/a11y/useSemanticElements: groupe de boutons maison (pas de radio natif). */}
              <button
                ref={(el) => {
                  refs.current[i] = el;
                }}
                type="button"
                role="radio"
                aria-checked={i === index}
                aria-disabled={reason ? true : undefined}
                aria-description={disabledReason ? undefined : option.disabledReason}
                tabIndex={i === index ? 0 : -1}
                className={styles.chip}
                onClick={() => !reason && onChange(option.value)}
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
          );
        })}
      </div>
    </Tooltip>
  );
}
