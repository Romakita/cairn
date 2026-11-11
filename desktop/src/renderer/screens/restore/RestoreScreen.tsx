// Écran Restauration (U §3.8, tâche 12.8) : assistant en 4 étapes visibles (source, version, contenu, récapitulatif),
// colonne « Version choisie », puis la restauration confirmée par une feuille (jeton passé au main) et sa progression. Rien n'est écrit avant
// « Restaurer » : le récapitulatif vient d'une simulation (`planRestore` avec `simulate`). Les outils go et
// `~/.local/bin` sont listés « à réinstaller à la main » avec leur version (spec `restore` modifiée).
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CircleX,
  FolderOpen,
  HardDrive,
  History,
  RotateCcw,
  Server,
  TriangleAlert,
  Wrench,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Fmt } from "../../../core/format.ts";
import { t } from "../../../core/l10n.ts";
import type { RestoreStep } from "../../../core/restore/service.ts";
import type {
  NavigationRequest,
  RestorePart,
  RestorePlanArgs,
  RestorePlanView,
  RestoreSource,
} from "../../../shared/contract.ts";
import { confirmedCall } from "../../api/confirm.ts";
import { useApi, useSnapshot } from "../../api/hooks.ts";
import { Banner } from "../../ui/Banner.tsx";
import { Button } from "../../ui/Button.tsx";
import { Card } from "../../ui/Card.tsx";
import { Checkbox } from "../../ui/Checkbox.tsx";
import { FolderRow } from "../../ui/FolderRow.tsx";
import { Icon } from "../../ui/Icon.tsx";
import { PasswordField } from "../../ui/PasswordField.tsx";
import { ProgressBar } from "../../ui/ProgressBar.tsx";
import { RowDivider } from "../../ui/RowDivider.tsx";
import { Sheet } from "../../ui/Sheet.tsx";
import { Spinner } from "../../ui/Spinner.tsx";
import { WizardStepper } from "../../ui/WizardStepper.tsx";
import type { ScreenProps } from "../types.ts";
import styles from "./RestoreScreen.module.css";

const STEPS = ["source", "version", "parts", "summary"] as const;
/** Volume APFS que la restauration peut créer (dossiers suivis sous `/Volumes/workspaces`). */
const WORKSPACES_ROOT = "/Volumes/workspaces";
type Step = (typeof STEPS)[number];

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function formatDate(ms: number | null): string {
  return ms === null ? "—" : Fmt.date(new Date(ms));
}

/** Nom lisible d'une partie (`home`, `folders/x`, `ai/claude-code`…) ou d'une étape. */
function partLabel(part: string, plan: RestorePlanView | null): string {
  if (part === "home") return t("restore.ui.part.home");
  if (part === "tools") return t("restore.part.tools");
  if (part === "ai") return t("section.ai");
  if (part === "check") return t("restore.ui.step.check");
  if (part === "command-line-tools") return t("restore.ui.step.clt");
  if (part === "brew-install") return t("restore.ui.step.brew");
  if (part.startsWith("folders/")) return part.slice("folders/".length);
  if (part.startsWith("ai/")) {
    const id = part.slice(3);
    return plan?.details?.aiTools.find((x) => x.id === id)?.name ?? id;
  }
  if (part.startsWith("tool:")) return part.slice(5);
  return part;
}

function StepRow({ step, plan }: { step: RestoreStep; plan: RestorePlanView | null }) {
  const manual = step.manual !== undefined;
  // Code de la copie (« rsync 0 ») : rien à dire si elle a réussi, sinon le code d'échec, sans nom d'outil.
  const code = /^rsync (-?\d+)$/.exec(step.detail)?.[1];
  const detail = code === undefined ? step.detail : step.ok ? "" : t("restore.detail.failed", code);
  return (
    <li className={styles.stepRow} data-ok={step.ok || undefined} data-manual={manual || undefined}>
      <span className={styles.stepIcon}>
        <Icon icon={manual ? Wrench : step.ok ? Check : CircleX} size={14} />
      </span>
      <span className={styles.stepName}>{partLabel(step.step, plan)}</span>
      {detail && <span className={styles.stepDetail}>{detail}</span>}
    </li>
  );
}

