// Mot de passe d'une image chiffrée créée par la dernière sauvegarde : montré une seule fois (rangé dans le Trousseau,
// mais nécessaire pour restaurer sur un Mac neuf). « C'est noté » appelle `acknowledgeImagePassword` : le main l'oublie.
import { Copy, KeyRound } from "lucide-react";
import { useState } from "react";
import { t } from "../../../core/l10n.ts";
import { useApi } from "../../api/hooks.ts";
import { Button } from "../../ui/Button.tsx";
import { Icon } from "../../ui/Icon.tsx";
import { Sheet } from "../../ui/Sheet.tsx";
import styles from "./ImagePasswordSheet.module.css";

export interface ImagePasswordSheetProps {
  destination: string;
  label: string;
  password: string;
}

export function ImagePasswordSheet({ destination, label, password }: ImagePasswordSheetProps) {
  const api = useApi();
  const [copied, setCopied] = useState(false);
  // Le message de la 0.8.0 se termine par le mot de passe (`{1}`) : il est affiché à part, en police fixe.
  const message = t("backup.image_password.message", "").trim();
  return (
    <Sheet
      open
      heading={t("backup.image_password.title")}
      description={label}
      closeLabel={t("action.close")}
      width={520}
      footer={
        <>
          <Button
            icon={Copy}
            onClick={() =>
              void api.copyText({ text: password }).then(() => {
                setCopied(true);
              })
            }
          >
            {copied ? t("backup.ui.copied") : t("backup.image_password.copy")}
          </Button>
          <Button variant="primary" onClick={() => void api.acknowledgeImagePassword({ destination })}>
            {t("backup.image_password.noted")}
          </Button>
        </>
      }
    >
      <div className={styles.body}>
        <p className={styles.text}>{message}</p>
        <div className={styles.password}>
          <Icon icon={KeyRound} size={16} />
          <span className={styles.value}>{password}</span>
        </div>
      </div>
    </Sheet>
  );
}
