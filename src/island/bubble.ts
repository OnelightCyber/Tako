import { Spring, clamp, lerp } from "../core/anim";
import { bytes, clockSince, middle } from "../core/hud";
import { State, type AgentTask } from "../core/state";
import { Timer, PHASE_COLORS, clockText, phaseLabel } from "../core/timer";
import { createMiniBot } from "../mascot/minibots";
import { h, clear } from "../views/dom";
import { liveRing, type LiveRing } from "../views/extra";
import { proIcon } from "../views/pro-icons";
import { vizEl } from "../views/viz";
import type { IslandMode, IslandViewName } from "../core/layout";

export type LiveKind = "session" | "call" | "timer" | "download" | "music";

const D = 30;
const GAP = 12;
const NS = "http://www.w3.org/2000/svg";
const BUSY = new Set(["working", "thinking", "approval", "question"]);
const CALL_COLOR = "#34D399";
const DOWNLOAD_COLOR = "#38BDF8";

export function busySession(): AgentTask | null {
  const busy = State.ownSessions.filter((t) => BUSY.has(t.state));
  busy.sort((a, b) => (a.state === "approval" ? -1 : 0) - (b.state === "approval" ? -1 : 0) || (b.lastEventAt ?? 0) - (a.lastEventAt ?? 0));
  return busy[0] ?? null;
}

export function musicLive(): boolean {
  return State.settings.mediaEnabled && !!State.media?.active && State.media.playing;
}

export function liveKinds(): LiveKind[] {
  const out = baseLiveKinds();
  const preferred = State.livePreferred as LiveKind | null;
  if (!preferred || out[0] === preferred || !out.includes(preferred)) return out;
  if (out[0] === "session" && busySession()?.state === "approval") return out;
  return [preferred, ...out.filter((k) => k !== preferred)];
}

export function baseLiveKinds(): LiveKind[] {
  const out: LiveKind[] = [];
  const session = busySession();
  if (session?.state === "approval") out.push("session");
  if (State.call && State.settings.callActivity) out.push("call");
  if (session && !out.includes("session")) out.push("session");
  if (Timer.active) out.push("timer");
  if (State.download && State.settings.downloadsEnabled) out.push("download");
  if (musicLive()) out.push("music");
  return out;
}

function gooFilter(): SVGSVGElement {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("width", "0");
  svg.setAttribute("height", "0");
  svg.setAttribute("aria-hidden", "true");
  svg.style.position = "absolute";
  const filter = document.createElementNS(NS, "filter");
  filter.setAttribute("id", "tako-goo");
  filter.setAttribute("x", "-50%");
  filter.setAttribute("y", "-50%");
  filter.setAttribute("width", "200%");
  filter.setAttribute("height", "200%");
  const blur = document.createElementNS(NS, "feGaussianBlur");
  blur.setAttribute("in", "SourceGraphic");
  blur.setAttribute("stdDeviation", "4");
  const matrix = document.createElementNS(NS, "feColorMatrix");
  matrix.setAttribute("mode", "matrix");
  matrix.setAttribute("values", "1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 18 -7");
  filter.append(blur, matrix);
  svg.append(filter);
  return svg;
}

function blobRing(): { el: SVGSVGElement; bar: SVGCircleElement; track: SVGCircleElement } {
  const el = document.createElementNS(NS, "svg");
  el.setAttribute("viewBox", "0 0 100 100");
  el.setAttribute("class", "blob-ring");
  const track = document.createElementNS(NS, "circle");
  const bar = document.createElementNS(NS, "circle");
  for (const c of [track, bar]) {
    c.setAttribute("cx", "50");
    c.setAttribute("cy", "50");
    c.setAttribute("r", "45");
    c.setAttribute("fill", "none");
  }
  track.setAttribute("class", "br-track");
  bar.setAttribute("class", "br-bar");
  bar.setAttribute("pathLength", "100");
  bar.setAttribute("stroke-dasharray", "100");
  bar.setAttribute("transform", "rotate(-90 50 50)");
  el.append(track, bar);
  return { el, bar, track };
}

