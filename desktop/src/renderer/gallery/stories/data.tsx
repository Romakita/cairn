import { Cpu, FileUp, HardDrive, House, Search, Server } from "lucide-react";
import type { CSSProperties } from "react";
import { Fmt } from "../../../core/format.ts";
import {
  Badge,
  BreakdownBar,
  BreakdownChart,
  Button,
  CATEGORIES,
  CATEGORY_KEYS,
  type CategoryKey,
  CategoryTag,
  Checkbox,
  ChoiceChip,
  ChoiceTile,
  DropdownMenu,
  FillBar,
  FilterChip,
  MessageBar,
  NumberStepper,
  PasswordField,
  PathField,
  PopupMenu,
  ProgressBar,
  ProjectBar,
  RailButton,
  RowDivider,
  SegmentBar,
  Spinner,
  Stat,
  TextField,
  Toggle,
  type Tone,
  Tooltip,
  WorkerRow,
} from "../../ui/index.ts";
import { Column, Grid, Row, Stateful, States, Surface } from "../helpers.tsx";
import {
  breakdownItems,
  breakdownParts,
  SAMPLE_BREAKDOWN,
  SAMPLE_FILES,
  SAMPLE_TOTAL,
  sampleMenu,
  suggestPaths,
} from "../sample-data.ts";
import { s } from "../sample-text.ts";
import { bool, num, type Story, text } from "../story.ts";
import styles from "./data.module.css";

const TONES: readonly Tone[] = ["neutral", "success", "warning", "danger", "info"];
const noop = () => {};

export const feedback = (): Story[] => [
  {
    id: "feedback.badge",
    group: "feedback",
    component: "Badge",
    width: 240,
    controls: [
      { kind: "choice", key: "tone", options: TONES, default: "success" },
      { kind: "text", key: "label", default: s("hub.badge.ok") },
    ],
    render: (v) => <Badge tone={text(v, "tone") as Tone}>{text(v, "label")}</Badge>,
  },
  {
    id: "feedback.badge_tones",
    group: "feedback",
    component: "Badge",
    render: () => (
      <Row gap={8}>
        {TONES.map((tone) => (
          <Badge key={tone} tone={tone}>
            {s(`gallery.option.${tone}`)}
          </Badge>
        ))}
      </Row>
    ),
  },
  {
    id: "feedback.fill_bar",
    group: "feedback",
    component: "FillBar",
    controls: [{ kind: "number", key: "percent", min: 0, max: 100, default: 42 }],
    render: (v) => (
      <Column gap={8}>
        <FillBar value={num(v, "percent") / 100} label={s("gallery.sample.disk_used")} />
        <FillBar value={num(v, "percent") / 100} color="var(--tone-danger-fg)" label={s("gallery.sample.disk_used")} />
      </Column>
    ),
  },
  {
    id: "feedback.segment_bar",
    group: "feedback",
    component: "SegmentBar",
    controls: [{ kind: "number", key: "percent", min: 0, max: 100, default: 60 }],
    render: (v) => (
      <div data-tint="" className={styles.tinted} style={{ "--tint": "var(--module-git)" } as CSSProperties}>
        <SegmentBar
          parts={[
            { key: "a", value: num(v, "percent"), color: "var(--tint)" },
            { key: "b", value: 100 - num(v, "percent"), color: "var(--tint-muted)" },
          ]}
        />
      </div>
    ),
  },
  {
    id: "feedback.message_bar",
    group: "feedback",
    component: "MessageBar",
    width: 560,
    render: () => (
      <MessageBar onClose={noop} closeLabel={s("action.close")}>
        {s("gallery.sample.banner")}
      </MessageBar>
    ),
  },
  {
    id: "feedback.worker_rows",
    group: "feedback",
    component: "WorkerRow",
    width: 520,
    render: () => (
      <Surface tone="worker">
        <WorkerRow
          icon={FileUp}
          label={s("backup.worker.copy")}
          detail="Developer/cairn/Cairn/Sources/CairnCore/Package.swift"
          done={false}
          stateLabel={s("gallery.sample.in_progress")}
        />
        <RowDivider inset={false} />
        <WorkerRow
          icon={Cpu}
          label={s("gallery.sample.counting")}
          detail={s("backup.worker.done")}
          done
          stateLabel={s("backup.worker.done")}
        />
      </Surface>
    ),
  },
  {
    id: "feedback.tooltip",
    group: "feedback",
    component: "Tooltip",
    width: 420,
    render: () => (
      <Column gap={64} center>
        <Row>
          <Tooltip content={s("gallery.sample.section.home")} side="right" open>
            <RailButton icon={House} label={s("gallery.sample.section.home")} />
          </Tooltip>
        </Row>
        <Row>
          <Tooltip content={s("gallery.sample.reason_backup_running")} side="top" open>
            <Button variant="primary" disabledReason={s("gallery.sample.reason_backup_running")}>
              {s("gallery.sample.install_update")}
            </Button>
          </Tooltip>
        </Row>
      </Column>
    ),
  },
  {
    id: "feedback.progress_bar",
    group: "feedback",
    component: "ProgressBar",
    controls: [{ kind: "number", key: "percent", min: 0, max: 100, default: 64 }],
    render: (v) => (
      <Column gap={14}>
        <ProgressBar value={num(v, "percent") / 100} label={s("gallery.sample.copying")} />
        <ProgressBar label={s("gallery.sample.counting")} />
      </Column>
    ),
  },
  {
    id: "feedback.spinner",
    group: "feedback",
    component: "Spinner",
    render: () => (
      <Row gap={18}>
        <Spinner size="mini" />
        <Spinner size="small" />
        <Spinner size="regular" />
        <Spinner size="large" label={s("gallery.sample.loading")} />
      </Row>
    ),
  },
  {
    id: "feedback.stat",
    group: "feedback",
    component: "Stat",
    width: 560,
    render: () => (
      <Grid columns={3}>
        <Stat label={s("gallery.sample.repositories")} value={Fmt.count(42)} detail={Fmt.bytes(86_000_000_000)} />
        <Stat
          label={s("gallery.sample.freeable")}
          value={Fmt.bytes(31_600_000_000)}
          detail={s("gallery.sample.in_repos", 12)}
        />
        <Stat label={s("gallery.sample.last_backup")} value={s("gallery.sample.today")} />
      </Grid>
    ),
  },
];

