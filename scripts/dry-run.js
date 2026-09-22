#!/usr/bin/env node
"use strict";
// Decide without executing: `node scripts/dry-run.js "open spotify" "click the share button"`.
// Targeted commands still look at the page/window to find candidates; they just never click.
const fs = require("node:fs");
const path = require("node:path");

for (const line of fs.readFileSync(path.join(__dirname, "..", ".env"), "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const { decide } = require("../src/runner");

const pct = (p) => (p * 100).toFixed(0).padStart(3) + "%";

(async () => {
  const cmds = process.argv.slice(2);
  if (!cmds.length) { console.error("usage: dry-run.js <command> [<command>...]"); process.exit(1); }
  for (const c of cmds) {
    const t0 = Date.now();
    const d = await decide(c);
    const ms = Date.now() - t0;
    const p = d.plan;
    const args = Object.entries(p.args).filter(([, v]) => v != null).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" ");
    console.log(`\n"${c}"`);
    console.log(`  → ${(d.status === "ready" ? "ACT" : d.status.toUpperCase()).padEnd(8)} ${p.action} ${args}`);
    if (d.status !== "ready") console.log(`    ${d.reason}`);
    console.log(`    conf ${pct(p.confidence)}  risk ${pct(p.risk)}  ${ms} ms  ${d.usage.input_tokens + d.usage.output_tokens} tok${p.candidates ? `  (${p.candidates} targets seen)` : ""}`);
    for (const u of p.used) console.log(`    ${u.q.padEnd(7)} ${pct(u.p)}  ${u.label}`);
    if (d.status !== "ready" && d.alternatives) console.log(`    alternatives  ${d.alternatives.map((a) => `${a.label} ${pct(a.p)}`).join(", ")}`);
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
