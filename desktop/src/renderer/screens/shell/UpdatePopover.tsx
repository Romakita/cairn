// Panneau de mise à jour (§3.12) : version disponible, notes de version, installation désactivée avec sa raison
// (sauvegarde en cours, copie non remplaçable), téléchargement en cours, échec.
import type { ReactNode, RefObject } from "react";
import { t } from "../../../core/l10n.ts";
import type { UpdateView } from "../../../shared/contract.ts";
import { useApi } from "../../api/hooks.ts";
import { Banner } from "../../ui/Banner.tsx";
import { Button } from "../../ui/Button.tsx";
import { Popover } from "../../ui/Popover.tsx";
import styles from "./UpdatePopover.module.css";

export function UpdatePopover({
  open,
  onClose,
  anchor,
  updates,
}: {
  open: boolean;
  onClose: () => void;
  anchor: RefObject<HTMLElement | null>;
  updates: UpdateView;
}) {
  const api = useApi();
  const available = updates.available;
  if (!available) return null;
  const downloading = updates.phase === "downloading";
  const reason = updates.blocker ?? (updates.installable ? undefined : t("update.blocked.not_installable"));
  const openPage = () => void api.openExternal({ url: available.pageURL });
  return (
    <Popover open={open} onClose={onClose} anchor={anchor} label={t("update.available")} width={400}>
      <div className={styles.content}>
        <div className={styles.head}>
          <h2 className={styles.title}>{t("update.title", available.version)}</h2>
          <span className={styles.versions}>{t("shell.update.versions", updates.current, available.version)}</span>
        </div>
        <section className={styles.notes} aria-label={t("shell.update.notes")}>
          <ReleaseNotes text={available.notes} openLink={(url) => void api.openExternal({ url })} />
        </section>
        {updates.error && <Banner tone="danger">{updates.error}</Banner>}
        {reason && <p className={styles.blocker}>{reason}</p>}
        <div className={styles.footer}>
          <Button onClick={onClose}>{t("update.later")}</Button>
          <Button onClick={openPage}>{t("update.release_page")}</Button>
          <Button
            variant="primary"
            loading={downloading}
            disabledReason={reason}
            onClick={() => void api.installUpdate()}
          >
            {downloading ? t("update.downloading") : t("update.install")}
          </Button>
        </div>
      </div>
    </Popover>
  );
}

/** Notes du CHANGELOG (Markdown simple) : titres en gras, puces, liens ouverts dans le navigateur. */
function ReleaseNotes({ text, openLink }: { text: string; openLink: (url: string) => void }) {
  type Block = { kind: "heading" | "paragraph"; text: string } | { kind: "list"; items: string[] };
  const blocks: Block[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    const previous = blocks.at(-1);
    if (!line) blocks.push({ kind: "paragraph", text: "" });
    else if (heading) blocks.push({ kind: "heading", text: heading[1]! });
    else if (bullet && previous?.kind === "list") previous.items.push(bullet[1]!);
    else if (bullet) blocks.push({ kind: "list", items: [bullet[1]!] });
    else blocks.push({ kind: "paragraph", text: line });
  }
  let n = 0;
  const key = () => `b${n++}`;
  return (
    <>
      {blocks.map((b) => {
        if (b.kind === "list")
          return (
            <ul key={key()} className={styles.list}>
              {b.items.map((item) => (
                <li key={key()}>{inline(item, openLink)}</li>
              ))}
            </ul>
          );
        if (!b.text) return null;
        if (b.kind === "heading")
          return (
            <h3 key={key()} className={styles.heading}>
              {inline(b.text, openLink)}
            </h3>
          );
        return <p key={key()}>{inline(b.text, openLink)}</p>;
      })}
    </>
  );
}

function inline(text: string, openLink: (url: string) => void): ReactNode[] {
  const parts: ReactNode[] = [];
  const re = /\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    if (m[1] && m[2]) {
      const url = m[2];
      parts.push(
        <a
          key={m.index}
          href={url}
          className={styles.link}
          onClick={(event) => {
            event.preventDefault();
            openLink(url);
          }}
        >
          {m[1]}
        </a>,
      );
    } else {
      parts.push(<strong key={m.index}>{m[3]}</strong>);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}
