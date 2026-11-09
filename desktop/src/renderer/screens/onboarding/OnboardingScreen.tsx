// Assistant de premier lancement (§3.10 de parity/ui.md ; spec app-configuration) : six étapes, valeurs détectées
// par `onboardingDetect`, retour libre, avance jusqu'à l'étape atteinte + 1. Rien n'est écrit avant « Terminer »
// (`onboardingFinish` reçoit tout le brouillon, et le mot de passe du NAS une seule fois).
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Cloud,
  Folder,
  FolderOpen,
  HardDrive,
  Layers,
  type LucideIcon,
  Minus,
  Moon,
  Power,
  Server,
} from "lucide-react";
import { useEffect, useState } from "react";
import { t } from "../../../core/l10n.ts";
import type { OnboardingDraftWire } from "../../../shared/contract.ts";
import { useApi } from "../../api/hooks.ts";
import { Badge } from "../../ui/Badge.tsx";
import { Banner } from "../../ui/Banner.tsx";
import { Button } from "../../ui/Button.tsx";
import { CairnLogo } from "../../ui/CairnLogo.tsx";
import { Card } from "../../ui/Card.tsx";
import { CardTray } from "../../ui/CardTray.tsx";
import { ChoiceChip } from "../../ui/ChoiceChip.tsx";
import { ChoiceTile } from "../../ui/ChoiceTile.tsx";
import { DropdownMenu } from "../../ui/DropdownMenu.tsx";
import { Icon } from "../../ui/Icon.tsx";
import { IconTile } from "../../ui/IconTile.tsx";
import { PasswordField } from "../../ui/PasswordField.tsx";
import { PathField } from "../../ui/PathField.tsx";
import { RowDivider } from "../../ui/RowDivider.tsx";
import { SelectableRow } from "../../ui/SelectableRow.tsx";
import { SettingsRow } from "../../ui/SettingsRow.tsx";
import { Sheet } from "../../ui/Sheet.tsx";
import { Spinner } from "../../ui/Spinner.tsx";
import { TabBar } from "../../ui/TabBar.tsx";
import { TextField } from "../../ui/TextField.tsx";
import { Toggle } from "../../ui/Toggle.tsx";
import { WizardStepper } from "../../ui/WizardStepper.tsx";
import { rowLabel, shortPath } from "../shell/format.ts";
import type { ScreenProps } from "../types.ts";
import { homeIcon } from "./homeIcon.ts";
import styles from "./OnboardingScreen.module.css";

const STEPS = ["folders", "home", "ai", "destination", "schedule", "notifications"] as const;
type Step = (typeof STEPS)[number];
const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

interface Draft extends OnboardingDraftWire {
  password: string;
}

/** Problème qui empêche de quitter une étape, ou `null`. */
function problem(step: Step, d: Draft): string | null {
  switch (step) {
    case "folders":
      return d.folders.some((f) => f.selected) ? null : t("onboarding.need_folder");
    case "destination":
      if (d.destination.kind === "local" && !d.destination.path.trim()) return t("onboarding.need_path");
      if (d.destination.kind === "smb" && !/^smb:\/\/[^/\s]+/.test(d.destination.url.trim()))
        return t("onboarding.need_url");
      return null;
    case "schedule":
      return d.frequency !== "manual" && !TIME.test(d.time) ? t("onboarding.need_time") : null;
    default:
      return null;
  }
}

