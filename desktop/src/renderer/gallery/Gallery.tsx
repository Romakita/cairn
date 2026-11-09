import { useEffect, useState } from "react";
import { currentLanguage, setLanguage } from "../../core/l10n.ts";
import {
  Button,
  CairnLogo,
  DropdownMenu,
  NumberStepper,
  PillPicker,
  SidebarHeader,
  SidebarRow,
  TextField,
  Toggle,
} from "../ui/index.ts";
import styles from "./Gallery.module.css";
import { type GalleryRoute, galleryHash } from "./route.ts";
import { s } from "./sample-text.ts";
import { allStories } from "./stories/index.ts";
import {
  defaultValues,
  groupTitle,
  STORY_GROUPS,
  type Story,
  type StoryControl,
  type StoryValue,
  type StoryValues,
  storyTitle,
} from "./story.ts";

const WIDTHS = [0, 320, 480, 640, 800] as const;
const DEFAULT_WIDTH = 480;

/** Aperçu d'une story : carte de fond `content`, à la largeur prévue. Cible des captures. */
function StoryCanvas({ story, values, width }: { story: Story; values: StoryValues; width: number }) {
  return (
    <div className={styles.canvas} data-testid="story-canvas" data-story-id={story.id} style={{ width }}>
      {story.render(values)}
    </div>
  );
}

function Control({
  control,
  value,
  onChange,
}: {
  control: StoryControl;
  value: StoryValue;
  onChange: (v: StoryValue) => void;
}) {
  const label = s(`gallery.control.${control.key}`);
  switch (control.kind) {
    case "text":
      return (
        <div className={styles.control}>
          <span className={styles.controlLabel}>{label}</span>
          <TextField value={String(value)} onChange={onChange} label={label} />
        </div>
      );
    case "toggle":
      return (
        <div className={styles.controlInline}>
          <span className={styles.controlText}>{label}</span>
          <Toggle checked={value === true} onChange={onChange} label={label} size="small" />
        </div>
      );
    case "number":
      return (
        <div className={styles.controlInline}>
          <span className={styles.controlLabel}>{label}</span>
          <NumberStepper
            value={Number(value)}
            onChange={onChange}
            min={control.min}
            max={control.max}
            step={control.step}
            label={label}
            decrementLabel={s("gallery.sample.decrease")}
            incrementLabel={s("gallery.sample.increase")}
          />
        </div>
      );
    case "choice":
      return (
        <div className={styles.control}>
          <span className={styles.controlLabel}>{label}</span>
          <DropdownMenu
            label={label}
            value={String(value)}
            onChange={onChange}
            options={control.options.map((o) => ({ value: o, label: s(`gallery.option.${o}`) }))}
          />
        </div>
      );
  }
}

/** Catalogue des composants (`cairn --gallery`, `#/gallery`) : stories à gauche, aperçu, réglages à droite. */
export function Gallery({ route }: { route: GalleryRoute }) {
  if (route.language && route.language !== currentLanguage()) setLanguage(route.language);
  const stories = allStories();
  const story = stories.find((st) => st.id === route.story) ?? stories[0]!;
  const [values, setValues] = useState<Record<string, Record<string, StoryValue>>>({});
  const [width, setWidth] = useState<number>(0);
  const current = values[story.id] ?? defaultValues(story);
  const language = currentLanguage();

  useEffect(() => {
    document.documentElement.dataset.theme = route.theme;
    document.documentElement.lang = language;
  }, [route.theme, language]);

  const go = (patch: Partial<GalleryRoute>) => {
    location.hash = galleryHash({ ...route, story: story.id, ...patch });
  };
  const manifest = JSON.stringify(
    stories.map((st) => ({
      id: st.id,
      group: st.group,
      groupTitle: groupTitle(st.group),
      title: storyTitle(st),
      component: st.component,
    })),
  );
  const frameWidth = width === 0 ? (story.width ?? DEFAULT_WIDTH) : width;

  if (route.capture) {
    return (
      <div className={styles.capture} data-gallery-manifest={manifest}>
        <StoryCanvas key={`${story.id}-${language}`} story={story} values={current} width={frameWidth} />
      </div>
    );
  }

  return (
    <div className={styles.gallery} data-gallery-manifest={manifest}>
      <aside className={styles.sidebar} aria-label={s("gallery.stories")}>
        <div className={styles.brand}>
          <CairnLogo size={20} />
          <span className={styles.brandTitle}>{s("gallery.window.title")}</span>
        </div>
        <span className={styles.count}>{s("gallery.stories_count", stories.length)}</span>
        {STORY_GROUPS.map((group) => (
          <div key={group} className={styles.group}>
            <SidebarHeader label={groupTitle(group)} />
            {stories
              .filter((st) => st.group === group)
              .map((st) => (
                <SidebarRow
                  key={st.id}
                  label={storyTitle(st)}
                  selected={st.id === story.id}
                  onClick={() => go({ story: st.id })}
                />
              ))}
          </div>
        ))}
      </aside>
      <section className={styles.main}>
        <div className={styles.toolbar}>
          <PillPicker
            label={s("gallery.toolbar.theme")}
            options={[
              { value: "light", label: s("gallery.toolbar.light") },
              { value: "dark", label: s("gallery.toolbar.dark") },
            ]}
            value={route.theme}
            onChange={(theme) => go({ theme })}
          />
          <PillPicker
            label={s("gallery.toolbar.language")}
            options={[
              { value: "en-US", label: "English" },
              { value: "fr-FR", label: "Français" },
            ]}
            value={language}
            onChange={(lang) => {
              setValues({});
              go({ language: lang });
            }}
          />
          <span className={styles.spacer} />
          <span className={styles.toolbarLabel}>{s("gallery.toolbar.width")}</span>
          <DropdownMenu
            label={s("gallery.toolbar.width")}
            value={width}
            onChange={setWidth}
            options={WIDTHS.map((w) => ({
              value: w,
              label: w === 0 ? s("gallery.toolbar.width_auto") : s("gallery.toolbar.width_value", w),
            }))}
          />
        </div>
        <div className={styles.stage}>
          <div className={styles.frame}>
            <StoryCanvas key={`${story.id}-${language}`} story={story} values={current} width={frameWidth} />
          </div>
        </div>
      </section>
      <aside className={styles.controls} aria-label={s("gallery.controls.title")}>
        <div className={styles.controlsHeader}>
          <span className={styles.controlsTitle}>{s("gallery.controls.title")}</span>
          {story.controls?.length ? (
            <Button onClick={() => setValues((v) => ({ ...v, [story.id]: defaultValues(story) }))}>
              {s("gallery.controls.reset")}
            </Button>
          ) : null}
        </div>
        <div className={styles.storyInfo}>
          <span className={styles.storyTitle}>{storyTitle(story)}</span>
          <span className={styles.storyComponent}>{story.component}</span>
        </div>
        {story.controls?.length ? (
          story.controls.map((c) => (
            <Control
              key={c.key}
              control={c}
              value={current[c.key] ?? c.default}
              onChange={(v) => setValues((all) => ({ ...all, [story.id]: { ...current, [c.key]: v } }))}
            />
          ))
        ) : (
          <span className={styles.none}>{s("gallery.controls.none")}</span>
        )}
      </aside>
    </div>
  );
}
