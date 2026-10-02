import { Tracked, Spring, clamp } from "../core/anim";
import { Bridge, IS_TAURI } from "../core/bridge";
import {
  COMPACT_W, EXPANDED_CORNER, EXPANDED_W, NOTCH_H, NOTCH_W, PANEL_H, PANEL_W,
  ROUNDED_CORNER, VIEW_LAYOUTS, botGlowColor, botGlowOpacity, botPosition, chatPromptHeight,
  islandSize,
  type IslandMode, type IslandViewName,
} from "../core/layout";
import { Hud, type HudSpec } from "../core/hud";
import { Sound } from "../core/sound";
import { PLACEHOLDER_ID, State } from "../core/state";
import { BotEngine, hexToRGB, type VoiceMood } from "../mascot/engine";
import { Greeting } from "../mascot/greeting";
import { createMiniBot, pruneMiniBots, syncMiniBotStates, tickMiniBots } from "../mascot/minibots";
import { UploadCanvas } from "../upload/canvas";
import { USC, UploadSeq } from "../upload/sequence";
import { buildHeader, buildViews, type ViewActions, type ViewHost } from "../views/views";
import { h } from "../views/dom";
import { IslandStateMachine } from "./fsm";
import { decideCurrent } from "./hooks";
import { LiveLayer, baseLiveKinds, busySession, liveKinds, musicLive, type LiveKind } from "./bubble";
import { HudLayer, hudSize } from "./hud";
import { Timer } from "../core/timer";
import { feedViz, idleViz, vizEl } from "../views/viz";
import { proIcon } from "../views/pro-icons";
import { weatherIcon, weatherTone } from "../views/weather";
import { VoiceUi } from "../views/voice";
import { artColor } from "./art";

const BOT_OVERHANG = 40;

const HIT_MARGIN = 14;

const UPLOAD_VIEWS: ReadonlySet<IslandViewName> = new Set(["upload", "uploading", "choose"]);

const PRE_PROGRESS = USC.T_PROG_START - USC.T_DROP;

const MAX_DROP_BYTES = 64 * 1024 * 1024;

const modeOrder = (m: IslandMode) => (m === "hidden" ? 0 : m === "compact" ? 1 : 2);

const LONG_PRESS_MS = 420;

const DAYS = ["dim.", "lun.", "mar.", "mer.", "jeu.", "ven.", "sam."];
const MONTHS = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];

