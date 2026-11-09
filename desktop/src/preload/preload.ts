import { contextBridge } from "electron";

// API exposée à l'interface : seulement des fonctions métier, jamais ipcRenderer, fs ou shell.
contextBridge.exposeInMainWorld("cairn", {
  platform: process.platform,
});
