import { Check } from "lucide-react";
import type { CSSProperties } from "react";
import { Icon } from "./Icon.tsx";
import styles from "./WizardStepper.module.css";

export interface WizardStepperProps {
  steps: readonly string[];
  /** Étape affichée. */
  current: number;
  /** Étape la plus avancée atteinte. */
  reached: number;
  /** Étapes où l'on peut revenir ; les autres ne réagissent pas (sans être grisées). */
  canSelect: (index: number) => boolean;
  onSelect: (index: number) => void;
  /** Nom accessible de la liste d'étapes. */
  label: string;
}

/** Étapes d'un assistant : pastilles numérotées reliées par une ligne, courante noire, faites cochées. */
export function WizardStepper({ steps, current, reached, canSelect, onSelect, label }: WizardStepperProps) {
  const style = { "--steps": steps.length, "--current": current } as CSSProperties;
  return (
    <nav aria-label={label} className={styles.root} style={style}>
      <span className={styles.line} aria-hidden="true">
        <span className={styles.progress} />
      </span>
      <ol className={styles.list}>
        {steps.map((title, i) => {
          const state = i === current ? "current" : i < current ? "done" : i <= reached ? "reached" : "todo";
          const enabled = canSelect(i) && i !== current;
          return (
            <li key={title} className={styles.step}>
              <button
                type="button"
                className={styles.button}
                data-state={state}
                data-enabled={enabled || undefined}
                aria-current={i === current ? "step" : undefined}
                tabIndex={enabled || i === current ? 0 : -1}
                onClick={() => enabled && onSelect(i)}
              >
                <span className={styles.node}>{state === "done" ? <Icon icon={Check} size={13} /> : i + 1}</span>
                <span className={styles.title}>{title}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
