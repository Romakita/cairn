// Feuille Ajouter / Modifier une destination (U §3.4) : rien n'est enregistré avant une vérification réussie.
// Ajout en 4 étapes : type (disque local ou NAS), emplacement (navigateur de dossiers ; NAS : l'hôte seul liste ses
// partages), vérification (messages et conseils, sauvegardes trouvées), options (chiffrement, rétention).
// Modification : emplacement et vérification seulement (chemin, adresse, identifiant, mot de passe).
// Toute modification de l'emplacement invalide la vérification ; « Ajouter » renvoie à la première étape invalide.
// La fermeture démonte ce que Cairn a monté pour vérifier (`closeProbe`).
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CircleAlert,
  Folder,
  HardDrive,
  Network,
  Plus,
  Server,
  User,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Retention } from "../../../core/config.ts";
import { describeProbeFailure, probeFailureHint } from "../../../core/destinations/failure.ts";
import { Fmt } from "../../../core/format.ts";
import { t } from "../../../core/l10n.ts";
import type {
  DestinationView,
  NavigationRequest,
  NewDestination,
  ProbeResult,
  SavedDestinationView,
} from "../../../shared/contract.ts";
import { useApi } from "../../api/hooks.ts";
import { Banner } from "../../ui/Banner.tsx";
import { Button } from "../../ui/Button.tsx";
import { Card } from "../../ui/Card.tsx";
import { CardTray } from "../../ui/CardTray.tsx";
import { ChoiceTile } from "../../ui/ChoiceTile.tsx";
import { FolderRow } from "../../ui/FolderRow.tsx";
import { Icon } from "../../ui/Icon.tsx";
import { PasswordField } from "../../ui/PasswordField.tsx";
import { RowDivider } from "../../ui/RowDivider.tsx";
import { SettingsRow } from "../../ui/SettingsRow.tsx";
import { Sheet } from "../../ui/Sheet.tsx";
import { Spinner } from "../../ui/Spinner.tsx";
import { TextField } from "../../ui/TextField.tsx";
import { Toggle } from "../../ui/Toggle.tsx";
import { WizardStepper } from "../../ui/WizardStepper.tsx";
import styles from "./DestinationSheet.module.css";
import { FolderBrowser } from "./FolderBrowser.tsx";
import { RECOMMENDED } from "./model.ts";
import { RetentionEditor } from "./RetentionEditor.tsx";

export type DestinationSheetMode = { kind: "add" } | { kind: "edit"; destination: DestinationView };

type StepId = "type" | "location" | "check" | "options";
type Kind = "local" | "smb";

export interface DestinationSheetProps {
  mode: DestinationSheetMode;
  onClose: () => void;
  onSaved: (saved: SavedDestinationView) => void;
  navigate: (request: NavigationRequest) => void;
}

