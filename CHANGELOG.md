# Changelog

**English** · [Français](CHANGELOG.fr.md)

Every Tako release, newest first. Installers are on the [Releases](https://github.com/OnelightCyber/Tako/releases)
page, and an installed copy updates itself.

## 0.5.0 — October 3, 2026

The biggest update yet: the island becomes a real Dynamic Island, Tako listens and talks back, and several Claudes
work for you at once, even overnight.

### A real Dynamic Island

- **The island stretches like on an iPhone**: volume, Caps Lock, charging and low battery, USB drive plugged in
  (with "Open"), connection lost and back, downloads in progress and finished (Open / Folder).
- **Your Windows notifications** (Discord, WhatsApp, Outlook, Teams…) land in the island with the app's icon, and
  the bell tab keeps them all. Mute an app in one click, or hide the text with private mode.
- **Calls**: when Discord, Teams or Zoom use your microphone, the island shows the call duration. An orange dot for
  the microphone, green for the camera, with the app's name on hover.
- **Today**: the time, date and weather, the whole month and a 5-day forecast.
- **Both sides of the folded island**: date and weather (or what Claude is doing) on the left, the time or your
  notifications on the right.
- **A fuller home view**: weather, Claude usage, voice assistant, date and timer pills.
- **The visualizer follows your PC's real audio**, in the album art's colours.
- **Three island sizes** for large screens.
- **Game mode**: a full-screen terminal or editor no longer counts as a game.

### Jarvis mode

- **"Hey Tako"**: the island opens, the character listens, your words appear as you speak, and Claude answers with
  your own Claude Code account. "Tako, stop" cuts it off.
- **Your voice stays on your PC**: Whisper transcribes locally in about half a second (190 MB model downloaded
  once, SHA-256 checked).
- **Natural voices**: Siwis, Pierre or Jessica (Piper, running locally). The Windows voice is still available.
- **Instant answers, no Claude needed**: time, date, weather, timers ("10 minutes", "1h30", "une heure et demie"),
  pause and next track, your notifications, the settings.
- **Voice approvals** (optional): "Tako, oui" allows, "Tako, non" denies. A "yes" only counts when Tako is sure it
  heard it.
- Music pauses while Tako listens or talks, then resumes. Nothing during a call or a game.

### The Lens

- Copy something and the island suggests what to do with it: an **error** → Explain or Fix (a mission ready to
  start), **English text** → Translate, a **tracking number** → Track, an **address** → Directions.
- The text is read on your PC only to recognise it, nothing leaves without a click, and copies from password
  managers are ignored.

### Mission Control

- **Several Claudes at once** (up to 4), each in its own copy of the project (a git worktree): your folder doesn't
  change until you merge.
- **Review, then merge**: diff and changed lines, one-click **Merge** (Tako checks your branch and rolls everything
  back on a conflict), **Discard** with a confirmation, **Reply** or **Continue** in a terminal.
- **Safety nets**: no mission on a detached HEAD or during a merge or rebase, a damaged copy is never touched, and
  every failed merge is explained.

### The night shift

- Pick "Cette nuit": from the chosen hour (1 a.m. by default) until 7 a.m., Claude works through your tasks. The PC
  stays awake as soon as a task is scheduled.
- **Careful** (edits inside the project copy, tests and builds, everything else denied) or Claude's **auto mode**.
- **Morning briefing**: when you're back, the island opens the night's report and Tako reads it to you.

### A character with a life

- It **dances to your music**, **sweats** when the CPU is maxed out, **falls asleep at night** and **celebrates
  when your tests pass**.

### iPhone-style motion

- Jelly effect, **long press** to open the current activity, **Shift + wheel** (or a touchpad swipe) to switch
  activities, blurred transitions, and a "Reduce motion" setting.

### Settings

- Rebuilt from scratch: one page per module, a "Test" button everywhere and a search. New Voice assistant, Mission
  Control and Lens pages.

### Under the hood

- Chrome only starts when the browser agent is really used.
- Lighter on 144 / 165 Hz screens: at most 60 frames per second (120 while the island moves, 30 at rest), and
  hidden views stop running.
- Model downloads are verified, pinned to a fixed revision, and given up if they stall.
- Before release: a full code review, and 528 interface tests all passing.

## 0.4.0 — October 1, 2026

- **The island splits in two**: when two things are live at once, a bubble detaches like a drop with a gooey
  animation. Click it to open it.
- **Timer and Pomodoro**: focus, break and long break cycles, a ring around the character, an animated alarm, and
  the island stays visible while it runs.
- **Game mode**: nothing opens over a full-screen game or video, the island and the widget hide and let clicks
  through, sounds mute, and a recap waits for you afterwards.
- **Bluetooth**: headphones connecting show up with their battery.
- **VPN watch**: an alert when the tunnel drops, another when it's back, with the Mullvad location.
- The chat can **open your apps** on request, and never closes them.
- The browser agent keeps **its Chrome window open** between messages.
- Review mode lets sessions in auto, accept-edits or bypass mode through, and the live view shows the mode.
- Missions and Claude runs started by Tako no longer inherit the original session's environment.
- The 0.3.0 protections are back: sensitive files are never copied or sent, copies are size-capped per turn, and
  review mode denies edits when Tako is paused or overloaded.

## 0.3.0 — October 1, 2026

- **All your sessions at once**: one pill per Claude Code terminal (red when it waits for you, green when it's
  done), a context ring, and a queue for permission requests.
- **End-of-turn summary**: files, lines added and removed, time and tokens, with **Commit** (message written by
  Claude), **See the diff** and **Undo** from a copy taken before each edit (kept 3 days, sensitive files never
  copied).
- **Review mode** (optional): every edit waits for your OK in the island, with the real diff. No answer, no edit.
- **Missions**: a global shortcut starts Claude Code on a project in a new terminal.
- **Usage**: alerts at 80 and 90 % with a forecast, a sound when the 5-hour limit resets, and a history in the
  settings.
- **Now playing** with artwork and controls, plus live CPU, memory and GPU.
- Fixes: the step ticker no longer overlaps or stalls at 20 steps, new requests are guarded against hasty clicks,
  and nothing runs while the island is hidden.

## 0.2.0 — October 1, 2026

- **Usage widget**: your 5-hour and weekly limits at the top of the screen, details on hover, drag it anywhere with
  snapping, right-click to hide it.
- **/usage** in the chat shows your limits as gauges.
- Chat replies can be selected and copied in one click.
- Settings: rebuilt dropdowns and a widget position picker.
- Fixes: the chat no longer waits for the browser agent, the Ask button works after a file drop, and steps show
  the command's description.

## 0.1.1 — October 1, 2026 — First version

- **Claude Code's live view**: every tool as a step, the diff of every edit with its real line numbers, the file
  being read, the command and the end of its output, the todo plan. The island grows with what it shows.
- **One-click permissions** from the island.
- **A chat with your own Claude Code account** (no API key) that sees your screen, knows the `/` commands and can
  drive a browser, with Allow / Deny every time.
- File drops, integrations (GitHub, Vercel, n8n, Resend, Notion, Cal.com, Stripe), a full settings window and
  signed automatic updates.