export function OnboardingScreen({ navigate }: ScreenProps) {
  const api = useApi();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [step, setStep] = useState(0);
  const [reached, setReached] = useState(0);
  const [finishing, setFinishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void api.onboardingDetect().then((d) => live && setDraft({ ...d, password: "" }));
    return () => {
      live = false;
    };
  }, [api]);

  const update = (change: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...change } : d));
  const firstInvalid = draft ? STEPS.findIndex((s) => problem(s, draft) !== null) : -1;
  const go = (index: number) => {
    setStep(index);
    setReached((r) => Math.max(r, index));
  };
  const issue = draft ? problem(STEPS[step]!, draft) : null;
  const last = step === STEPS.length - 1;

  const finish = async () => {
    if (!draft) return;
    if (firstInvalid >= 0) return go(firstInvalid);
    setFinishing(true);
    setError(null);
    try {
      const { password, ...wire } = draft;
      await api.onboardingFinish({ draft: wire, ...(password ? { password } : {}) });
      navigate({ route: "home" });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setFinishing(false);
    }
  };

  return (
    <div className={styles.root} data-testid="screen-onboarding">
      <header className={styles.header}>
        <CairnLogo size={22} />
        <span className={styles.welcome}>{t("onboarding.welcome")}</span>
        <span className={styles.spacer} />
        <span className={styles.noDrag}>
          <Button variant="outline" onClick={() => navigate({ route: "restore" })}>
            {t("onboarding.restore_instead")}
          </Button>
        </span>
      </header>
      <div className={styles.stepper}>
        <WizardStepper
          label={t("settings.onboarding.steps")}
          steps={STEPS.map((s) => t(`onboarding.${s}.title`))}
          current={step}
          reached={reached}
          canSelect={(i) =>
            draft !== null && i <= reached + 1 && STEPS.slice(0, i).every((s) => problem(s, draft) === null)
          }
          onSelect={go}
        />
      </div>
      <main className={styles.scroll}>
        <div className={styles.page}>
          <div className={styles.intro}>
            <h1 className={styles.heading}>{t(`onboarding.${STEPS[step]}.heading`)}</h1>
            <p className={styles.text}>{t(`onboarding.${STEPS[step]}.text`)}</p>
          </div>
          {!draft ? (
            <div className={styles.loading}>
              <Spinner size="regular" label={t("settings.onboarding.detecting")} />
            </div>
          ) : (
            <StepBody step={STEPS[step]!} draft={draft} update={update} onEdit={go} />
          )}
          {error && <Banner tone="danger">{error}</Banner>}
        </div>
      </main>
      <footer className={styles.footer}>
        <Button
          icon={ArrowLeft}
          disabledReason={step === 0 ? t("settings.onboarding.first_step") : undefined}
          onClick={() => go(step - 1)}
        >
          {t("action.back")}
        </Button>
        <span className={styles.stepOf}>{t("onboarding.step_of", step + 1, STEPS.length)}</span>
        <span className={styles.problem} role={issue ? "alert" : undefined}>
          {issue}
        </span>
        {last ? (
          <Button
            variant="primary"
            icon={Check}
            loading={finishing}
            disabledReason={draft ? undefined : t("settings.onboarding.detecting")}
            onClick={() => void finish()}
          >
            {t("action.finish")}
          </Button>
        ) : (
          <Button
            variant="primary"
            icon={ArrowRight}
            disabledReason={issue ?? (draft ? undefined : t("settings.onboarding.detecting"))}
            onClick={() => go(step + 1)}
          >
            {t("action.continue")}
          </Button>
        )}
      </footer>
    </div>
  );
}

interface StepProps {
  draft: Draft;
  update: (change: Partial<Draft>) => void;
}

function StepBody({ step, onEdit, ...props }: StepProps & { step: Step; onEdit: (index: number) => void }) {
  switch (step) {
    case "folders":
      return <FoldersStep {...props} />;
    case "home":
      return <HomeStep {...props} />;
    case "ai":
      return <AIStep {...props} />;
    case "destination":
      return <DestinationStep {...props} />;
    case "schedule":
      return <ScheduleStep {...props} />;
    case "notifications":
      return <NotificationsStep {...props} onEdit={onEdit} />;
  }
}

// MARK: Dossiers

function FoldersStep({ draft, update }: StepProps) {
  const api = useApi();
  const selected = draft.folders.filter((f) => f.selected).length;
  const all = selected === draft.folders.length;
  const add = async () => {
    const chosen = await api.chooseFolder({ buttonLabel: t("sidebar.add_folder") });
    if (!chosen || draft.folders.some((f) => f.path === chosen)) return;
    update({ folders: [...draft.folders, { path: chosen, selected: true }] });
  };
  return (
    <div className={styles.block}>
      <div className={styles.listHeader}>
        <span className={styles.count}>{t("onboarding.selected_count", selected, draft.folders.length)}</span>
        <Button onClick={() => update({ folders: draft.folders.map((f) => ({ ...f, selected: !all })) })}>
          {all ? t("action.select_none") : t("action.select_all")}
        </Button>
      </div>
      <Card flush>
        {draft.folders.map((f, i) => (
          <div key={f.path}>
            {i > 0 && <RowDivider />}
            <SelectableRow
              icon={Folder}
              label={shortPath(f.path)}
              mono
              checked={f.selected}
              onChange={(on) =>
                update({ folders: draft.folders.map((x) => (x.path === f.path ? { ...x, selected: on } : x)) })
              }
            />
          </div>
        ))}
        <CardTray>
          <Button icon={FolderOpen} onClick={() => void add()}>
            {t("sidebar.add_folder")}
          </Button>
        </CardTray>
      </Card>
    </div>
  );
}

