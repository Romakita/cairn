import { useRef } from "react";
import { moveIndex } from "./floating.ts";
import type { PickerOption } from "./PillPicker.tsx";
import styles from "./TabBar.module.css";

export interface TabBarProps<V extends string | number> {
  options: ReadonlyArray<PickerOption<V>>;
  value: V;
  onChange: (value: V) => void;
  /** Nom accessible du groupe (« Rétention »). */
  label: string;
}

/**
 * Choix d'une option dans une carte ou un tableau (« Public  Personnel ») : texte gris sans conteneur, choix courant
 * dans une pilule grise. Les onglets d'une page utilisent `PillPicker`.
 */
export function TabBar<V extends string | number>({ options, value, onChange, label }: TabBarProps<V>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const index = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );
  return (
    <div className={styles.bar} role="radiogroup" aria-label={label}>
      {options.map((option, i) => (
        // biome-ignore lint/a11y/useSemanticElements: groupe de boutons maison (pas de radio natif).
        <button
          key={String(option.value)}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="radio"
          aria-checked={i === index}
          tabIndex={i === index ? 0 : -1}
          className={styles.chip}
          onClick={() => onChange(option.value)}
          onKeyDown={(event) => {
            const next = moveIndex(event.key, i, options.length, "horizontal");
            if (next === null) return;
            event.preventDefault();
            onChange(options[next]!.value);
            refs.current[next]?.focus();
          }}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
