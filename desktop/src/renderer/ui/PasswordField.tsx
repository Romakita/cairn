import { Eye, EyeOff } from "lucide-react";
import { useState } from "react";
import { IconButton } from "./IconButton.tsx";
import { TextField, type TextFieldProps } from "./TextField.tsx";

export interface PasswordFieldProps extends Omit<TextFieldProps, "type" | "trailing" | "prefix" | "mono"> {
  /** Noms du bouton d'affichage (« Afficher le mot de passe » / « Masquer le mot de passe »). */
  showLabel: string;
  hideLabel: string;
}

/** Champ de mot de passe : masqué par défaut, bouton œil pour l'afficher, état refusé en rouge. */
export function PasswordField({ showLabel, hideLabel, ...props }: PasswordFieldProps) {
  const [visible, setVisible] = useState(false);
  return (
    <TextField
      {...props}
      type={visible ? "text" : "password"}
      trailing={
        <IconButton
          icon={visible ? EyeOff : Eye}
          label={visible ? hideLabel : showLabel}
          onClick={() => setVisible((v) => !v)}
        />
      }
    />
  );
}
