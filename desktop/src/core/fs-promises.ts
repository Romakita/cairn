// API `fs/promises` du core, de la CLI et du main : à importer à la place de `node:fs/promises` (le lint l'impose).
// Sous Electron, `original-fs`.promises : voir src/core/fs.ts (fichiers `.asar` vus comme des dossiers par le `fs`
// patché d'Electron).
import type * as NodeFsPromises from "node:fs/promises";
import { fs } from "./fs.ts";

export const fsPromises: typeof NodeFsPromises = fs.promises;

export type { FileHandle } from "node:fs/promises";

export const {
  access,
  appendFile,
  chmod,
  chown,
  constants,
  copyFile,
  cp,
  lchown,
  link,
  lstat,
  lutimes,
  mkdir,
  mkdtemp,
  open,
  opendir,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  statfs,
  symlink,
  truncate,
  unlink,
  utimes,
  watch,
  writeFile,
} = fsPromises;
