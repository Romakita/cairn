import {
  ArrowUpCircle,
  ChartPie,
  Clock,
  Folder,
  HardDrive,
  House,
  Plus,
  Settings,
  Sparkles,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import { Fmt } from "../../../core/format.ts";
import {
  Banner,
  Button,
  Card,
  CardTray,
  FolderBreadcrumb,
  FolderRow,
  IconButton,
  PillPicker,
  RailButton,
  RowDivider,
  SectionTitle,
  SelectableRow,
  SettingsRow,
  Sheet,
  SidebarHeader,
  SidebarRow,
  TabBar,
  Table,
  type TableSort,
  TextField,
  Toggle,
  type Tone,
  WizardStepper,
} from "../../ui/index.ts";
import { Column, Muted, Row, Simulate, Stateful, Surface, Title } from "../helpers.tsx";
import { fileMenu, SAMPLE_FILES_ROWS, type SampleFile } from "../sample-data.ts";
import { SAMPLE_BRANCHES, s } from "../sample-text.ts";
import { bool, num, type Story, text } from "../story.ts";

const RAIL = [
  [House, "home"],
  [ChartPie, "analysis"],
  [ArrowUpCircle, "backup"],
  [Sparkles, "ai"],
] as const;

export const navigation = (): Story[] => [
  {
    id: "navigation.rail",
    group: "navigation",
    component: "RailButton",
    width: 140,
    controls: [{ kind: "number", key: "selected", min: 0, max: 3, default: 0 }],
    render: (v) => (
      <Surface tone="rail">
        {RAIL.map(([icon, key], i) => (
          <RailButton
            key={key}
            icon={icon}
            label={s(`gallery.sample.section.${key}`)}
            selected={i === num(v, "selected")}
          />
        ))}
      </Surface>
    ),
  },
  {
    id: "navigation.sidebar",
    group: "navigation",
    component: "SidebarRow",
    width: 280,
    render: () => (
      <Surface tone="sidebar">
        <SidebarHeader label={s("sidebar.destinations")} />
        <SidebarRow
          dot="var(--status-ok)"
          label="syno"
          meta={s("gallery.sample.reachable")}
          selected
          onClick={() => {}}
        />
        <SidebarRow dot="var(--status-ok)" label="nas" busy fraction={0.42} onClick={() => {}} />
        <SidebarRow dot="var(--status-attention)" label="usb" busy onClick={() => {}} />
        <Simulate state="hover">
          <SidebarRow icon={Plus} label={s("sidebar.add_destination")} onClick={() => {}} />
        </Simulate>
        <SidebarHeader label={s("sidebar.folders")} />
        <SidebarRow icon={Folder} label="workspaces" meta={Fmt.bytes(128_000_000_000)} />
        <SidebarRow icon={Folder} label="Documents" meta={Fmt.bytes(12_000_000_000)} />
      </Surface>
    ),
  },
  {
    id: "navigation.sidebar_header",
    group: "navigation",
    component: "SidebarHeader",
    width: 280,
    render: () => <SidebarHeader label={s("sidebar.sources")} />,
  },
  {
    id: "navigation.wizard_stepper",
    group: "navigation",
    component: "WizardStepper",
    width: 640,
    controls: [{ kind: "number", key: "selected", min: 0, max: 4, default: 2 }],
    render: (v) => {
      const current = num(v, "selected");
      return (
        <WizardStepper
          label={s("gallery.sample.steps")}
          steps={["folders", "home", "ai", "destination", "schedule"].map((k) => s(`onboarding.${k}.title`))}
          current={current}
          reached={current}
          canSelect={(i) => i <= current}
          onSelect={() => {}}
        />
      );
    },
  },
  {
    id: "navigation.folder_breadcrumb",
    group: "navigation",
    component: "FolderBreadcrumb",
    width: 420,
    render: () => (
      <FolderBreadcrumb
        label={s("gallery.sample.breadcrumb")}
        items={[
          { label: "Macintosh HD", id: "/" },
          { label: "…" },
          { label: "Developer", id: "/Developer" },
          { label: "cairn", id: "/Developer/cairn" },
        ]}
        onSelect={() => {}}
      />
    ),
  },
  {
    id: "navigation.pill_picker",
    group: "navigation",
    component: "PillPicker",
    render: () => (
      <Stateful initial="chat">
        {(value, set) => (
          <PillPicker
            label={s("gallery.sample.options")}
            options={[
              { value: "chat", label: s("gallery.sample.option_a") },
              { value: "work", label: s("gallery.sample.option_b") },
              {
                value: "later",
                label: s("gallery.sample.tab_files"),
                disabledReason: s("gallery.sample.reason_backup_running"),
              },
            ]}
            value={value}
            onChange={set}
          />
        )}
      </Stateful>
    ),
  },
  {
    id: "navigation.tab_bar",
    group: "navigation",
    component: "TabBar",
    render: () => (
      <Column gap={10}>
        <Stateful initial={0}>
          {(value, set) => (
            <TabBar
              label={s("gallery.sample.options")}
              options={[
                { value: 0, label: s("gallery.sample.tab_overview") },
                { value: 1, label: s("gallery.sample.tab_projects") },
                { value: 2, label: s("gallery.sample.tab_files") },
              ]}
              value={value}
              onChange={set}
            />
          )}
        </Stateful>
        <TabBar
          label={s("gallery.sample.options")}
          disabledReason={s("gallery.sample.reason_backup_running")}
          options={[
            { value: 0, label: s("gallery.sample.tab_overview") },
            { value: 1, label: s("gallery.sample.tab_projects") },
          ]}
          value={0}
          onChange={() => {}}
        />
      </Column>
    ),
  },
];

function SheetStory() {
  const [open, setOpen] = useState(false);
  const footer = (close: () => void) => (
    <>
      <Button onClick={close}>{s("gallery.sample.cancel")}</Button>
      <Button variant="danger" onClick={close}>
        {s("action.delete")}
      </Button>
    </>
  );
  return (
    <Column gap={14}>
      <Sheet
        open
        presentation="inline"
        heading={s("gallery.sample.sheet_title")}
        description={s("gallery.sample.sheet_text")}
        closeLabel={s("action.close")}
        onClose={() => {}}
        footer={footer(() => {})}
      >
        <Column gap={4}>
          {SAMPLE_BRANCHES.map((b) => (
            <span key={b}>{b}</span>
          ))}
        </Column>
      </Sheet>
      <Row>
        <Button variant="outline" onClick={() => setOpen(true)}>
          {s("gallery.sample.open_sheet")}
        </Button>
      </Row>
      <Sheet
        open={open}
        heading={s("gallery.sample.sheet_title")}
        description={s("gallery.sample.sheet_text")}
        closeLabel={s("action.close")}
        onClose={() => setOpen(false)}
        footer={footer(() => setOpen(false))}
      />
    </Column>
  );
}

function TableStory() {
  const [sort, setSort] = useState<TableSort>({ column: "size", direction: "descending" });
  const [selected, setSelected] = useState<string | null>("node_modules");
  const rows = [...SAMPLE_FILES_ROWS].sort((a, b) => {
    const order = sort.column === "size" ? a.size - b.size : a.name.localeCompare(b.name);
    return sort.direction === "ascending" ? order : -order;
  });
  return (
    <Table<SampleFile>
      label={s("gallery.sample.tab_files")}
      rows={rows}
      rowKey={(r) => r.name}
      sort={sort}
      onSortChange={setSort}
      selected={selected}
      onSelect={setSelected}
      rowMenu={() => fileMenu()}
      rowMenuLabel={s("gallery.sample.more")}
      columns={[
        { id: "name", header: s("col.name"), sortable: true, render: (r) => r.name },
        { id: "path", header: s("col.location"), render: (r) => r.path },
        {
          id: "size",
          header: s("col.size"),
          width: "96px",
          align: "end",
          sortable: true,
          render: (r) => Fmt.bytes(r.size),
        },
      ]}
    />
  );
}

const TONES: readonly Tone[] = ["neutral", "success", "warning", "danger", "info"];

export const containers = (): Story[] => [
  {
    id: "containers.card",
    group: "containers",
    component: "Card",
    controls: [
      { kind: "number", key: "padding", min: 0, max: 32, step: 2, default: 18 },
      { kind: "text", key: "label", default: s("gallery.sample.card_body") },
    ],
    render: (v) => (
      <Card padding={num(v, "padding")}>
        <Column gap={6}>
          <Title>{s("gallery.sample.card_title")}</Title>
          <Muted>{text(v, "label")}</Muted>
        </Column>
      </Card>
    ),
  },
  {
    id: "containers.section_title",
    group: "containers",
    component: "SectionTitle",
    render: () => (
      <Column gap={8}>
        <SectionTitle label={s("gallery.sample.section_general")} />
        <Card>{s("gallery.sample.card_body")}</Card>
      </Column>
    ),
  },
  {
    id: "containers.settings",
    group: "containers",
    component: "SettingsRow",
    width: 560,
    render: () => (
      <Card flush>
        <Stateful initial={true}>
          {(on, set) => (
            <SettingsRow
              icon={Clock}
              label={s("gallery.sample.setting_schedule")}
              description={s("gallery.sample.setting_schedule_hint")}
            >
              <Toggle checked={on} onChange={set} label={s("gallery.sample.setting_schedule")} />
            </SettingsRow>
          )}
        </Stateful>
        <RowDivider />
        <SettingsRow icon={Folder} label="~/Developer" description={Fmt.bytes(128_000_000_000)} mono>
          <IconButton icon={Trash2} label={s("action.delete")} />
        </SettingsRow>
        <CardTray>
          <Button>{s("sidebar.add_folder")}</Button>
        </CardTray>
      </Card>
    ),
  },
  {
    id: "containers.selectable_rows",
    group: "containers",
    component: "SelectableRow",
    width: 520,
    render: () => (
      <Card flush>
        <Stateful initial={true}>
          {(on, set) => (
            <SelectableRow icon={Folder} label="workspaces" subtitle="~/workspaces" checked={on} onChange={set} />
          )}
        </Stateful>
        <RowDivider />
        <Stateful initial={false}>
          {(on, set) => <SelectableRow icon={Settings} label="~/.config" mono checked={on} onChange={set} />}
        </Stateful>
        <RowDivider />
        <SelectableRow
          icon={HardDrive}
          label="Time Machine"
          subtitle="/Volumes/Backups"
          checked={false}
          onChange={() => {}}
          disabledReason={s("gallery.sample.reason_backup_running")}
        />
      </Card>
    ),
  },
  {
    id: "containers.folder_rows",
    group: "containers",
    component: "FolderRow",
    render: () => (
      <Card flush>
        <FolderRow name="Macintosh HD" icon={House} onOpen={() => {}} />
        <Simulate state="hover">
          <FolderRow name="syno" icon={HardDrive} onOpen={() => {}} />
        </Simulate>
        <FolderRow name="Developer" icon={Folder} onOpen={() => {}} />
      </Card>
    ),
  },
  {
    id: "containers.row_divider",
    group: "containers",
    component: "RowDivider",
    render: () => (
      <Card flush>
        <SettingsRow label={s("gallery.sample.option_a")} />
        <RowDivider />
        <SettingsRow label={s("gallery.sample.option_b")} />
      </Card>
    ),
  },
  {
    id: "containers.card_tray",
    group: "containers",
    component: "CardTray",
    render: () => (
      <Card flush>
        <SettingsRow label={s("gallery.sample.card_body")} />
        <CardTray>
          <Stateful initial="">
            {(value, set) => (
              <TextField
                value={value}
                onChange={set}
                placeholder={s("gallery.sample.field_placeholder")}
                label={s("gallery.sample.field_placeholder")}
              />
            )}
          </Stateful>
          <Button variant="primary">{s("sidebar.add_folder")}</Button>
        </CardTray>
      </Card>
    ),
  },
  {
    id: "containers.banner",
    group: "containers",
    component: "Banner",
    width: 560,
    controls: [
      { kind: "choice", key: "tone", options: TONES, default: "warning" },
      { kind: "text", key: "label", default: s("gallery.sample.banner") },
      { kind: "toggle", key: "action", default: true },
    ],
    render: (v) => (
      <Banner
        tone={text(v, "tone") as Tone}
        action={bool(v, "action") ? <Button variant="outline">{s("action.backup_now")}</Button> : undefined}
      >
        {text(v, "label")}
      </Banner>
    ),
  },
  {
    id: "containers.sheet",
    group: "containers",
    component: "Sheet",
    width: 640,
    render: () => <SheetStory />,
  },
  {
    id: "containers.table",
    group: "containers",
    component: "Table",
    width: 640,
    render: () => <TableStory />,
  },
];
