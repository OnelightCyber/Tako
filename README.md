<div align="center">

<img src="docs/banner.png" alt="Tako" width="100%">

<br>

**English** · [Français](README.fr.md)

![Windows 10/11](https://img.shields.io/badge/Windows-10%20%2F%2011-0078D4?style=flat-square&logo=windows&logoColor=white)
![Tauri 2](https://img.shields.io/badge/Tauri-2-24C8DB?style=flat-square&logo=tauri&logoColor=white)
![Rust](https://img.shields.io/badge/Rust-backend-B7410E?style=flat-square&logo=rust&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-no%20framework-3178C6?style=flat-square&logo=typescript&logoColor=white)
![Claude Code](https://img.shields.io/badge/Claude%20Code-hooks%20%2B%20headless-D97757?style=flat-square)
![License MIT](https://img.shields.io/badge/code-MIT-22C55E?style=flat-square)

**A Dynamic Island for Windows that shows what Claude Code is doing — for real, as it happens.**

<img src="docs/demo.gif" alt="Live view demo" width="660">

</div>

---

Claude Code works in a terminal you're not looking at. Tako puts it where you can see it without leaving what
you're doing: every file it reads, **the diff of every edit with its real line numbers**, the command it runs and
**the end of its output**, its todo plan — and permission prompts you answer in one click. The island grows with
what it shows, tucks itself away when you leave, and costs nothing while hidden.

Next to it, a **chat that runs through your own Claude Code account** — no API key — that reads your project,
**looks at your screen when your question is about it**, knows Claude's **`/` commands**, and can turn into an
**agent that drives a real browser**.

## Contents

- [Features](#features)
- [Screenshots](#screenshots)
- [Install](#install)
- [Updates](#updates)
- [Connect Claude Code](#connect-claude-code)
- [Chat, vision and the browser agent](#chat-vision-and-the-browser-agent)
- [Security and guarantees](#security-and-guarantees)
- [Architecture](#architecture)
- [Development](#development)
- [Project layout](#project-layout)
- [Roadmap](#roadmap)
- [License](#license)

---

## Features

### Live view of Claude Code

Every tool call becomes a step, shown for real:

| Tool | What the island shows |
|---|---|
| **Edit / MultiEdit** | The red / green diff with real line numbers and surrounding context, from Claude Code's `structuredPatch`. While the edit is in flight, the new lines type themselves in. |
| **Write** | The new file, or the diff when it replaces one. |
| **Read** | The lines read, syntax-highlighted (TS, JS, Rust, Python, PowerShell, JSON, TOML…). |
| **Bash / PowerShell** | The command, then the end of its output: green when it passes, red when it breaks, a blinking cursor while it runs. |
| **Grep / Glob** | The pattern and the hits, `file:line  text`. |
| **TodoWrite** | Claude's plan as a checklist: done, in progress, to do. |
| **Browser, web, subagents, MCP** | The action, the URL or the query, and the result when it lands. |

On the left, the steps of the current turn — done, running, failed, then *Done*. The panel follows the newest
one; click an older step to bring it back, click again to return to live.

**The island fits its content**, like a Dynamic Island: a long diff or a long output makes it up to 30 % taller,
wide lines of code make it wider, and it springs back once the content is short again.

### Every session at once

Each Claude Code terminal gets its own pill next to the character, with its project name. **Red and pulsing**: it's
waiting for you. **Green**: it's done. Click a pill to bring its live view up; the session that needs you takes the
stage on its own. A small ring shows **how full the context is** (read from the session's own transcript), so you
know when it's time to `/compact`.

### When Claude finishes

A summary card: Claude's last words, the files changed with lines **+added −removed**, how long it took and how many
tokens it used. Three buttons:

- **Commit** — Claude writes the message, you edit it and confirm. Only the files of the turn, your git identity,
  no trailers.
- **See the diff** — the whole turn as one diff in VS Code.
- **Undo** — every file goes back to how it was before the turn, except the ones you touched since. Before each
  edit, Tako keeps a copy of the file on your PC for 3 days.

### Review mode

Optional: every file edit waits for your OK in the island, with the real diff and line numbers — **Approve**,
**Reject**, or approve the rest of the turn. No answer: the edit isn't applied. Tako closed: Claude Code works as
usual.

### Missions

`Alt+Shift+Space` from anywhere (or the rocket tab): type a task, pick the project, and Tako opens Claude Code on it
in a new terminal — then you follow it live from the island.

### One-click permissions

When Claude Code asks for a permission, the island opens with **Deny / Allow** (`N` / `Y`) and the exact command,
file or URL. Nobody answers? Claude Code asks in the terminal, as if Tako weren't there.

### Chat with your Claude Code account

- **No API key**: Tako runs your own official Claude Code in the background, on your subscription.
- **Live**: the answer streams in, and the island shows what Claude is looking at (“Read · hooks.ts”).
- **In your project**: it reads the folder of your current Claude Code session.
- **Screen vision**: when your question is about what you see — an error, a page, a design — Claude takes a
  screenshot on its own and looks at it.
- **`/` commands**: type `/` and Tako suggests Claude Code's commands and skills (`/code-review`, `/simplify`,
  `/usage`, `/context`…), with the keyboard or the mouse.
- **Read-only**: it answers, it never changes anything. One button clears the conversation.

### Browser agent

Turn the agent on and the chat drives a **real browser** (Playwright): it opens sites, reads pages, clicks, fills
forms. The browser **stays open** between messages, with a profile of its own. By default every action that
does something — open a page, click, type, run JavaScript — is asked in the island with the exact URL or text;
**auto mode** lets everything through.

### Usage widget

Your Claude limits, always in sight: a small widget at the top of the screen with a ring for the 5-hour session, one
for the week, and the time left before the reset. Hover it for every limit (all models, per model). **Drag it
anywhere** — it snaps to the top edge and back next to the island — or pick a spot in the settings; a right-click
hides it. Type `/usage` in the chat for the same numbers as a card. They come from your own Claude Code's `/usage`,
refreshed every 4 minutes.

Tako also **warns you at 80 % and 90 %** with the time you'll hit the limit at this pace, plays a sound when your
5-hour limit resets, and keeps a **history** in the settings: use per day, peak per week.

### A real Dynamic Island

- **Now playing**: Spotify, YouTube, Deezer… with the artwork, previous / play / next and a progress bar, and a mini
  equalizer in the compact island.
- **Your PC**: processor, memory and graphics card live, in a pill.

### And also

- **File drops**: drop a file on the island and it lands in the chat. The hidden island wakes up when a file comes
  near the top of the screen.
- **Integrations**: GitHub, Vercel, n8n, Resend, Notion, Cal.com, Stripe — up to 4 pills next to the character,
  keys kept in the Windows Credential Manager.
- **Full settings**: the state of every part, hooks with a diff before anything is written, chat, vision, agent,
  integrations, sounds, behaviour, updates.
- **Out of the way**: compact while Claude works, open on a click, folds itself away, and an option to stay closed
  when Claude finishes — handy while gaming. No taskbar window, no console.

---

## Screenshots

<table>
<tr>
<td width="50%"><img src="docs/screenshots/session-diff.png" alt="Numbered diff"><br><sub>An edit's diff with real line numbers</sub></td>
<td width="50%"><img src="docs/screenshots/session-terminal.png" alt="Terminal"><br><sub>The command and the end of its output — the island grew to fit it</sub></td>
</tr>
<tr>
<td><img src="docs/screenshots/sessions.png" alt="Sessions"><br><sub>Three sessions, context ring, music and PC stats</sub></td>
<td><img src="docs/screenshots/review.png" alt="Review"><br><sub>Review mode: the edit waits for your OK</sub></td>
</tr>
<tr>
<td><img src="docs/screenshots/finished.png" alt="Summary"><br><sub>The turn summary: Commit, diff, Undo</sub></td>
<td><img src="docs/screenshots/music.png" alt="Music"><br><sub>What's playing, with the controls</sub></td>
</tr>
<tr>
<td><img src="docs/screenshots/session-read.png" alt="Read"><br><sub>A file being read, highlighted</sub></td>
<td><img src="docs/screenshots/session-plan.png" alt="Plan"><br><sub>Claude's todo plan</sub></td>
</tr>
<tr>
<td><img src="docs/screenshots/settings-home.png" alt="Settings home"><br><sub>Settings: everything at a glance</sub></td>
<td><img src="docs/screenshots/settings-chat.png" alt="Settings chat"><br><sub>Chat, screen vision and the browser agent</sub></td>
</tr>
<tr>
<td><img src="docs/screenshots/usage-chat.png" alt="/usage in the chat"><br><sub><code>/usage</code> in the chat</sub></td>
<td align="center"><img src="docs/screenshots/usage-widget.png" alt="Usage widget" width="250"><br><sub>The usage widget, hovered</sub></td>
</tr>
<tr>
<td><img src="docs/screenshots/settings-usage.png" alt="Widget settings"><br><sub>Where the widget sits — or drag it</sub></td>
<td><img src="docs/screenshots/settings-integrations.png" alt="Integrations"><br><sub>Integrations</sub></td>
</tr>
</table>

<sub>Screenshots taken with the built-in demos (`?demo`), which replay a made-up session. The settings window is in
French for now.</sub>

---

## Install

You need [Rust](https://rustup.rs), [Node 20+](https://nodejs.org) and the **MSVC Build Tools** (Visual Studio Build
Tools, “Desktop development with C++”). WebView2 ships with Windows 10 / 11. For the API-key-free chat,
[Claude Code](https://code.claude.com) installed and signed in.

```powershell
git clone https://github.com/OnelightCyber/Tako.git
cd Tako
npm install
npm run pack            # the app and its installer, in release/
```

Then either:

- **Without installing**: run `target\release\tako.exe`.
- **With the installer**: `release\Tako-Windows-setup.exe` (per user, no admin rights).

The installer isn't code-signed yet: SmartScreen may warn you. Built from source by you, that's expected.

## Updates

Tako checks GitHub 15 seconds after launch and every 6 hours. When a new version is out, **Settings → About**
offers to install it: download, install and restart happen on their own. Every update is signed, and Tako refuses
anything that doesn't carry the project's signature.

Shipping a version:

```powershell
npm run release 0.2.0
```

The script bumps the version everywhere, creates the `v0.2.0` commit and tag, and pushes them. GitHub Actions then
builds the installer, signs it and publishes the release with its `latest.json` — the file every installed Tako
checks. The signing key stays on the maintainer's machine and in the repository secrets, never in the code.

## Connect Claude Code

Tako icon in the notification area → **Settings… → Claude Code → Install the hooks…**

- The **exact diff** of `%USERPROFILE%\.claude\settings.json` is shown before anything is written.
- A **dated backup** is made next to it (`settings.json.bak-YYYYMMDD-HHMMSS`).
- Your own hooks are never touched; uninstalling removes only Tako's.

The relay, `tako-hook.exe`, is copied to `%LOCALAPPDATA%\Tako\bin\` at every launch. It works from any terminal:
Windows Terminal, PowerShell, VS Code, Git Bash.

---

## Chat, vision and the browser agent

### What Tako runs

```
claude -p --output-format stream-json --verbose --include-partial-messages
       --setting-sources project,local --strict-mcp-config
       --tools Read,Grep,Glob,WebSearch,WebFetch
       --system-prompt "<Tako's short prompt>" [--resume <session>] [--add-dir <folder>]
       [--mcp-config <tako + playwright>] [--settings <agent guard>]
```

- The prompt goes through **stdin**, never through a shell.
- **None of your user settings** (so no hooks echoing back into the island, no plugins), **none of your MCP
  servers**, a short system prompt: about 3.7k tokens for the first message, almost nothing after thanks to the
  cache. It counts against your Claude plan like any Claude Code use.
- Started from your home folder, it runs from a neutral folder and reads your home folder through `--add-dir`, so
  your `~/.claude/settings.json` is never loaded as project settings.

### Screen vision

`tako-hook.exe mcp` is a tiny MCP server with a single tool, `screenshot`. Claude decides on its own to use it when
the question is about what you see. The capture of the main display is scaled to 1568 px (the sweet spot for
Claude's vision) and goes straight to Claude **without ever being written to disk**. It's only taken during a chat
question, never in the background, and can be turned off in the settings.

### Browser agent

Tako starts `@playwright/mcp` as a **local HTTP server that stays up** (`--port`, `--shared-browser-context`) and the
chat connects to it: the browser outlives the end of an answer and stays open between messages. It uses a profile
of its own (`%LOCALAPPDATA%\Tako\browser-profile`), never your Chrome profile, and stops with Tako.

Outside auto mode, every acting action goes through a `PreToolUse` hook: the relay pauses the agent, the island
shows **Allow / Deny** with the exact URL or text, and **no answer means the action is refused**. Reading the page
and taking screenshots never ask.

### Why it's fine

Tako never reads, stores or sends your Claude credentials. [Anthropic's terms](https://code.claude.com/docs/en/legal-and-compliance)
forbid third-party apps from offering their own claude.ai sign-in or collecting session tokens; they don't prevent a
user from signing in **themselves** to the unmodified Claude Code binary with their own subscription. That's
exactly what happens here: everyone uses their own account, on their own machine.

---

## Security and guarantees

- **Claude Code is never blocked or slowed down.** Tako closed, slow or crashed: the relay gives up within 300 ms and
  Claude Code carries on. A relay run fits in 2 s, 110 s when a human has to answer.
- **Silence means business as usual.** No answer to a permission: the terminal takes over.
- **Agent actions fail closed.** No decision, no action.
- **Review mode fails closed while Tako runs**: no answer in time, Tako paused, or too many edits at once — the edit
  is rejected. It covers file edits, not commands. Tako closed: Claude Code applies its own permissions. A Tako
  "allow" never overrides your `permissions.deny` rules.
- **Clicks can't slip**: a permission or a review that just appeared ignores clicks for 0.7 s, so a double-click
  never approves the next one.
- **Undo copies stay on your PC**: before each edit, a copy of the file goes to `%LOCALAPPDATA%\Tako\snapshots` for
  3 days (10 MB per file, 1 GB in total). Sensitive files — `.env`, keys, certificates, `.ssh`, `.aws`… — are never
  copied, and their contents are never sent to Claude to write a commit message, nor committed by the Commit button.
- **`settings.json` is never overwritten**: merge, diff shown, dated backup, written only after your click and only
  if the file hasn't changed since the diff.
- **No permission is granted without an explicit click.**
- **Secrets** live in the Windows Credential Manager (service `dev.tako.island`); the interface can only ask whether
  a key exists.
- **No telemetry.** Network requests only go to the services you set up, and to Claude through your own Claude Code.
- **Nothing is injected as HTML**: code from your files is built node by node, never through `innerHTML`.
- **0 % CPU while hidden**: animations, the cursor poll, music and PC stats stop; only 8 Win32 reads per second watch
  for a file being dragged towards the hidden island.
- **The relay checks who it talks to**: the named pipe is bound to your Windows account (SID) and the server is
  verified before anything is sent. Programs running under your own account are trusted, like everything else they
  can already do as you.

---

## Architecture

```
 Claude Code (any terminal)
        │  hook JSON on stdin, for every event
        ▼
 tako-hook.exe ───────────► 300 ms to connect, otherwise it exits silently
        │  slims the JSON: keeps the diff and the end of outputs; strings ≤ 2,000 chars,
        │  lists ≤ 60, the whole line ≤ 256 KB
        ▼
 \\.\pipe\tako-<SID>         named pipe, same user checked on both ends
        │
        ▼
 Rust · src-tauri/src/pipe.rs ──► "hook" event to the island webview
        │                          permission or agent action: waits for the decision
        ▼
 Island · src/island/hooks.ts
        ├─ src/core/activity.ts   PreToolUse → running step, PostToolUse → real result
        └─ src/views/session.ts   steps + diff / code / terminal / plan, sized to fit

 Chat · src-tauri/src/claude_cli.rs
        claude -p (stream-json) ──► chat-delta / chat-status to the island
          ├─ MCP "tako"          tako-hook.exe mcp → screenshot
          └─ MCP "playwright"    src-tauri/src/browser.rs → persistent local HTTP server

 Usage · src-tauri/src/usage.rs
        claude -p "/usage" every 4 min ──► usage-updated to the widget (src/usage)
```

---

## Development

```powershell
npm run tauri dev       # the whole app, hot reload
npm run dev             # just the interface, in a browser
```

- **Live view demo**: `npm run dev`, then <http://127.0.0.1:1420/?demo> (add `&until=plan|read|edit|diff|shell` to
  stop at a step).
- **Settings demo**: <http://127.0.0.1:1420/settings.html?demo>.
- **README banner**: <http://127.0.0.1:1420/dev/banner.html>.
- **File drop demo**: <http://127.0.0.1:1420/dev/upload-preview.html>.
- **Usage demo**: <http://127.0.0.1:1420/?demo=usage> (the `/usage` card) and
  <http://127.0.0.1:1420/usage.html?open> (the widget).
- **New views**: <http://127.0.0.1:1420/?feature=overview> (also `review`, `finished`, `music`, `system`,
  `mission`, `usage`).
- **Tests**: `cargo test -p tako-hook --release` (relay, agent guard, MCP server) and `cargo test -p tako --lib`
  (hooks, files, sessions, undo and commit on a real repository, `/usage` forecasts and alerts, widget placement,
  media, PC stats).
- **Icons**: `npm run icons` redraws `src-tauri/icons` from `scripts/gen-icons.mjs`.
- **Log**: `%LOCALAPPDATA%\Tako\tako.log` — hook events, decisions, tool result shapes (keys only), drags, browser,
  chat errors. It stays on your machine.

## Project layout

```
src/                      island front end (TypeScript, no framework)
  core/                   state, geometry, animation, sounds, bridge to Rust
    activity.ts           Claude's actions: diffs, outputs, plan
  island/                 state machine, Claude Code hooks, integrations
  views/                  island views
    session.ts            the live view
    chat.ts               the chat and / commands
    fit.ts                island size from its content
    highlight.ts          syntax colouring, plain DOM
    pro-icons.ts          line icons
    brand-logos.ts        integration logos
  mascot/                 the character and the opening animation (Canvas 2D)
    look.ts               the character's shape and colours
  settings/               the settings window
  usage/                  the usage widget
src-tauri/src/            Rust backend
  claude_cli.rs           chat through the user's Claude Code
  usage.rs                Claude Code's /usage, history, forecast, alerts
  widget.rs               the widget window: spots, drag, snap
  sessions.rs             context, turn summary, undo, commit, diff, missions
  media.rs                what's playing (Windows media sessions)
  sysstats.rs             CPU, memory, GPU
  browser.rs              the agent's persistent Playwright server
  updater.rs              signed updates from GitHub releases
  pipe.rs                 named pipe, permissions, agent actions
  hooks.rs                install / uninstall the hooks
  island.rs               window, click-through, cursor, file drops
hook/src/                 tako-hook.exe
  main.rs                 the hook relay
  snapshot.rs             a copy of each file before Claude edits it
  review.rs               the diff shown in review mode
  mcp.rs, screen.rs       the screenshot MCP server
sounds/                   Tako's 28 sounds
dev/                      demos and the banner (never shipped)
docs/                     banner, GIF and screenshots
```

---

## Roadmap

- [x] Live view: steps, real numbered diffs, reads, terminal, plan
- [x] Island that grows with its content
- [x] Chat through the user's Claude Code, no API key
- [x] Screen vision on Claude's own initiative
- [x] Claude Code `/` commands in the chat
- [x] Persistent browser agent with a guard and an auto mode
- [x] Full settings, integration logos, signed auto-updates
- [x] Tako's own character, icon and sounds
- [x] **Usage widget**: the 5-hour and weekly limits on screen, draggable, and `/usage` in the chat
- [x] **Multi-session** with a pill per terminal and a context ring
- [x] **Turn summary** with Commit, diff and Undo, and an optional **review mode**
- [x] **Missions** from a global shortcut
- [x] Limit alerts, forecast and history; music; PC stats
- [ ] English settings window
- [ ] **Game mode**: nothing opens over a full-screen game
- [ ] **Server monitoring**: up / down, CPU, RAM, disk, containers
- [ ] **Session guardrails**: block dangerous commands, flag access to secrets
- [ ] Code-signed installer

---

## License

- **Code**: MIT — see [`LICENSE`](LICENSE).
- **Name, character, icon, sounds and artwork**: all rights reserved — see [`LICENSE-ASSETS.md`](LICENSE-ASSETS.md).
  Forks are welcome with their own name, icon, character and sounds.
- **Third-party material**: see [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

Claude and Claude Code are trademarks of Anthropic. Tako is not made or endorsed by Anthropic.