const AI_CATEGORIES = ["conversations", "config", "memories", "credentials"] as const;
const FILTERS: readonly CategoryKey[] = ["deps", "build", "cache"];

export const fields = (): Story[] => [
  {
    id: "fields.text",
    group: "fields",
    component: "TextField",
    controls: [
      { kind: "toggle", key: "icon", default: true },
      { kind: "text", key: "value", default: "" },
    ],
    render: (v) => (
      <States
        rows={[
          [
            "normal",
            <Stateful key={text(v, "value")} initial={text(v, "value")}>
              {(value, set) => (
                <TextField
                  value={value}
                  onChange={set}
                  icon={bool(v, "icon") ? Search : undefined}
                  placeholder={s("gallery.sample.field_placeholder")}
                  label={s("gallery.sample.field_placeholder")}
                />
              )}
            </Stateful>,
          ],
          [
            "disabled",
            <TextField
              key="d"
              value=""
              onChange={noop}
              icon={Search}
              placeholder={s("gallery.sample.field_placeholder")}
              label={s("gallery.sample.field_placeholder")}
              disabledReason={s("gallery.sample.reason_backup_running")}
            />,
          ],
        ]}
      />
    ),
  },
  {
    id: "fields.password",
    group: "fields",
    component: "PasswordField",
    render: () => (
      <States
        rows={[
          [
            "normal",
            <Stateful key="n" initial="">
              {(value, set) => (
                <PasswordField
                  value={value}
                  onChange={set}
                  placeholder={s("gallery.sample.password")}
                  label={s("gallery.sample.password")}
                  showLabel={s("gallery.sample.show_password")}
                  hideLabel={s("gallery.sample.hide_password")}
                />
              )}
            </Stateful>,
          ],
          [
            "invalid",
            <Stateful key="i" initial="hunter2">
              {(value, set) => (
                <PasswordField
                  value={value}
                  onChange={set}
                  invalid
                  label={s("gallery.sample.password")}
                  showLabel={s("gallery.sample.show_password")}
                  hideLabel={s("gallery.sample.hide_password")}
                />
              )}
            </Stateful>,
          ],
        ]}
      />
    ),
  },
  {
    id: "fields.dropdown",
    group: "fields",
    component: "DropdownMenu",
    width: 280,
    render: () => (
      <States
        rows={[
          [
            "normal",
            <Stateful key="n" initial="weekly">
              {(value, set) => (
                <DropdownMenu
                  label={s("gallery.sample.frequency")}
                  options={[
                    { value: "daily", label: s("gallery.sample.daily") },
                    { value: "weekly", label: s("gallery.sample.weekly") },
                  ]}
                  value={value}
                  onChange={set}
                />
              )}
            </Stateful>,
          ],
          [
            "hover",
            <DropdownMenu
              key="h"
              label={s("gallery.sample.frequency")}
              options={[{ value: "daily", label: s("gallery.sample.daily") }]}
              value="daily"
              onChange={noop}
            />,
          ],
          [
            "disabled",
            <DropdownMenu
              key="d"
              label={s("gallery.sample.frequency")}
              options={[{ value: "daily", label: s("gallery.sample.daily") }]}
              value="daily"
              onChange={noop}
              disabledReason={s("gallery.sample.reason_backup_running")}
            />,
          ],
        ]}
      />
    ),
  },
  {
    id: "fields.choice_chips",
    group: "fields",
    component: "ChoiceChip",
    render: () => (
      <Row gap={8} wrap>
        {AI_CATEGORIES.map((cat) => (
          <Stateful key={cat} initial={cat !== "credentials"}>
            {(on, set) => <ChoiceChip label={s(`ai.category.${cat}`)} checked={on} onChange={set} />}
          </Stateful>
        ))}
      </Row>
    ),
  },
  {
    id: "fields.filter_chips",
    group: "fields",
    component: "FilterChip",
    width: 560,
    render: () => (
      <Stateful<string> initial="all">
        {(active, set) => (
          <Row gap={6} wrap>
            <FilterChip
              label={s("list.all")}
              total={Fmt.bytes(SAMPLE_TOTAL)}
              color="var(--color-accent)"
              active={active === "all"}
              onClick={() => set("all")}
            />
            {FILTERS.map((c) => (
              <FilterChip
                key={c}
                label={s(`category.${c}.short`)}
                total={Fmt.bytes(SAMPLE_BREAKDOWN[c])}
                color={CATEGORIES[c].color}
                active={active === c}
                onClick={() => set(c)}
              />
            ))}
          </Row>
        )}
      </Stateful>
    ),
  },
  {
    id: "fields.choice_tiles",
    group: "fields",
    component: "ChoiceTile",
    width: 560,
    render: () => (
      <Stateful initial="local">
        {(kind, set) => (
          <div role="radiogroup" aria-label={s("gallery.sample.destination_type")} className={styles.tiles}>
            <ChoiceTile
              icon={HardDrive}
              label={s("onboarding.destination.local")}
              description={s("onboarding.destination.local.text")}
              selected={kind === "local"}
              onSelect={() => set("local")}
            />
            <ChoiceTile
              icon={Server}
              label={s("onboarding.destination.smb")}
              description={s("onboarding.destination.smb.text")}
              selected={kind === "smb"}
              onSelect={() => set("smb")}
            />
          </div>
        )}
      </Stateful>
    ),
  },
  {
    id: "fields.popup_menu",
    group: "fields",
    component: "PopupMenu",
    width: 280,
    render: () => <PopupMenu entries={sampleMenu()} label={s("gallery.sample.more")} />,
  },
  {
    id: "fields.path",
    group: "fields",
    component: "PathField",
    controls: [{ kind: "text", key: "value", default: "De" }],
    render: (v) => (
      <div className={styles.pathRoom}>
        <Stateful key={text(v, "value")} initial={text(v, "value")}>
          {(value, set) => (
            <PathField
              value={value}
              onChange={set}
              suggest={suggestPaths}
              placeholder={s("gallery.sample.field_placeholder")}
              label={s("gallery.sample.path_label")}
              listLabel={s("gallery.sample.suggestions")}
            />
          )}
        </Stateful>
      </div>
    ),
  },
  {
    id: "fields.toggle",
    group: "fields",
    component: "Toggle",
    render: () => (
      <States
        rows={[
          [
            "normal",
            <Row key="n" gap={14}>
              <Stateful initial={true}>
                {(on, set) => <Toggle checked={on} onChange={set} label={s("gallery.sample.run_in_background")} />}
              </Stateful>
              <Stateful initial={false}>
                {(on, set) => <Toggle checked={on} onChange={set} label={s("gallery.sample.run_in_background")} />}
              </Stateful>
              <Stateful initial={true}>
                {(on, set) => (
                  <Toggle checked={on} onChange={set} size="small" label={s("gallery.sample.run_in_background")} />
                )}
              </Stateful>
            </Row>,
          ],
          [
            "disabled",
            <Toggle
              key="d"
              checked
              onChange={noop}
              label={s("gallery.sample.run_in_background")}
              disabledReason={s("gallery.sample.reason_backup_running")}
            />,
          ],
        ]}
      />
    ),
  },
  {
    id: "fields.checkbox",
    group: "fields",
    component: "Checkbox",
    render: () => (
      <States
        rows={[
          [
            "checked",
            <Stateful key="c" initial={true}>
              {(on, set) => (
                <Checkbox checked={on} onChange={set}>
                  {s("col.keep")}
                </Checkbox>
              )}
            </Stateful>,
          ],
          [
            "unchecked",
            <Stateful key="u" initial={false}>
              {(on, set) => (
                <Checkbox checked={on} onChange={set}>
                  {s("col.keep")}
                </Checkbox>
              )}
            </Stateful>,
          ],
          [
            "mixed",
            <Checkbox key="m" checked="mixed" onChange={noop}>
              {s("list.all")}
            </Checkbox>,
          ],
          [
            "hover",
            <Checkbox key="h" checked={false} onChange={noop}>
              {s("col.keep")}
            </Checkbox>,
          ],
          [
            "disabled",
            <Checkbox key="d" checked onChange={noop} disabledReason={s("gallery.sample.reason_backup_running")}>
              {s("col.keep")}
            </Checkbox>,
          ],
        ]}
      />
    ),
  },
  {
    id: "fields.number_stepper",
    group: "fields",
    component: "NumberStepper",
    render: () => (
      <Stateful initial={7}>
        {(value, set) => (
          <NumberStepper
            value={value}
            onChange={set}
            min={1}
            max={30}
            label={s("gallery.sample.retention")}
            decrementLabel={s("gallery.sample.decrease")}
            incrementLabel={s("gallery.sample.increase")}
            minReason={s("gallery.sample.min_versions")}
            maxReason={s("gallery.sample.max_versions")}
            format={(n) => s("gallery.sample.versions", n)}
          />
        )}
      </Stateful>
    ),
  },
];