function shortDate(d: Date): string {
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

export class Island {
  readonly fsm = new IslandStateMachine();

  private root: HTMLElement;
  private islandEl!: HTMLElement;
  private clipEl!: HTMLElement;
  private contentEl!: HTMLElement;
  private viewsEl!: HTMLElement;
  private botCanvas!: HTMLCanvasElement;
  private botGlow!: HTMLElement;
  private greetingCanvas!: HTMLCanvasElement;
  private miniGrid!: HTMLElement;
  private mediaStrip!: HTMLElement;
  private live!: LiveLayer;
  private hudLayer!: HudLayer;
  private dots!: HTMLElement;
  private trail!: HTMLElement;
  private glance!: HTMLElement;
  private countdown!: HTMLElement;
  private wakeStrip!: HTMLElement;

  private header!: ViewHost;
  private views!: Map<IslandViewName, ViewHost>;
  private uploadCanvas!: UploadCanvas;

  private width = new Tracked(NOTCH_W);
  private height = new Tracked(0);
  private radius = new Tracked(ROUNDED_CORNER);
  private botCx = new Spring(46);
  private botCy = new Spring(16);
  private botSize = new Spring(10);
  private jellyX = new Spring(0, 0.34, 0.42);
  private jellyY = new Spring(0, 0.34, 0.42);
  private lastW = NOTCH_W;
  private lastH = 0;

  private engine = new BotEngine();
  private greeting = new Greeting();

  private running = false;
  private lastFrame = 0;
  private dirty = true;
  private canvasPx = 0;
  private canvasDpr = 0;
  private greetingDpr = 0;

  private collapsed = false;
  private collapseTimer: number | null = null;
  private wasInIsland = false;

  private pushedRect = { x: -1, y: -1, w: -1, h: -1 };
  private homeCollapseAt: number | null = null;

  private botHovering = false;
  private botHoverTimer: number | null = null;
  private lastLoveTime = 0;
  private botHoverStart = { x: 0, y: 0 };

  private confusedRecovery: number | null = null;
  private prevViewBeforeConfused: IslandViewName = "overview";
  private lastSyncedView: IslandViewName | null = null;

  private uploadTens = 0;
  private uploadDone = false;

  private hudRevealed = false;
  private quietReveal = false;
  private livePrimary: LiveKind | null = null;
  private wasSettling = false;
  private vizOn = false;
  private meterOn = false;
  private dancing = false;
  private beatAvg = 0;
  private lastBeatAt = 0;
  private hotStreak = 0;
  private asleep = false;
  private voiceRelease: number | null = null;
  private pressTimer: number | null = null;
  private pressed = false;
  private wheelAt = 0;
  private wheelSum = 0;
  private artKey = "";
  private dotsKey = "";
  private trailKey = "";
  private glanceKey = "";

  constructor(root: HTMLElement) {
    this.root = root;
    this.build();
    this.wireFsm();
    this.wireInput();
    this.engine.onDizzy = () => this.handleDizzy();
    this.greeting.onComplete = () => this.fsm.greetComplete();
    State.subscribe(() => {
      this.dirty = true;
      this.ensureRunning();
    });
  }

  private build() {
    const actions: ViewActions = {
      setView: (v) => this.setView(v),
      collapse: () => this.collapse(),
      setFocus: (id) => {
        State.setFocus(id);
        Sound.play("blip");
      },
      openTerminal: () => {
        const cwd = State.focusTask?.sessionCwd ?? null;
        void Bridge.openInVSCode(cwd);
      },

      openTarget: () => {
        const task = State.focusTask;
        if (!task) return;
        const urls: Record<string, string> = {
          integration_resend: "https://resend.com/emails",
          integration_vercel: "https://vercel.com/dashboard",
          integration_github: "https://github.com",
          integration_stripe: "https://dashboard.stripe.com/payments",
          integration_notion: "https://notion.so",
          integration_calcom: "https://app.cal.com/bookings",
        };
        if (task.sessionId || task.id === PLACEHOLDER_ID) void Bridge.openInVSCode(task.sessionCwd ?? null);
        else if (task.id === "integration_n8n") void Bridge.openN8n();
        else if (urls[task.id]) void Bridge.openUrl(urls[task.id]);
      },
      openUrl: (url) => {
        if (url) void Bridge.openUrl(url);
      },
      decide: (d) => decideCurrent(this, d),
      toggleSound: () => {
        State.settings.soundEnabled = !State.settings.soundEnabled;
        Sound.setEnabled(State.settings.soundEnabled);
        void Bridge.saveSettings(State.settings);
        State.notify();
      },
      setVolume: (v) => {
        State.settings.soundVolume = v;
        Sound.setVolume(v);
        void Bridge.saveSettings(State.settings);
        State.notify();
      },
      setAutoClose: (s) => {
        State.settings.autoCloseInterval = s;
        this.fsm.homeToPetitDelay = s;
        void Bridge.saveSettings(State.settings);
        State.notify();
      },
      openSettingsWindow: () => void Bridge.openSettingsWindow(),
      blip: () => Sound.play("blip"),
    };

    this.wakeStrip = h("div", { id: "wake-strip" });
    this.botGlow = h("div", { id: "bot-glow" });
    this.botCanvas = h("canvas", { id: "bot-canvas" });
    this.greetingCanvas = h("canvas", { id: "greeting-canvas" });
    this.miniGrid = h("div", { id: "mini-grid" });
    this.mediaStrip = h("div", { id: "media-strip" });
    this.countdown = h("div", { id: "countdown" });
    this.dots = h("div", { id: "privacy-dots" });
    this.trail = h("div", { id: "trail" });
    this.trail.addEventListener("mousedown", (e) => {
      const kind = this.trail.dataset.kind;
      if (!kind) return;
      e.stopPropagation();
      Sound.play("blip");
      this.setView(kind === "bell" ? "notifications" : "today");
    });
    this.glance = h("div", { id: "glance" });
    this.glance.addEventListener("mousedown", (e) => {
      if (!this.glance.dataset.kind || State.mode !== "compact") return;
      e.stopPropagation();
      Sound.play("blip");
      if (this.glance.dataset.kind === "session") this.openLive("session");
      else this.setView("today");
    });
    window.setInterval(() => {
      if (State.mode !== "compact") return;
      this.dirty = true;
      this.ensureRunning();
    }, 15_000);
    window.setInterval(() => this.ambient(), 3500);

    this.hudLayer = new HudLayer();
    this.header = buildHeader(actions);
    this.views = buildViews(actions, () => this.animateGeometry(false));
    this.viewsEl = h("div", { id: "views" });
    for (const v of this.views.values()) this.viewsEl.append(v.el);
    this.contentEl = h("div", { id: "content" }, this.header.el, this.viewsEl);

    this.uploadCanvas = new UploadCanvas({
      ask: () => {
        State.promptContext = State.droppedFile
          ? { kind: "file", name: State.droppedFile.name, path: State.droppedFile.path }
          : null;
        this.setView("prompt");
      },
      cancel: () => this.setView(State.defaultView()),
    });

    this.clipEl = h(
      "div",
      { id: "island-clip" },
      this.greetingCanvas,
      this.uploadCanvas.el,
      this.contentEl,
      this.hudLayer.el,
    );
    this.islandEl = h(
      "div",
      { id: "island" },
      this.clipEl,
      this.botGlow,
      this.botCanvas,
      this.miniGrid,
      this.mediaStrip,
      this.countdown,
      this.glance,
      this.trail,
      this.dots,
    );

    this.sizeGreeting();

    this.live = new LiveLayer();
    this.live.onOpen = (kind) => this.openLive(kind);
    this.islandEl.insertBefore(this.live.ringEl, this.botCanvas);
    this.islandEl.append(this.live.strip, this.live.bar);
    this.root.append(this.live.defs, this.wakeStrip, this.live.goo, this.islandEl, this.live.bubble);
    Hud.subscribe(() => this.onHud());
    this.applyGeometry();
  }

  hud(spec: HudSpec): boolean {
    if (State.gameMode || State.paused || State.mode === "expanded") return false;
    if (this.fsm.state === "hidden") {
      this.hudRevealed = true;
      this.quietReveal = true;
      this.fsm.reveal();
      this.quietReveal = false;
    }
    Hud.show(spec);
    return true;
  }

  audioLevel(peak: number) {
    if (this.vizOn) feedViz(peak);
    if (!this.dancing) return;
    const now = performance.now();
    this.beatAvg = this.beatAvg === 0 ? peak : this.beatAvg * 0.94 + peak * 0.06;
    if (peak > 0.08 && peak > this.beatAvg * 1.22 && now - this.lastBeatAt > 300) {
      this.lastBeatAt = now;
      this.engine.beat((peak / Math.max(0.05, this.beatAvg) - 1) * 2.2);
      this.ensureRunning();
    }
  }

  voiceMood(mood: VoiceMood) {
    this.engine.voice = mood;
    if (mood === "off") {
      this.engine.voiceLevel = 0;
      this.engine.tgEs = 1;
    }
    this.ensureRunning();
  }

  voiceLevel(level: number) {
    this.engine.voiceLevel = this.engine.voiceLevel * 0.45 + level * 0.55;
    VoiceUi.push(level);
    if (this.engine.voice !== "off") this.ensureRunning();
  }

  openVoice() {
    if (this.voiceRelease != null) window.clearTimeout(this.voiceRelease);
    this.voiceRelease = null;
    State.isPinned = true;
    this.alert("voice");
  }

  releaseVoice(delayMs: number) {
    if (!State.pendingApproval) {
      State.isPinned = false;
      this.fsm.pinned = false;
    }
    if (this.voiceRelease != null) window.clearTimeout(this.voiceRelease);
    this.voiceRelease = window.setTimeout(() => {
      this.voiceRelease = null;
      if (State.mode === "expanded" && State.view === "voice" && !this.wasInIsland && !State.isPinned) this.collapse();
    }, delayMs);
  }

  celebrate() {
    if (!State.settings.mascotAlive || State.settings.calmMotion) return;
    this.engine.celebrate();
    this.ensureRunning();
  }

  private botShown(): boolean {
    if (State.mode === "compact") return !Hud.current;
    if (State.mode !== "expanded" || State.view === "greeting" || this.uploadActive) return false;
    return VIEW_LAYOUTS[State.view].botDiameter > 0;
  }

  private sleepy(): boolean {
    if (!State.settings.mascotAlive || State.mode === "expanded" || State.effectiveState !== "idle") return false;
    const hour = new Date().getHours();
    return hour < 6 && performance.now() - State.lastActivity > 120_000;
  }

  private ambient() {
    const s = State.stats;
    this.hotStreak = State.settings.mascotAlive && s && s.cpu >= 85 ? this.hotStreak + 1 : 0;
    if (this.hotStreak >= 2 && State.mode !== "hidden" && this.botShown() && !State.settings.calmMotion) {
      this.engine.emit("sweat", 1);
      this.ensureRunning();
    }
    const sleepy = this.sleepy();
    if (sleepy !== this.asleep) {
      this.asleep = sleepy;
      this.dirty = true;
      this.ensureRunning();
    }
  }

  private shiftLive(direction: number) {
    const kinds = baseLiveKinds();
    if (kinds.length < 2) return;
    const current = Math.max(0, kinds.indexOf(liveKinds()[0]));
    const next = kinds[(current + direction + kinds.length) % kinds.length];
    State.livePreferred = next === kinds[0] ? null : next;
    Sound.play("blip");
    this.nudge(direction);
    State.notify();
  }

  private nudge(direction: number) {
    if (State.settings.calmMotion) return;
    this.jellyX.velocity += direction * 0.9;
    this.ensureRunning();
  }

  private onHud() {
    const spec = Hud.current;
    if (!spec && this.hudRevealed) {
      this.hudRevealed = false;
      window.setTimeout(() => {
        if (Hud.current || State.mode !== "compact" || this.wasInIsland || this.fsm.keepCompact) return;
        if (this.fsm.state === "petit") this.fsm.forceHidden();
      }, 260);
    }
    this.dirty = true;
    this.animateGeometry(!spec);
  }

  private openLive(kind: LiveKind) {
    Sound.play("blip");
    if (kind === "timer") {
      this.setView("timer");
    } else if (kind === "music") {
      this.setView("music");
    } else if (kind === "call" || kind === "download") {
      this.setView(State.defaultView());
    } else {
      const task = busySession();
      if (task) State.setFocus(task.id);
      this.setView(task?.state === "approval" && State.pendingApproval ? (State.pendingApproval.kind === "review" ? "review" : "approval") : "session");
    }
  }

  setGameMode(active: boolean, app: string) {
    if (State.gameMode === active && State.gameApp === app) return;
    const was = State.gameMode;
    State.gameMode = active;
    State.gameApp = app;
    Sound.muted = active && State.settings.gameMute;
    this.fsm.setSuppressed(active);
    if (active) {
      State.isPinned = false;
      this.fsm.pinned = false;
    } else if (was && State.missed.length) {
      const during = app || "ta partie";
      State.noteMessage = `Pendant ${during} : ${State.missed.join(" · ")}`;
      State.missed = [];
      Sound.play("peek");
      this.alert("note");
    }
    State.notify();
  }

  private noteMissed(view: IslandViewName) {
    const task = State.focusTask;
    const at = new Date();
    const clock = `${at.getHours()}\u00A0h\u00A0${String(at.getMinutes()).padStart(2, "0")}`;
    let label: string | null = null;
    switch (view) {
      case "finished": label = task?.sessionId ? `${task.name} a fini` : null; break;
      case "error": label = task?.sessionId ? `${task.name} s'est arrêté sur une erreur` : null; break;
      case "usage": label = State.usageAlert ? `limite Claude à ${State.usageAlert.percent} %` : null; break;
      case "vpn": label = State.vpnEvent ? (State.vpnEvent.kind === "up" ? `VPN reconnecté à ${clock}` : `VPN coupé à ${clock}`) : null; break;
      case "timer": label = "minuteur terminé"; break;
      case "note": label = State.noteMessage; break;
      default: label = null;
    }
    if (label && !State.missed.includes(label)) State.missed.push(label);
  }

  private wireFsm() {
    this.fsm.hold = () => !!Hud.current;
    this.fsm.homeToPetitDelay = State.settings.autoCloseInterval;
    this.fsm.onTransition = (from, to) => {
      switch (to) {
        case "hidden":
          this.setMode("hidden");
          break;
        case "petit":
          if (from === "tako") this.greeting.interrupt();
          else if (from === "hidden" && !this.quietReveal) Sound.play("peek");
          this.setMode("compact");
          if (from === "tako") State.view = State.defaultView();
          if (!this.wasInIsland) this.fsm.mouseLeft();
          break;
        case "home":
          this.expand(State.defaultView());
          if (!this.wasInIsland) this.fsm.mouseLeft();
          break;
        case "tako":
          this.expand("greeting");
          this.greeting.start();
          break;
      }
      State.notify();
    };
  }

  launch() {
    this.fsm.launch();
  }

  private setMode(mode: IslandMode) {
    const prev = State.mode;
    if (mode === prev) return;
    State.mode = mode;
    if (mode === "expanded") {
      Sound.play("open");
      Hud.clear();
    }
    if (prev === "expanded") {
      Sound.play("close");
      State.isPinned = false;
      void Bridge.focusWindow(false);
    }
    if (mode !== "expanded") {
      this.engine.resetMorph();

      UploadSeq.deactivate();
    }
    this.updateWindowCollapsed();
    this.animateGeometry(modeOrder(mode) < modeOrder(prev));
    State.notify();
  }

  private get uploadActive(): boolean {
    return State.mode === "expanded" && UploadSeq.isActive && UPLOAD_VIEWS.has(State.view);
  }

  private stopSequenceIfLeaving(view: IslandViewName) {
    if (UploadSeq.isActive && !UPLOAD_VIEWS.has(view)) UploadSeq.deactivate();
  }

  expand(view: IslandViewName) {
    this.stopSequenceIfLeaving(view);
    State.view = view;
    if (State.mode !== "expanded") this.setMode("expanded");
    else this.animateGeometry(false);
    State.lastActivity = performance.now();
    this.homeCollapseAt = null;
    State.notify();
  }

  setView(view: IslandViewName) {
    this.stopSequenceIfLeaving(view);
    if (State.mode !== "expanded") {
      this.fsm.forceHome();
      State.view = view;
      this.animateGeometry(false);
      State.notify();
      return;
    }
    const grew = VIEW_LAYOUTS[view].height >= VIEW_LAYOUTS[State.view].height;
    State.view = view;
    State.lastActivity = performance.now();
    this.animateGeometry(!grew);
    State.notify();
  }

  collapse() {
    State.isPinned = false;
    this.fsm.pinned = false;

    this.fsm.forcePetit();
  }

  alert(view: IslandViewName) {
    if (State.gameMode) {
      this.noteMissed(view);
      return;
    }
    this.fsm.pinned = State.isPinned;
    this.fsm.forceHome();
    this.expand(view);
  }

  reveal() {
    if (State.gameMode) return;
    this.fsm.reveal();
  }

  openMission() {
    State.isPinned = true;
    this.alert("mission");
  }

  dropPin() {
    this.fsm.pinned = false;
  }

  private onDragDrop(e: { type: "enter" | "over" | "leave" | "drop"; file?: File }) {
    if (e.type !== "over") void Bridge.log(`drag ${e.type}${e.file ? ` ${e.file.name}` : ""}`);
    if (State.paused) return;
    switch (e.type) {
      case "enter":
      case "over": {
        if (State.fileDragOver) return;
        State.fileDragOver = true;
        this.engine.animateMorph(1);

        UploadSeq.enterZone(State.mouseInIsland.x, State.mouseInIsland.y);
        this.alert("upload");
        break;
      }
      case "leave": {
        if (!State.fileDragOver) return;
        State.fileDragOver = false;
        this.engine.animateMorph(0);

        UploadSeq.exitZone();
        State.notify();
        break;
      }
      case "drop": {
        State.fileDragOver = false;
        if (!e.file) {
          this.engine.animateMorph(0);
          this.setView(State.defaultView());
          return;
        }
        this.swallow(e.file);
        break;
      }
    }
  }

  private swallow(file: File) {
    const name = file.name || "file";
    State.droppedFile = { name, path: "" };
    State.promptContext = { kind: "file", name, path: "" };
    State.chatHistory = [];
    void Bridge.chatReset();

    UploadSeq.performDrop(State.uploadDuration);
    this.uploadTens = 0;
    this.uploadDone = false;

    this.engine.gulp();
    Sound.play("approve");
    this.engine.triggerEmote("happy");
    this.engine.animateMorph(0);

    State.uploadProgress = 0;
    this.setView("uploading");
    this.ensureRunning();

    const fail = (err: unknown) => {
      UploadSeq.deactivate();
      State.noteMessage = String(err).replace(/^Error:\s*/, "");
      this.engine.animateMorph(0);
      this.setView("note");
      Sound.play("error");
      window.setTimeout(() => this.setView(State.defaultView()), 2400);
    };
    if (file.size > MAX_DROP_BYTES) {
      fail(`${name} est trop lourd pour être déposé (${MAX_DROP_BYTES / 1024 / 1024}\u00A0Mo maximum).`);
      return;
    }
    void file
      .arrayBuffer()
      .then((buf) => Bridge.ingestBytes(name, new Uint8Array(buf)))
      .then((saved) => {
        State.droppedFile = { name: saved.name, path: saved.path };
        State.promptContext = { kind: "file", name: saved.name, path: saved.path };
        State.notify();
      })
      .catch(fail);
  }

  private stepSequence() {
    const since = UploadSeq.sinceDrop();
    if (since == null) return;
    const dur = State.uploadDuration;
    const p = Math.max(0, Math.min(1, (since - PRE_PROGRESS) / dur));

    const tens = Math.floor(p * 10);
    if (tens > this.uploadTens && tens < 10) {
      this.uploadTens = tens;
      Sound.play("tick");
    }

    if (!this.uploadDone && since >= PRE_PROGRESS + dur) {
      this.uploadDone = true;
      Sound.play("approve");
      this.engine.triggerEmote("happy");
    }

    if (since >= PRE_PROGRESS + dur + 1 && State.view === "uploading") {
      this.setView("choose");
    }
  }

  private targetSize(): { w: number; h: number; r: number } {
    if (State.mode === "compact") {
      const spec = Hud.current;
      if (spec) {
        const s = hudSize(spec);
        return { w: s.w, h: s.h, r: spec.banner ? 26 : 19 };
      }
      const wide = this.livePrimary === "call" || this.livePrimary === "download";
      return { w: wide ? COMPACT_W + 40 : COMPACT_W, h: NOTCH_H, r: ROUNDED_CORNER };
    }
    const { w, h } = islandSize(State.mode, State.view, State.chatHistory.length, State.sizeHint);
    const r = State.mode === "expanded" ? EXPANDED_CORNER : ROUNDED_CORNER;
    return { w, h, r };
  }

  private animateGeometry(shrinking: boolean) {
    const { w, h, r } = this.targetSize();
    if (shrinking) {
      this.width.curveTowards(w);
      this.height.curveTowards(h);
      this.radius.curveTowards(r);
    } else {
      this.width.springTo(w);
      this.height.springTo(h);
      this.radius.springTo(r);
    }
    this.ensureRunning();
  }

  private applyGeometry() {
    const w = this.width.value;
    const hh = this.height.value;
    const r = this.radius.value;
    this.islandEl.style.width = `${w}px`;
    this.islandEl.style.height = `${hh}px`;
    this.islandEl.style.borderRadius = `0 0 ${r}px ${r}px`;
    const jx = this.jellyX.value;
    const jy = this.jellyY.value;
    this.islandEl.style.transform = jx || jy ? `scale(${(1 + jx).toFixed(4)}, ${(1 + jy).toFixed(4)})` : "";

    this.miniGrid.style.left = `${w - 40 - 14.5}px`;
    this.miniGrid.style.top = `${hh / 2 - 14.5}px`;
    this.greetingCanvas.style.left = `${(w - EXPANDED_W) / 2}px`;
    this.uploadCanvas.el.style.left = `${(w - EXPANDED_W) / 2}px`;
    this.live.layout((PANEL_W - w) / 2, w, hh, r, State.mode);

    const rect = this.hitRect();
    const p = this.pushedRect;
    if (Math.abs(p.x - rect.x) > 0.5 || Math.abs(p.w - rect.w) > 0.5 || Math.abs(p.h - rect.h) > 0.5) {
      this.pushedRect = rect;
      void Bridge.setIslandRect(rect.x, rect.y, rect.w, rect.h);
    }
  }

  private islandRect(): { x: number; y: number; w: number; h: number } {
    const w = this.width.value;
    const hh = this.height.value;
    return { x: (PANEL_W - w) / 2, y: 0, w, h: hh };
  }

  private hitRect(): { x: number; y: number; w: number; h: number } {
    const rect = this.islandRect();
    const bubble = this.live?.bubbleRect();
    if (!bubble) return rect;
    const right = Math.max(rect.x + rect.w, bubble.x + bubble.w);
    return { x: rect.x, y: 0, w: right - rect.x, h: Math.max(rect.h, bubble.h) };
  }

  private updateWindowCollapsed() {
    if (this.collapseTimer != null) {
      window.clearTimeout(this.collapseTimer);
      this.collapseTimer = null;
    }
    if (State.mode === "hidden") {
      this.collapseTimer = window.setTimeout(() => {
        this.collapseTimer = null;
        if (State.mode !== "hidden") return;
        this.collapsed = true;
        void Bridge.setCollapsed(true);
      }, 420);
    } else if (this.collapsed) {
      this.collapsed = false;
      void Bridge.setCollapsed(false);
    }
  }

  private wireInput() {
    this.wakeStrip.addEventListener("mouseenter", () => {
      Sound.resume();
      if (State.mode === "hidden") this.fsm.mouseEntered();
    });

    this.islandEl.addEventListener("mousedown", (e) => {
      Sound.resume();
      State.lastActivity = performance.now();
      if (State.mode !== "expanded") {
        if (e.button !== 0 || this.fsm.state !== "petit") {
          this.fsm.click();
          return;
        }
        this.pressed = true;
        this.islandEl.classList.add("pressing");
        if (this.pressTimer != null) window.clearTimeout(this.pressTimer);
        this.pressTimer = window.setTimeout(() => {
          this.pressTimer = null;
          if (!this.pressed) return;
          this.pressed = false;
          this.islandEl.classList.remove("pressing");
          const kinds = liveKinds();
          const kind = (State.livePreferred as LiveKind | null) && kinds.includes(State.livePreferred as LiveKind) ? (State.livePreferred as LiveKind) : kinds[0];
          if (kind) this.openLive(kind);
          else {
            Sound.play("blip");
            this.setView("today");
          }
        }, LONG_PRESS_MS);
        return;
      }
      if (this.isBotHit(e.clientX, e.clientY)) {
        this.cancelBotHover();
        this.engine.slap();
      }
    });

    const release = () => {
      if (!this.pressed) return;
      this.pressed = false;
      this.islandEl.classList.remove("pressing");
      if (this.pressTimer != null) window.clearTimeout(this.pressTimer);
      this.pressTimer = null;
      if (State.mode !== "expanded") this.fsm.click();
    };
    window.addEventListener("mouseup", release);
    this.islandEl.addEventListener("mouseleave", () => {
      if (!this.pressed) return;
      this.pressed = false;
      this.islandEl.classList.remove("pressing");
      if (this.pressTimer != null) window.clearTimeout(this.pressTimer);
      this.pressTimer = null;
    });

    this.islandEl.addEventListener("wheel", (e) => {
      if (State.mode !== "compact") return;
      const sideways = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.shiftKey ? e.deltaY : 0;
      if (!sideways) return;
      e.preventDefault();
      const now = performance.now();
      if (now - this.wheelAt > 260) this.wheelSum = 0;
      this.wheelAt = now;
      this.wheelSum += sideways;
      if (Math.abs(this.wheelSum) < 40) return;
      const direction = this.wheelSum > 0 ? 1 : -1;
      this.wheelSum = -direction * 400;
      this.shiftLive(direction);
    }, { passive: false });

    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && State.mode === "expanded" && !State.isPinned) this.collapse();
      State.lastActivity = performance.now();
    });

    let dragDepth = 0;
    const carriesFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
    window.addEventListener("dragenter", (e) => {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      dragDepth++;
      if (dragDepth === 1) this.onDragDrop({ type: "enter" });
    });
    window.addEventListener("dragover", (e) => {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
      this.onCursor(e.clientX, e.clientY);
      this.onDragDrop({ type: "over" });
    });
    window.addEventListener("dragleave", (e) => {
      if (!carriesFiles(e)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) this.onDragDrop({ type: "leave" });
    });
    window.addEventListener("drop", (e) => {
      e.preventDefault();
      dragDepth = 0;
      this.onDragDrop({ type: "drop", file: e.dataTransfer?.files?.[0] });
    });

    if (!IS_TAURI) {
      window.addEventListener("mousemove", (e) => this.onCursor(e.clientX, e.clientY));
    }
  }

  onCursor(x: number, y: number) {
    State.mouse = { x, y };
    const rect = this.islandRect();
    State.mouseInIsland = { x: x - rect.x, y: y - rect.y };

    if (UploadSeq.isActive && !UploadSeq.dropped) {
      UploadSeq.updateCursor(State.mouseInIsland.x, State.mouseInIsland.y);
    }

    const hit = this.hitRect();
    const inIsland =
      x >= hit.x - HIT_MARGIN && x <= hit.x + hit.w + HIT_MARGIN &&
      y >= hit.y - HIT_MARGIN && y <= hit.y + hit.h + HIT_MARGIN;

    if (inIsland && !this.wasInIsland) {
      if (this.asleep) {
        this.asleep = false;
        State.lastActivity = performance.now();
        this.engine.stretch();
        this.dirty = true;
      }
      if (this.fsm.state === "tako") this.greeting.hover();
      this.fsm.mouseEntered();
      this.homeCollapseAt = null;
    }
    if (!inIsland && this.wasInIsland) {
      this.fsm.mouseLeft();
      if (this.fsm.state === "home" && !State.isPinned) {
        this.homeCollapseAt = performance.now() + State.settings.autoCloseInterval * 1000;
      }
    }
    this.wasInIsland = inIsland;

    const overBot = State.mode === "expanded" && State.stateOverride == null && this.isBotHit(x, y);
    if (overBot && !this.botHovering) this.botHoverIn(x, y);
    if (!overBot && this.botHovering) this.cancelBotHover();
    this.botHovering = overBot;
    if (this.botHovering) {
      const d = Math.hypot(x - this.botHoverStart.x, y - this.botHoverStart.y);
      if (d > 40) {
        this.botHoverStart = { x, y };
        this.scheduleLove();
      }
    }

    this.ensureRunning();
  }

  private isBotHit(x: number, y: number): boolean {
    const rect = this.islandRect();
    const cx = rect.x + this.botCx.value;
    const cy = rect.y + this.botCy.value;
    const radius = this.botSize.value / 2;
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius;
  }

  private botHoverIn(x: number, y: number) {
    if (performance.now() / 1000 - this.lastLoveTime < 6) return;
    this.botHoverStart = { x, y };
    this.engine.blink();
    this.engine.tgEs = 1.08;
    Sound.play("hover");
    this.scheduleLove();
  }

  private scheduleLove() {
    if (this.botHoverTimer != null) window.clearTimeout(this.botHoverTimer);
    this.botHoverTimer = window.setTimeout(() => {
      this.botHoverTimer = null;
      if (!this.botHovering || State.stateOverride != null) return;
      if (performance.now() / 1000 - this.lastLoveTime < 6) return;
      this.lastLoveTime = performance.now() / 1000;
      this.engine.triggerEmote("love");
      Sound.play("love");
    }, 1900);
  }

  private cancelBotHover() {
    if (this.botHoverTimer != null) window.clearTimeout(this.botHoverTimer);
    this.botHoverTimer = null;
    this.engine.tgEs = 1;
  }

  private handleDizzy() {
    this.prevViewBeforeConfused = State.view;
    State.stateOverride = "dizzy";
    this.engine.setState("dizzy");
    Sound.play("dizzy");
    this.alert("confused");
    if (this.confusedRecovery != null) window.clearTimeout(this.confusedRecovery);
    this.confusedRecovery = window.setTimeout(() => {
      this.confusedRecovery = null;
      State.stateOverride = null;
      this.engine.setState(State.effectiveState);
      if (State.view === "confused") {
        const fallback = State.defaultView();
        this.setView(this.prevViewBeforeConfused === "confused" ? fallback : this.prevViewBeforeConfused);
      }
      this.engine.triggerEmote("happy");
    }, 3300);
  }

  ensureRunning() {
    if (this.running) return;
    this.running = true;
    this.lastFrame = performance.now();
    requestAnimationFrame(this.frame);
  }

  private frame = (nowMs: number) => {
    const dt = Math.max(0, Math.min(0.05, (nowMs - this.lastFrame) / 1000));
    this.lastFrame = nowMs;

    this.width.step(dt, nowMs);
    this.height.step(dt, nowMs);
    this.radius.step(dt, nowMs);
    this.stepJelly(dt);
    this.applyGeometry();

    if (this.dirty) {
      this.dirty = false;
      this.syncDom();
    }

    this.updateBotTargets();
    this.botCx.step(dt);
    this.botCy.step(dt);
    this.botSize.step(dt);
    this.live.step(dt, this.botCx.value, this.botCy.value, this.botSize.value * 0.6);

    const greetingActive = State.mode === "expanded" && State.view === "greeting";
    if (greetingActive) {
      const gctx = this.greetingCanvas.getContext("2d");
      if (gctx) {
        const dpr = this.sizeGreeting();
        gctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this.greeting.draw(gctx);
      }
    } else {
      this.drawBot(dt);
    }

    const uploadActive = this.uploadActive;
    if (uploadActive) this.uploadCanvas.draw(UploadSeq.frame(), nowMs / 1000);
    this.uploadCanvas.el.classList.toggle("on", uploadActive);
    this.viewsEl.classList.toggle("hidden-by-upload", uploadActive);

    tickMiniBots(dt);
    this.views.get(State.view)?.tick?.(nowMs);
    if (UploadSeq.isActive) this.stepSequence();
    this.updateCountdown(nowMs);

    const settling =
      this.width.animating || this.height.animating || this.radius.animating;
    if (this.wasSettling && !settling) this.dirty = true;
    this.wasSettling = settling;
    const busy = State.mode === "hidden"
      ? settling || this.dirty
      : settling || this.dirty ||
        !this.botCx.settled || !this.botCy.settled || !this.botSize.settled || this.jellyMoving ||
        greetingActive || this.engine.busy || UploadSeq.isActive || this.live.animating ||
        this.views.get(State.view)?.animating?.() === true;

    if (busy) {
      requestAnimationFrame(this.frame);
    } else {
      this.running = false;
      Sound.idle();
    }
  };

  private get jellyMoving(): boolean {
    return Math.abs(this.jellyX.value) > 0.0015 || Math.abs(this.jellyY.value) > 0.0015 ||
      Math.abs(this.jellyX.velocity) > 0.01 || Math.abs(this.jellyY.velocity) > 0.01;
  }

  private stepJelly(dt: number) {
    const w = this.width.value;
    const hh = this.height.value;
    const calm = State.settings.calmMotion || State.mode === "hidden";
    if (dt > 0) {
      const vw = (w - this.lastW) / dt;
      const vh = (hh - this.lastH) / dt;
      this.jellyX.target = calm ? 0 : clamp(vw / 30000 - vh / 34000, -0.035, 0.035);
      this.jellyY.target = calm ? 0 : clamp(vh / 16000 - vw / 42000, -0.05, 0.05);
    }
    this.lastW = w;
    this.lastH = hh;
    this.jellyX.step(dt);
    this.jellyY.step(dt);
    if (!this.jellyMoving) {
      this.jellyX.set(0);
      this.jellyY.set(0);
    }
  }

  private updateBotTargets() {
    const p = botPosition(State.mode, State.view, this.height.value, State.uploadProgress);
    this.botCx.target = p.cx;
    this.botCy.target = p.cy;
    this.botSize.target = p.diameter / 0.6;

    const greetingActive = State.mode === "expanded" && State.view === "greeting";

    const hudOn = State.mode === "compact" && !!Hud.current;
    const visible = p.opacity > 0 && p.diameter > 0 && !greetingActive && !this.uploadActive && !hudOn;
    this.botCanvas.style.opacity = visible ? "1" : "0";

    if (State.mode === "expanded" && State.view !== "uploading" && !greetingActive && !this.uploadActive) {
      const d = p.diameter;
      const color = botGlowColor(State.effectiveState);
      this.botGlow.style.display = "block";
      this.botGlow.style.width = `${d * 2.2}px`;
      this.botGlow.style.height = `${d * 2.2}px`;
      this.botGlow.style.left = `${this.botCx.value - d * 1.1}px`;
      this.botGlow.style.top = `${this.botCy.value - d * 1.1}px`;
      this.botGlow.style.background = `radial-gradient(circle, ${color} 0%, transparent 62%)`;
      this.botGlow.style.opacity = String(botGlowOpacity(State.effectiveState));
    } else {
      this.botGlow.style.display = "none";
    }
  }

  private drawBot(dt: number) {
    const size = this.botSize.value;
    const w = Math.max(1, Math.round(size));
    const hCss = w + BOT_OVERHANG;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (this.canvasPx !== w || this.canvasDpr !== dpr) {
      this.canvasPx = w;
      this.canvasDpr = dpr;
      this.botCanvas.width = Math.round(w * dpr);
      this.botCanvas.height = Math.round(hCss * dpr);
      this.botCanvas.style.width = `${w}px`;
      this.botCanvas.style.height = `${hCss}px`;
    }
    this.botCanvas.style.left = `${this.botCx.value - w / 2}px`;
    this.botCanvas.style.top = `${this.botCy.value - BOT_OVERHANG / 2 - hCss / 2}px`;

    const ctx = this.botCanvas.getContext("2d");
    if (!ctx) return;

    const focus = State.focusTask;
    this.engine.bodyColor = focus?.isIntegration ? hexToRGB(focus.color) : null;
    this.engine.particleOverhang = BOT_OVERHANG;
    this.engine.lookX = this.lookX();
    this.engine.lookY = this.lookY();
    if (this.engine.morph > 0.3) {
      this.engine.slotHTarget = State.fileDragOver ? 0.2 : 0;
    } else {
      this.engine.slotHTarget = 0;
      if (this.engine.morph < 0.05) {
        this.engine.slotH = 0;
        this.engine.slotHVel = 0;
      }
    }
    this.engine.update(dt);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hCss);
    this.engine.draw(ctx, w, hCss);
  }

  private sizeGreeting(): number {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (this.greetingDpr !== dpr) {
      this.greetingDpr = dpr;
      this.greetingCanvas.width = Math.round(EXPANDED_W * dpr);
      this.greetingCanvas.height = Math.round(150 * dpr);
      this.greetingCanvas.style.width = `${EXPANDED_W}px`;
      this.greetingCanvas.style.height = "150px";
    }
    return dpr;
  }

  private lookX(): number {
    const rect = this.islandRect();
    const botScreenX = rect.x + this.botCx.value;
    return Math.tanh((State.mouse.x - botScreenX) / 260);
  }

  private lookY(): number {
    return -Math.tanh((State.mouse.y - this.botCy.value) / 200);
  }

  private updateCountdown(nowMs: number) {
    if (State.mode !== "expanded" || State.isPinned || this.homeCollapseAt == null) {
      this.countdown.style.width = "0px";
      return;
    }
    const autoClose = State.settings.autoCloseInterval;
    const windowS = Math.min(10, autoClose * 0.6);
    const remaining = (this.homeCollapseAt - nowMs) / 1000;
    this.countdown.style.width =
      remaining < windowS ? `${Math.max(0, clamp(remaining / windowS, 0, 1) * 160)}px` : "0px";
  }

  private lastTargetKey = "";

  private followContentSize() {
    const { w, h } = this.targetSize();
    const key = `${State.mode}:${State.view}:${w}x${h}`;
    if (key === this.lastTargetKey) return;
    const prev = this.lastTargetKey.split(":")[2]?.split("x").map(Number) ?? [w, h];
    this.lastTargetKey = key;
    if (State.mode !== "hidden" && (prev[0] !== w || prev[1] !== h)) {
      this.animateGeometry(h < prev[1] || w < prev[0]);
    }
  }

  private syncDom() {
    const expanded = State.mode === "expanded";
    const greetingActive = expanded && State.view === "greeting";

    this.contentEl.style.opacity = expanded && !greetingActive ? "1" : "0";
    this.contentEl.classList.toggle("interactive", expanded && !greetingActive);
    this.greetingCanvas.style.display = greetingActive ? "block" : "none";

    this.header.sync();
    for (const [name, view] of this.views) {
      const on = name === State.view;
      view.el.classList.toggle("on", on);
      if (on) view.sync();
    }

    if (this.lastSyncedView !== State.view) {
      const typing = (v: string | null | undefined) => v === "prompt" || v === "mission";
      const wasTyping = typing(this.lastSyncedView);
      this.lastSyncedView = State.view;
      if (typing(State.view)) {
        void Bridge.focusWindow(true);
        const view = State.view;
        window.setTimeout(() => this.views.get(view)?.focus?.(), 120);
      } else if (wasTyping) {
        void Bridge.focusWindow(false);
      }
    }

    const hudOn = State.mode === "compact" && !!Hud.current;
    this.hudLayer.sync(State.mode === "compact");
    this.islandEl.classList.toggle("has-hud", hudOn);
    if (hudOn && Hud.current) this.islandEl.style.setProperty("--key", Hud.current.tone);
    this.live.setHidden(hudOn);
    const live = this.live.sync(State.mode, State.view);
    this.livePrimary = live.primary;
    const keepLive = State.settings.keepLiveVisible && (
      !!busySession() || (State.settings.callActivity && !!State.call) || (State.settings.downloadsEnabled && !!State.download) || musicLive());
    this.fsm.setKeepCompact(Timer.active || keepLive);
    const m = State.media;
    const showStrip = State.mode === "compact" && !hudOn && live.primary === "music" && !!m?.active;
    this.mediaStrip.classList.toggle("on", showStrip);
    if (showStrip && m) {
      const key = `${m.title}~${m.art ? m.art.length : 0}`;
      if (this.mediaStrip.dataset.key !== key) {
        this.mediaStrip.dataset.key = key;
        this.mediaStrip.replaceChildren();
        const art = h("div", { class: "ms-art" });
        if (m.art && m.art.startsWith("data:image/")) art.append(h("img", { src: m.art, alt: "" }));
        this.mediaStrip.append(art, h("span", { class: "ms-title", text: m.title }), vizEl(4, "ms-viz"));
      }
    }
    const wantViz = State.settings.visualizer && musicLive() && !hudOn && (
      (State.mode === "compact" && (live.primary === "music" || live.secondary === "music")) ||
      (State.mode === "expanded" && State.view === "music"));
    if (!wantViz && this.vizOn) idleViz(true);
    this.vizOn = wantViz;
    this.dancing = State.settings.mascotAlive && !State.settings.calmMotion && musicLive() && State.mode !== "hidden" && this.botShown();
    const wantMeter = wantViz || this.dancing;
    if (wantMeter !== this.meterOn) {
      this.meterOn = wantMeter;
      void Bridge.audioMeter(wantMeter);
    }
    this.syncArt();
    this.syncDots(hudOn);

    const showGrid = State.mode === "compact" && !hudOn;
    this.miniGrid.style.opacity = showGrid ? "1" : "0";
    const others = showGrid ? State.otherTasks.slice(0, 4) : [];
    this.syncTrail(showGrid && others.length === 0 && live.primary !== "call" && live.primary !== "download");
    const leftBusy = live.primary === "timer" || live.primary === "call" || live.primary === "download" || showStrip;
    this.syncGlance(showGrid && !leftBusy, live.primary);
    if (showGrid) {
      const key = others.map((t) => t.id).join("|");
      if (this.miniGrid.dataset.key !== key) {
        this.miniGrid.dataset.key = key;
        this.miniGrid.replaceChildren();
        for (const t of others) {
          this.miniGrid.append(createMiniBot(t, 13));
        }
        pruneMiniBots();
      }
    }

    syncMiniBotStates(State.tasks);
    this.root.classList.toggle("calm", State.settings.calmMotion);
    this.engine.setState(this.asleep && State.effectiveState === "idle" ? "sleeping" : State.effectiveState);
    this.followContentSize();
  }

  private syncArt() {
    const m = State.media;
    const art = State.settings.mediaEnabled && m?.active && m.art?.startsWith("data:image/") ? m.art : null;
    const key = art ? `${art.length}:${art.slice(-48)}` : "";
    if (key === this.artKey) return;
    this.artKey = key;
    if (!art) {
      document.documentElement.style.removeProperty("--art");
      return;
    }
    void artColor(art).then((color) => {
      if (this.artKey !== key) return;
      if (color) document.documentElement.style.setProperty("--art", color);
      else document.documentElement.style.removeProperty("--art");
    });
  }

  private syncGlance(on: boolean, primary: LiveKind | null) {
    const w = State.weather;
    const session = primary === "session" ? busySession() : null;
    const kind = !on ? "" : session ? "session" : "idle";
    const mic = State.settings.voiceEnabled && !State.gameMode && !State.paused;
    const now = new Date();
    const date = shortDate(now);
    const wx = kind === "idle" && State.settings.weatherEnabled && w ? `${Math.round(w.temp)}~${w.code}~${w.isDay}` : "";
    const step = session ? session.steps.at(-1) ?? "" : "";
    const key = `${kind}~${date}~${wx}~${mic}~${session?.id ?? ""}~${session?.name ?? ""}~${step}`;
    this.glance.classList.toggle("on", !!kind);
    if (key === this.glanceKey) return;
    this.glanceKey = key;
    this.glance.dataset.kind = kind;
    this.glance.replaceChildren();
    this.glance.title = "";
    if (!kind) return;
    if (mic) this.glance.append(h("i", { class: "gl-mic", title: "Dis « Hey Tako »" }, proIcon("mic", 11, 2.2)));
    if (session) {
      this.glance.append(h("b", { class: "gl-name", text: session.name }));
      if (step) this.glance.append(h("span", { class: "gl-step", text: step }));
      this.glance.title = step ? `${session.name} · ${step}` : session.name;
      return;
    }
    this.glance.append(h("span", { class: "gl-date", text: date }));
    if (wx && w) {
      const chip = h("span", { class: "gl-wx" }, proIcon(weatherIcon(w), 13, 2), h("span", { text: `${Math.round(w.temp)}°` }));
      chip.style.setProperty("--wx", weatherTone(w));
      this.glance.append(chip);
      this.glance.title = w.city;
    }
  }

  private syncTrail(on: boolean) {
    let kind = "";
    if (on) {
      if (State.settings.notificationsEnabled && State.unreadNotices > 0) kind = "bell";
      else kind = "clock";
    }
    this.trail.classList.toggle("on", !!kind);
    const now = new Date();
    const clock = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    const key = kind === "bell" ? `bell${State.unreadNotices}` : kind === "clock" ? `clock${clock}` : "";
    if (key === this.trailKey) return;
    this.trailKey = key;
    this.trail.dataset.kind = kind;
    this.trail.replaceChildren();
    this.trail.title = "";
    if (kind === "bell") {
      const n = State.unreadNotices;
      this.trail.append(proIcon("bell", 12, 2.2), h("b", { text: n > 9 ? "9+" : String(n) }));
      this.trail.title = `${n} notification${n > 1 ? "s" : ""} non lue${n > 1 ? "s" : ""}`;
    } else if (kind === "clock") {
      this.trail.append(h("span", { text: clock }));
    }
  }

  private syncDots(hudOn: boolean) {
    const p = State.privacy;
    const on = State.settings.privacyDots && State.mode === "compact" && !hudOn && (p.mic.length > 0 || p.cam.length > 0);
    this.dots.classList.toggle("on", on);
    this.islandEl.classList.toggle("dots-on", on);
    const key = on ? `${p.mic.map((u) => u.app).join(",")}|${p.cam.map((u) => u.app).join(",")}` : "";
    if (key === this.dotsKey) return;
    this.dotsKey = key;
    this.dots.replaceChildren();
    if (!on) return;
    if (p.cam.length) this.dots.append(h("i", { class: "cam" }));
    if (p.mic.length) this.dots.append(h("i", { class: "mic" }));
    const parts = [];
    if (p.mic.length) parts.push(`Micro : ${p.mic.map((u) => u.app).join(", ")}`);
    if (p.cam.length) parts.push(`Caméra : ${p.cam.map((u) => u.app).join(", ")}`);
    this.dots.title = parts.join(" · ");
  }

  applySettings() {
    Sound.setEnabled(State.settings.soundEnabled);
    Sound.setVolume(State.settings.soundVolume);
    this.fsm.homeToPetitDelay = State.settings.autoCloseInterval;
    State.notify();
  }

  get panelSize() {
    return { w: PANEL_W, h: PANEL_H };
  }

  get chatHeight() {
    return chatPromptHeight(State.chatHistory.length);
  }
}
