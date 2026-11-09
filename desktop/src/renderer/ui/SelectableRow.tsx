import { useId } from "react";
import { cx } from "./cx.ts";
import type { LucideIcon } from "./Icon.tsx";
import { IconTile } from "./IconTile.tsx";
import { MiddleText } from "./MiddleText.tsx";
import styles from "./SelectableRow.module.css";
import { ToggleTrack } from "./Toggle.tsx";
import { Tooltip } from "./Tooltip.tsx";

export interface SelectableRowProps {
  label: string;
  subtitle?: string;
  icon: LucideIcon;
  mono?: boolean;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabledReason?: string;
}

/** Élément à cocher d'une carte : tuile, titre (grisé si décoché), interrupteur ; toute la ligne bascule. */
export function SelectableRow({
  label,
  subtitle,
  icon,
  mono = false,
  checked,
  onChange,
  disabledReason,
}: SelectableRowProps) {
  const id = useId();
  const disabled = Boolean(disabledReason);
  return (
    <Tooltip content={disabledReason} block>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={id}
        aria-disabled={disabled || undefined}
        aria-description={disabledReason}
        className={styles.row}
        onClick={() => !disabled && onChange(!checked)}
      >
        <IconTile icon={icon} size={30} />
        <span className={styles.text}>
          <span id={id} className={styles.titleLine} data-off={checked ? undefined : true}>
            <MiddleText text={label} className={cx(styles.title, mono && styles.mono)} />
          </span>
          {subtitle && <MiddleText text={subtitle} className={styles.subtitle} />}
        </span>
        <ToggleTrack checked={checked} size="small" />
      </button>
    </Tooltip>
  );
}