// MARK: Home

function HomeStep({ draft, update }: StepProps) {
  const api = useApi();
  const [value, setValue] = useState("");
  const selected = draft.home.filter((h) => h.selected).length;
  const add = () => {
    const item = value.trim().replace(/^~\//, "").replace(/\/$/, "");
    if (!item) return;
    setValue("");
    if (draft.home.some((h) => h.path === item))
      update({ home: draft.home.map((h) => (h.path === item ? { ...h, selected: true } : h)) });
    else update({ home: [...draft.home, { path: item, selected: true }] });
  };
  return (
    <div className={styles.block}>
      <div className={styles.listHeader}>
        <span className={styles.count}>{t("onboarding.selected_count", selected, draft.home.length)}</span>
      </div>
      <Card flush>
        {draft.home.length === 0 && <p className={styles.empty}>{t("onboarding.home.none")}</p>}
        {draft.home.map((h, i) => (
          <div key={h.path}>
            {i > 0 && <RowDivider />}
            <SelectableRow
              icon={homeIcon(h.path)}
              label={`~/${h.path}`}
              mono
              checked={h.selected}
              onChange={(on) =>
                update({ home: draft.home.map((x) => (x.path === h.path ? { ...x, selected: on } : x)) })
              }
            />
          </div>
        ))}
        <CardTray>
          <div className={styles.grow}>
            <PathField
              value={value}
              onChange={setValue}
              suggest={(input) => api.completePath({ input })}
              placeholder={t("onboarding.home.add_placeholder")}
              label={t("settings.home.path")}
              listLabel={t("settings.home.suggestions")}
              onSubmit={add}
            />
          </div>
          <Button
            variant="primary"
            disabledReason={value.trim() ? undefined : t("settings.home.need_path")}
            onClick={add}
          >
            {t("action.add")}
          </Button>
        </CardTray>
      </Card>
    </div>
  );
}

// MARK: Outils IA

function AIStep({ draft, update }: StepProps) {
  const setCategories = (id: string, categories: string[]) =>
    update({ ai: draft.ai.map((a) => (a.id === id ? { ...a, categories } : a)) });
  return (
    <div className={styles.block}>
      {draft.ai.map((tool) => {
        const categories = [...new Set([...tool.offeredCategories, ...tool.categories])];
        return (
          <div key={tool.id} className={styles.aiCard} data-absent={tool.detected ? undefined : true}>
            <Card>
              <div className={styles.aiHead}>
                <span className={styles.aiName}>{tool.name}</span>
                <Badge tone={tool.detected ? "success" : "neutral"}>
                  {tool.detected ? t("onboarding.ai.detected") : t("onboarding.ai.not_detected")}
                </Badge>
              </div>
              <div className={styles.chips}>
                {categories.map((c) => (
                  <ChoiceChip
                    key={c}
                    label={t(`ai.category.${c}`)}
                    checked={tool.categories.includes(c)}
                    onChange={(on) =>
                      setCategories(tool.id, on ? [...tool.categories, c] : tool.categories.filter((x) => x !== c))
                    }
                  />
                ))}
              </div>
            </Card>
          </div>
        );
      })}
      <p className={styles.note}>{t("onboarding.ai.credentials_note")}</p>
    </div>
  );
}

// MARK: Destination

function DestinationStep({ draft, update }: StepProps) {
  const api = useApi();
  const [confirmClear, setConfirmClear] = useState(false);
  const d = draft.destination;
  const tiles: { kind: Draft["destination"]["kind"]; icon: LucideIcon; label: string; text: string }[] = [
    {
      kind: "later",
      icon: Cloud,
      label: t("onboarding.destination.later"),
      text: t("onboarding.destination.later.text"),
    },
    {
      kind: "local",
      icon: HardDrive,
      label: t("onboarding.destination.local"),
      text: t("onboarding.destination.local.text"),
    },
    { kind: "smb", icon: Server, label: t("onboarding.destination.smb"), text: t("onboarding.destination.smb.text") },
  ];
  const choose = (kind: Draft["destination"]["kind"]) => {
    if (kind === d.kind) return;
    if (kind === "later") update({ destination: { kind } });
    else if (kind === "local") update({ destination: { kind, path: "" } });
    else update({ destination: { kind, url: "", username: "" } });
  };
  const pick = async () => {
    const chosen = await api.chooseFolder({ buttonLabel: t("settings.onboarding.choose") });
    if (chosen) update({ destination: { kind: "local", path: chosen } });
  };
  return (
    <div className={styles.block}>
      <div className={styles.tiles} role="radiogroup" aria-label={t("onboarding.destination.title")}>
        {tiles.map((tile) => (
          <ChoiceTile
            key={tile.kind}
            icon={tile.icon}
            label={tile.label}
            description={tile.text}
            selected={d.kind === tile.kind}
            onSelect={() => choose(tile.kind)}
          />
        ))}
      </div>
      {d.kind === "local" && (
        <Card>
          <div className={styles.fieldRow}>
            <div className={styles.grow}>
              <TextField
                label={t("onboarding.destination.path")}
                placeholder="/Volumes/Backup"
                value={d.path}
                mono
                onChange={(path) => update({ destination: { kind: "local", path } })}
              />
            </div>
            <Button icon={FolderOpen} onClick={() => void pick()}>
              {t("settings.onboarding.choose")}
            </Button>
          </div>
        </Card>
      )}
      {d.kind === "smb" && (
        <Card>
          <div className={styles.fields}>
            <TextField
              label={t("onboarding.destination.url_label")}
              placeholder="smb://nas.local/backups"
              value={d.url}
              mono
              onChange={(url) => update({ destination: { ...d, url } })}
            />
            <div className={styles.fieldRow}>
              <div className={styles.grow}>
                <TextField
                  label={t("onboarding.destination.user")}
                  placeholder={t("onboarding.destination.user")}
                  value={d.username}
                  onChange={(username) => update({ destination: { ...d, username } })}
                />
              </div>
              <div className={styles.grow}>
                <PasswordField
                  label={t("onboarding.destination.password")}
                  placeholder={t("onboarding.destination.password")}
                  value={draft.password}
                  onChange={(password) => update({ password })}
                  showLabel={t("settings.onboarding.show_password")}
                  hideLabel={t("settings.onboarding.hide_password")}
                />
              </div>
            </div>
            <p className={styles.note}>{t("onboarding.destination.keychain")}</p>
          </div>
        </Card>
      )}
      {d.kind !== "later" && (
        <>
          <Card flush>
            <SettingsRow
              label={rowLabel(t("onboarding.destination.encrypted"))}
              description={t("onboarding.destination.encrypted.text")}
            >
              <Toggle
                label={t("onboarding.destination.encrypted")}
                checked={draft.encrypted}
                onChange={(on) => (on ? update({ encrypted: true }) : setConfirmClear(true))}
              />
            </SettingsRow>
          </Card>
          {!draft.encrypted && <Banner tone="warning">{t("onboarding.destination.unencrypted_warning")}</Banner>}
        </>
      )}
      <Sheet
        open={confirmClear}
        onClose={() => setConfirmClear(false)}
        heading={t("onboarding.destination.disable_encryption.title")}
        description={t("onboarding.destination.disable_encryption.message")}
        closeLabel={t("action.close")}
        width={520}
        footer={
          <>
            <Button autoFocus onClick={() => setConfirmClear(false)}>
              {t("action.cancel")}
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setConfirmClear(false);
                update({ encrypted: false });
              }}
            >
              {t("onboarding.destination.disable_encryption.confirm")}
            </Button>
          </>
        }
      />
    </div>
  );
}

