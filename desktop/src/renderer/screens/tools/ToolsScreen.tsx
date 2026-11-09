// Écran Outils CLI : inventaire des outils installés (utilisés, inutilisés, requis mais absents), raison de chaque
// statut, case « Garder » (exclusions de config.toml) et export de la liste retenue.
import { Download, RefreshCw, Search, Terminal } from "lucide-react";
import { useEffect, useState } from "react";
import { type InventoryEntry, type InventoryStatus, reasonText } from "../../../core/inventory/types.ts";
import { t } from "../../../core/l10n.ts";
import type { AppSnapshot } from "../../../shared/contract.ts";
import { useApi, useSnapshot } from "../../api/hooks.ts";
import { Badge } from "../../ui/Badge.tsx";
import { Banner, type Tone } from "../../ui/Banner.tsx";
import { Button } from "../../ui/Button.tsx";
import { Checkbox } from "../../ui/Checkbox.tsx";
import { EmptyState } from "../../ui/EmptyState.tsx";
import { PageHeader } from "../../ui/PageHeader.tsx";
import { PillPicker } from "../../ui/PillPicker.tsx";
import { Table, type TableSort } from "../../ui/Table.tsx";
import { TextField } from "../../ui/TextField.tsx";
import type { ScreenProps } from "../types.ts";
import styles from "./ToolsScreen.module.css";

type Filter = "all" | InventoryStatus;

const STATUS_TONE: Record<InventoryStatus, Tone> = { used: "success", unused: "neutral", missing: "danger" };
const STATUS_ORDER: Record<InventoryStatus, number> = { missing: 0, used: 1, unused: 2 };

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function ToolsScreen(props: ScreenProps) {
  const snapshot = useSnapshot();
  if (!snapshot) return <div data-testid="screen-tools" className={styles.screen} />;
  return <ToolsContent {...props} snapshot={snapshot} />;
}

