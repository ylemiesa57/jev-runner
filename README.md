# Jev Runner

A text field and a Run button. Type what you want done on this Mac; Jev decides what
you meant; code does it.

## New here? Install it with Claude Code

You need a Mac, Google Chrome, a free [TypeSafe](https://console.typesafe.ai) account for
an API key, and [Claude Code](https://claude.com/claude-code) open in a terminal. Then:

**1. Paste this into Claude Code:**

```
Install Jev Runner from https://github.com/ylemiesa57/jev-runner.
Download the latest-release binary for my Mac (jev-runner-setup-darwin-arm64 on Apple
silicon, -amd64 on Intel) into ~/.local/bin/jev-runner-setup using curl — not a browser,
so Gatekeeper doesn't quarantine it — and make it executable. Don't run the installer
yourself: I'll run it so I can type my TypeSafe API key privately. Tell me when it's
ready, and afterwards run `jev-runner-setup doctor`, fix anything it flags, and launch
the app with `jev-runner`.
```

**2. When Claude says it's ready, type this in Claude Code** (the `!` runs it in your own
terminal, so the key prompt is hidden and never enters the conversation):

```
! ~/.local/bin/jev-runner-setup install
```

It finds or downloads Node, unpacks the app, asks for your TypeSafe key and checks it
against the API, installs browser-harness, and connects to Chrome. Two things it may ask
you to do by hand, once: tick the box at `chrome://inspect/#remote-debugging` in Chrome,
and grant Accessibility to your terminal (System Settings → Privacy & Security) if you
want it to click and type in native Mac apps.

**3. Type `jev-runner`** — a small window with a text field appears. Try
`open spotify`, `search for cnc quoting software in chrome`, or, with a page open,
`click the sign in link`.

Don't have Claude Code? The same thing without it:
`curl -fsSL https://raw.githubusercontent.com/ylemiesa57/jev-runner/main/install.sh | sh`

## Install (single binary)

```
./scripts/build-installer.sh          # needs Go; writes dist/jev-runner-setup-darwin-{arm64,amd64}
dist/jev-runner-setup                 # interactive install → ~/.jev-runner/app
jev-runner                            # launch (launcher goes in ~/.local/bin)
```

The installer embeds the app and sets up everything around it:

| step | what it does |
|---|---|
| Node.js | finds Node 20+ on PATH / `~/.local/node`, or downloads the current LTS there |
| App | unpacks `src/`, `package.json`, `scripts/` to `--app-dir` (keeps `.env` and `node_modules`), runs `npm install` |
| TypeSafe | takes the key from `--typesafe-key`, `$TYPESAFE_API_KEY`, an existing `.env`, or a hidden prompt; **validates it with a real call** before writing `.env` (mode 600) |
| browser-harness | finds it, or `uv tool install --python 3.12 browser-harness` (offers to install uv first); then makes one live call to Chrome and, if that fails, walks you through `chrome://inspect/#remote-debugging` |
| Launcher | writes `~/.local/bin/jev-runner` |

`jev-runner-setup doctor` re-checks every step without changing anything; `jev-runner-setup run`
launches; `--yes` makes install non-interactive (`--typesafe-key` or `$TYPESAFE_API_KEY` then
required). Source is in `cmd/jev-runner-setup/`, stdlib only.

**Building it needs Go.** Users of the app don't — the release ships binaries. The required
version is the `go` directive in `go.mod` (currently 1.22); `scripts/build-installer.sh` and the
release workflow both check the installed Go's major *and* minor against it and refuse to build
with anything older. To get Go: the macOS `.pkg` from [go.dev/dl](https://go.dev/dl/) (recommended),
`brew install go`, or unpack the tarball into `~/.local/go`.

## Develop

```
npm start
```

The API key lives in `.env` (`TYPESAFE_API_KEY=…`), which is gitignored.

## How a command becomes an action

1. **Observe.** Frontmost app, front window title, installed apps.
2. **Find candidates.** Regex and list-matching in `src/runner.js` pull every plausible
   app name, URL, search query and quoted string out of the command. They are tuned to
   over-find; that is fine, because
3. **One Jev request** (`judge()`) asks, over the same state and in parallel:
   - `action` — *choice* among `open_app`, `web_search`, `open_url`, `browser_click`,
     `browser_type`, `click`, `type_text`, `screenshot`, `none`
   - `app` / `url` / `query` / `text` — one *choice* each over the candidates found in
     step 2, always with a `none` escape hatch. These are speculative: every branch's
     arguments are asked up front, and code reads only the chosen branch's.
   - `risky` — *noul*: could carrying this out send, delete, spend, or type somewhere
     it would be acted on?
4. **Targeted actions take a second request.** For `browser_click`, `browser_type` and
   `click`, the candidates are the *named elements on screen*, which do not exist until
   code has looked. `resolveTarget()` enumerates them — the Chrome page's accessibility
   tree through [browser-harness](https://github.com/browser-use/browser-harness)
   (`src/browser.js`), or the frontmost window's buttons and menu bar through System
   Events (`src/native.js`) — and asks one more *choice* (`target`, with `none`) plus a
   second `risky` *noul* now that the target list is known. Risk is the max of the two.
   Chrome's *visible* tab is resolved first and the harness attached to it, so the click
   lands on the page you are looking at, not whichever tab the harness last used.
5. **Plan** (`plan()`) consumes the chosen branch. Confidence is the **minimum**
   probability across the judgments actually used — one wrong argument spoils the call,
   so it is not a product.
6. **Policy lives in code**, not in the model:
   - `action == none` or a required argument missing → declined
   - confidence < 0.5 → *unsure*; the UI shows the runner-up actions
   - risk > 0.5 → *confirm*; press Run again with the same text to proceed
   - otherwise → run the executor in `src/actions.js`

Jev never generates a value. Whatever reaches an executor is a string code already found
in the command, copied unchanged. A browser mentioned alongside a search or URL
(`…in chrome`) is consumed from the speculative `app` answer.

## Trying it without side effects

```
node scripts/dry-run.js "open spotify" "take a screenshot" "delete everything"
```

prints the plan, confidence, risk and candidates for each command and executes nothing.

## Actions

| action | what it does | how the target is chosen |
|---|---|---|
| `open_app` | `open -a` | Jev picks from installed apps mentioned in the command |
| `web_search` | Google in the default or named browser | query candidates from the command |
| `open_url` | `open` a URL, optionally in a named browser | URL candidates from the command |
| `browser_click` | click an element on the visible Chrome page | Jev picks from the page's named buttons/links/tabs/fields (AX tree, ≤60) |
| `browser_type` | click a field on the page, then type | field candidates from the AX tree; text from the command |
| `click` | click a button or menu-bar item of the frontmost Mac app | Jev picks from the front window's buttons + menu bar |
| `type_text` | keystrokes into whatever is in front | text from the command |
| `screenshot` | `screencapture` to `~/Desktop` | — |

There are no pixel-coordinate clicks. Jev only ever selects a *named* element code has
already found; code then computes where it is and clicks there.

## Permissions

- Reading the frontmost window title, **native clicking** and **typing** use System
  Events. Grant Accessibility to the app that launched Jev Runner (Terminal, iTerm, or
  the packaged app) under System Settings → Privacy & Security → Accessibility. Without
  it the runner still works; it just cannot see window titles, click natively, or type.
- **Page actions** need `browser-harness` (`~/.local/bin/browser-harness`, or set
  `BROWSER_HARNESS`) and Chrome with remote debugging enabled once at
  `chrome://inspect/#remote-debugging`. If the harness reports a permission sheet,
  run `browser-harness mac-approve`.
- Screenshots go to `~/Desktop/jev-<timestamp>.png`.

## Extending

Add an executor to `src/actions.js`, a one-line description to `ACTIONS` in
`src/runner.js`, and — if it takes an argument — a finder that over-finds candidates for
it and a `pick()` line in `judge()`. Thresholds are the two constants at the top of
`src/runner.js`; changing them does not change what Jev is asked.
