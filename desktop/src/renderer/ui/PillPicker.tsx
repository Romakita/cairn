import { type CSSProperties, useRef } from "react";
import { moveIndex } from "./floating.ts";
import styles from "./PillPicker.module.css";

export interface PickerOption<V extends string | number | boolean> {
  value: V;
  label: string;
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
 * blanc ombré qui glisse. Dans une carte ou un tableau, utiliser `TabBar`.
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
  const style = { "--pill-index": index, "--pill-count": options.length } as CSSProperties;
  return (
    <div className={styles.track} role="tablist" aria-label={label} style={style}>
      <span className={styles.thumb} aria-hidden="true" />
      {options.map((option, i) => (
        <button
          key={String(option.value)}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="tab"
          aria-selected={i === index}
          tabIndex={i === index ? 0 : -1}
          className={styles.segment}
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
