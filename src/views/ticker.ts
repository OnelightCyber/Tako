import { h, svg } from "./dom";
import { ICONS } from "./icons";
import { cubicBezier, clamp, lerp } from "../core/anim";
import type { AgentTask } from "../core/state";

const ROW_H = 22;

const DURATION = 380;

const MAX_QUEUE = 4;
const COMPLETED_SCALE = 11.5 / 13;
const EASE = cubicBezier(0.4, 0, 0.2, 1);

interface Row {
  el: HTMLElement;
  chevron: SVGElement;
  check: SVGElement;
  shimmer: HTMLElement;
  dim: HTMLElement;
  text: string;
}

function makeRow(): Row {
  const chevron = svg(ICONS.chevronRight, 9, { stroke: 2.4 });
  const check = svg(ICONS.check, 8, { stroke: 2.2 });
  check.style.color = "#454850";
  check.style.position = "absolute";
  chevron.style.position = "absolute";
  const shimmer = h("span", { class: "tick-text shimmer" });
  const dim = h("span", {
    class: "tick-text",
    style: "position:absolute;left:0;right:0;top:0;color:#6b7079",
  });
  const el = h(
    "div",
    { class: "ticker-row" },
    h("span", { class: "tick-icon", style: "position:relative" }, chevron, check),
    h("span", { style: "position:relative;flex:1 1 auto;min-width:0" }, shimmer, dim),
  );
  return { el, chevron, check, shimmer, dim, text: "" };
}

function setText(row: Row, text: string) {
  if (row.text === text) return;
  row.text = text;
  row.shimmer.textContent = text;
  row.dim.textContent = text;
}

function place(row: Row, y: number, phase: number, opacity: number) {
  const scale = 1 - phase * (1 - COMPLETED_SCALE);
  row.el.style.transform = `translate(${-phase * 10}px, ${y}px) scale(${scale})`;
  row.el.style.opacity = String(opacity);
  row.chevron.style.opacity = String(clamp(1 - phase * 2, 0, 1));
  row.check.style.opacity = String(clamp(phase * 2 - 1, 0, 1));
  row.shimmer.style.opacity = String(clamp(1 - phase * 1.6, 0, 1));
  row.dim.style.opacity = String(clamp(phase * 2 - 0.4, 0, 1));
}

export function appended(before: string[], after: string[]): number {
  if (before.length === after.length && before.every((s, i) => s === after[i])) return 0;
  for (let n = 1; n <= after.length; n++) {
    const drop = before.length + n - after.length;
    if (drop < 0 || drop > before.length) continue;
    const kept = before.slice(drop);
    if (kept.length === 0 && before.length > 0) continue;
    if (kept.every((s, i) => s === after[i])) return n;
  }
  return -1;
}

export class Ticker {
  readonly el: HTMLElement;
  private a = makeRow();
  private b = makeRow();
  private c = makeRow();
  private queue: string[] = [];
  private startMs: number | null = null;
  private shown: string[] | null = null;

  constructor() {
    this.el = h("div", { class: "ticker" }, this.a.el, this.b.el, this.c.el);
    this.rest();
  }

  private rest() {
    place(this.a, 0, 1, 1);
    place(this.b, ROW_H, 0, 1);
    place(this.c, ROW_H * 2, 0, 0);
  }

  get animating(): boolean {
    return this.startMs != null || this.queue.length > 0;
  }

  sync(task: AgentTask | null) {
    const idle = task?.prompt ? task.prompt.replace(/\s+/g, " ").slice(0, 70) : "En attente de Claude…";
    const steps = task && task.steps.length > 0 ? task.steps : [idle];
    const added = this.shown ? appended(this.shown, steps) : -1;
    this.shown = [...steps];

    if (added < 0) {
      this.queue = [];
      this.startMs = null;
      setText(this.a, steps.length > 1 ? steps[steps.length - 2] : "");
      setText(this.b, steps[steps.length - 1]);
      this.rest();
      return;
    }

    if (added > 0) this.queue.push(...steps.slice(-added));
    if (this.queue.length > MAX_QUEUE) {
      this.queue = this.queue.slice(-MAX_QUEUE);
    }
  }

  tick(nowMs: number) {
    if (this.startMs == null) {
      if (this.queue.length === 0) return;
      setText(this.c, this.queue[0]);
      place(this.c, ROW_H * 2, 0, 0);
      this.startMs = nowMs;
    }

    const p = clamp((nowMs - this.startMs) / DURATION, 0, 1);
    const e = EASE(p);

    place(this.a, lerp(0, -ROW_H, e), 1, clamp(1 - p * 1.35, 0, 1));
    place(this.b, lerp(ROW_H, 0, e), e, 1);
    place(this.c, lerp(ROW_H * 2, ROW_H, e), 0, e);

    if (p < 1) return;

    setText(this.a, this.b.text);
    setText(this.b, this.c.text);
    this.queue.shift();
    this.startMs = null;
    this.rest();
  }
}