// MARK: Planification

const POINTS: { id: string; icon: LucideIcon }[] = [
  { id: "menubar", icon: Layers },
  { id: "login", icon: Power },
  { id: "sleep", icon: Moon },
];

function ScheduleStep({ draft, update }: StepProps) {
  const timeValid = TIME.test(draft.time);
  return (
    <div className={styles.block}>
      <Card>
        <ul className={styles.points}>
          {POINTS.map((p) => (
            <li key={p.id} className={styles.point}>
              <IconTile icon={p.icon} size={32} />
              <span className={styles.pointText}>
                <span className={styles.pointTitle}>{t(`onboarding.schedule.point_${p.id}.title`)}</span>
                <span className={styles.note}>{t(`onboarding.schedule.point_${p.id}.text`)}</span>
              </span>
            </li>
          ))}
        </ul>
      </Card>
      <Card flush>
        <SettingsRow label={rowLabel(t("onboarding.schedule.backup"))}>
          <TabBar
            label={t("settings.frequency")}
            value={draft.frequency}
            options={(["daily", "weekly", "manual"] as const).map((f) => ({ value: f, label: t(`frequency.${f}`) }))}
            onChange={(frequency) => update({ frequency })}
          />
        </SettingsRow>
        {draft.frequency !== "manual" && (
          <>
            <RowDivider />
            <SettingsRow
              label={rowLabel(t("settings.time"))}
              description={timeValid ? undefined : t("settings.time.invalid")}
            >
              <div className={styles.timeField}>
                <TextField
                  label={t("settings.time")}
                  value={draft.time}
                  mono
                  invalid={!timeValid}
                  placeholder="12:30"
                  onChange={(time) => update({ time })}
                />
              </div>
            </SettingsRow>
          </>
        )}
        {draft.frequency === "weekly" && (
          <>
            <RowDivider />
            <SettingsRow label={rowLabel(t("onboarding.schedule.weekday"))}>
              <DropdownMenu
                label={t("onboarding.schedule.weekday")}
                value={draft.weekday}
                options={WEEKDAYS.map((w) => ({ value: w, label: t(`weekday.${w}`) }))}
                onChange={(weekday) => update({ weekday })}
              />
            </SettingsRow>
          </>
        )}
        <RowDivider />
        <SettingsRow label={rowLabel(t("onboarding.schedule.background_toggle"))}>
          <Toggle
            label={t("onboarding.schedule.background_toggle")}
            checked={draft.background}
            onChange={(background) => update({ background })}
          />
        </SettingsRow>
      </Card>
    </div>
  );
}

