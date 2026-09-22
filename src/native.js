"use strict";
// Native macOS UI through System Events. Needs Accessibility permission for whatever launched us.
// Targets are the front window's buttons (one level of groups deep) and the menu bar; that is
// shallow on purpose — a full `entire contents` walk takes seconds on a busy window.
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const exec = promisify(execFile);

async function osa(script, timeout = 8000) {
  const { stdout } = await exec("osascript", ["-e", script], { timeout });
  return stdout.trim();
}

const ENUMERATE = `
tell application "System Events"
  set p to first application process whose frontmost is true
  set out to {}
  tell p
    try
      set w to window 1
      repeat with b in (every button of w)
        try
          set d to description of b
          if d is missing value or d is "" then set d to name of b
          if d is not missing value and d is not "" then set end of out to ("button" & tab & d)
        end try
      end repeat
      repeat with g in (every group of w)
        repeat with b in (every button of g)
          try
            set d to description of b
            if d is not missing value and d is not "" then set end of out to ("button" & tab & d)
          end try
        end repeat
      end repeat
    end try
    try
      repeat with m in (every menu bar item of menu bar 1)
        set end of out to ("menu" & tab & (name of m))
      end repeat
    end try
  end tell
  set AppleScript's text item delimiters to linefeed
  return (name of p) & linefeed & (out as text)
end tell`;

async function targets() {
  let raw;
  try { raw = await osa(ENUMERATE); }
  catch (e) { throw new Error("Could not read the frontmost window. Native clicking needs Accessibility permission for the app that launched Jev Runner. " + (e.stderr || "").trim()); }
  const [app, ...lines] = raw.split("\n");
  const seen = new Set(), out = [];
  for (const line of lines) {
    const [role, name] = line.split("\t");
    if (!name || seen.has(role + name)) continue;
    seen.add(role + name);
    out.push({ role, name: name.slice(0, 70) });
  }
  return { app, targets: out };
}

const q = (s) => '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';

async function click(target) {
  const script = target.role === "menu"
    ? `tell application "System Events" to tell (first application process whose frontmost is true) to click menu bar item ${q(target.name)} of menu bar 1`
    : `tell application "System Events"
  tell (first application process whose frontmost is true)
    set w to window 1
    repeat with b in (every button of w)
      try
        if (description of b is ${q(target.name)}) or (name of b is ${q(target.name)}) then
          click b
          return "ok"
        end if
      end try
    end repeat
    repeat with g in (every group of w)
      repeat with b in (every button of g)
        try
          if description of b is ${q(target.name)} then
            click b
            return "ok"
          end if
        end try
      end repeat
    end repeat
    error "button not found any more"
  end tell
end tell`;
  await osa(script);
}

module.exports = { targets, click };