export interface LiveSync {
  primary: LiveKind | null;
  secondary: LiveKind | null;
}

export class LiveLayer {
  readonly goo: HTMLElement;
  readonly bubble: HTMLElement;
  readonly strip: HTMLElement;
  readonly bar: HTMLElement;
  readonly ringEl: SVGSVGElement;
  readonly defs: SVGSVGElement = gooFilter();

  onOpen: ((kind: LiveKind) => void) | null = null;

  private gooPill: HTMLElement;
  private gooBall: HTMLElement;
  private inner: HTMLElement;
  private stripIcon: HTMLElement;
  private stripLabel: HTMLElement;
  private stripTime: HTMLElement;
  private barFill: HTMLElement;
  private ring = blobRing();
  private bubbleRing: LiveRing = liveRing(26, 3);
  private bubbleText: HTMLElement;
  private offset = new Spring(0, 0.42, 0.6);
  private kind: LiveKind | null = null;
  private shown: LiveKind | null = null;
  private stripKind: LiveKind | null = null;
  private contentKey = "";
  private pill = { x: 0, w: 0, h: 0, r: 0 };
  private mode: IslandMode = "hidden";
  private clock: number | null = null;
  private hidden = false;

  constructor() {
    this.gooPill = h("div", { class: "goo-pill" });
    this.gooBall = h("div", { class: "goo-ball" });
    this.goo = h("div", { id: "goo" }, this.gooPill, this.gooBall);
    this.inner = h("div", { class: "lb-inner" });
    this.bubbleText = h("span", { class: "lb-text" });
    this.bubble = h("div", { id: "live-bubble", title: "" }, this.inner);
    this.bubble.addEventListener("mousedown", (e) => {
      e.stopPropagation();
      if (this.shown) this.onOpen?.(this.shown);
    });
    this.stripIcon = h("span", { class: "ls-icon" });
    this.stripLabel = h("span", { class: "ls-label" });
    this.stripTime = h("span", { class: "ls-time" });
    this.strip = h("div", { id: "live-strip" }, this.stripIcon, this.stripLabel, this.stripTime);
    this.barFill = h("i");
    this.bar = h("div", { id: "live-bar" }, this.barFill);
    this.ringEl = this.ring.el;
    Timer.onTick(() => this.tick());
  }

  get animating(): boolean {
    return !this.offset.settled;
  }

  get bubbleKind(): LiveKind | null {
    return this.shown;
  }

  setHidden(on: boolean) {
    this.hidden = on;
  }

  bubbleRect(): { x: number; y: number; w: number; h: number } | null {
    if (this.mode !== "compact" || this.hidden || !this.shown || this.offset.value < 0.5) return null;
    const cx = this.centerX();
    return { x: cx - D / 2, y: 0, w: D, h: Math.max(this.pill.h, D + 2) };
  }

  private centerX(): number {
    const right = this.pill.x + this.pill.w;
    return right + lerp(-D / 2 - 4, GAP + D / 2, this.offset.value);
  }

  sync(mode: IslandMode, view: IslandViewName): LiveSync {
    this.mode = mode;
    const kinds = liveKinds();
    const primary = kinds[0] ?? null;
    const secondary = kinds[1] ?? null;
    const wanted = mode === "compact" && !this.hidden ? secondary : null;
    if (wanted !== this.kind) {
      this.kind = wanted;
      if (wanted) {
        if (!this.shown || this.offset.value < 0.2) this.shown = wanted;
        this.offset.target = 1;
      } else {
        this.offset.target = 0;
      }
    }
    if (wanted && this.shown !== wanted && this.offset.value > 0.2) {
      this.shown = wanted;
    }
    this.renderBubble();
    this.renderStrip(mode, primary);
    this.renderRing(mode, view, primary);
    this.syncClock(kinds);
    return { primary, secondary };
  }

