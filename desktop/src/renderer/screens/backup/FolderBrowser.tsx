// Navigateur de dossiers du formulaire de destination : fil d'Ariane (« Emplacements » › volume › …), dossiers à ouvrir
// (ouvrir un dossier le choisit), « Nouveau dossier ». Racines : emplacements locaux (`localRoots`) ou racine d'un
// partage monté. Lecture seule hors « Créer ».
import { FolderOpen, FolderPlus, HardDrive, Lock } from "lucide-react";
import { useEffect, useState } from "react";
import { t } from "../../../core/l10n.ts";
import type { FolderEntry } from "../../../shared/contract.ts";
import { useApi } from "../../api/hooks.ts";
import { Badge } from "../../ui/Badge.tsx";
import { Banner } from "../../ui/Banner.tsx";
import { Button } from "../../ui/Button.tsx";
import { CardTray } from "../../ui/CardTray.tsx";
import { type Crumb, FolderBreadcrumb } from "../../ui/FolderBreadcrumb.tsx";
import { FolderRow } from "../../ui/FolderRow.tsx";
import { Spinner } from "../../ui/Spinner.tsx";
import { TextField } from "../../ui/TextField.tsx";
import styles from "./FolderBrowser.module.css";

export interface FolderBrowserProps {
  /** Racine unique (partage monté) ; absente : emplacements locaux. */
  root?: FolderEntry;
  /** Dossier courant (choisi), `null` : liste des emplacements. */
  value: string | null;
  onChange: (path: string | null) => void;
  /** Badges des sauvegardes trouvées dans le dossier courant (ce Mac, autre machine). */
  badges?: string[];
}

const LOCATIONS = "\u0000locations";

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function FolderBrowser({ root, value, onChange, badges = [] }: FolderBrowserProps) {
  const api = useApi();
  const [roots, setRoots] = useState<FolderEntry[] | null>(root ? [root] : null);
  const [entries, setEntries] = useState<FolderEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const current = value ?? (root ? root.path : null);

  const rootPath = root?.path;
  const rootName = root?.name;
  useEffect(() => {
    if (rootPath !== undefined) {
      setRoots([{ path: rootPath, name: rootName ?? rootPath }]);
      return;
    }
    let live = true;
    api
      .localRoots()
      .then((r) => live && setRoots(r))
      .catch((e) => live && setError(errorText(e)));
    return () => {
      live = false;
    };
  }, [api, rootPath, rootName]);

  useEffect(() => {
    setError(null);
    setEntries(null);
    if (current === null) return;
    let live = true;
    api
      .listFolders({ path: current })
      .then((r) => live && setEntries(r))
      .catch((e) => {
        if (!live) return;
        setError(errorText(e));
        setEntries([]);
      });
    return () => {
      live = false;
    };
  }, [api, current]);

  const base = roots?.find((r) => current !== null && (current === r.path || current.startsWith(`${r.path}/`)));
  const crumbs: Crumb[] = [];
  if (!root) crumbs.push({ label: t("probe.browser.locations"), id: LOCATIONS });
  if (base && current !== null) {
    crumbs.push({ label: base.name, id: base.path });
    const rest = current.slice(base.path.length).split("/").filter(Boolean);
    let acc = base.path;
    const parts = rest.map((seg) => {
      acc = `${acc}/${seg}`;
      return { label: seg, id: acc };
    });
    // Au plus 4 niveaux visibles : « … » pour les niveaux masqués.
    if (parts.length > 3) crumbs.push({ label: "…" }, ...parts.slice(-3));
    else crumbs.push(...parts);
  } else if (current !== null && !base) {
    crumbs.push({ label: current, id: current });
  }

  const create = async () => {
    if (current === null) return;
    setCreateError(null);
    try {
      const created = await api.createFolder({ parent: current, name });
      setName("");
      onChange(created);
    } catch (e) {
      setCreateError(errorText(e));
    }
  };

  const list = current === null ? roots : entries;
  return (
    <div className={styles.browser}>
      <div className={styles.top}>
        <FolderBreadcrumb
          label={t("backup.ui.form.folder")}
          items={crumbs}
          onSelect={(id) => onChange(id === LOCATIONS ? null : id)}
        />
        {badges.length > 0 && (
          <span className={styles.badges}>
            {badges.map((b) => (
              <Badge key={b} tone="info">
                {b}
              </Badge>
            ))}
          </span>
        )}
      </div>
      <div className={styles.list}>
        {list === null && !error && (
          <p className={styles.empty}>
            <Spinner size="small" />
          </p>
        )}
        {error && (
          <div className={styles.denied}>
            <Banner tone="warning" icon={Lock}>
              {t("probe.browser.access_denied")} — {error}
            </Banner>
            {current !== null && base && current !== base.path && (
              <Button onClick={() => onChange(current.slice(0, current.lastIndexOf("/")) || null)}>
                {t("probe.browser.up")}
              </Button>
            )}
          </div>
        )}
        {list !== null && list.length === 0 && !error && (
          <p className={styles.empty}>{current === null ? t("probe.browser.no_location") : t("probe.browser.empty")}</p>
        )}
        {list && list.length > 0 && (
          <ul className={styles.items}>
            {list.map((e) => (
              <li key={e.path}>
                <FolderRow
                  name={e.name}
                  icon={current === null ? HardDrive : FolderOpen}
                  onOpen={() => onChange(e.path)}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
      {current !== null && (
        <CardTray>
          <div className={styles.create}>
            <TextField
              value={name}
              onChange={setName}
              icon={FolderPlus}
              label={t("probe.browser.new_folder_placeholder")}
              placeholder={t("probe.browser.new_folder_placeholder")}
              invalid={createError !== null}
              onSubmit={() => void create()}
            />
            <Button
              onClick={() => void create()}
              disabledReason={name.trim() === "" ? t("probe.error.name_empty") : undefined}
            >
              {t("probe.browser.create")}
            </Button>
          </div>
          {createError && <p className={styles.error}>{createError}</p>}
        </CardTray>
      )}
    </div>
  );
}
