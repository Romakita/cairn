import {
  ArrowUpCircle,
  ChartPie,
  Ellipsis,
  Folder,
  FolderGit2,
  HardDrive,
  History,
  House,
  RefreshCw,
  Search,
  Settings,
  Sparkles,
  Terminal,
  Trash2,
} from "lucide-react";
import {
  Button,
  type ButtonVariant,
  CATEGORIES,
  CATEGORY_KEYS,
  CairnLogo,
  Icon,
  IconButton,
  IconTile,
  MoreButton,
} from "../../ui/index.ts";
import { Caption, Column, Grid, Row, States, Swatch } from "../helpers.tsx";
import { sampleMenu } from "../sample-data.ts";
import { s } from "../sample-text.ts";
import { bool, num, type Story, text } from "../story.ts";

const COLOR_TOKENS = [
  "content",
  "sidebar",
  "rail",
  "rail-selected",
  "row-selected",
  "row-hover",
  "border",
  "field-border",
  "field",
  "field-pressed",
  "text",
  "text-tertiary",
  "text-secondary",
  "placeholder",
  "accent",
  "primary",
  "primary-text",
  "danger-solid",
] as const;

const TONES = ["neutral", "success", "warning", "danger", "info"] as const;
const VARIANTS: readonly ButtonVariant[] = ["primary", "secondary", "outline", "danger"];
const variantLabel = (v: ButtonVariant) => s(v === "danger" ? "gallery.option.danger_button" : `gallery.option.${v}`);

export const palette = (): Story[] => [
  {
    id: "palette.colors",
    group: "palette",
    component: "tokens.css",
    width: 560,
    render: () => (
      <Grid columns={3}>
        {COLOR_TOKENS.map((name) => (
          <Swatch key={name} name={name} color={`var(--color-${name})`} />
        ))}
      </Grid>
    ),
  },
  {
    id: "palette.tones",
    group: "palette",
    component: "tokens.css (--tone-*)",
    render: () => (
      <Column gap={8}>
        {TONES.map((tone) => (
          <Row key={tone}>
            <Swatch name={s(`gallery.option.${tone}`)} color={`var(--tone-${tone}-bg)`} />
            <Swatch name={s("gallery.label.foreground")} color={`var(--tone-${tone}-fg)`} />
          </Row>
        ))}
      </Column>
    ),
  },
  {
    id: "palette.categories",
    group: "palette",
    component: "tokens.css (--category-*)",
    render: () => (
      <Grid columns={2}>
        {CATEGORY_KEYS.map((key) => (
          <Swatch key={key} name={s(`category.${key}.label`)} color={CATEGORIES[key].color} />
        ))}
      </Grid>
    ),
  },
];

export const buttons = (): Story[] => [
  {
    id: "buttons.pill",
    group: "buttons",
    component: "Button",
    controls: [
      { kind: "choice", key: "kind", options: ["primary", "secondary", "outline", "danger"], default: "primary" },
      { kind: "text", key: "label", default: s("action.backup_now") },
      { kind: "toggle", key: "disabled", default: false },
      { kind: "toggle", key: "loading", default: false },
    ],
    render: (v) => (
      <Button
        variant={text(v, "kind") as ButtonVariant}
        disabledReason={bool(v, "disabled") ? s("gallery.sample.reason_no_backup") : undefined}
        loading={bool(v, "loading")}
      >
        {text(v, "label")}
      </Button>
    ),
  },
  {
    id: "buttons.pill_all",
    group: "buttons",
    component: "Button",
    width: 560,
    render: () => (
      <States
        rows={[
          [
            "normal",
            VARIANTS.map((k) => (
              <Button key={k} variant={k}>
                {variantLabel(k)}
              </Button>
            )),
          ],
          [
            "hover",
            VARIANTS.map((k) => (
              <Button key={k} variant={k}>
                {variantLabel(k)}
              </Button>
            )),
          ],
          [
            "disabled",
            VARIANTS.map((k) => (
              <Button key={k} variant={k} disabledReason={s("gallery.sample.reason_no_backup")}>
                {variantLabel(k)}
              </Button>
            )),
          ],
          [
            "loading",
            VARIANTS.map((k) => (
              <Button key={k} variant={k} loading>
                {variantLabel(k)}
              </Button>
            )),
          ],
        ]}
      />
    ),
  },
  {
    id: "buttons.icon",
    group: "buttons",
    component: "IconButton",
    render: () => (
      <States
        rows={[
          [
            "normal",
            <Row key="n" gap={6}>
              <IconButton icon={Trash2} label={s("action.delete")} />
              <IconButton icon={RefreshCw} label={s("gallery.sample.refresh")} />
              <IconButton icon={Ellipsis} label={s("gallery.sample.more")} />
            </Row>,
          ],
          ["hover", <IconButton key="h" icon={Trash2} label={s("action.delete")} />],
          [
            "disabled",
            <IconButton
              key="d"
              icon={RefreshCw}
              label={s("gallery.sample.refresh")}
              disabledReason={s("gallery.sample.reason_backup_running")}
            />,
          ],
        ]}
      />
    ),
  },
  {
    id: "buttons.more_icon",
    group: "buttons",
    component: "MoreButton",
    width: 200,
    render: () => (
      <States
        rows={[
          ["normal", <MoreButton key="n" entries={sampleMenu} label={s("gallery.sample.more")} />],
          ["hover", <MoreButton key="h" entries={sampleMenu} label={s("gallery.sample.more")} />],
        ]}
      />
    ),
  },
  {
    id: "buttons.more_menu",
    group: "buttons",
    component: "MenuButton",
    width: 240,
    render: () => (
      <Row>
        <MoreButton entries={sampleMenu} label={s("gallery.sample.more")} align="start" />
      </Row>
    ),
  },
];

const ICONS = [
  ["house", House],
  ["chart-pie", ChartPie],
  ["arrow-up-circle", ArrowUpCircle],
  ["sparkles", Sparkles],
  ["terminal", Terminal],
  ["folder-git-2", FolderGit2],
  ["history", History],
  ["folder", Folder],
  ["trash-2", Trash2],
  ["settings", Settings],
  ["search", Search],
  ["hard-drive", HardDrive],
] as const;

export const brand = (): Story[] => [
  {
    id: "brand.logo",
    group: "brand",
    component: "CairnLogo",
    width: 240,
    controls: [{ kind: "number", key: "size", min: 16, max: 96, step: 4, default: 48 }],
    render: (v) => (
      <Row gap={20}>
        <CairnLogo size={num(v, "size")} />
        <CairnLogo size={20} badge />
      </Row>
    ),
  },
  {
    id: "brand.icons",
    group: "brand",
    component: "Icon",
    render: () => (
      <Grid columns={6}>
        {ICONS.map(([name, glyph]) => (
          <Column key={name} gap={6}>
            <Icon icon={glyph} size={20} />
            <Caption>{name}</Caption>
          </Column>
        ))}
      </Grid>
    ),
  },
  {
    id: "brand.icon_tile",
    group: "brand",
    component: "IconTile",
    controls: [{ kind: "number", key: "size", min: 24, max: 64, step: 4, default: 32 }],
    render: (v) => (
      <Row gap={12}>
        {[Folder, HardDrive, Sparkles, Terminal].map((glyph, i) => (
          <IconTile key={String(i)} icon={glyph} size={num(v, "size")} />
        ))}
        <IconTile icon={HardDrive} size={num(v, "size")} tint="var(--module-backup)" />
      </Row>
    ),
  },
];