function ToolsContent({ snapshot }: ScreenProps & { snapshot: AppSnapshot }) {
  const api = useApi();
  const { inventory, config } = snapshot;
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<TableSort>({ column: "status", direction: "ascending" });
  const [notice, setNotice] = useState<{ tone: Tone; text: string } | null>(null);
  const [exporting, setExporting] = useState(false);

  // Premier passage : l'inventaire n'a pas encore été dressé.
  // biome-ignore lint/correctness/useExhaustiveDependencies: une seule fois, à l'ouverture de l'écran.
  useEffect(() => {
    if (inventory.status === "idle") void api.toolsRefresh().catch(() => {});
  }, []);

  const excluded = new Set(config.config.excludedTools);
  const entries = inventory.inventory?.entries ?? [];
  const kept = entries.filter((e) => e.tool && !excluded.has(e.name));
  const installed = entries.filter((e) => e.tool);
  const count = (s: InventoryStatus) => entries.filter((e) => e.status === s).length;
  const q = query.trim().toLowerCase();
  const visible = entries.filter(
    (e) => (filter === "all" || e.status === filter) && (q === "" || e.name.toLowerCase().includes(q)),
  );
  const values: Record<string, (e: InventoryEntry) => number | string> = {
    keep: (e) => (excluded.has(e.name) ? 1 : 0),
    tool: (e) => e.name.toLowerCase(),
    source: (e) => e.tool?.source ?? "~",
    status: (e) => STATUS_ORDER[e.status] * 1000 + (e.name.charCodeAt(0) || 0),
  };
  const value = values[sort.column] ?? values.tool!;
  const rows = [...visible].sort((a, b) => {
    const x = value(a);
    const y = value(b);
    const d = typeof x === "string" ? x.localeCompare(String(y)) : x - Number(y);
    return sort.direction === "ascending" ? d : -d;
  });

  const loading = inventory.status === "loading" || inventory.status === "idle";
  const blocked = config.hasErrors ? t("settings.blocked") : undefined;

  const setKept = (name: string, keep: boolean) => {
    const next = keep ? config.config.excludedTools.filter((n) => n !== name) : [...config.config.excludedTools, name];
    api
      .saveConfig({ patches: [{ kind: "excludedTools", excludedTools: next }] })
      .catch((e: unknown) => setNotice({ tone: "danger", text: errorText(e) }));
  };

  const exportList = async () => {
    setExporting(true);
    setNotice(null);
    try {
      const result = await api.toolsExport();
      if (result) setNotice({ tone: "success", text: t("inventory.exported", kept.length, result.dir) });
    } catch (e) {
      setNotice({ tone: "danger", text: errorText(e) });
    } finally {
      setExporting(false);
    }
  };

  const exportBlocked = loading
    ? t("tools.unavailable.loading")
    : kept.length === 0
      ? t("tools.unavailable.nothing_kept")
      : undefined;

  return (
    <div data-testid="screen-tools" className={styles.screen}>
      <PageHeader
        heading={t("section.cli")}
        subtitle={
          inventory.status === "loaded" ? t("inventory.retained", kept.length, installed.length) : t("tools.subtitle")
        }
        actions={
          <>
            <Button
              icon={RefreshCw}
              onClick={() =>
                void api.toolsRefresh().catch((e: unknown) => setNotice({ tone: "danger", text: errorText(e) }))
              }
              disabledReason={inventory.status === "loading" ? t("inventory.collecting") : undefined}
            >
              {t("inventory.refresh")}
            </Button>
            <Button
              variant="primary"
              icon={Download}
              loading={exporting}
              help={t("inventory.export_note")}
              disabledReason={exportBlocked}
              onClick={() => void exportList()}
            >
              {t("inventory.export")}
            </Button>
          </>
        }
      >
        {entries.length > 0 && (
          <PillPicker<Filter>
            label={t("col.status")}
            value={filter}
            onChange={setFilter}
            options={[
              { value: "all", label: t("tools.filter.count", t("inventory.filter.all"), entries.length) },
              { value: "used", label: t("tools.filter.count", t("inventory.badge.used"), count("used")) },
              { value: "unused", label: t("tools.filter.count", t("inventory.badge.unused"), count("unused")) },
              { value: "missing", label: t("tools.filter.count", t("inventory.badge.missing"), count("missing")) },
            ]}
          />
        )}
      </PageHeader>
      {inventory.error && <Banner tone="danger">{inventory.error}</Banner>}
      {notice && <Banner tone={notice.tone}>{notice.text}</Banner>}
      {loading && entries.length === 0 ? (
        <EmptyState busy heading={t("inventory.collecting")}>
          {t("tools.collecting.text")}
        </EmptyState>
      ) : entries.length === 0 ? (
        <EmptyState icon={Terminal} heading={t("tools.empty.title")}>
          {t("tools.empty.text")}
        </EmptyState>
      ) : (
        <>
          <div className={styles.toolbar}>
            <div className={styles.search}>
              <TextField
                value={query}
                onChange={setQuery}
                icon={Search}
                type="search"
                placeholder={t("tools.search")}
                label={t("tools.search")}
              />
            </div>
            <span className={styles.note}>{t("inventory.apps_note")}</span>
          </div>
          <Table
            label={t("section.cli")}
            rows={rows}
            rowKey={(e) => `${e.tool?.source ?? "missing"}:${e.name}`}
            sort={sort}
            onSortChange={setSort}
            empty={t("tools.no_match")}
            columns={[
              {
                id: "keep",
                header: t("col.keep"),
                sortable: true,
                width: "64px",
                render: (e) => (
                  <Checkbox
                    checked={e.tool !== null && !excluded.has(e.name)}
                    onChange={(on) => setKept(e.name, on)}
                    label={t("tools.keep", e.name)}
                    disabledReason={e.tool ? blocked : t("tools.keep.missing")}
                  />
                ),
              },
              {
                id: "tool",
                header: t("col.tool"),
                sortable: true,
                width: "minmax(0, 1fr)",
                render: (e) => <span className={styles.mono}>{e.name}</span>,
              },
              {
                id: "source",
                header: t("col.source"),
                sortable: true,
                width: "130px",
                render: (e) => (e.tool ? t(`source.${e.tool.source}`) : "—"),
              },
              {
                id: "version",
                header: t("col.version"),
                width: "100px",
                render: (e) => <span className={styles.monoSecondary}>{e.tool?.version || "—"}</span>,
              },
              {
                id: "why",
                header: t("col.why"),
                width: "minmax(0, 1.4fr)",
                render: (e) => (
                  <span className={styles.secondary}>
                    {e.reasons.length > 0 ? e.reasons.map(reasonText).join(" · ") : t("tools.no_reason")}
                  </span>
                ),
              },
              {
                id: "status",
                header: t("col.status"),
                sortable: true,
                width: "110px",
                render: (e) => <Badge tone={STATUS_TONE[e.status]}>{t(`inventory.badge.${e.status}`)}</Badge>,
              },
            ]}
          />
          <footer className={styles.footer}>
            <strong className={styles.kept}>{t("inventory.retained", kept.length, installed.length)}</strong>
            <span className={styles.note}>{t("inventory.export_note")}</span>
            {count("missing") > 0 && (
              <span className={styles.warning}>{t("tools.missing_note", count("missing"))}</span>
            )}
          </footer>
        </>
      )}
    </div>
  );
}