/** `smb://hôte[/partage[/sous/dossier]]` ; `null` si l'adresse n'en est pas une. */
export function parseSMB(address: string): { host: string; share: string | null; sub: string[] } | null {
  const m = /^smb:\/\/([^/\s]+)(\/.*)?$/i.exec(address.trim());
  if (!m) return null;
  const segments = (m[2] ?? "").split("/").filter(Boolean);
  return { host: m[1]!, share: segments[0] ?? null, sub: segments.slice(1) };
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

interface Connection {
  host: string;
  share: string;
  root: string;
  credentials: string;
}

interface CheckState {
  key: string;
  result: ProbeResult | null;
  error: string | null;
}

/** Nom de l'image (`cairn-<machine>.sparsebundle`) d'un chemin trouvé par la vérification. */
function imageName(p: string): string {
  return p.split("/").filter(Boolean).pop() ?? p;
}

export function DestinationSheet({ mode, onClose, onSaved, navigate }: DestinationSheetProps) {
  const api = useApi();
  const editing = mode.kind === "edit" ? mode.destination : null;
  const steps: StepId[] = editing ? ["location", "check"] : ["type", "location", "check", "options"];
  const [step, setStep] = useState(0);
  const [reached, setReached] = useState(0);
  const [kind, setKind] = useState<Kind | null>(editing ? editing.provider : null);
  // Disque local
  const [path, setPath] = useState(editing?.config.path ?? "");
  const [browse, setBrowse] = useState<string | null>(editing?.config.path ?? null);
  // NAS
  const [address, setAddress] = useState(editing?.config.url ?? "");
  const [username, setUsername] = useState(editing?.config.username ?? "");
  const [password, setPassword] = useState("");
  const [shares, setShares] = useState<{ host: string; list: string[] } | null>(null);
  const [connection, setConnection] = useState<Connection | null>(null);
  const [smbPath, setSmbPath] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<{ message: string; hint: string | null; auth: boolean } | null>(
    null,
  );
  // Vérification et options
  const [check, setCheck] = useState<CheckState | null>(null);
  const [encrypted, setEncrypted] = useState(editing?.config.encrypted ?? true);
  const [confirmPlain, setConfirmPlain] = useState(false);
  const [retention, setRetention] = useState<Retention>(editing?.config.retention ?? RECOMMENDED);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [attempted, setAttempted] = useState(false);

  // Ce que Cairn a monté pour vérifier est démonté à la fermeture de la feuille.
  useEffect(() => () => void api.closeProbe().catch(() => {}), [api]);

  const parts = parseSMB(address);
  const credentials = `${username}\u0000${password}`;
  const connected =
    connection !== null &&
    parts !== null &&
    connection.host === parts.host &&
    (parts.share === null || parts.share === connection.share) &&
    connection.credentials === credentials
      ? connection
      : null;
  const relative = connected && smbPath ? smbPath.slice(connected.root.length) : "";
  const finalAddress = connected ? `smb://${connected.host}/${connected.share}${relative}` : address.trim();
  const finalParts = parseSMB(finalAddress);
  const locationKey = kind === "local" ? `local:${path}` : `smb:${finalAddress}\u0000${credentials}`;
  const locationValid = kind === "local" ? path.startsWith("/") : finalParts !== null && finalParts.share !== null;
  const verified = check?.key === locationKey && check.result?.kind === "ok";

  const reasonFor = (id: StepId): string | null => {
    switch (id) {
      case "type":
        return kind === null ? t("backup.ui.form.pick_type") : null;
      case "location":
        if (locationValid) return null;
        return kind === "local" ? t("backup.ui.form.pick_folder") : t("backup.ui.form.pick_share");
      case "check":
        return verified ? null : t("probe.need_verification");
      case "options":
        return null;
    }
  };
  const current = steps[step]!;
  const currentReason = reasonFor(current);

  const runCheck = async () => {
    const key = locationKey;
    setCheck({ key, result: null, error: null });
    try {
      const result =
        kind === "local"
          ? await api.probeLocal({ path })
          : await api.checkSMB({ address: finalAddress, username, password: password || undefined });
      setCheck((c) => (c?.key === key ? { key, result, error: null } : c));
    } catch (e) {
      setCheck((c) => (c?.key === key ? { key, result: null, error: errorText(e) } : c));
    }
  };

  // Arrivée sur l'étape de vérification : elle se lance seule pour l'emplacement courant.
  const runCheckRef = useRef(runCheck);
  runCheckRef.current = runCheck;
  useEffect(() => {
    if (current === "check" && locationValid && check?.key !== locationKey) void runCheckRef.current();
  }, [current, locationKey, locationValid, check?.key]);

  const goTo = (index: number) => {
    setStep(index);
    setReached((r) => Math.max(r, index));
  };

  const connectShare = async (host: string, share: string, sub: string[], createCairn: boolean) => {
    setConnecting(true);
    setConnectError(null);
    try {
      const r = await api.connectSMB({ address: `smb://${host}/${share}`, username, password: password || undefined });
      if (!r.ok || r.root === null) {
        setConnectError({
          message: r.message ?? t("probe.error.mount", -1),
          hint: r.hint,
          auth: r.failure?.kind === "authenticationFailed" || r.failure?.kind === "passwordRequired",
        });
        return;
      }
      const root = r.root;
      let target = sub.length > 0 ? `${root}/${sub.join("/")}` : root;
      // Partage choisi dans la liste : les sauvegardes vont dans un dossier « cairn » (créé s'il n'existe pas).
      if (createCairn) {
        try {
          target = await api.createFolder({ parent: root, name: "cairn" });
        } catch {
          target = `${root}/cairn`;
        }
      }
      setConnection({ host, share, root, credentials });
      setSmbPath(target);
      setShares(null);
      setAddress(`smb://${host}/${share}`);
    } catch (e) {
      setConnectError({ message: errorText(e), hint: null, auth: false });
    } finally {
      setConnecting(false);
    }
  };

  const connect = async () => {
    if (!parts) {
      setConnectError({
        message: t("probe.error.invalid_address", address),
        hint: t("probe.hint.address"),
        auth: false,
      });
      return;
    }
    if (parts.share !== null) {
      await connectShare(parts.host, parts.share, parts.sub, false);
      return;
    }
    setConnecting(true);
    setConnectError(null);
    try {
      const list = await api.listShares({ host: parts.host, username, password: password || undefined });
      setShares({ host: parts.host, list });
    } catch (e) {
      setConnectError({ message: errorText(e), hint: t("probe.hint.unreachable"), auth: false });
    } finally {
      setConnecting(false);
    }
  };

  /** Enregistre la destination ; `then` (au lieu de la fermeture habituelle seule) enchaîne après l'enregistrement. */
  const save = async (then?: (saved: SavedDestinationView) => void) => {
    const invalid = steps.findIndex((id) => reasonFor(id) !== null);
    if (invalid >= 0) {
      setAttempted(true);
      goTo(invalid);
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      let saved: SavedDestinationView;
      if (editing) {
        const { id: _id, ...rest } = editing.config;
        const destination: NewDestination =
          kind === "local"
            ? { ...rest, path }
            : { ...rest, url: finalAddress, username: username === "" ? undefined : username };
        saved = await api.editDestination({ id: editing.id, destination, password: password || undefined });
      } else {
        const destination: NewDestination =
          kind === "local"
            ? { provider: "local", path, encrypted, retention }
            : {
                provider: "smb",
                url: finalAddress,
                ...(username !== "" ? { username } : {}),
                encrypted,
                retention,
              };
        saved = await api.addDestination({ destination, password: password || undefined });
      }
      onSaved(saved);
      then?.(saved);
    } catch (e) {
      setSaveError(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  const stepTitles = steps.map((id) => t(`backup.ui.form.step.${id}`));
  const last = step === steps.length - 1;
  const originalFolder = editing ? (editing.config.path ?? editing.config.url ?? "") : "";
  const moved = editing !== null && (kind === "local" ? path : finalAddress) !== originalFolder;

  const typeStep = (
    <div className={styles.section}>
      <p className={styles.lead}>{t("backup.ui.form.type_text")}</p>
      <div className={styles.tiles} role="radiogroup" aria-label={t("backup.ui.form.step.type")}>
        <ChoiceTile
          icon={HardDrive}
          label={t("onboarding.destination.local")}
          description={t("onboarding.destination.local.text")}
          selected={kind === "local"}
          onSelect={() => setKind("local")}
        />
        <ChoiceTile
          icon={Server}
          label={t("onboarding.destination.smb")}
          description={t("onboarding.destination.smb.text")}
          selected={kind === "smb"}
          onSelect={() => setKind("smb")}
        />
      </div>
    </div>
  );

  const localStep = (
    <div className={styles.section}>
      <div className={styles.field}>
        <span className={styles.label}>{t("onboarding.destination.path")}</span>
        <div className={styles.inline}>
          <TextField
            value={path}
            onChange={setPath}
            icon={Folder}
            mono
            label={t("onboarding.destination.path")}
            placeholder="/Volumes/Backup"
            onSubmit={() => setBrowse(path || null)}
          />
          <Button
            onClick={() =>
              void api
                .chooseFolder({ buttonLabel: t("backup.ui.form.choose"), defaultPath: path || undefined })
                .then((p) => {
                  if (p) {
                    setPath(p);
                    setBrowse(p);
                  }
                })
            }
          >
            {t("probe.browse")}
          </Button>
        </div>
        <span className={styles.hint}>{t("probe.status.pick_folder")}</span>
      </div>
      <FolderBrowser
        value={browse}
        onChange={(p) => {
          setBrowse(p);
          if (p) setPath(p);
        }}
      />
    </div>
  );

  const smbStep = (
    <div className={styles.section}>
      <Card flush label={t("onboarding.destination.smb")}>
        <div className={styles.rows}>
          <div className={styles.field}>
            <span className={styles.label}>{t("onboarding.destination.url_label")}</span>
            <TextField
              value={address}
              onChange={setAddress}
              icon={Network}
              mono
              label={t("onboarding.destination.url_label")}
              placeholder="smb://nas.local"
              onSubmit={() => void connect()}
            />
            <span className={styles.hint}>{t("probe.smb.url_hint")}</span>
          </div>
          <div className={styles.pair}>
            <div className={styles.field}>
              <span className={styles.label}>{t("onboarding.destination.user")}</span>
              <TextField value={username} onChange={setUsername} icon={User} label={t("onboarding.destination.user")} />
            </div>
            <div className={styles.field}>
              <span className={styles.label}>{t("onboarding.destination.password")}</span>
              <PasswordField
                value={password}
                onChange={setPassword}
                label={t("onboarding.destination.password")}
                invalid={
                  connectError?.auth === true ||
                  (check?.result?.kind === "failed" && check.result.failure.kind === "authenticationFailed")
                }
                showLabel={t("backup.ui.form.show_password")}
                hideLabel={t("backup.ui.form.hide_password")}
                onSubmit={() => void connect()}
              />
            </div>
          </div>
          <span className={styles.hint}>
            {editing ? t("destination.edit.password_hint") : t("probe.smb.keychain_later")}
          </span>
        </div>
        <CardTray>
          <div className={styles.trayLine}>
            <Button
              variant={connected ? "secondary" : "primary"}
              loading={connecting}
              disabledReason={parts === null ? t("probe.hint.address") : undefined}
              onClick={() => void connect()}
            >
              {connected ? t("probe.smb.reconnect") : t("probe.smb.connect")}
            </Button>
            {connected ? (
              <span className={styles.mono}>{finalAddress}</span>
            ) : (
              <span className={styles.hint}>{t("probe.smb.connect_hint")}</span>
            )}
          </div>
        </CardTray>
      </Card>
      {connectError && (
        <Banner tone="danger">
          <span className={styles.stack}>
            <span>{connectError.message}</span>
            {connectError.hint && <span className={styles.soft}>{connectError.hint}</span>}
          </span>
        </Banner>
      )}
      {shares && !connected && (
        <Card flush label={t("probe.smb.shares_title")}>
          <div className={styles.cardTitle}>{t("probe.smb.shares_title")}</div>
          <p className={styles.cardText}>{t("probe.status.pick_share")}</p>
          <div className={styles.shares}>
            {shares.list.map((share) => (
              <FolderRow
                key={share}
                name={share}
                icon={Server}
                onOpen={() => void connectShare(shares.host, share, [], true)}
              />
            ))}
          </div>
        </Card>
      )}
      {connected && (
        <FolderBrowser
          root={{ name: connected.share, path: connected.root }}
          value={smbPath}
          onChange={(p) => setSmbPath(p ?? connected.root)}
        />
      )}
    </div>
  );

  const result = check?.key === locationKey ? check : null;
  const checkStep = (
    <div className={styles.section}>
      <div className={styles.target}>
        <Icon icon={kind === "smb" ? Server : HardDrive} size={16} />
        <span className={styles.mono}>{kind === "local" ? path : finalAddress}</span>
      </div>
      {result && result.result === null && result.error === null && (
        <p className={styles.status}>
          <Spinner size="small" />
          {t("probe.status.checking")}
        </p>
      )}
      {result?.error && (
        <Banner
          tone="danger"
          action={
            <Button variant="outline" onClick={() => void runCheck()}>
              {t("probe.retry")}
            </Button>
          }
        >
          {result.error}
        </Banner>
      )}
      {result?.result?.kind === "failed" && (
        <Banner
          tone="danger"
          action={
            <Button variant="outline" onClick={() => void runCheck()}>
              {t("probe.retry")}
            </Button>
          }
        >
          <span className={styles.stack}>
            <span>{describeProbeFailure(result.result.failure)}</span>
            {probeFailureHint(result.result.failure) && (
              <span className={styles.soft}>{probeFailureHint(result.result.failure)}</span>
            )}
          </span>
        </Banner>
      )}
      {result?.result?.kind === "ok" && (
        <>
          <Banner tone="success">
            {result.result.freeBytes !== null
              ? t("probe.status.ok_free", Fmt.bytes(result.result.freeBytes))
              : t("probe.status.ok")}
          </Banner>
          {result.result.existingImages.map((image) =>
            image.isThisMac ? (
              <Banner key={image.path} tone="info">
                {t("probe.image.this_mac")}
              </Banner>
            ) : (
              <Banner
                key={image.path}
                tone="info"
                action={
                  editing ? undefined : (
                    <Button
                      variant="outline"
                      loading={saving}
                      onClick={() =>
                        // La destination est enregistrée, puis la restauration s'ouvre sur l'image choisie, pas sur
                        // celle de ce Mac ni la première trouvée (156f978).
                        void save((saved) =>
                          navigate({ route: "restore", ref: saved.destination.id, image: imageName(image.path) }),
                        )
                      }
                    >
                      {t("probe.image.restore")}
                    </Button>
                  )
                }
              >
                {t("probe.image.found", image.machine)}
              </Banner>
            ),
          )}
        </>
      )}
      {moved && <Banner tone="info">{t("destination.edit.folder_changed")}</Banner>}
      {editing && <p className={styles.hint}>{t("destination.edit.encryption_fixed")}</p>}
    </div>
  );

  const optionsStep = (
    <div className={styles.section}>
      <Card flush label={t("backup.ui.form.encryption")}>
        <SettingsRow
          label={t("onboarding.destination.encrypted")}
          description={t("onboarding.destination.encrypted.text")}
        >
          <Toggle
            checked={encrypted}
            label={t("onboarding.destination.encrypted")}
            onChange={(on) => (on ? setEncrypted(true) : setConfirmPlain(true))}
          />
        </SettingsRow>
        <RowDivider />
        <div className={styles.retention}>
          <span className={styles.label}>{t("backup.retention")}</span>
          <RetentionEditor value={retention} onChange={setRetention} />
        </div>
      </Card>
      {!encrypted && <Banner tone="warning">{t("onboarding.destination.unencrypted_warning")}</Banner>}
    </div>
  );

  const body = {
    type: typeStep,
    location: kind === "smb" ? smbStep : localStep,
    check: checkStep,
    options: optionsStep,
  }[current];

  return (
    <>
      <Sheet
        open
        onClose={saving ? undefined : onClose}
        heading={editing ? t("destination.edit.title") : t("sidebar.add_destination")}
        description={editing ? t("destination.edit.text") : t("probe.sheet.text")}
        closeLabel={t("action.close")}
        width={760}
        footer={
          <div className={styles.footer}>
            <span className={styles.problem}>
              {(attempted || current === "check") && currentReason && (
                <>
                  <Icon icon={CircleAlert} size={14} />
                  {currentReason}
                </>
              )}
            </span>
            <Button onClick={onClose}>{t("action.cancel")}</Button>
            {step > 0 && (
              <Button icon={ArrowLeft} onClick={() => setStep(step - 1)}>
                {t("action.back")}
              </Button>
            )}
            {last ? (
              <Button variant="primary" icon={editing ? Check : Plus} loading={saving} onClick={() => void save()}>
                {editing ? t("action.save") : t("action.add")}
              </Button>
            ) : (
              <Button
                variant="primary"
                icon={ArrowRight}
                disabledReason={currentReason ?? undefined}
                onClick={() => goTo(step + 1)}
              >
                {t("action.continue")}
              </Button>
            )}
          </div>
        }
      >
        <div className={styles.body}>
          <WizardStepper
            steps={stepTitles}
            current={step}
            reached={reached}
            canSelect={(i) => i <= reached}
            onSelect={setStep}
            label={t("backup.ui.form.steps")}
          />
          {saveError && <Banner tone="danger">{saveError}</Banner>}
          {body}
        </div>
      </Sheet>
      <Sheet
        open={confirmPlain}
        onClose={() => setConfirmPlain(false)}
        heading={t("onboarding.destination.disable_encryption.title")}
        description={t("onboarding.destination.disable_encryption.message")}
        closeLabel={t("action.close")}
        width={480}
        footer={
          <>
            <Button autoFocus onClick={() => setConfirmPlain(false)}>
              {t("action.cancel")}
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setEncrypted(false);
                setConfirmPlain(false);
              }}
            >
              {t("onboarding.destination.disable_encryption.confirm")}
            </Button>
          </>
        }
      />
    </>
  );
}
