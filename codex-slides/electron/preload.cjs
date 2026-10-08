const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("codexSlidesDesktop", Object.freeze({
  platform: process.platform,
  isDesktop: true,
  copyText: (value) => ipcRenderer.invoke("codex-slides:copy-text", value),
}));
