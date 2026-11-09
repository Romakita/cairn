import { File, Folder } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Icon } from "./Icon.tsx";
import styles from "./PathField.module.css";
import { TextField } from "./TextField.tsx";

export interface PathSuggestion {
  /** Chemin relatif au home, sans `~/`. */
  path: string;
  isDirectory: boolean;
}

export interface PathFieldProps {
  value: string;
  onChange: (value: string) => void;
  /** Source des suggestions (jamais lue ici : le core ou des données d'exemple la fournissent). */
  suggest: (text: string) => readonly PathSuggestion[] | Promise<readonly PathSuggestion[]>;
  placeholder?: string;
  /** Nom accessible du champ. */
  label: string;
  /** Nom accessible de la liste de suggestions. */
  listLabel: string;
  onSubmit?: () => void;
  invalid?: boolean;
}

/**
 * Chemin relatif au home avec complétion : suggestions au-dessus du champ, ↑/↓ pour choisir, Tab ou Entrée pour
 * accepter, Échap pour fermer. Un dossier accepté garde la liste ouverte.
 */
export function PathField({
  value,
  onChange,
  suggest,
  placeholder,
  label,
  listLabel,
  onSubmit,
  invalid,
}: PathFieldProps) {
  const [items, setItems] = useState<readonly PathSuggestion[]>([]);
  const [highlighted, setHighlighted] = useState<number | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const listId = useId();
  const source = useRef(suggest);
  source.current = suggest;

  useEffect(() => {
    let cancelled = false;
    if (!value.trim()) {
      setItems([]);
      return;
    }
    void Promise.resolve(source.current(value)).then((list) => {
      if (!cancelled) setItems(list);
    });
    return () => {
      cancelled = true;
    };
  }, [value]);

  const open = !dismissed && items.length > 0;
  const accept = (s: PathSuggestion) => {
    onChange(s.path);
    setHighlighted(null);
    setDismissed(!s.isDirectory);
  };

  return (
    <div className={styles.root}>
      {open && (
        <div className={styles.list} id={listId} role="listbox" aria-label={listLabel}>
          {items.map((item, i) => (
            <div
              key={item.path}
              id={`${listId}-${i}`}
              role="option"
              tabIndex={-1}
              aria-selected={i === highlighted}
              className={styles.option}
              data-highlighted={i === highlighted || undefined}
              onPointerDown={(event) => {
                event.preventDefault();
                accept(item);
              }}
            >
              <span className={styles.optionIcon}>
                <Icon icon={item.isDirectory ? Folder : File} size={15} />
              </span>
              <span className={styles.optionPath}>~/{item.path}</span>
            </div>
          ))}
        </div>
      )}
      <TextField
        value={value}
        onChange={(v) => {
          onChange(v);
          setDismissed(false);
          setHighlighted(null);
        }}
        placeholder={placeholder}
        prefix="~/"
        label={label}
        invalid={invalid}
        onBlur={() => setDismissed(true)}
        inputProps={{
          role: "combobox",
          "aria-autocomplete": "list",
          "aria-expanded": open,
          "aria-controls": open ? listId : undefined,
          "aria-activedescendant": open && highlighted !== null ? `${listId}-${highlighted}` : undefined,
        }}
        onKeyDown={(event) => {
          if (!open) {
            if (event.key === "Enter") {
              onSubmit?.();
              setDismissed(true);
              event.preventDefault();
            }
            return;
          }
          const count = items.length;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const delta = event.key === "ArrowDown" ? 1 : -1;
            setHighlighted((h) => ((h ?? (delta > 0 ? -1 : count)) + delta + count) % count);
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            setDismissed(true);
          } else if (event.key === "Tab" && !event.shiftKey) {
            event.preventDefault();
            accept(items[highlighted ?? 0]!);
          } else if (event.key === "Enter") {
            event.preventDefault();
            if (highlighted !== null) accept(items[highlighted]!);
            else {
              onSubmit?.();
              setDismissed(true);
            }
          }
        }}
      />
    </div>
  );
}
