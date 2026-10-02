import type { ProIconName } from "../views/pro-icons";

export interface HudAction {
  label: string;
  run: () => void;
  primary?: boolean;
}

export interface HudSpec {
  key: string;
  tone: string;
  title: string;
  icon?: ProIconName;
  image?: string | null;
  initials?: string;
  detail?: string;
  meta?: string;
  metaTone?: string;
  value?: number | null;
  banner?: boolean;
  at?: number;
  ms: number;
  priority?: number;
  onClick?: () => void;
  actions?: HudAction[];
  pulse?: boolean;
}

export interface HudShown extends HudSpec {
  id: number;
  until: number;
  height?: number;
}

interface Queued {
  spec: HudSpec;
  queuedAt: number;
  ms: number;
}

type Listener = () => void;

const MAX_QUEUE = 6;
const STALE_MS = 20_000;
const SHORTEN_MS = 2200;

const rank = (s: { priority?: number }) => s.priority ?? 1;

class HudStore {
  current: HudShown | null = null;
  private queue: Queued[] = [];
  private timer: number | null = null;
  private held = false;
  private seq = 0;
  private listeners = new Set<Listener>();

  subscribe(fn: Listener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }

  show(spec: HudSpec) {
    const now = Date.now();
    const cur = this.current;
    if (cur && cur.key === spec.key) {
      this.current = { ...spec, id: cur.id, until: now + spec.ms, height: cur.height };
      this.arm();
      this.emit();
      return;
    }
    const waiting = this.queue.findIndex((q) => q.spec.key === spec.key);
    if (waiting >= 0) {
      this.queue[waiting] = { spec, queuedAt: now, ms: spec.ms };
      return;
    }
    if (cur && rank(spec) <= rank(cur)) {
      if (rank(spec) < 2) {
        if (rank(cur) >= 2) return;
      } else {
        if (this.queue.length >= MAX_QUEUE) this.queue.shift();
        this.queue.push({ spec, queuedAt: now, ms: spec.ms });
        cur.until = Math.min(cur.until, now + SHORTEN_MS);
        this.arm();
        return;
      }
    }
    if (cur && rank(cur) >= 2 && cur.until - now > 1200) {
      this.queue.unshift({ spec: cur, queuedAt: now, ms: cur.until - now });
    }
    this.current = { ...spec, id: ++this.seq, until: now + spec.ms };
    this.arm();
    this.emit();
  }

  measured(id: number, height: number) {
    const cur = this.current;
    if (!cur || cur.id !== id || cur.height === height) return;
    cur.height = height;
    this.emit();
  }

  hold(on: boolean) {
    if (this.held === on) return;
    this.held = on;
    if (!on && this.current) {
      this.current.until = Math.max(this.current.until, Date.now() + 1400);
      this.arm();
    }
  }

  dismiss() {
    this.finish();
  }

  clear() {
    this.queue = [];
    if (this.current) this.finish();
  }

  private arm() {
    if (this.timer != null) window.clearTimeout(this.timer);
    const cur = this.current;
    if (!cur) return;
    this.timer = window.setTimeout(() => {
      this.timer = null;
      if (this.held) {
        this.arm();
        return;
      }
      if (this.current?.id === cur.id) this.finish();
    }, Math.max(60, cur.until - Date.now()));
  }

  private finish() {
    if (this.timer != null) window.clearTimeout(this.timer);
    this.timer = null;
    this.held = false;
    const now = Date.now();
    this.queue = this.queue.filter((q) => now - q.queuedAt < STALE_MS);
    const next = this.queue.shift();
    this.current = next ? { ...next.spec, id: ++this.seq, until: now + next.ms } : null;
    if (this.current) this.arm();
    this.emit();
  }
}

export const Hud = new HudStore();

export function bytes(n: number): string {
  if (n < 1024) return `${n} o`;
  const units = ["Ko", "Mo", "Go", "To"];
  let v = n / 1024;
  let i = 0;
  while (v >= 999.5 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const text = v >= 100 ? String(Math.round(v)) : v.toFixed(1).replace(".", ",").replace(",0", "");
  return `${text} ${units[i]}`;
}

export function middle(text: string, max: number): string {
  if (text.length <= max) return text;
  const dot = text.lastIndexOf(".");
  const tail = dot > 0 && text.length - dot <= 8 ? Math.min(text.length - dot + 4, Math.floor(max / 2)) : Math.floor(max / 3);
  const head = max - tail - 1;
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
}

export function clockSince(since: number, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - since) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(h ? 2 : 1, "0");
  return h ? `${h}:${mm}:${String(sec).padStart(2, "0")}` : `${mm}:${String(sec).padStart(2, "0")}`;
}

export function ago(at: number, now = Date.now(), seconds = true): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 8) return "maintenant";
  if (s < 60) return seconds ? `il y a ${s} s` : "à l'instant";
  const m = Math.round(s / 60);
  if (m < 60) return `il y a ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `il y a ${h} h`;
  return new Date(at).toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? parts[0][0] + parts[1][0] : (parts[0] ?? "?").slice(0, 2);
  return letters.toUpperCase();
}

export function toneFor(name: string): string {
  const palette = ["#FF7A59", "#5865F2", "#22C55E", "#F5A524", "#38BDF8", "#E879F9", "#F4505E", "#A78BFA"];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return palette[Math.abs(hash) % palette.length];
}

export function temp(value: number): string {
  const r = Math.round(value);
  return `${r < 0 ? "−" : ""}${Math.abs(r)}°`;
}

const SHORT_DAYS = ["dim.", "lun.", "mar.", "mer.", "jeu.", "ven.", "sam."];
const SHORT_MONTHS = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];

export function shortDate(d: Date): string {
  return `${SHORT_DAYS[d.getDay()]} ${d.getDate()} ${SHORT_MONTHS[d.getMonth()]}`;
}
