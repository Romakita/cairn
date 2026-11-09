import type { FocusEvent, InputHTMLAttributes, KeyboardEvent, ReactNode, Ref } from "react";
import { cx } from "./cx.ts";
import { Icon, type LucideIcon } from "./Icon.tsx";
import styles from "./TextField.module.css";
import { Tooltip } from "./Tooltip.tsx";

export interface TextFieldProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** Icône à gauche (recherche…). */
  icon?: LucideIcon;
  /** Préfixe en police fixe (`~/`) : la saisie passe aussi en police fixe. */
  prefix?: string;
  /** Valeur refusée (mot de passe du NAS) : bordure rouge. */
  invalid?: boolean;
  /** Nom accessible quand le champ n'a pas de libellé visible. */
  label?: string;
  type?: "text" | "password" | "search";
  mono?: boolean;
  disabledReason?: string;
  /** Élément à droite dans la capsule (bouton d'affichage du mot de passe). */
  trailing?: ReactNode;
  onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
  onFocus?: (event: FocusEvent<HTMLInputElement>) => void;
  onBlur?: (event: FocusEvent<HTMLInputElement>) => void;
  onSubmit?: () => void;
  autoFocus?: boolean;
  inputRef?: Ref<HTMLInputElement>;
  /** Attributs ARIA supplémentaires (combobox de `PathField`). */
  inputProps?: Pick<
    InputHTMLAttributes<HTMLInputElement>,
    "role" | "aria-autocomplete" | "aria-controls" | "aria-expanded" | "aria-activedescendant" | "id"
  >;
}

/** Champ capsule de Cairn : bordure fine, accent 1,5 au focus (sans anneau natif), icône ou préfixe. */
export function TextField({
  value,
  onChange,
  placeholder,
  icon,
  prefix,
  invalid = false,
  label,
  type = "text",
  mono = false,
  disabledReason,
  trailing,
  onKeyDown,
  onFocus,
  onBlur,
  onSubmit,
  autoFocus,
  inputRef,
  inputProps,
}: TextFieldProps) {
  const disabled = Boolean(disabledReason);
  return (
    <Tooltip content={disabledReason} block>
      <span className={styles.field} data-invalid={invalid || undefined} data-disabled={disabled || undefined}>
        {icon && (
          <span className={styles.icon}>
            <Icon icon={icon} size={15} />
          </span>
        )}
        {prefix && <span className={styles.prefix}>{prefix}</span>}
        <input
          {...inputProps}
          ref={inputRef}
          className={cx(styles.input, (mono || prefix) && styles.mono)}
          type={type}
          value={value}
          placeholder={placeholder}
          aria-label={label}
          aria-invalid={invalid || undefined}
          aria-description={disabledReason}
          readOnly={disabled}
          // biome-ignore lint/a11y/noAutofocus: choisi par l'écran appelant (feuille, assistant).
          autoFocus={autoFocus}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            onKeyDown?.(event);
            if (!event.defaultPrevented && event.key === "Enter") onSubmit?.();
          }}
          onFocus={onFocus}
          onBlur={onBlur}
        />
        {trailing}
      </span>
    </Tooltip>
  );
}
