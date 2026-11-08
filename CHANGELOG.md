# Changelog

All notable changes to Cairn. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
versions follow [SemVer](https://semver.org/). The current version is in `Cairn/VERSION`.

## [Unreleased]

## [0.2.0] - 2026-11-08

### Added
- In-app updates, like Codex: when a new release is published, an **Update available** button appears at the bottom
  of the icon bar. It shows the release notes and offers **Install and relaunch**: the archive is checked against its
  SHA-256, and the previous app is put back if the swap fails. **Check for Updates…** menu item, and an
  `[updates] check` setting to turn off the automatic check.

### Changed
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
