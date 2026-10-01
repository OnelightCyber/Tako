import { State } from "./state";

export type TimerPhase = "focus" | "break" | "long" | "custom";

export interface TimerState {
  phase: TimerPhase;
  durationMs: number;
  endsAt: number | null;
  remainingMs: number;
  running: boolean;
  done: boolean;
  round: number;
  rounds: number;
  pomodoro: boolean;
}

const KEY = "tako.timer";
const MINUTE = 60_000;

export const PHASE_COLORS: Record<TimerPhase, string> = {
  focus: "#FF7A59",
  break: "#34D399",
  long: "#22D3EE",
  custom: "#60A5FA",
};

export function phaseLabel(s: TimerState): string {
  switch (s.phase) {
    case "focus": return s.pomodoro ? `Focus ${s.round}/${s.rounds}` : "Focus";
    case "break": return "Pause";
    case "long": return "Grande pause";
    default: return "Minuteur";
  }
}

export function clockText(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function nextPhase(s: TimerState, rounds: number): { phase: TimerPhase; round: number } {
  if (s.phase === "focus") return { phase: s.round >= rounds ? "long" : "break", round: s.round };
  return { phase: "focus", round: s.phase === "long" ? 1 : s.round + 1 };
}

type Listener = () => void;

class TimerEngine {
  state: TimerState | null = null;
  onFinish: ((s: TimerState) => void) | null = null;
  private listeners = new Set<Listener>();
  private tickHandle: number | null = null;
  private endHandle: number | null = null;

  onTick(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  get active(): boolean {
    return !!this.state && !this.state.done;
  }

  get running(): boolean {
    return !!this.state?.running;
  }

  remaining(now = Date.now()): number {
    const s = this.state;
    if (!s) return 0;
    if (s.running && s.endsAt != null) return Math.max(0, s.endsAt - now);
    return s.remainingMs;
  }

  progress(now = Date.now()): number {
    const s = this.state;
    if (!s || !s.durationMs) return 0;
    return Math.min(1, Math.max(0, this.remaining(now) / s.durationMs));
  }

  minutesFor(phase: TimerPhase): number {
    const set = State.settings;
    if (phase === "focus") return set.pomodoroFocus;
    if (phase === "break") return set.pomodoroBreak;
    if (phase === "long") return set.pomodoroLong;
    return 25;
  }

  startPomodoro() {
    this.begin("focus", this.minutesFor("focus") * MINUTE, 1, State.settings.pomodoroRounds, true);
  }

  startMinutes(minutes: number) {
    this.begin("custom", Math.max(1, Math.round(minutes)) * MINUTE, 1, 1, false);
  }

  next() {
    const s = this.state;
    if (!s || !s.pomodoro) {
      this.stop();
      return;
    }
    const n = nextPhase(s, s.rounds);
    this.begin(n.phase, this.minutesFor(n.phase) * MINUTE, n.round, s.rounds, true);
  }

  pause() {
    const s = this.state;
    if (!s || !s.running) return;
    s.remainingMs = this.remaining();
    s.running = false;
    s.endsAt = null;
    this.clear();
    this.changed();
  }

  resume() {
    const s = this.state;
    if (!s || s.running || s.done) return;
    s.endsAt = Date.now() + s.remainingMs;
    s.running = true;
    this.schedule();
    this.changed();
  }

  addMinutes(minutes: number) {
    const s = this.state;
    if (!s) return;
    const extra = minutes * MINUTE;
    if (s.done) {
      this.begin(s.phase === "custom" ? "custom" : s.phase, extra, s.round, s.rounds, s.pomodoro);
      return;
    }
    s.durationMs += extra;
    if (s.running && s.endsAt != null) s.endsAt += extra;
    else s.remainingMs += extra;
    if (s.running) this.schedule();
    this.changed();
  }

  stop() {
    this.state = null;
    this.clear();
    this.changed();
  }

  restore() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return;
      const s = JSON.parse(raw) as TimerState;
      if (!s || typeof s.durationMs !== "number") return;
      this.state = s;
      if (s.running && s.endsAt != null && s.endsAt <= Date.now()) {
        s.running = false;
        s.done = true;
        s.remainingMs = 0;
        s.endsAt = null;
      }
      if (s.running) this.schedule();
    } catch {
      this.state = null;
    }
  }

  private begin(phase: TimerPhase, durationMs: number, round: number, rounds: number, pomodoro: boolean) {
    this.state = {
      phase,
      durationMs,
      endsAt: Date.now() + durationMs,
      remainingMs: durationMs,
      running: true,
      done: false,
      round,
      rounds: Math.max(1, rounds),
      pomodoro,
    };
    this.schedule();
    this.changed();
  }

  private schedule() {
    this.clear();
    this.tickHandle = window.setInterval(() => this.tick(), 1000);
    this.endHandle = window.setTimeout(() => this.tick(), this.remaining() + 40);
  }

  private clear() {
    if (this.tickHandle != null) window.clearInterval(this.tickHandle);
    if (this.endHandle != null) window.clearTimeout(this.endHandle);
    this.tickHandle = null;
    this.endHandle = null;
  }

  private tick() {
    const s = this.state;
    if (!s || !s.running) return;
    if (this.remaining() <= 0) {
      s.running = false;
      s.done = true;
      s.remainingMs = 0;
      s.endsAt = null;
      this.clear();
      this.changed();
      this.onFinish?.(s);
      return;
    }
    for (const fn of this.listeners) fn();
  }

  private changed() {
    try {
      if (this.state) localStorage.setItem(KEY, JSON.stringify(this.state));
      else localStorage.removeItem(KEY);
    } catch {
    }
    for (const fn of this.listeners) fn();
    State.notify();
  }
}

export const Timer = new TimerEngine();
