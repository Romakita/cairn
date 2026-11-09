// Réglages (§3.9 de parity/ui.md) : les mêmes clés que config.toml, enregistrées par `saveConfig` (le main réécrit
// le fichier en gardant commentaires et clés inconnues). Fichier invalide : bandeau avec la clé et la ligne, et toute
// modification est refusée (contrôles désactivés avec la raison) jusqu'à sa correction.
import { Bell, CalendarClock, FileText, Folder, FolderX, Globe, HardDrive, House, Trash2, Wrench } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Fmt } from "../../../core/format.ts";
import { parseLanguageSetting, t } from "../../../core/l10n.ts";
import type { AppSnapshot, CairnApi, ConfigPatch } from "../../../shared/contract.ts";
import { useApi, useSnapshot } from "../../api/hooks.ts";
import { Badge } from "../../ui/Badge.tsx";
import { Banner } from "../../ui/Banner.tsx";
import { Button } from "../../ui/Button.tsx";
import { Card } from "../../ui/Card.tsx";
import { CardTray } from "../../ui/CardTray.tsx";
import { DropdownMenu } from "../../ui/DropdownMenu.tsx";
import { IconButton } from "../../ui/IconButton.tsx";
import { NumberStepper } from "../../ui/NumberStepper.tsx";
import { PathField } from "../../ui/PathField.tsx";
import { RowDivider } from "../../ui/RowDivider.tsx";
import { SettingsRow } from "../../ui/SettingsRow.tsx";
import { Sheet } from "../../ui/Sheet.tsx";
import { SidebarHeader } from "../../ui/SidebarHeader.tsx";
import { SidebarRow } from "../../ui/SidebarRow.tsx";
import { TabBar } from "../../ui/TabBar.tsx";
import { TextField } from "../../ui/TextField.tsx";
import { Toggle } from "../../ui/Toggle.tsx";
import { rowLabel, shortPath } from "../shell/format.ts";
import { Page, Section, Sidebar, SplitView } from "../shell/Layout.tsx";
import type { ScreenProps } from "../types.ts";
import styles from "./SettingsScreen.module.css";

const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Sections de la page, dans l'ordre (ancres de la barre latérale). */
const SECTIONS = [
  { id: "general", key: "settings.general", icon: Globe },
  { id: "folders", key: "sidebar.folders", icon: Folder },
  { id: "home", key: "settings.home", icon: House },
  { id: "schedule", key: "settings.schedule", icon: CalendarClock },
  { id: "alerts", key: "settings.alerts", icon: Bell },
  { id: "maintenance", key: "settings.maintenance", icon: Wrench },
] as const;