/** Outils à réinstaller à la main (go, `~/.local/bin`) : nom, version, origine. */
function ManualTools({ steps }: { steps: RestoreStep[] }) {
  const manual = steps.filter((s) => s.manual);
  if (manual.length === 0) return null;
  return (
    <Banner tone="warning" icon={Wrench}>
      <span className={styles.stack}>
        <span>{t("restore.ui.manual.title", manual.length)}</span>
        <ul className={styles.manualList}>
          {manual.map((s) => (
            <li key={s.step}>
              <span className={styles.mono}>{s.manual?.name}</span>{" "}
              {s.manual?.version ? <span className={styles.mono}>{s.manual.version}</span> : null}{" "}
              <span className={styles.soft}>
                ({t(`restore.ui.manual.source.${s.manual?.source === "go" ? "go" : "local_bin"}`)})
              </span>
            </li>
          ))}
        </ul>
      </span>
    </Banner>
  );
}

export function RestoreScreen({ navigate, request }: ScreenProps) {
  const snapshot = useSnapshot();
  const api = useApi();
  const [step, setStep] = useState(0);
  const [reached, setReached] = useState(0);
  const [source, setSource] = useState<RestoreSource | null>(null);
  const [passwords, setPasswords] = useState<{ share?: string; image?: string }>({});
  const [typed, setTyped] = useState("");
  const [plan, setPlan] = useState<RestorePlanView | null>(null);
  const [version, setVersion] = useState<string | undefined>(undefined);
  const [parts, setParts] = useState<Set<RestorePart>>(() => new Set<RestorePart>(["tools", "home", "ai"]));
  const [folders, setFolders] = useState<string[]>([]);
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [tools, setTools] = useState<string[] | null>(null);
  const [replaceDatabases, setReplaceDatabases] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [volumeSheet, setVolumeSheet] = useState(false);
  const goTo = (i: number) => {
    setStep(i);
    setReached((r) => Math.max(r, i));
  };

  const call = async (args: Partial<RestorePlanArgs> & { source: RestoreSource }, simulate = false) => {
    setBusy(true);
    setError(null);
    try {
      const p = await api.planRestore({
        ...args,
        ...(passwords.share ? { sharePassword: passwords.share } : {}),
        ...(passwords.image ? { imagePassword: passwords.image } : {}),
        ...(simulate ? { simulate: true } : {}),
      });
      setPlan(p);
      return p;
    } catch (e) {
      setError(errorText(e));
      return null;
    } finally {
      setBusy(false);
    }
  };

  const chooseSource = async (src: RestoreSource) => {
    setSource(src);
    setVersion(undefined);
    setPlan(null);
    const p = await call({ source: src });
    if (!p || p.needsPassword) return;
    goTo(p.versions.length > 0 ? 1 : 2);
  };

  // Arrivée depuis « Restaurer cette sauvegarde » : destination et image présélectionnées, ouvertes une fois par demande.
  const lastRequest = useRef<NavigationRequest | undefined>(undefined);
  // biome-ignore lint/correctness/useExhaustiveDependencies: une seule ouverture par demande de navigation.
  useEffect(() => {
    if (request === lastRequest.current) return;
    lastRequest.current = request;
    if (request?.route !== "restore" || !request.ref) return;
    void chooseSource({
      kind: "destination",
      destination: request.ref,
      ...(request.image ? { image: request.image } : {}),
    });
  }, [request]);

  if (!snapshot) return <div className={styles.root} data-testid="screen-restore" />;
  const restore = snapshot.restore;

  const fullArgs = (src: RestoreSource): RestorePlanArgs => {
    const chosen = [...parts].filter((p) => p !== "folders" || folders.length > 0);
    return {
      source: src,
      ...(version ? { version } : {}),
      parts: chosen.length > 0 ? chosen : ["tools"],
      folders,
      targets,
      ...(tools ? { tools } : {}),
      replaceDatabases,
    };
  };

  const unlock = async () => {
    if (!source || !plan?.needsPassword) return;
    const kind = plan.needsPassword;
    const next = { ...passwords, [kind]: typed };
    setPasswords(next);
    setTyped("");
    setBusy(true);
    setError(null);
    try {
      const p = await api.planRestore({
        source,
        ...(next.share ? { sharePassword: next.share } : {}),
        ...(next.image ? { imagePassword: next.image } : {}),
      });
      setPlan(p);
      if (!p.needsPassword) goTo(p.versions.length > 0 ? 1 : 2);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const chooseVersion = async (name: string) => {
    if (!source) return;
    setVersion(name);
    const p = await call({ source, version: name });
    if (p) goTo(2);
  };

  const simulate = async () => {
    if (!source) return;
    const p = await call(fullArgs(source), true);
    if (p) goTo(3);
  };

  /** Restauration confirmée par la feuille : le main ne redemande pas. */
  const apply = async () => {
    if (!plan) return;
    setBusy(true);
    setError(null);
    try {
      const r = await confirmedCall(api, "applyRestore", { planId: plan.planId });
      if (!r.cancelled) setApplied(true);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setConfirming(false);
      setBusy(false);
    }
  };

  /** Volume « workspaces » créé après la feuille, puis plan relu (les cibles ne manquent plus). */
  const createVolume = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await confirmedCall(api, "createWorkspacesVolume", {});
      setVolumeSheet(false);
      if (!r.cancelled && source)
        await call(
          plan?.simulated ? fullArgs(source) : { source, ...(version ? { version } : {}) },
          plan?.simulated === true,
        );
    } catch (e) {
      setVolumeSheet(false);
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const restart = () => {
    setApplied(false);
    setStep(0);
    setReached(0);
    setPlan(null);
    setSource(null);
    setVersion(undefined);
  };

  const details = plan?.details ?? null;
  const current: Step = STEPS[step]!;
  const togglePart = (p: RestorePart, on: boolean) =>
    setParts((s) => {
      const n = new Set(s);
      if (on) n.add(p);
      else n.delete(p);
      return n;
    });
  const aiChosen = tools ?? details?.aiTools.map((x) => x.id) ?? [];
  const nothingChosen =
    !(parts.has("tools") && details?.tools) &&
    !(parts.has("home") && details?.home) &&
    !(parts.has("ai") && aiChosen.length > 0) &&
    folders.length === 0;

  // MARK: Restauration appliquée : progression puis résultat.
  const progress = restore.progress;
  if ((applied || restore.running) && progress) {
    const finished = progress.finished && !restore.running;
    return (
      <div className={styles.root} data-testid="screen-restore">
        <div className={styles.scroll}>
          <div className={styles.page}>
            <h1 className={styles.title}>{finished ? t("restore.ui.done.title") : t("restore.ui.running.title")}</h1>
            <Card label={t("restore.ui.running.title")}>
              <div className={styles.progress}>
                <div className={styles.progressHead}>
                  {finished ? <Icon icon={restore.ok ? Check : TriangleAlert} size={20} /> : <Spinner size="regular" />}
                  <span className={styles.progressTitle}>
                    {finished
                      ? restore.ok
                        ? t("restore.ui.done.ok")
                        : t("restore.ui.done.failed")
                      : progress.current
                        ? t("restore.ui.running.part", partLabel(progress.current, restore.plan))
                        : t("restore.ui.running.title")}
                  </span>
                  <span className={styles.count}>{t("restore.ui.running.count", progress.done, progress.total)}</span>
                </div>
                <ProgressBar
                  value={progress.total > 0 ? progress.done / progress.total : undefined}
                  label={t("restore.ui.running.title")}
                />
                {progress.waiting?.kind === "quit" && (
                  <Banner tone="warning">{t("restore.quit_tool", progress.waiting.name)}</Banner>
                )}
                {progress.waiting?.kind === "admin" && <Banner tone="info">{t("cli.restore.terminal")}</Banner>}
                {progress.steps.length > 0 && (
                  <ul className={styles.steps}>
                    {progress.steps.map((s, i) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: étapes dans l'ordre d'exécution (noms répétés possibles).
                      <StepRow key={i} step={s} plan={restore.plan} />
                    ))}
                  </ul>
                )}
              </div>
            </Card>
            {restore.error && <Banner tone="danger">{restore.error}</Banner>}
            {finished && (
              <>
                <ManualTools steps={progress.steps} />
                <Banner tone="info">{t("cli.restore.manual")}</Banner>
                <div className={styles.actions}>
                  <Button icon={RotateCcw} onClick={restart}>
                    {t("restore.ui.again")}
                  </Button>
                  <Button variant="primary" onClick={() => navigate({ route: "home" })}>
                    {t("restore.ui.done.home")}
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    );
  }

  // MARK: Assistant
  const sourceStep = (
    <div className={styles.section}>
      <p className={styles.lead}>{t("restore.source.text")}</p>
      <div className={styles.sources}>
        {snapshot.destinations.map((d) => (
          <Button
            key={d.id}
            variant={source?.kind === "destination" && source.destination === d.id ? "primary" : "outline"}
            icon={d.provider === "smb" ? Server : HardDrive}
            loading={busy && source?.kind === "destination" && source.destination === d.id}
            onClick={() => void chooseSource({ kind: "destination", destination: d.id })}
          >
            {d.label}
          </Button>
        ))}
        <Button
          icon={FolderOpen}
          onClick={() =>
            void api.chooseFolder({ buttonLabel: t("restore.ui.choose") }).then((p) => {
              if (p) void chooseSource({ kind: "folder", path: p });
            })
          }
        >
          {t("restore.source.folder")}
        </Button>
      </div>
      {snapshot.destinations.length === 0 && (
        <Banner
          tone="info"
          action={
            <Button variant="outline" onClick={() => navigate({ route: "backup", ref: "add" })}>
              {t("sidebar.add_destination")}
            </Button>
          }
        >
          {t("restore.ui.no_destination")}
        </Banner>
      )}
      {plan?.needsPassword && (
        <Card label={t(`restore.password.${plan.needsPassword}`)}>
          <div className={styles.password}>
            <span className={styles.cardTitle}>{t(`restore.password.${plan.needsPassword}`)}</span>
            <span className={styles.hint}>{t("restore.password.hint")}</span>
            <div className={styles.inline}>
              <PasswordField
                value={typed}
                onChange={setTyped}
                label={t(`restore.password.${plan.needsPassword}`)}
                showLabel={t("restore.ui.show_password")}
                hideLabel={t("restore.ui.hide_password")}
                autoFocus
                onSubmit={() => void unlock()}
              />
              <Button
                variant="primary"
                loading={busy}
                disabledReason={typed === "" ? t("restore.ui.password_empty") : undefined}
                onClick={() => void unlock()}
              >
                {t("restore.password.submit")}
              </Button>
            </div>
          </div>
        </Card>
      )}
    </div>
  );

  const versionStep = (
    <div className={styles.section}>
      {plan && plan.versions.length === 0 && <p className={styles.lead}>{t("cli.restore.no_version")}</p>}
      {plan && plan.versions.length > 0 && (
        <Card flush label={t("restore.step.version.heading")}>
          <ul className={styles.versions}>
            {[...plan.versions]
              .sort((a, b) => (b.date ?? 0) - (a.date ?? 0))
              .map((v) => {
                const label = [
                  formatDate(v.date),
                  v.thisMac ? t("restore.ui.this_mac") : v.machine,
                  v.partial ? t("restore.version.partial") : null,
                ]
                  .filter(Boolean)
                  .join(" · ");
                return (
                  <li key={`${v.machine}/${v.name}`} data-chosen={v.name === plan.version || undefined}>
                    <FolderRow name={label} icon={History} onOpen={() => void chooseVersion(v.name)} />
                  </li>
                );
              })}
          </ul>
        </Card>
      )}
    </div>
  );

  const partsStep = details && (
    <div className={styles.section}>
      <Card flush label={t("restore.step.parts.heading")}>
        <div className={styles.parts}>
          {details.tools && (
            <div className={styles.part}>
              <Checkbox checked={parts.has("tools")} onChange={(on) => togglePart("tools", on)}>
                {t("restore.part.tools")}
              </Checkbox>
              <span className={styles.partDetail}>{t("restore.part.tools_detail")}</span>
            </div>
          )}
          {details.home && (
            <div className={styles.part}>
              <Checkbox checked={parts.has("home")} onChange={(on) => togglePart("home", on)}>
                {t("restore.ui.part.home")}
              </Checkbox>
              <span className={styles.partDetail}>{t("restore.part.home_detail")}</span>
            </div>
          )}
          {details.aiTools.length > 0 && <RowDivider inset={false} />}
          {details.aiTools.map((tool) => (
            <div key={tool.id} className={styles.part}>
              <Checkbox
                checked={parts.has("ai") && aiChosen.includes(tool.id)}
                onChange={(on) => {
                  const next = on ? [...new Set([...aiChosen, tool.id])] : aiChosen.filter((x) => x !== tool.id);
                  setTools(next);
                  togglePart("ai", next.length > 0);
                }}
              >
                {tool.name}
              </Checkbox>
              <span className={styles.partDetail}>{t("restore.part.ai_detail")}</span>
            </div>
          ))}
          {details.aiTools.length > 0 && parts.has("ai") && aiChosen.length > 0 && (
            <div className={styles.part}>
              <Checkbox checked={replaceDatabases} onChange={setReplaceDatabases}>
                {t("restore.replace_databases")}
              </Checkbox>
            </div>
          )}
          {details.folders.length > 0 && <RowDivider inset={false} />}
          {details.folders.map((f) => {
            const target = targets[f.name] ?? f.originalPath;
            const chosen = folders.includes(f.name);
            return (
              <div key={f.name} className={styles.part}>
                <Checkbox
                  checked={chosen}
                  onChange={(on) => {
                    setFolders((list) => (on ? [...list, f.name] : list.filter((x) => x !== f.name)));
                    togglePart("folders", true);
                  }}
                >
                  {f.name}
                </Checkbox>
                <span className={styles.partDetail}>{t("restore.part.folder_detail")}</span>
                {chosen && (
                  <div className={styles.target}>
                    <span className={styles.mono}>{t("restore.target", target)}</span>
                    <Button
                      onClick={() =>
                        void api
                          .chooseFolder({ buttonLabel: t("restore.ui.choose"), defaultPath: target })
                          .then((p) => {
                            if (p) setTargets((x) => ({ ...x, [f.name]: p }));
                          })
                      }
                    >
                      {t("restore.change")}
                    </Button>
                  </div>
                )}
                {chosen && f.targetMissing && target === f.target && (
                  <Banner tone="warning">
                    <span className={styles.stack}>
                      <span>{t("restore.missing_volume", target)}</span>
                      {target.startsWith(WORKSPACES_ROOT) && (
                        <span>
                          <Button icon={HardDrive} onClick={() => setVolumeSheet(true)}>
                            {t("restore.create_volume")}
                          </Button>
                        </span>
                      )}
                    </span>
                  </Banner>
                )}
              </div>
            );
          })}
        </div>
      </Card>
    </div>
  );

  const total = plan ? Object.values(plan.sizes).reduce((a, b) => a + b, 0) : 0;
  const toolSteps = plan?.steps.filter((s) => s.step.startsWith("tool:") || s.step === "command-line-tools") ?? [];
  const summaryStep = plan?.simulated && (
    <div className={styles.section}>
      <Card label={t("restore.total")}>
        <ul className={styles.sizes}>
          {Object.entries(plan.sizes)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([part, bytes]) => (
              <li key={part} className={styles.sizeRow}>
                <span>{partLabel(part, plan)}</span>
                <span className={styles.figure}>{Fmt.bytes(bytes)}</span>
              </li>
            ))}
          <li className={styles.totalRow}>
            <span>{t("restore.total")}</span>
            <span className={styles.figure}>{Fmt.bytes(total)}</span>
          </li>
        </ul>
        <p className={styles.hint}>{t("restore.pre_restore_note")}</p>
      </Card>
      {toolSteps.length > 0 && (
        <Card label={t("restore.part.tools")}>
          <span className={styles.cardTitle}>{t("restore.part.tools")}</span>
          <ul className={styles.steps}>
            {toolSteps
              .filter((s) => !s.manual)
              .map((s) => (
                <StepRow key={s.step} step={s} plan={plan} />
              ))}
          </ul>
        </Card>
      )}
      <ManualTools steps={plan.steps} />
      {plan.warnings.map((w) => (
        <Banner key={w} tone="warning">
          {w}
        </Banner>
      ))}
      <p className={styles.hint}>{t("restore.terminal_note")}</p>
    </div>
  );

  const body = { source: sourceStep, version: versionStep, parts: partsStep, summary: summaryStep }[current];
  const canContinue: Record<Step, string | undefined> = {
    source: plan && !plan.needsPassword && source ? undefined : t("restore.ui.reason.source"),
    version: plan?.details ? undefined : t("restore.ui.reason.version"),
    parts: nothingChosen ? t("restore.ui.reason.parts") : undefined,
    summary: undefined,
  };
  const backupRunning = snapshot.backup.running ? t("backup.unavailable.running") : undefined;

  return (
    <div className={styles.root} data-testid="screen-restore">
      <div className={styles.scroll}>
        <div className={styles.page}>
          <h1 className={styles.title}>{t(`restore.step.${current}.heading`)}</h1>
          <WizardStepper
            steps={STEPS.map((s) => t(`restore.ui.step.${s}`))}
            current={step}
            reached={reached}
            canSelect={(i) => i <= reached && (i !== 3 || plan?.simulated === true)}
            onSelect={setStep}
            label={t("restore.ui.steps")}
          />
          <div className={styles.columns}>
            <div className={styles.main}>
              {error && <Banner tone="danger">{error}</Banner>}
              {restore.running && <Banner tone="info">{t("restore.ui.running.title")}</Banner>}
              {busy && current !== "source" && (
                <p className={styles.status}>
                  <Spinner size="small" />
                  {current === "parts" ? t("restore.ui.simulating") : t("restore.ui.reading")}
                </p>
              )}
              {body}
            </div>
            {details && (
              <aside className={styles.side} aria-label={t("restore.chosen")}>
                <Card label={t("restore.chosen")}>
                  <span className={styles.cardTitle}>{t("restore.chosen")}</span>
                  <dl className={styles.facts}>
                    <dt>{t("restore.date")}</dt>
                    <dd>{formatDate(details.date)}</dd>
                    <dt>{t("restore.machine")}</dt>
                    <dd>{details.machine || "—"}</dd>
                    <dt>{t("restore.arch")}</dt>
                    <dd data-warning={!details.archMatches || undefined}>
                      {!details.archMatches && <Icon icon={TriangleAlert} size={13} />}
                      {details.arch || "—"}
                    </dd>
                    <dt>{t("restore.format")}</dt>
                    <dd>{details.kind === "legacy" ? t("cli.restore.legacy") : "Cairn"}</dd>
                  </dl>
                </Card>
              </aside>
            )}
          </div>
          <footer className={styles.footer}>
            {step > 0 && (
              <Button icon={ArrowLeft} onClick={() => setStep(step - 1)}>
                {t("action.back")}
              </Button>
            )}
            <span className={styles.spacer} />
            {current === "parts" && (
              <Button
                variant="primary"
                icon={ArrowRight}
                loading={busy}
                disabledReason={canContinue.parts}
                onClick={() => void simulate()}
              >
                {t("restore.ui.simulate")}
              </Button>
            )}
            {(current === "source" || current === "version") && (
              <Button
                variant="primary"
                icon={ArrowRight}
                disabledReason={canContinue[current]}
                onClick={() => goTo(current === "source" && plan?.versions.length ? 1 : 2)}
              >
                {t("action.continue")}
              </Button>
            )}
            {current === "summary" && (
              <Button
                variant="primary"
                icon={RotateCcw}
                loading={busy}
                disabledReason={backupRunning ?? (restore.running ? t("cli.busy") : undefined)}
                onClick={() => setConfirming(true)}
              >
                {t("restore.run")}
              </Button>
            )}
          </footer>
          <Sheet
            open={confirming}
            width={520}
            heading={t("restore.ui.confirm.title")}
            description={t("cli.restore.confirm")}
            closeLabel={t("action.close")}
            onClose={busy ? undefined : () => setConfirming(false)}
            footer={
              <>
                <Button
                  onClick={() => setConfirming(false)}
                  disabledReason={busy ? t("restore.ui.running.title") : undefined}
                >
                  {t("action.cancel")}
                </Button>
                <Button variant="primary" icon={RotateCcw} loading={busy} autoFocus onClick={() => void apply()}>
                  {t("restore.run")}
                </Button>
              </>
            }
          >
            {plan && (
              <div className={styles.confirm}>
                <span className={styles.figure}>{t("restore.ui.confirm.total", Fmt.bytes(total))}</span>
                {plan.warnings.map((w) => (
                  <Banner key={w} tone="warning">
                    {w}
                  </Banner>
                ))}
              </div>
            )}
          </Sheet>
          <Sheet
            open={volumeSheet}
            width={520}
            heading={t("restore.ui.volume.title")}
            description={t("restore.ui.volume.text")}
            closeLabel={t("action.close")}
            onClose={busy ? undefined : () => setVolumeSheet(false)}
            footer={
              <>
                <Button
                  onClick={() => setVolumeSheet(false)}
                  disabledReason={busy ? t("restore.ui.volume.busy") : undefined}
                >
                  {t("action.cancel")}
                </Button>
                <Button variant="primary" icon={HardDrive} loading={busy} onClick={() => void createVolume()}>
                  {t("restore.create_volume")}
                </Button>
              </>
            }
          />
        </div>
      </div>
    </div>
  );
}
