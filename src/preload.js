"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("jev", {
  run: (text) => ipcRenderer.invoke("run", text),
});
