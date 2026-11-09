import { Minus, Plus } from "lucide-react";
import { IconButton } from "./IconButton.tsx";
import styles from "./NumberStepper.module.css";

export interface NumberStepperProps {
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step?: number;
  /** Nom accessible (« Versions gardées »). */
  label: string;
  decrementLabel: string;
  incrementLabel: string;
  /** Raisons des bornes, montrées quand le bouton est désactivé. */
  minReason?: string;
  maxReason?: string;
  /** Texte affiché (« 7 jours ») ; la valeur sinon. */
  format?: (value: number) => string;
}

/** Choix d'un nombre (rétention) : moins, valeur, plus ; flèches haut et bas au clavier (remplace `Stepper`). */
export function NumberStepper({
  value,
  onChange,
  min,
  max,
  step = 1,
  label,
  decrementLabel,
  incrementLabel,
  minReason,
  maxReason,
  format,
}: NumberStepperProps) {
  const set = (v: number) => onChange(Math.min(max, Math.max(min, v)));
  return (
    <div className={styles.root}>
      <IconButton
        icon={Minus}
        label={decrementLabel}
        disabledReason={value <= min ? (minReason ?? decrementLabel) : undefined}
        onClick={() => set(value - step)}
      />
      <span
        role="spinbutton"
        tabIndex={0}
        aria-label={label}
        aria-valuenow={value}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuetext={format?.(value)}
        className={styles.value}
        onKeyDown={(event) => {
          if (event.key === "ArrowUp") set(value + step);
          else if (event.key === "ArrowDown") set(value - step);
          else if (event.key === "Home") set(min);
          else if (event.key === "End") set(max);
          else return;
          event.preventDefault();
        }}
      >
        {format ? format(value) : value}
      </span>
      <IconButton
        icon={Plus}
        label={incrementLabel}
        disabledReason={value >= max ? (maxReason ?? incrementLabel) : undefined}
        onClick={() => set(value + step)}
      />
    </div>
  );
}
