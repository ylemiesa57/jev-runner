"use strict";
// Executors. Each takes the typed args `plan()` produced and returns a one-line description of what it did.
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const path = require("node:path");
const os = require("node:os");

const exec = promisify(execFile);
const browser = require("./browser");
const native = require("./native");

function withScheme(url) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`;
}

module.exports = {
  async open_app({ app }) {
    await exec("open", ["-a", app]);
    return `Opened ${app}`;
  },

  async open_url({ url, browser }) {
    const full = withScheme(url);
    await exec("open", browser ? ["-a", browser, full] : [full]);
    return `Opened ${full}${browser ? ` in ${browser}` : ""}`;
  },

  async web_search({ query, browser }) {
    const full = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
    await exec("open", browser ? ["-a", browser, full] : [full]);
    return `Searched for “${query}”${browser ? ` in ${browser}` : ""}`;
  },

  async type_text({ text }) {
    // Needs Accessibility permission for the app that launched this (Electron / Terminal).
    const escaped = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    try {
      await exec("osascript", ["-e", `tell application "System Events" to keystroke "${escaped}"`]);
    } catch (e) {
      throw new Error("Typing needs Accessibility permission: System Settings → Privacy & Security → Accessibility → enable this app. " + (e.stderr || ""));
    }
    return `Typed “${text}” into the frontmost app`;
  },

  // Targeted actions get the element Jev picked (resolved in stage 2) as the second argument.
  async browser_click(_args, target) {
    const r = await browser.click(target);
    return `Clicked ${target.role} “${target.name}” at (${r.x}, ${r.y})${r.title ? ` — now on “${r.title.replace(/^🐴 /, "")}”` : ""}`;
  },

  async browser_type({ text }, target) {
    await browser.type(target, text);
    return `Typed “${text}” into ${target.role} “${target.name}”`;
  },

  async click(_args, target) {
    await native.click(target);
    return `Clicked ${target.role === "menu" ? "menu" : "button"} “${target.name}”`;
  },

  async screenshot() {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const file = path.join(os.homedir(), "Desktop", `jev-${stamp}.png`);
    await exec("screencapture", ["-x", file]);
    return `Saved screenshot to ${file}`;
  },
};
