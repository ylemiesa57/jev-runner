"use strict";
// The pipeline: observe → find candidates → one Jev request → (maybe a second, for a target) → policy → act.
//
// Jev never generates a value. Code finds every plausible app name, URL, query and literal
// string in the command (tuned to over-find); Jev picks which one the user meant, or "none".
// For clicking, the candidates are the named elements code can see on the page or window,
// which do not exist until code has looked — so those actions take a second, targeted request.

const { TypeSafeClient, choice, noul } = require("@typesafe-ai/sdk");
const observe = require("./observe");
const actions = require("./actions");
const browser = require("./browser");
const native = require("./native");

const NONE = "none";
const CONFIDENCE_FLOOR = 0.5; // below this, ask instead of act
const RISK_GATE = 0.5;        // above this, require a second Run to confirm

const BROWSERS = new Set(["Safari", "Google Chrome", "Arc", "Firefox", "Brave Browser", "Microsoft Edge"]);
const TARGETED = new Set(["browser_click", "browser_type", "click"]);

const ACTIONS = {
  open_app: "Launch, or switch to, an application installed on this Mac. The command names the app and asks for nothing else.",
  web_search: "Look something up on the web. The command says what to search for; it may also name which browser to use.",
  open_url: "Open one specific web address. The command contains the address itself, not a description of what to find.",
  browser_click: "Click something on the web page currently open in Google Chrome: a button, link, tab, menu item, or checkbox the command names or describes.",
  browser_type: "Type text into a field on the web page currently open in Google Chrome. The command gives the text and names or describes the field.",
  click: "Click a button or menu-bar item of the frontmost Mac application itself — not something inside a web page.",
  type_text: "Type a literal piece of text into whatever application is in front, as if on the keyboard, without naming a particular field.",
  screenshot: "Capture what is on the screen right now to an image file.",
  [NONE]: "None of these. The command asks for something this runner has no action for, or is not a command at all.",
};

let client;
function getClient() {
  if (!process.env.TYPESAFE_API_KEY) throw new Error("TYPESAFE_API_KEY is not set (put it in .env)");
  return (client ??= new TypeSafeClient({ defaultModel: "jev-latest" }));
}

// Candidate finders. Each should return more than it needs to; Jev narrows.
function findApps(text, installed) {
  const t = text.toLowerCase();
  const hits = installed.filter((app) => {
    const name = app.toLowerCase();
    if (t.includes(name)) return true;
    return name.split(/[\s.]+/).some((w) => w.length >= 4 && t.includes(w));
  });
  const aliases = { chrome: "Google Chrome", vscode: "Visual Studio Code", "vs code": "Visual Studio Code", code: "Visual Studio Code", term: "Terminal" };
  for (const [alias, app] of Object.entries(aliases)) {
    if (new RegExp(`\\b${alias}\\b`).test(t) && installed.includes(app)) hits.push(app);
  }
  return [...new Set(hits)];
}

function findUrls(text) {
  const re = /\b(?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s"']*)?/gi;
  return [...new Set((text.match(re) || []).map((u) => u.replace(/[.,;:)]+$/, "")))];
}