export const charts = (): Story[] => [
  {
    id: "charts.breakdown_bar",
    group: "charts",
    component: "BreakdownBar",
    controls: [{ kind: "number", key: "percent", min: 5, max: 100, step: 5, default: 80 }],
    render: (v) => (
      <BreakdownBar
        parts={breakdownParts()}
        scale={(SAMPLE_TOTAL * 100) / Math.max(num(v, "percent"), 1)}
        label={s("col.breakdown")}
      />
    ),
  },
  {
    id: "charts.category_tags",
    group: "charts",
    component: "CategoryTag",
    render: () => (
      <Grid columns={4}>
        {CATEGORY_KEYS.map((key) => (
          <div key={key}>
            <CategoryTag category={key} label={s(`category.${key}.short`)} />
          </div>
        ))}
      </Grid>
    ),
  },
  {
    id: "charts.breakdown_chart",
    group: "charts",
    component: "BreakdownChart",
    width: 360,
    render: () => (
      <BreakdownChart
        items={breakdownItems()}
        total={Fmt.bytes(SAMPLE_TOTAL)}
        caption={s("stat.files", Fmt.count(SAMPLE_FILES))}
        label={s("col.breakdown")}
      />
    ),
  },
  {
    id: "charts.project_bar",
    group: "charts",
    component: "ProjectBar",
    render: () => (
      <Column gap={10}>
        <ProjectBar
          sources={4_200_000_000}
          git={1_900_000_000}
          regenerable={6_800_000_000}
          externalWorktrees={1_100_000_000}
          scale={14_000_000_000}
        />
        <ProjectBar sources={2_100_000_000} git={600_000_000} regenerable={1_200_000_000} scale={14_000_000_000} />
        <ProjectBar sources={400_000_000} git={300_000_000} regenerable={0} scale={14_000_000_000} />
      </Column>
    ),
  },
];
