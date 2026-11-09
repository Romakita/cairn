import { type CSSProperties, type ReactNode, useState } from "react";
import styles from "./helpers.module.css";
import { s } from "./sample-text.ts";

/** Montre un composant dans un état simulé (survol) : les composants de ui/ reconnaissent `data-simulate`. */
export function Simulate({ state, children }: { state: "hover"; children: ReactNode }) {
  return (
    <div className={styles.simulate} data-simulate={state}>
      {children}
    </div>
  );
}

export type StateName = "normal" | "hover" | "disabled" | "loading" | "destructive" | "invalid" | "selected";

/** Grille « état → rendu » : une ligne par état, libellé à gauche. */
export function States({ rows }: { rows: ReadonlyArray<readonly [StateName | string, ReactNode]> }) {
  return (
    <div className={styles.states}>
      {rows.map(([state, node]) => (
        <div key={state} className={styles.stateRow}>
          <span className={styles.stateLabel}>{s(`gallery.state.${state}`)}</span>
          <div className={styles.stateContent}>
            {state === "hover" ? <Simulate state="hover">{node}</Simulate> : node}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Ligne d'éléments espacés. */
export function Row({ children, gap = 10, wrap = false }: { children: ReactNode; gap?: number; wrap?: boolean }) {
  return (
    <div className={styles.row} style={{ gap }} data-wrap={wrap || undefined}>
      {children}
    </div>
  );
}

/** Colonne d'éléments espacés. */
export function Column({
  children,
  gap = 10,
  center = false,
}: {
  children: ReactNode;
  gap?: number;
  center?: boolean;
}) {
  return (
    <div className={styles.column} style={{ gap }} data-center={center || undefined}>
      {children}
    </div>
  );
}

/** Pastille d'un jeton de couleur, avec son nom. */
export function Swatch({ name, color }: { name: string; color: string }) {
  return (
    <div className={styles.swatch}>
      <span className={styles.swatchColor} style={{ "--swatch": color } as CSSProperties} />
      <span className={styles.swatchName}>{name}</span>
    </div>
  );
}

/** Grille de N colonnes. */
export function Grid({ children, columns }: { children: ReactNode; columns: number }) {
  return (
    <div className={styles.grid} style={{ "--grid-columns": columns } as CSSProperties}>
      {children}
    </div>
  );
}

/** État local d'une story (sélecteur, champ, case). */
export function Stateful<T>({
  initial,
  children,
}: {
  initial: T;
  children: (value: T, set: (v: T) => void) => ReactNode;
}) {
  const [value, setValue] = useState(initial);
  return <>{children(value, setValue)}</>;
}

/** Fond d'un échantillon (rail, barre latérale) pour montrer un composant dans son cadre. */
export function Surface({ children, tone }: { children: ReactNode; tone: "rail" | "sidebar" | "worker" }) {
  return (
    <div className={styles.surface} data-surface={tone}>
      {children}
    </div>
  );
}

/** Légende monospace sous un échantillon (nom d'icône…). */
export function Caption({ children }: { children: ReactNode }) {
  return <span className={styles.caption}>{children}</span>;
}

/** Titre d'échantillon (15 medium). */
export function Title({ children }: { children: ReactNode }) {
  return <span className={styles.title}>{children}</span>;
}

/** Texte secondaire d'échantillon (13, gris). */
export function Muted({ children }: { children: ReactNode }) {
  return <span className={styles.muted}>{children}</span>;
}