export function SettingsScreen(_props: ScreenProps) {
  const snapshot = useSnapshot();
  const api = useApi();
  const [error, setError] = useState<string | null>(null);
  if (!snapshot) return <div data-testid="screen-settings" />;
  const view = snapshot.config;
  const first = view.issues.find((i) => i.severity === "error") ?? view.issues[0];
  const reason = view.hasErrors ? t("config.save.refused", first?.description ?? view.file) : undefined;
  const save = async (...patches: ConfigPatch[]) => {
    setError(null);
    try {
      await api.saveConfig({ patches });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const scrollTo = (id: string) => document.getElementById(`settings-${id}`)?.scrollIntoView({ behavior: "smooth" });

  return (
    <div data-testid="screen-settings" className={styles.root}>
      <SplitView
        sidebar={
          <Sidebar heading={t("section.settings")} label={t("section.settings")}>
            {SECTIONS.map((s) => (
              <SidebarRow key={s.id} icon={s.icon} label={t(s.key)} onClick={() => scrollTo(s.id)} />
            ))}
            <SidebarHeader label={t("settings.file")} />
            <SidebarRow
              icon={FileText}
              label="config.toml"
              onClick={() => void api.showInFinder({ kind: "path", path: view.file })}
            />
            <p className={styles.hint}>{t("settings.file_hint")}</p>
          </Sidebar>
        }
      >
        <Page heading={t("section.settings")}>
          {view.hasErrors && first && (
            <Banner tone="danger">
              <strong>{t("config.banner.error", first.message)}</strong>
              <br />
              {first.line !== null
                ? t("settings.invalid.where_line", first.key, first.line)
                : t("settings.invalid.where", first.key)}{" "}
              {t("settings.blocked")}
            </Banner>
          )}
          {error && <Banner tone="danger">{error}</Banner>}
          <General snapshot={snapshot} api={api} reason={reason} save={save} />
          <Folders snapshot={snapshot} api={api} reason={reason} save={save} />
          <HomeItems snapshot={snapshot} api={api} reason={reason} save={save} />
          <Schedule snapshot={snapshot} reason={reason} save={save} />
          <Alerts snapshot={snapshot} reason={reason} save={save} />
          <Maintenance snapshot={snapshot} reason={reason} save={save} />
          <Section heading={t("settings.file")}>
            <Card flush>
              <SettingsRow
                icon={FileText}
                label={rowLabel(shortPath(view.file))}
                mono
                description={t("settings.file_hint")}
              >
                <Button onClick={() => void api.showInFinder({ kind: "path", path: view.file })}>
                  {t("settings.reveal_file")}
                </Button>
              </SettingsRow>
            </Card>
          </Section>
        </Page>
      </SplitView>
    </div>
  );
}

interface PartProps {
  snapshot: AppSnapshot;
  reason?: string;
  save: (...patches: ConfigPatch[]) => Promise<void>;
}

function Anchor({ id, heading, children }: { id: string; heading: string; children: ReactNode }) {
  return (
    <div id={`settings-${id}`} className={styles.anchor}>
      <Section heading={heading}>{children}</Section>
    </div>
  );
}

function stepperLabels() {
  return { decrementLabel: t("settings.stepper.decrease"), incrementLabel: t("settings.stepper.increase") };
}

// MARK: Général

function General({ snapshot, api, reason, save }: PartProps & { api: CairnApi }) {
  const config = snapshot.config.config;
  const language = parseLanguageSetting(config.language) ?? "auto";
  const updates = snapshot.updates;
  return (
    <Anchor id="general" heading={t("settings.general")}>
      <Card flush>
        <SettingsRow label={rowLabel(t("settings.language"))} description={t("settings.language.text")}>
          <DropdownMenu
            label={t("settings.language")}
            value={language}
            disabledReason={reason}
            options={[
              { value: "auto", label: t("settings.language.auto") },
              { value: "en-US", label: t("settings.language.en") },
              { value: "fr-FR", label: t("settings.language.fr") },
            ]}
            onChange={(v) => void save({ kind: "language", language: v })}
          />
        </SettingsRow>
        <RowDivider />
        <SettingsRow
          label={rowLabel(t("settings.updates.check"))}
          description={updates.message ?? t("settings.updates.version", snapshot.version)}
        >
          <Button loading={updates.phase === "checking"} onClick={() => void api.checkUpdates()}>
            {t("update.check")}
          </Button>
          <Toggle
            label={t("settings.updates.check")}
            checked={config.checkUpdates}
            disabledReason={reason}
            onChange={(check) => void save({ kind: "updates", check })}
          />
        </SettingsRow>
      </Card>
    </Anchor>
  );
}

// MARK: Dossiers suivis

function Folders({ snapshot, api, reason, save }: PartProps & { api: CairnApi }) {
  const folders = snapshot.config.config.folders;
  const [removing, setRemoving] = useState<string | null>(null);
  const scans = snapshot.analysis.folders;
  const scanOf = (p: string) => scans.find((s) => s.folder === p || shortPath(s.folder) === p);
  const add = async () => {
    const chosen = await api.chooseFolder({ buttonLabel: t("sidebar.add_folder") });
    if (!chosen || folders.some((f) => f.path === chosen || f.path === shortPath(chosen))) return;
    await save({ kind: "folders", folders: [...folders, { path: shortPath(chosen), backup: true, exclude: [] }] });
  };
  return (
    <Anchor id="folders" heading={t("sidebar.folders")}>
      <Card flush>
        {folders.length === 0 && <p className={styles.empty}>{t("settings.folders.none")}</p>}
        {folders.map((f, i) => {
          const scan = scanOf(f.path);
          const unavailable = scan !== undefined && !scan.available;
          return (
            <div key={f.path}>
              {i > 0 && <RowDivider />}
              <SettingsRow
                icon={unavailable ? FolderX : Folder}
                label={rowLabel(shortPath(f.path))}
                mono
                description={scan?.root ? Fmt.bytes(scan.root.size) : undefined}
              >
                {unavailable && <Badge tone="warning">{t("settings.folder.unavailable")}</Badge>}
                <span className={styles.inlineLabel}>{t("settings.folder.backup")}</span>
                <Toggle
                  size="small"
                  label={t("settings.folder.backup_of", shortPath(f.path))}
                  checked={f.backup}
                  disabledReason={reason}
                  onChange={(backup) =>
                    void save({
                      kind: "folders",
                      folders: folders.map((x) => (x.path === f.path ? { ...x, backup } : x)),
                    })
                  }
                />
                <IconButton
                  icon={Trash2}
                  label={t("settings.folder.remove")}
                  disabledReason={reason}
                  onClick={() => setRemoving(f.path)}
                />
              </SettingsRow>
            </div>
          );
        })}
        <CardTray>
          <Button disabledReason={reason} onClick={() => void add()}>
            {t("sidebar.add_folder")}
          </Button>
        </CardTray>
      </Card>
      <Sheet
        open={removing !== null}
        onClose={() => setRemoving(null)}
        heading={t("settings.folder.remove.title", removing ? shortPath(removing) : "")}
        description={t("settings.folder.remove.text")}
        closeLabel={t("action.close")}
        width={520}
        footer={
          <>
            <Button onClick={() => setRemoving(null)}>{t("action.cancel")}</Button>
            <Button
              variant="primary"
              autoFocus
              onClick={() => {
                const path = removing;
                setRemoving(null);
                void save({ kind: "folders", folders: folders.filter((x) => x.path !== path) });
              }}
            >
              {t("settings.folder.remove.confirm")}
            </Button>
          </>
        }
      />
    </Anchor>
  );
}

// MARK: Home

function HomeItems({ snapshot, api, reason, save }: PartProps & { api: CairnApi }) {
  const include = snapshot.config.config.home.include;
  const [found, setFound] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  useEffect(() => {
    let live = true;
    void api.homeChoices().then((items) => live && setFound(items));
    return () => {
      live = false;
    };
  }, [api]);
  const items = [...new Set([...include, ...found])].sort((a, b) => a.localeCompare(b));
  const setItems = (next: string[]) => save({ kind: "home", home: { include: next } });
  const add = () => {
    const item = draft.trim().replace(/^~\//, "").replace(/\/$/, "");
    if (!item) return;
    setDraft("");
    if (!include.includes(item)) void setItems([...include, item]);
  };
  return (
    <Anchor id="home" heading={t("settings.home")}>
      <Card flush>
        {items.length === 0 && <p className={styles.empty}>{t("onboarding.home.none")}</p>}
        {items.map((item, i) => (
          <div key={item}>
            {i > 0 && <RowDivider />}
            <SettingsRow label={rowLabel(`~/${item}`)} mono>
              <Toggle
                label={`~/${item}`}
                checked={include.includes(item)}
                disabledReason={reason}
                onChange={(on) => void setItems(on ? [...include, item] : include.filter((x) => x !== item))}
              />
            </SettingsRow>
          </div>
        ))}
        <CardTray>
          <div className={styles.grow}>
            <PathField
              disabledReason={reason}
              value={draft}
              onChange={setDraft}
              suggest={(input) => api.completePath({ input })}
              placeholder={t("onboarding.home.add_placeholder")}
              label={t("settings.home.path")}
              listLabel={t("settings.home.suggestions")}
              onSubmit={add}
            />
          </div>
          <Button
            variant="primary"
            disabledReason={reason ?? (draft.trim() ? undefined : t("settings.home.need_path"))}
            onClick={add}
          >
            {t("action.add")}
          </Button>
        </CardTray>
      </Card>
    </Anchor>
  );
}

// MARK: Planification

function backgroundDescription(snapshot: AppSnapshot): string {
  if (snapshot.background.enabled && snapshot.background.status === "requires-approval")
    return t("settings.background.approval");
  return t("settings.background.text");
}

function Schedule({ snapshot, reason, save }: PartProps) {
  const schedule = snapshot.config.config.schedule;
  const [time, setTime] = useState(schedule.time);
  useEffect(() => setTime(schedule.time), [schedule.time]);
  const timeValid = TIME.test(time);
  const commitTime = () => {
    if (timeValid && time !== schedule.time) void save({ kind: "schedule", schedule: { time } });
  };
  const manual = schedule.frequency === "manual";
  return (
    <Anchor id="schedule" heading={t("settings.schedule")}>
      <Card flush>
        <SettingsRow label={rowLabel(t("settings.frequency"))}>
          <TabBar
            disabledReason={reason}
            label={t("settings.frequency")}
            value={schedule.frequency}
            options={(["daily", "weekly", "manual"] as const).map((f) => ({ value: f, label: t(`frequency.${f}`) }))}
            onChange={(frequency) => void save({ kind: "schedule", schedule: { frequency } })}
          />
        </SettingsRow>
        {!manual && (
          <>
            <RowDivider />
            <SettingsRow
              label={rowLabel(t("settings.time"))}
              description={timeValid ? t("settings.time.text") : t("settings.time.invalid")}
            >
              <div className={styles.timeField}>
                <TextField
                  label={t("settings.time")}
                  value={time}
                  onChange={setTime}
                  onBlur={commitTime}
                  onSubmit={commitTime}
                  invalid={!timeValid}
                  mono
                  disabledReason={reason}
                  placeholder="12:30"
                />
              </div>
            </SettingsRow>
          </>
        )}
        {schedule.frequency === "weekly" && (
          <>
            <RowDivider />
            <SettingsRow label={rowLabel(t("onboarding.schedule.weekday"))}>
              <DropdownMenu
                label={t("onboarding.schedule.weekday")}
                value={schedule.weekday}
                disabledReason={reason}
                options={WEEKDAYS.map((d) => ({ value: d, label: t(`weekday.${d}`) }))}
                onChange={(weekday) => void save({ kind: "schedule", schedule: { weekday } })}
              />
            </SettingsRow>
          </>
        )}
        <RowDivider />
        <SettingsRow
          label={rowLabel(t("onboarding.schedule.background_toggle"))}
          description={backgroundDescription(snapshot)}
        >
          <Toggle
            label={t("onboarding.schedule.background_toggle")}
            checked={schedule.background}
            disabledReason={reason}
            onChange={(background) => void save({ kind: "schedule", schedule: { background } })}
          />
        </SettingsRow>
        <RowDivider />
        <SettingsRow
          label={rowLabel(t("settings.ui.battery", Fmt.percent(schedule.onBatteryMinPercent, 100, 0)))}
          description={t("settings.battery.text")}
        >
          <NumberStepper
            disabledReason={reason}
            {...stepperLabels()}
            label={t("settings.battery.label")}
            value={schedule.onBatteryMinPercent}
            min={0}
            max={100}
            step={5}
            format={(v) => Fmt.percent(v, 100, 0)}
            onChange={(onBatteryMinPercent) => void save({ kind: "schedule", schedule: { onBatteryMinPercent } })}
          />
        </SettingsRow>
      </Card>
    </Anchor>
  );
}

// MARK: Alertes de stockage

function Alerts({ snapshot, reason, save }: PartProps) {
  const a = snapshot.config.config.alerts;
  const set = (patch: Partial<typeof a>) => void save({ kind: "alerts", alerts: patch });
  const pct = (v: number) => Fmt.percent(v, 100, 0);
  const gb = (v: number) => t("settings.alerts.gb_value", Fmt.number(v, 0));
  return (
    <Anchor id="alerts" heading={t("settings.alerts")}>
      <Card flush>
        <SettingsRow
          icon={HardDrive}
          label={rowLabel(t("settings.ui.alerts.low", pct(a.lowPercent), gb(a.lowGB)))}
          description={t("settings.alerts.low.text")}
        >
          <div className={styles.steppers}>
            <NumberStepper
              disabledReason={reason}
              {...stepperLabels()}
              label={t("settings.alerts.low_percent")}
              value={a.lowPercent}
              min={Math.max(1, a.criticalPercent + 1)}
              max={50}
              maxReason={t("settings.alerts.max")}
              minReason={t("settings.alerts.order")}
              format={pct}
              onChange={(lowPercent) => set({ lowPercent })}
            />
            <NumberStepper
              disabledReason={reason}
              {...stepperLabels()}
              label={t("settings.alerts.low_gb")}
              value={a.lowGB}
              min={Math.max(1, a.criticalGB + 1)}
              max={500}
              step={5}
              minReason={t("settings.alerts.order")}
              format={gb}
              onChange={(lowGB) => set({ lowGB })}
            />
          </div>
        </SettingsRow>
        <RowDivider />
        <SettingsRow
          icon={HardDrive}
          label={rowLabel(t("settings.ui.alerts.critical", pct(a.criticalPercent), gb(a.criticalGB)))}
          description={t("settings.alerts.critical.text")}
        >
          <div className={styles.steppers}>
            <NumberStepper
              disabledReason={reason}
              {...stepperLabels()}
              label={t("settings.alerts.critical_percent")}
              value={a.criticalPercent}
              min={1}
              max={Math.max(1, a.lowPercent - 1)}
              maxReason={t("settings.alerts.order")}
              format={pct}
              onChange={(criticalPercent) => set({ criticalPercent })}
            />
            <NumberStepper
              disabledReason={reason}
              {...stepperLabels()}
              label={t("settings.alerts.critical_gb")}
              value={a.criticalGB}
              min={1}
              max={Math.max(1, a.lowGB - 1)}
              maxReason={t("settings.alerts.order")}
              format={gb}
              onChange={(criticalGB) => set({ criticalGB })}
            />
          </div>
        </SettingsRow>
      </Card>
    </Anchor>
  );
}

// MARK: Maintenance

function Maintenance({ snapshot, reason, save }: PartProps) {
  const config = snapshot.config.config;
  return (
    <Anchor id="maintenance" heading={t("settings.maintenance")}>
      <Card flush>
        <SettingsRow
          label={rowLabel(t("settings.logs", config.logRetentionDays))}
          description={t("settings.logs.text")}
        >
          <NumberStepper
            disabledReason={reason}
            {...stepperLabels()}
            label={t("settings.logs.label")}
            value={config.logRetentionDays}
            min={15}
            max={365}
            step={15}
            onChange={(days) => void save({ kind: "logRetentionDays", days })}
          />
        </SettingsRow>
        <RowDivider />
        <SettingsRow
          label={rowLabel(t("settings.stale_days", config.git.worktreeStaleDays))}
          description={t("settings.stale_days.text")}
        >
          <NumberStepper
            disabledReason={reason}
            {...stepperLabels()}
            label={t("settings.stale_days.label")}
            value={config.git.worktreeStaleDays}
            min={1}
            max={365}
            step={5}
            onChange={(worktreeStaleDays) => void save({ kind: "git", git: { worktreeStaleDays } })}
          />
        </SettingsRow>
        <RowDivider />
        <SettingsRow label={rowLabel(t("settings.git_gc"))} description={t("settings.git_gc.text")}>
          <Toggle
            label={t("settings.git_gc")}
            checked={config.git.gc}
            disabledReason={reason}
            onChange={(gc) => void save({ kind: "git", git: { gc } })}
          />
        </SettingsRow>
      </Card>
    </Anchor>
  );
}
