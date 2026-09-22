"use strict";
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

// Load .env without a dependency. Existing environment wins.
try {
  for (const line of fs.readFileSync(path.join(__dirname, "..", ".env"), "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch { /* no .env; TYPESAFE_API_KEY may be in the environment already */ }

const { run } = require("./runner");

// The renderer sends the same text twice to confirm a risky action; remember what it last saw.
let pendingConfirm = null;

ipcMain.handle("run", async (_e, text) => {
  const command = String(text || "").trim();
  if (!command) return { status: "declined", reason: "Type a command first." };
  const confirmed = pendingConfirm === command;
  try {
    const result = await run(command, { confirmed });
    pendingConfirm = result.status === "confirm" ? command : null;
    return result;
  } catch (e) {
    pendingConfirm = null;
    return { status: "error", reason: e.message };
  }
});

function createWindow() {
  const win = new BrowserWindow({
    width: 560,
    height: 300,
    minWidth: 420,
    minHeight: 200,
    title: "Jev Runner",
    titleBarStyle: "hiddenInset",
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false },
  });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
}

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
