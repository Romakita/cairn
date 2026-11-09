// Écran Outils IA : outils détectés, taille par catégorie, catégories sauvegardées (puces), identifiants exclus
// quand une destination n'est pas chiffrée, jeton rangé au Trousseau, conversations, dernière sauvegarde.
import { CloudUpload, KeyRound, Lock, LockOpen, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { Fmt } from "../../../core/format.ts";
import { t } from "../../../core/l10n.ts";
import type { AIToolView, AppSnapshot } from "../../../shared/contract.ts";
import { useApi, useSnapshot } from "../../api/hooks.ts";
import { Badge } from "../../ui/Badge.tsx";
import { Banner, type Tone } from "../../ui/Banner.tsx";
import { Button } from "../../ui/Button.tsx";
import { Card } from "../../ui/Card.tsx";
import { ChoiceChip } from "../../ui/ChoiceChip.tsx";
import { EmptyState } from "../../ui/EmptyState.tsx";
import { Icon } from "../../ui/Icon.tsx";
import { MiddleText } from "../../ui/MiddleText.tsx";
import { PageHeader } from "../../ui/PageHeader.tsx";
import { RowDivider } from "../../ui/RowDivider.tsx";
import { Tooltip } from "../../ui/Tooltip.tsx";
import type { ScreenProps } from "../types.ts";
import styles from "./AIScreen.module.css";
import { CATEGORY_ORDER, profileOf } from "./profiles.ts";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function AIScreen(props: ScreenProps) {
  const snapshot = useSnapshot();
  if (!snapshot) return <div data-testid="screen-ai" className={styles.screen} />;
  return <AIContent {...props} snapshot={snapshot} />;
}

/** Catégories proposées pour un outil : celles de son profil (identifiants seulement s'ils sont des fichiers). */
function categoriesOf(tool: AIToolView): string[] {
  const profile = profileOf(tool.id);
  const known = profile
    ? Object.entries(profile.categories)
        .filter(([c, paths]) => paths.length > 0 || (c !== "credentials" && c in tool.bytesByCategory))
        .map(([c]) => c)
    : Object.keys(tool.bytesByCategory);
  return [...new Set([...known, ...tool.categories])].sort(
    (a, b) => (CATEGORY_ORDER.indexOf(a) + 1 || 99) - (CATEGORY_ORDER.indexOf(b) + 1 || 99),
  );
}

function AIContent({ snapshot, navigate }: ScreenProps & { snapshot: AppSnapshot }) {
  const api = useApi();
  const { ai, config, backup, lock } = snapshot;
  const [notice, setNotice] = useState<{ tone: Tone; text: string } | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: une seule fois, à l'ouverture de l'écran.
  useEffect(() => {
    if (ai.status === "idle") void api.aiRefresh().catch(() => {});
  }, []);

  const configured = config.config.ai;
  const checkedOf = (tool: AIToolView) => configured.find((a) => a.id === tool.id)?.categories ?? tool.categories;
  const anyChecked = ai.tools.some((tool) => tool.detected && checkedOf(tool).length > 0);

  const toggle = (tool: AIToolView, category: string, on: boolean) => {
    const current = checkedOf(tool);
    const categories = on ? [...current, category] : current.filter((c) => c !== category);
    const next = configured.some((a) => a.id === tool.id)
      ? configured.map((a) => (a.id === tool.id ? { ...a, categories } : a))
      : [...configured, { id: tool.id, categories }];
    api
      .saveConfig({ patches: [{ kind: "ai", ai: next }] })
      .catch((e: unknown) => setNotice({ tone: "danger", text: errorText(e) }));
  };

  const backupBlocked =
    snapshot.destinations.length === 0
      ? t("backup.no_destination")
      : config.hasErrors
        ? t("settings.blocked")
        : backup.running
          ? t("backup.unavailable.running")
          : lock.byOther
            ? t("ai.page.locked")
            : !anyChecked
              ? t("ai.page.nothing_checked")
              : undefined;

  const start = (dryRun: boolean) => {
    setNotice(null);
    api.startBackup({ only: ["ai"], dryRun }).then(
      () => navigate({ route: "backup" }),
      (e: unknown) => setNotice({ tone: "danger", text: errorText(e) }),
    );
  };

  const detected = ai.tools.filter((tool) => tool.detected);
  const lastBackup = Math.max(0, ...ai.tools.map((tool) => tool.lastBackup ?? 0));

  return (
    <div data-testid="screen-ai" className={styles.screen}>
      <PageHeader
        heading={t("section.ai")}
        subtitle={
          ai.status === "loading"
            ? t("ai.measuring")
            : t(
                "ai.page.subtitle",
                detected.length,
                lastBackup > 0 ? Fmt.date(new Date(lastBackup)) : t("ai.last_backup.never"),
              )
        }
        actions={
          <>
            <Button onClick={() => start(true)} disabledReason={backupBlocked} help={t("ai.page.simulate.help")}>
              {t("backup.simulate")}
            </Button>
            <Button variant="primary" icon={CloudUpload} onClick={() => start(false)} disabledReason={backupBlocked}>
              {t("ai.backup_now")}
            </Button>
          </>
        }
      />
      {ai.credentialsBlock ? (
        <Banner tone="warning" icon={LockOpen}>
          {t("ai.banner.credentials_ignored")}
        </Banner>
      ) : (
        <Banner tone="info" icon={Lock}>
          {t("ai.banner.encrypted")}
        </Banner>
      )}
      {ai.error && <Banner tone="danger">{ai.error}</Banner>}
      {notice && <Banner tone={notice.tone}>{notice.text}</Banner>}
      {ai.tools.length === 0 ? (
        ai.status === "loading" || ai.status === "idle" ? (
          <EmptyState busy heading={t("ai.measuring")} />
        ) : (
          <EmptyState icon={Sparkles} heading={t("ai.page.empty")}>
            {t("onboarding.ai.text")}
          </EmptyState>
        )
      ) : (
        <div className={styles.grid}>
          {ai.tools.map((tool) => (
            <ToolCard
              key={tool.id}
              tool={tool}
              checked={checkedOf(tool)}
              credentialsBlock={ai.credentialsBlock}
              configBlocked={config.hasErrors ? t("settings.blocked") : undefined}
              onToggle={(c, on) => toggle(tool, c, on)}
            />
          ))}
        </div>
      )}
      <p className={styles.footnote}>{t("ai.sqlite_note")}</p>
    </div>
  );
}

interface ToolCardProps {
  tool: AIToolView;
  checked: readonly string[];
  credentialsBlock: string | null;
  configBlocked: string | undefined;
  onToggle: (category: string, on: boolean) => void;
}

function ToolCard({ tool, checked, credentialsBlock, configBlocked, onToggle }: ToolCardProps) {
  const profile = profileOf(tool.id);
  const effective = checked.filter((c) => c !== "credentials" || !credentialsBlock);
  const saved = effective.reduce((s, c) => s + (tool.bytesByCategory[c] ?? 0), 0);
  const categories = categoriesOf(tool);
  return (
    <Card label={tool.name}>
      <div className={styles.card} data-detected={tool.detected || undefined}>
        <div className={styles.head}>
          <h2 className={styles.name}>{tool.name}</h2>
          {tool.detected ? (
            <Tooltip content={t("ai.size.saved_help")}>
              <span className={styles.size}>{Fmt.bytes(saved)}</span>
            </Tooltip>
          ) : (
            <Badge>{t("onboarding.ai.not_detected")}</Badge>
          )}
        </div>
        {profile && profile.root !== "~" && <MiddleText text={profile.root} className={styles.root} />}
        <dl className={styles.facts}>
          <div className={styles.fact}>
            <dt>{t("ai.category.conversations")}</dt>
            <dd>
              {tool.conversations > 0
                ? t(
                    "ai.page.conversations",
                    Fmt.count(tool.conversations),
                    tool.latestConversation ? Fmt.date(new Date(tool.latestConversation)) : "—",
                  )
                : "—"}
            </dd>
          </div>
          <div className={styles.fact}>
            <dt>{t("ai.page.last_backup")}</dt>
            <dd>{tool.lastBackup ? Fmt.date(new Date(tool.lastBackup)) : "—"}</dd>
          </div>
        </dl>
        <RowDivider inset={false} />
        <fieldset className={styles.chips} aria-label={t("ai.page.categories", tool.name)}>
          {categories.map((c) => {
            const label = tool.detected
              ? t("ai.page.chip", t(`ai.category.${c}`), Fmt.bytes(tool.bytesByCategory[c] ?? 0))
              : t(`ai.category.${c}`);
            const reason =
              configBlocked ??
              (!tool.detected
                ? t("ai.page.not_detected")
                : c === "credentials" && credentialsBlock
                  ? credentialsBlock
                  : undefined);
            const on = checked.includes(c) && !(c === "credentials" && credentialsBlock);
            return reason ? (
              // Puce indisponible : raison au survol, aucun effet au clic (ChoiceChip n'a pas encore d'état désactivé).
              <Tooltip key={c} content={reason}>
                <span className={styles.disabledChip} aria-disabled="true" aria-description={reason}>
                  <ChoiceChip label={label} checked={on} onChange={() => {}} />
                </span>
              </Tooltip>
            ) : (
              <ChoiceChip key={c} label={label} checked={on} onChange={(v) => onToggle(c, v)} />
            );
          })}
        </fieldset>
        {credentialsBlock && checked.includes("credentials") && (
          <p className={styles.warning}>
            <Icon icon={LockOpen} size={14} />
            {t("ai.credentials.ignored")}
          </p>
        )}
        {profile?.credentialsInKeychain && (
          <p className={styles.note}>
            <Icon icon={KeyRound} size={14} />
            {t("ai.page.keychain")}
          </p>
        )}
        {profile && profile.exclude.length > 0 && (
          <p className={styles.note}>
            {t(
              "ai.excluded",
              profile.exclude
                .filter((e) => e !== ".DS_Store")
                .slice(0, 3)
                .join(", "),
            )}
          </p>
        )}
      </div>
    </Card>
  );
}
