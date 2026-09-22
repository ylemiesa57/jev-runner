"use strict";
// Chrome, through browser-harness. Every call is one CLI invocation with a Python script on stdin;
// the script prints one line starting with @@JSON@@ that we parse. The harness keeps its own
// attached tab, which is not necessarily the tab the user is looking at, so target enumeration
// first resolves Chrome's visible tab and attaches to it.
const { execFile, spawn } = require("node:child_process");
const { promisify } = require("node:util");
const path = require("node:path");

const exec = promisify(execFile);
const HARNESS = process.env.BROWSER_HARNESS || path.join(process.env.HOME || "", ".local", "bin", "browser-harness");
const SENTINEL = "@@JSON@@";

// Roles worth offering as click targets, in the order we prefer to show them.
const CLICK_ROLES = ["button", "link", "tab", "menuitem", "checkbox", "radio", "switch", "option", "textbox", "searchbox", "combobox"];
const FIELD_ROLES = ["textbox", "searchbox", "combobox"];
const MAX_TARGETS = 60;

function py(script, timeout = 25000) {
  return new Promise((resolve, reject) => {
    const child = spawn(HARNESS, [], { env: { ...process.env, BH_TAB_MARKER: "0" } });
    let out = "", err = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("browser-harness timed out")); }, timeout);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => { clearTimeout(timer); reject(new Error(`browser-harness not runnable at ${HARNESS}: ${e.message}`)); });
    child.on("close", () => {
      clearTimeout(timer);
      const line = out.split("\n").find((l) => l.startsWith(SENTINEL));
      if (!line) return reject(new Error("browser-harness: " + (err.trim() || out.trim() || "no output").slice(-400)));
      resolve(JSON.parse(line.slice(SENTINEL.length)));
    });
    child.stdin.end(script);
  });
}

// What the user is actually looking at in Chrome, or null if Chrome has no window.
async function visibleTab() {
  try {
    const { stdout } = await exec("osascript", ["-e", 'tell application "Google Chrome" to get URL of active tab of front window & linefeed & title of active tab of front window'], { timeout: 3000 });
    const [url, ...title] = stdout.trim().split("\n");
    return url ? { url, title: title.join("\n") } : null;
  } catch {
    return null;
  }
}

const ATTACH = (url) => `
import json
_vis = ${JSON.stringify(url || "")}
_tabs = list_tabs()
_m = next((t for t in _tabs if t["url"] == _vis), None) or next((t for t in _tabs if t["url"].split("#")[0] == _vis.split("#")[0]), None)
if _m: switch_tab(_m["targetId"])
else: ensure_real_tab()
`;

async function targets({ fields = false } = {}) {
  const vis = await visibleTab();
  const roles = fields ? FIELD_ROLES : CLICK_ROLES;
  const r = await py(`${ATTACH(vis && vis.url)}
info = page_info()
ROLES = ${JSON.stringify(roles)}
rank = {r: i for i, r in enumerate(ROLES)}
out, seen = [], set()
for n in cdp("Accessibility.getFullAXTree")["nodes"]:
    if n.get("ignored"): continue
    role = (n.get("role") or {}).get("value")
    name = ((n.get("name") or {}).get("value") or "").strip()
    if role not in rank or not name or "backendDOMNodeId" not in n: continue
    key = (role, name.lower())
    if key in seen: continue
    seen.add(key); out.append({"id": n["backendDOMNodeId"], "role": role, "name": name[:70]})
out.sort(key=lambda t: rank[t["role"]])
print("${SENTINEL}" + json.dumps({"tab": {"url": info.get("url"), "title": info.get("title")}, "targets": out[:${MAX_TARGETS}]}))
`);
  return r;
}

const CENTER = (id) => `
_id = ${id}
def _center():
    q = cdp("DOM.getBoxModel", backendNodeId=_id)["model"]["content"]
    return sum(q[0::2]) / 4, sum(q[1::2]) / 4
x, y = _center()
_vp = cdp("Page.getLayoutMetrics")["cssVisualViewport"]
if x < 0 or y < 0 or x > _vp["clientWidth"] or y > _vp["clientHeight"]:
    cdp("DOM.scrollIntoViewIfNeeded", backendNodeId=_id); wait(0.2); x, y = _center()
`;

async function click(target) {
  const vis = await visibleTab();
  return py(`${ATTACH(vis && vis.url)}${CENTER(target.id)}
click_at_xy(x, y); wait(0.6)
info = page_info()
print("${SENTINEL}" + json.dumps({"x": round(x), "y": round(y), "url": info.get("url"), "title": info.get("title")}))
`);
}

async function type(target, text) {
  const vis = await visibleTab();
  return py(`${ATTACH(vis && vis.url)}${CENTER(target.id)}
click_at_xy(x, y); wait(0.2)
type_text(${JSON.stringify(text)}); wait(0.2)
print("${SENTINEL}" + json.dumps({"x": round(x), "y": round(y)}))
`);
}

module.exports = { visibleTab, targets, click, type, HARNESS };
