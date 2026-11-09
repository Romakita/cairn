import { Minus, Plus } from "lucide-react";
import { IconButton } from "./IconButton.tsx";
import styles from "./NumberStepper.module.css";
import { Tooltip } from "./Tooltip.tsx";

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
  /** Raison pour laquelle la valeur ne peut pas changer (configuration invalide…) : tout est désactivé. */
  disabledReason?: string;
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
  disabledReason,
}: NumberStepperProps) {
  const set = (v: number) => {
    if (!disabledReason) onChange(Math.min(max, Math.max(min, v)));
  };
  return (
    <div className={styles.root} data-disabled={disabledReason ? true : undefined}>
      <IconButton
        icon={Minus}
        label={decrementLabel}
        disabledReason={disabledReason ?? (value <= min ? (minReason ?? decrementLabel) : undefined)}
        onClick={() => set(value - step)}
      />
      <Tooltip content={disabledReason}>
        <span
          role="spinbutton"
          tabIndex={0}
          aria-label={label}
          aria-disabled={disabledReason ? true : undefined}
          aria-description={disabledReason}
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
      </Tooltip>
      <IconButton
        icon={Plus}
        label={incrementLabel}
        disabledReason={disabledReason ?? (value >= max ? (maxReason ?? incrementLabel) : undefined)}
        onClick={() => set(value + step)}
      />
    </div>
  );
}
