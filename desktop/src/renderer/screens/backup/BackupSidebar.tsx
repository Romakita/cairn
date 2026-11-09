// Sidebar des Sauvegardes : destinations (pastille d'état, anneau et pourcentage pendant une sauvegarde), ajout, et
// contenu sauvegardé ; chaque ligne du contenu mène à l'écran qui le règle (U §4.15 : pas de faux filtres).
import { Folder, House, Plus, Sparkles, SquareTerminal } from "lucide-react";
import { t } from "../../../core/l10n.ts";
import type { AppSnapshot, NavigationRequest } from "../../../shared/contract.ts";
import { SidebarHeader } from "../../ui/SidebarHeader.tsx";
import { SidebarRow } from "../../ui/SidebarRow.tsx";
import { Sidebar } from "../shell/Layout.tsx";
import styles from "./BackupSidebar.module.css";
import { isActive, progressFraction, reachability, reachabilityDot, reachabilityLabel } from "./model.ts";

export interface BackupSidebarProps {
  snapshot: AppSnapshot;
  selected: string | null;
  onSelect: (id: string) => void;
  onAdd: () => void;
  navigate: (request: NavigationRequest) => void;
}

function shortPath(p: string): string {
  return p.replace(/^\/Users\/[^/]+/, "~");
}

export function BackupSidebar({ snapshot, selected, onSelect, onAdd, navigate }: BackupSidebarProps) {
  const config = snapshot.config.config;
  const folders = config.folders.filter((f) => f.backup);
  const ai = config.ai.filter((a) => a.categories.length > 0);
  return (
    <Sidebar heading={t("section.backup")} label={t("section.backup")}>
      <div className={styles.group}>
        <SidebarHeader label={t("sidebar.destinations")} />
        {snapshot.destinations.map((d) => {
          const p = snapshot.backup.destinations.find((x) => x.destination === d.id);
          const busy = snapshot.backup.running && p !== undefined && isActive(p);
          const r = reachability(d);
          return (
            <SidebarRow
              key={d.id}
              label={d.label}
              dot={reachabilityDot(r)}
              meta={r === "reachable" ? undefined : reachabilityLabel(r)}
              selected={d.id === selected}
              busy={busy}
              fraction={busy && p ? progressFraction(p) : undefined}
              onClick={() => onSelect(d.id)}
            />
          );
        })}
        <SidebarRow label={t("sidebar.add_destination")} icon={Plus} onClick={onAdd} />
      </div>
      {snapshot.destinations.length > 0 && (
        <div className={styles.group}>
          <SidebarHeader label={t("backup.content")} />
          {folders.map((f) => (
            <SidebarRow
              key={f.path}
              label={shortPath(f.path)}
              icon={Folder}
              onClick={() => navigate({ route: "settings" })}
            />
          ))}
          <SidebarRow
            label={t("backup.ui.content.home")}
            icon={House}
            meta={String(config.home.include.length)}
            onClick={() => navigate({ route: "settings" })}
          />
          <SidebarRow
            label={t("section.ai")}
            icon={Sparkles}
            meta={String(ai.length)}
            onClick={() => navigate({ route: "ai" })}
          />
          <SidebarRow
            label={t("section.cli")}
            icon={SquareTerminal}
            meta={
              snapshot.inventory.inventory
                ? String(snapshot.inventory.inventory.entries.filter((e) => !e.excluded).length)
                : undefined
            }
            onClick={() => navigate({ route: "tools" })}
          />
        </div>
      )}
    </Sidebar>
  );
}
