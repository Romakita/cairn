import { CircleCheck } from "lucide-react";
import { Icon, type LucideIcon } from "./Icon.tsx";
import { MiddleText } from "./MiddleText.tsx";
import { Spinner } from "./Spinner.tsx";
import styles from "./WorkerRow.module.css";

export interface WorkerRowProps {
  icon: LucideIcon;
  label: string;
  /** Fichier en cours ou état, en police fixe, tronqué au milieu. */
  detail: string;
  done: boolean;
  /** Texte annoncé de l'état (« Terminé », « En cours »). */
  stateLabel?: string;
}

/** Ligne d'une tâche en cours (copie, comptage) : icône, titre, détail, roue ou coche verte. */
export function WorkerRow({ icon, label, detail, done, stateLabel }: WorkerRowProps) {
  return (
    <div className={styles.row}>
      <span className={styles.icon}>
        <Icon icon={icon} size={15} />
      </span>
      <span className={styles.text}>
        <span className={styles.title}>{label}</span>
        <MiddleText text={detail} className={styles.detail} />
      </span>
      {done ? (
        <span className={styles.done}>
          <Icon icon={CircleCheck} size={15} label={stateLabel} />
        </span>
      ) : (
        <Spinner size="small" label={stateLabel} />
      )}
    </div>
  );
}