function findQuoted(text) {
  const out = [];
  for (const m of text.matchAll(/["“]([^"”]+)["”]|'([^']+)'/g)) out.push(m[1] ?? m[2]);
  const after = text.match(/\b(?:type|write|enter|say)\s+(.+?)(?:\s+(?:in|into)\s+(?:the\s+)?[\w\s-]+(?:field|box|bar|input|search))?$/i);
  if (after) out.push(after[1].trim().replace(/^["“']|["”']$/g, ""));
  return [...new Set(out)].filter(Boolean);
}

function findQueries(text, apps) {
  const out = [];
  const lead = text.match(/\b(?:search(?: the web)?(?: for)?|google|look up|find|lookup)\s+(.+)$/i);
  if (lead) out.push(lead[1].trim());
  let stripped = text;
  for (const a of apps) stripped = stripped.replace(new RegExp(a, "i"), "");
  stripped = stripped.replace(/\b(?:open|launch|start|in|on|with|and|then|please|go to)\b/gi, " ").replace(/\s+/g, " ").trim();
  if (stripped && stripped.length > 2) out.push(stripped);
  return [...new Set(out.map((q) => q.replace(/[.?!]+$/, "")))].filter(Boolean);
}

// A choice over found candidates with the escape hatch the cookbook insists on.
function pick(question, labels) {
  const criteria = Object.fromEntries(labels.map((c) => [c, null]));
  criteria[NONE] = "None of these is what the command refers to.";
  return choice(question, criteria);
}

// Stage 1: route, and speculatively fill every branch's arguments from candidates already found.
async function judge(command) {
  const env = await observe();
  const cands = {
    apps: findApps(command, env.installedApps),
    urls: findUrls(command),
    texts: findQuoted(command),
  };
  cands.queries = findQueries(command, cands.apps);

  const chromeTab = await browser.visibleTab(); // cheap (~0.1 s); null when Chrome has no window
  const state = {
    command,
    frontmost_app: env.frontmostApp,
    front_window_title: env.windowTitle,
    chrome_visible_tab: chromeTab,
    candidates: cands,
  };

  const questions = {
    action: choice(
      "The user typed `command` into a launcher on their Mac. `frontmost_app` and `front_window_title` describe the window in front right now. `chrome_visible_tab` is the web page open in Google Chrome, which may be behind other windows; when the command talks about “the page”, “the site”, a link, or something on a website, it means that page even if Chrome is not in front. Which action carries out the command?",
      ACTIONS,
    ),
    risky: noul(
      "Could carrying out `command` literally, right now, send a message, delete or overwrite something, spend money, submit a form, or type into a terminal, password field, or chat box where the text would be acted on?",
      { true: "Yes: the effect would be hard to undo or would reach another person or system.", false: "No: it only opens, shows, selects, or searches for something." },
    ),
  };
  if (cands.apps.length) questions.app = pick("Which application in `candidates.apps` does `command` refer to?", cands.apps);
  if (cands.urls.length) questions.url = pick("Which entry in `candidates.urls` is the address `command` wants opened?", cands.urls);
  if (cands.queries.length) questions.query = pick("Which entry in `candidates.queries` is the thing `command` wants looked up, exactly as the user would want it searched?", cands.queries);
  if (cands.texts.length) questions.text = pick("Which entry in `candidates.texts` is the literal text `command` wants typed?", cands.texts);

  const { answers, usage } = await getClient().systemOne({ state, questions });
  return { env, cands, state, answers, usage };
}

// Read only the answers the chosen action needs. Confidence is the *least* certain of them —
// one wrong argument is enough to spoil the call, so it is a min, not a product.
function plan({ answers }) {
  const action = answers.action.choice;
  const used = [{ q: "action", label: action, p: answers.action.probabilities[action] }];
  const arg = (name) => {
    const a = answers[name];
    if (!a || a.choice === NONE) return null;
    used.push({ q: name, label: a.choice, p: a.probabilities[a.choice] });
    return a.choice;
  };
  const browserArg = () => {
    const app = answers.app && answers.app.choice !== NONE ? answers.app.choice : null;
    if (app && BROWSERS.has(app)) { used.push({ q: "app", label: app, p: answers.app.probabilities[app] }); return app; }
    return null;
  };

  const args = {};
  const required = [];
  switch (action) {
    case "open_app": args.app = arg("app"); required.push("app"); break;
    case "web_search": args.query = arg("query"); args.browser = browserArg(); required.push("query"); break;
    case "open_url": args.url = arg("url"); args.browser = browserArg(); required.push("url"); break;
    case "type_text": args.text = arg("text"); required.push("text"); break;
    case "browser_type": args.text = arg("text"); required.push("text"); break; // target comes in stage 2
  }

  const missing = required.filter((k) => args[k] == null);
  return { action, args, used, missing, confidence: Math.min(...used.map((u) => u.p)), risk: answers.risky.noul, usage: null };
}

// Stage 2, only for targeted actions: look at the page or window, then ask which named element is meant.
async function resolveTarget(command, p, state) {
  const wantFields = p.action === "browser_type";
  const seen = p.action === "click" ? await native.targets() : await browser.targets({ fields: wantFields });
  const list = seen.targets;
  if (!list.length) return { error: p.action === "click" ? `Nothing clickable in ${seen.app}'s front window.` : "No named elements found on the page." };

  const label = (t) => `${t.role}: ${t.name}`;
  const byLabel = new Map(list.map((t) => [label(t), t]));
  const where = p.action === "click" ? { frontmost_app: seen.app } : { chrome_tab: seen.tab };
  const noun = wantFields ? "field" : "element";

  const { answers, usage } = await getClient().systemOne({
    state: { command, ...where, [`${noun}s_on_screen`]: [...byLabel.keys()] },
    questions: {
      target: pick(`Which entry in \`${noun}s_on_screen\` is the ${noun} that \`command\` refers to? Match by meaning, not just wording — “sign in” can mean a button labelled “Log in”.`, [...byLabel.keys()]),
      risky: noul(
        `Would acting on the ${noun} that \`command\` refers to submit, send, delete, pay, sign out, or otherwise commit something that is hard to undo?`,
        { true: "Yes: it commits or destroys something.", false: "No: it navigates, opens, selects, reveals, or focuses something." },
      ),
    },
  });

  const a = answers.target;
  if (a.choice === NONE) return { error: `None of the ${list.length} ${noun}s on screen matches “${command}”.`, usage, alternatives: topN(a.probabilities, 3) };
  return {
    target: byLabel.get(a.choice),
    used: { q: "target", label: a.choice, p: a.probabilities[a.choice] },
    risk: answers.risky.noul,
    usage,
    candidates: list.length,
  };
}

function topN(probabilities, n) {
  return Object.entries(probabilities).sort((a, b) => b[1] - a[1]).slice(0, n).map(([label, p]) => ({ label, p }));
}

// Everything up to (not including) execution. dry-run.js uses this.
async function decide(command) {
  const j = await judge(command);
  const p = plan(j);
  const usage = { ...j.usage };
  let alternatives = topN(j.answers.action.probabilities, 3);
  const base = () => ({ command, plan: p, alternatives, observed: { frontmostApp: j.env.frontmostApp, windowTitle: j.env.windowTitle, chromeTab: j.state.chrome_visible_tab }, candidates: j.cands, usage });

  if (p.action === NONE) return { ...base(), status: "declined", reason: "No action here fits that command." };
  if (p.missing.length) return { ...base(), status: "declined", reason: `Could not find a ${p.missing.join(", ")} in the command to use.` };
  if (p.confidence < CONFIDENCE_FLOOR) return { ...base(), status: "unsure", reason: `Only ${(p.confidence * 100).toFixed(0)}% sure. Rephrase, or see alternatives.` };

  if (TARGETED.has(p.action)) {
    const r = await resolveTarget(command, p, j.state);
    if (r.usage) { usage.input_tokens += r.usage.input_tokens; usage.output_tokens += r.usage.output_tokens; }
    if (r.error) { if (r.alternatives) alternatives = r.alternatives; return { ...base(), status: "declined", reason: r.error }; }
    p.args.target = `${r.target.role}: ${r.target.name}`;
    p.resolved = r.target;
    p.used.push(r.used);
    p.confidence = Math.min(p.confidence, r.used.p);
    p.risk = Math.max(p.risk, r.risk);
    p.candidates = r.candidates;
    if (p.confidence < CONFIDENCE_FLOOR) return { ...base(), status: "unsure", reason: `Only ${(p.confidence * 100).toFixed(0)}% sure which of ${r.candidates} elements you mean.` };
  }

  if (p.risk > RISK_GATE) return { ...base(), status: "confirm", reason: `This looks like it could have side effects (${(p.risk * 100).toFixed(0)}%). Press Run again to confirm.` };
  return { ...base(), status: "ready" };
}

async function run(command, { confirmed = false } = {}) {
  const d = await decide(command);
  if (d.status === "confirm" && confirmed) d.status = "ready";
  if (d.status !== "ready") return d;
  const did = await actions[d.plan.action](d.plan.args, d.plan.resolved);
  return { ...d, status: "done", did };
}

module.exports = { run, decide, judge, plan, ACTIONS, NONE };
