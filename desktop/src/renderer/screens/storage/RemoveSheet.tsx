// Confirmation d'une suppression de l'analyse (Explorateur, Nettoyable, Gros objets) : corbeille par défaut,
// suppression définitive en option, aperçu des chemins. Le main redemande la confirmation avant d'agir.
import { useEffect, useState } from "react";
import { Fmt } from "../../../core/format.ts";
import { t } from "../../../core/l10n.ts";
import { Button } from "../../ui/Button.tsx";
import { Checkbox } from "../../ui/Checkbox.tsx";
import { MiddleText } from "../../ui/MiddleText.tsx";
import { Sheet } from "../../ui/Sheet.tsx";
import styles from "./RemoveSheet.module.css";

export interface RemovalItem {
  nodeId: number;
  path: string;
  size: number;
}

export interface RemoveSheetProps {
  items: readonly RemovalItem[] | null;
  /** Suppression en cours : boutons bloqués. */
  busy: boolean;
  onCancel: () => void;
  onConfirm: (permanently: boolean) => void;
}

const SHOWN = 6;

export function RemoveSheet({ items, busy, onCancel, onConfirm }: RemoveSheetProps) {
  const [permanently, setPermanently] = useState(false);
  const open = items !== null && items.length > 0;
  useEffect(() => {
    if (open) setPermanently(false);
  }, [open]);
  if (!open) return null;
  const bytes = Fmt.bytes(items.reduce((sum, i) => sum + i.size, 0));
  const heading = permanently
    ? t("confirm.delete.title", items.length, bytes)
    : t("confirm.trash.title", items.length, bytes);
  const more = items.length - SHOWN;
  return (
    <Sheet
      open
      width={560}
      heading={heading}
      closeLabel={t("action.close")}
      onClose={busy ? undefined : onCancel}
      footer={
        <>
          <Button onClick={onCancel} disabledReason={busy ? t("storage.remove.busy") : undefined}>
            {t("action.cancel")}
          </Button>
          {permanently ? (
            <Button variant="danger" loading={busy} onClick={() => onConfirm(true)}>
              {t("action.delete")}
            </Button>
          ) : (
            <Button variant="primary" loading={busy} autoFocus onClick={() => onConfirm(false)}>
              {t("action.trash")}
            </Button>
          )}
        </>
      }
    >
      <div className={styles.body}>
        <ul className={styles.list} aria-label={t("storage.remove.items")}>
          {items.slice(0, SHOWN).map((item) => (
            <li key={item.nodeId} className={styles.item}>
              <MiddleText text={item.path} className={styles.path} />
              <span className={styles.size}>{Fmt.bytes(item.size)}</span>
            </li>
          ))}
          {more > 0 && <li className={styles.more}>{t("confirm.more", more)}</li>}
        </ul>
        <Checkbox checked={permanently} onChange={setPermanently}>
          {t("storage.remove.permanently")}
        </Checkbox>
        <p className={permanently ? styles.danger : styles.note}>
          {permanently ? t("confirm.irreversible") : t("confirm.trash_note")}
        </p>
      </div>
    </Sheet>
  );
}