  layout(x: number, w: number, hh: number, r: number, mode: IslandMode) {
    this.pill = { x, w, h: hh, r };
    this.mode = mode;
    const visible = mode === "compact" && !this.hidden && (this.offset.value > 0.02 || this.offset.target > 0);
    this.goo.style.display = visible ? "block" : "none";
    this.bubble.style.display = visible ? "grid" : "none";
    if (!visible) return;
    this.gooPill.style.left = `${x}px`;
    this.gooPill.style.width = `${w}px`;
    this.gooPill.style.height = `${hh + 30}px`;
    this.gooPill.style.borderRadius = `0 0 ${r}px ${r}px`;
    const cx = this.centerX();
    const cy = hh / 2;
    const size = lerp(D * 0.55, D, clamp(this.offset.value * 1.4, 0, 1));
    this.gooBall.style.width = `${size}px`;
    this.gooBall.style.height = `${size}px`;
    this.gooBall.style.left = `${cx - size / 2}px`;
    this.gooBall.style.top = `${cy - size / 2}px`;
    this.bubble.style.left = `${cx - D / 2}px`;
    this.bubble.style.top = `${cy - D / 2}px`;
    this.bubble.style.opacity = String(clamp((this.offset.value - 0.55) * 3, 0, 1));
  }

  step(dt: number, botX: number, botY: number, botDiameter: number) {
    this.offset.step(dt);
    if (this.offset.target === 0 && this.offset.value < 0.03) {
      this.offset.set(0);
      this.shown = null;
    }
    const scale = this.mode === "compact" ? 1.5 : 2.05;
    const size = Math.max(0, botDiameter * scale);
    this.ringEl.style.width = `${size}px`;
    this.ringEl.style.height = `${size}px`;
    this.ringEl.style.left = `${botX - size / 2}px`;
    this.ringEl.style.top = `${botY - size / 2}px`;
  }

  tick() {
    this.renderStripTime();
    this.renderRingProgress();
    if (this.shown === "timer") this.renderTimerBubble();
  }

  private syncClock(kinds: LiveKind[]) {
    const need = kinds.includes("call") || kinds.includes("download");
    if (need && this.clock == null) {
      this.clock = window.setInterval(() => {
        this.renderStripTime();
        if (this.shown === "call") this.renderCallBubble();
      }, 1000);
    } else if (!need && this.clock != null) {
      window.clearInterval(this.clock);
      this.clock = null;
    }
  }

  private renderStrip(mode: IslandMode, primary: LiveKind | null) {
    const kind = mode === "compact" && !this.hidden && (primary === "timer" || primary === "call" || primary === "download") ? primary : null;
    const on = kind === "timer" ? !!Timer.state : kind === "call" ? !!State.call : kind === "download" ? !!State.download : false;
    this.strip.classList.toggle("on", on);
    this.bar.classList.toggle("on", on && kind !== "call");
    this.bar.classList.toggle("flow", on && kind === "download");
    if (!on) {
      this.stripKind = null;
      return;
    }
    if (kind !== this.stripKind) {
      this.stripKind = kind;
      this.strip.dataset.kind = kind ?? "";
      clear(this.stripIcon);
      if (kind === "call") this.stripIcon.append(proIcon("phoneCall", 12, 2.2));
      if (kind === "download") this.stripIcon.append(proIcon("download", 12, 2.4));
      this.stripIcon.style.display = kind === "timer" ? "none" : "";
    }
    this.renderStripTime();
  }

