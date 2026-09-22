"use strict";
// What code can see about the machine before asking Jev anything.
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const fs = require("node:fs/promises");
const path = require("node:path");

const exec = promisify(execFile);

const APP_DIRS = ["/Applications", "/System/Applications", "/System/Applications/Utilities", path.join(process.env.HOME || "", "Applications")];

let appCache = null;
async function installedApps() {
  if (appCache) return appCache;
  const names = new Set();
  for (const dir of APP_DIRS) {
    try {
      for (const f of await fs.readdir(dir)) if (f.endsWith(".app")) names.add(f.slice(0, -4));
    } catch { /* dir may not exist */ }
  }
  return (appCache = [...names].sort());
}

async function osa(script) {
  try {
    const { stdout } = await exec("osascript", ["-e", script], { timeout: 3000 });
    return stdout.trim();
  } catch {
    return null; // no Accessibility permission, or nothing frontmost
  }
}

module.exports = async function observe() {
  const [apps, frontmostApp, windowTitle] = await Promise.all([
    installedApps(),
    osa('tell application "System Events" to get name of first application process whose frontmost is true'),
    osa('tell application "System Events" to tell (first application process whose frontmost is true) to get name of front window'),
  ]);
  return { installedApps: apps, frontmostApp, windowTitle };
};