// MARK: Notifications et récapitulatif

function NotificationsStep({ draft, update, onEdit }: StepProps & { onEdit: (index: number) => void }) {
  const folders = draft.folders.filter((f) => f.selected).length;
  const home = draft.home.filter((h) => h.selected).length;
  const ai = draft.ai.filter((a) => a.categories.length > 0).length;
  const rows: { step: Step; text: string; ok: boolean }[] = [
    { step: "folders", text: t("onboarding.summary.folders", folders), ok: folders > 0 },
    { step: "home", text: t("onboarding.summary.home", home), ok: home > 0 },
    { step: "ai", text: t("onboarding.summary.ai", ai), ok: ai > 0 },
    {
      step: "destination",
      text:
        draft.destination.kind === "later"
          ? t("onboarding.summary.no_destination")
          : t("onboarding.summary.destination"),
      ok: draft.destination.kind !== "later",
    },
  ];
  return (
    <div className={styles.block}>
      <Card flush>
        <SettingsRow label={rowLabel(t("onboarding.notifications.toggle"))}>
          <Toggle
            label={t("onboarding.notifications.toggle")}
            checked={draft.notifications}
            onChange={(notifications) => update({ notifications })}
          />
        </SettingsRow>
      </Card>
      <h2 className={styles.summaryTitle}>{t("onboarding.summary")}</h2>
      <Card flush>
        {rows.map((r, i) => (
          <div key={r.step}>
            {i > 0 && <RowDivider />}
            <div className={styles.summaryRow}>
              <span className={styles.summaryIcon} data-ok={r.ok || undefined}>
                <Icon icon={r.ok ? Check : Minus} size={15} />
              </span>
              <span className={styles.summaryText}>{r.text}</span>
              <Button onClick={() => onEdit(STEPS.indexOf(r.step))}>{t("onboarding.edit")}</Button>
            </div>
          </div>
        ))}
      </Card>
    </div>
  );
}