  private renderStripTime() {
    if (this.stripKind === "call") {
      const c = State.call;
      if (!c) return;
      this.strip.style.setProperty("--tm", CALL_COLOR);
      this.stripLabel.textContent = c.app;
      this.stripTime.textContent = clockSince(c.since);
      this.strip.classList.remove("paused", "done");
      return;
    }
    if (this.stripKind === "download") {
      const d = State.download;
      if (!d) return;
      this.strip.style.setProperty("--tm", DOWNLOAD_COLOR);
      const more = State.downloadCount > 1 ? ` +${State.downloadCount - 1}` : "";
      this.stripLabel.textContent = `${d.name ? middle(d.name, 22) : "Téléchargement"}${more}`;
      this.stripTime.textContent = d.speed > 0 ? `${bytes(d.bytes)} · ${bytes(d.speed)}/s` : bytes(d.bytes);
      this.strip.classList.remove("paused", "done");
      this.barFill.style.background = DOWNLOAD_COLOR;
      return;
    }
    const s = Timer.state;
    if (!s || this.stripKind !== "timer") return;
    const color = PHASE_COLORS[s.phase];
    this.stripLabel.textContent = s.done ? "Terminé" : phaseLabel(s);
    this.stripTime.textContent = s.done ? "00:00" : clockText(Timer.remaining());
    this.strip.classList.toggle("paused", !s.running && !s.done);
    this.strip.classList.toggle("done", s.done);
    this.strip.style.setProperty("--tm", color);
    this.barFill.style.width = `${(1 - Timer.progress()) * 100}%`;
    this.barFill.style.background = color;
  }

  private renderRing(mode: IslandMode, view: IslandViewName, primary: LiveKind | null) {
    const s = Timer.state;
    const on = !this.hidden && !!s && ((mode === "compact" && primary === "timer") || (mode === "expanded" && view === "timer"));
    this.ringEl.classList.toggle("on", on);
    this.ringEl.classList.toggle("done", !!s?.done);
    if (on) this.renderRingProgress();
  }

  private renderRingProgress() {
    const s = Timer.state;
    if (!s) return;
    this.ring.bar.setAttribute("stroke", s.done ? "#F5A524" : PHASE_COLORS[s.phase]);
    this.ring.bar.setAttribute("stroke-dashoffset", String(100 - Timer.progress() * 100));
  }

  private renderTimerBubble() {
    const s = Timer.state;
    if (!s) return;
    this.bubbleRing.set(Timer.progress() * 100);
    this.bubbleRing.el.querySelector(".ring-bar")?.setAttribute("stroke", s.done ? "#F5A524" : PHASE_COLORS[s.phase]);
    const mins = Math.ceil(Timer.remaining() / 60_000);
    this.bubbleText.textContent = s.done ? "!" : !s.running ? "II" : mins > 99 ? "99+" : String(mins);
  }

  private renderCallBubble() {
    const c = State.call;
    this.bubble.title = c ? `${c.app} · ${clockSince(c.since)}` : "";
  }

  private renderBubble() {
    const kind = this.shown;
    const task = kind === "session" ? busySession() : null;
    const m = State.media;
    const key = `${kind}~${task?.id ?? ""}~${task?.state ?? ""}~${kind === "music" ? `${m?.title}~${m?.art?.length ?? 0}` : ""}~${kind === "call" ? State.call?.app : ""}`;
    if (key === this.contentKey) {
      if (kind === "timer") this.renderTimerBubble();
      return;
    }
    this.contentKey = key;
    clear(this.inner);
    this.bubble.className = kind ? `lb-${kind}` : "";
    if (kind === "timer") {
      this.inner.append(this.bubbleRing.el, this.bubbleText);
      this.bubble.title = "Minuteur";
      this.renderTimerBubble();
    } else if (kind === "music" && m) {
      const art = h("div", { class: "lb-art" });
      if (m.art && m.art.startsWith("data:image/")) art.append(h("img", { src: m.art, alt: "" }));
      this.inner.append(art, vizEl(3, "lb-viz"));
      this.bubble.title = [m.title, m.artist].filter(Boolean).join(" · ");
    } else if (kind === "session" && task) {
      this.inner.append(createMiniBot(task, 20));
      this.bubble.classList.toggle("asking", task.state === "approval");
      this.bubble.title = task.name;
    } else if (kind === "call") {
      this.inner.append(proIcon("phoneCall", 14, 2.2));
      this.renderCallBubble();
    } else if (kind === "download") {
      this.inner.append(h("i", { class: "lb-spin" }), proIcon("download", 13, 2.4));
      this.bubble.title = State.download?.name || "Téléchargement";
    }
  }
}
