# Changelog

All notable changes to Cairn. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
versions follow [SemVer](https://semver.org/). The current version is in `Cairn/VERSION`.

## [Unreleased]

### Fixed
- A backup no longer fails with "Could not copy the state_5.sqlite database": SQLite databases that an AI tool closed
  in WAL mode without keeping their `-shm` file (Codex) are now copied read-only without a lock, then checked. A
  database that still cannot be copied only produces a warning instead of stopping the whole backup.

## [0.3.0] - 2026-11-08

### Added
- shared destination form in the wizard and the app
- verify and browse a destination before saving it

### Fixed
- address review on destination verification

## [0.2.0] - 2026-11-08

### Added
- In-app updates, like Codex: when a new release is published, an **Update available** button appears at the bottom
  of the icon bar. It shows the release notes and offers **Install and relaunch**: the archive is checked against its
  SHA-256, and the previous app is put back if the swap fails. **Check for Updates…** menu item, and an
  `[updates] check` setting to turn off the automatic check.
- A destination is verified before it is saved, in the first-run wizard and in the app: the server answers, the
  credentials are accepted and the folder is writable. **Continue** stays disabled until it succeeds (**Later** is
  still there). Nothing is left behind: a test file deleted right away, and whatever Cairn mounted is unmounted.
- A folder browser on the destination (breadcrumb, subfolders, **New folder**), inside the SMB share once connected,
  or from the mounted volumes and the home for a local folder. Existing Cairn backups in the folder are flagged, with
  **Restore this backup** in the wizard.
- Destination page: **Edit** (connection, password stored in the Keychain, verified again before saving) and
  **Delete destination** in the **…** menu, keeping the backups on the destination (default) or deleting them after a
  simulation that lists what will be erased.

### Changed
- The home page is a hub: a global status with its causes, a read-only **Check everything** button (tracked folders,
  git cleanup in simulation, destination reachability, backup state) that can be stopped, one card per module
  (Storage, Backup, Git, AI tools, Restore) with its status and one action, a **Resolve** banner for the most urgent
  problem, and recent activity (`~/.cairn/state/activity.jsonl`, 200 entries at most). The old search bar and the
  outdated "Last backup" card are gone.
- Codex-style window: translucent frame, Cairn logo centered in the top bar, Codex colors, and
  [Lucide](https://lucide.dev) icons (ISC license, bundled with the app).
- "Versions" becomes "Backup history" and loads by itself when the page opens, if the destination is reachable.
- Buttons on a destination page are disabled when their action cannot succeed, with the reason in a tooltip;
  **Verify** and **Verify everything** move into the Integrity card.
- Cards in the same row have the same height; button groups in the Codex style (gray pill, no container).
- Releases are automatic, with semantic-release: after a successful build on `main`, the version is computed from the
  Conventional Commits since the last tag (breaking change → major, `feat` → minor, `fix`/`perf` → patch), then CI
  commits the bump, tags it and publishes the GitHub release with the app archive. No more manual bump or tag.
- Design system taken from Codex (`Cairn/DESIGN.md`): neutral palette, borderless cards, settings rows, black / gray /
  outlined buttons, segmented picker and page tabs, bordered menus, capsule text fields, dark tooltips in the icon bar.
- The first-run wizard shows its steps across the top, as a clickable progress line, with animated transitions,
  switch rows, destination tiles and a sticky Back / Continue bar.
- Home items (`~/…`) get path completion in the wizard and in Settings.
- Settings are laid out as Codex sections and rows.
- New icon: a cairn of shaded pebbles on a ridge at dusk.
- README rewritten for an open-source project, in English (`README.md`) and French (`README.fr.md`).
- The project is released under the MIT license.

### Fixed
- **Add a destination** in the app opens the destination form instead of sending you to Settings, which had no
  destinations section.
- The wizard's button to pick a destination folder was labelled "Analyze".
- No more crash when the resource bundle cannot be found: `Bundle.module` (which asserts) is no longer called, and
  the app starts with untranslated strings.
- The smoke test also launches the GUI and checks that it is still running after a few seconds: the 0.1.0 crash
  (while building the menus) was not covered by the CLI commands alone.

## [0.1.1] - 2026-11-08

### Fixed
- The app downloaded from a release crashed at launch: its resource bundle was only looked up in the build folder of
  the machine that compiled it. Resources are now looked up in `Cairn.app/Contents/Resources` (including through the
  `cairn` link), and CI runs the built app outside that folder.
- Git maintenance: the local main branch is never offered for deletion, even when checked out in a linked worktree.
- AI tools restore: a SQLite database missing from the Mac is always restored; a Claude project folder is only
  removed after a successful merge.

### Added
- `cairn restore --tool ID` to choose which AI tools to restore.

## [0.1.0] - 2026-11-08

First public release.

### Added
- Disk usage analysis of tracked folders: explorer, regenerable content (cleaned to the Trash after confirmation),
  large projects (worktrees included), large objects.
- Versioned backups with rsync (`--link-dest`) to a folder, a drive or an SMB NAS, inside an encrypted disk image
  (AES-256); tiered retention, resume of an interrupted backup, integrity check (SHA-256), scheduling while the app is
  open, waiting for an unreachable NAS.
- Backup and restore of AI tools' conversations and configuration (Claude Code, Claude Desktop, Codex) through
  declarative profiles, with consistent copies of SQLite databases.
- Inventory of command-line tools (brew, mise, npm, uv, pipx, cargo, go) and a reinstallable export.
- Git maintenance: gone, merged or squashed branches, stale worktrees, gc; dry run by default and a log of deleted
  SHAs.
- Selective restore (Cairn format and older `backup.sh` backups), including on a new Mac.
- Menu bar extra with a storage summary and disk-full alerts.
- `cairn` command (same binary as the app); interface in English and French.
