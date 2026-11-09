// API `fs` du core, de la CLI et du main : à importer à la place de `node:fs` (le lint l'impose).
//
// Pourquoi : dans le process Electron (main ET ses worker_threads), le `fs` de Node est patché pour lire les archives
// asar comme des dossiers. Un fichier ordinaire nommé `*.asar` (par exemple `resources/app.asar` d'un build Electron
// de l'utilisateur) y est vu comme un dossier de taille 0, ou fait échouer `stat` (« Invalid package »), et
// `open`/`createReadStream` y échouent en EISDIR : empreintes de la sauvegarde, analyse du disque, restauration…
// (validation 2026-11-09). Le module intégré `original-fs` d'Electron donne le comportement normal de Node.
//
// `process.getBuiltinModule` (Node ≥ 22.3, Bun) charge le module sans `require` statique : `bun build` n'a rien à
// résoudre, et le même code marche sous `bun test` (pas d'Electron : `node:fs`). Les fichiers de l'app dans app.asar
// ne passent pas par ici : interface servie par `net.fetch`, preload et worker git chargés par Electron/Node.
import type * as NodeFs from "node:fs";

/** `original-fs` sous Electron (fichiers `.asar` lus comme des fichiers), `node:fs` ailleurs. */
export const fs: typeof NodeFs = process.versions.electron
  ? (process.getBuiltinModule("original-fs") as typeof NodeFs)
  : process.getBuiltinModule("node:fs");

export type {
  BigIntStats,
  Dir,
  Dirent,
  FSWatcher,
  ReadStream,
  Stats,
  StatsFs,
  WriteStream,
} from "node:fs";

export const {
  access,
  accessSync,
  appendFile,
  appendFileSync,
  chmod,
  chmodSync,
  chown,
  chownSync,
  close,
  closeSync,
  constants,
  copyFile,
  copyFileSync,
  cp,
  cpSync,
  createReadStream,
  createWriteStream,
  existsSync,
  fchmod,
  fchmodSync,
  fchown,
  fchownSync,
  fdatasync,
  fdatasyncSync,
  fstat,
  fstatSync,
  fsync,
  fsyncSync,
  ftruncate,
  ftruncateSync,
  futimes,
  futimesSync,
  lchown,
  lchownSync,
  link,
  linkSync,
  lstat,
  lstatSync,
  lutimes,
  lutimesSync,
  mkdir,
  mkdirSync,
  mkdtemp,
  mkdtempSync,
  open,
  openSync,
  opendir,
  opendirSync,
  read,
  readSync,
  readdir,
  readdirSync,
  readFile,
  readFileSync,
  readlink,
  readlinkSync,
  readv,
  readvSync,
  realpath,
  realpathSync,
  rename,
  renameSync,
  rm,
  rmSync,
  rmdir,
  rmdirSync,
  stat,
  statSync,
  statfs,
  statfsSync,
  symlink,
  symlinkSync,
  truncate,
  truncateSync,
  unlink,
  unlinkSync,
  unwatchFile,
  utimes,
  utimesSync,
  watch,
  watchFile,
  write,
  writeSync,
  writeFile,
  writeFileSync,
  writev,
  writevSync,
} = fs;
