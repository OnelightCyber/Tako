import { State } from "../core/state";
import type { IslandViewName } from "../core/layout";

let charWidth = 0;

export function monoCharWidth(): number {
  if (charWidth) return charWidth;
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return 6.6;
  ctx.font = `11px "Cascadia Mono", Consolas, ui-monospace, monospace`;
  charWidth = ctx.measureText("M".repeat(20)).width / 20 || 6.6;
  return charWidth;
}

export function contentHeight(el: HTMLElement): number {
  let bottom = 0;
  for (const child of Array.from(el.children) as HTMLElement[]) {
    bottom = Math.max(bottom, child.offsetTop + child.offsetHeight);
  }
  return bottom + (parseFloat(getComputedStyle(el).paddingBottom) || 0);
}

export function islandBox(from: HTMLElement): { w: number; h: number } | null {
  const island = from.closest("#island") as HTMLElement | null;
  return island ? { w: island.clientWidth, h: island.clientHeight } : null;
}

export function setSizeHint(view: IslandViewName, w: number, h: number) {
  const cur = State.sizeHint;
  if (cur && cur.view === view && Math.abs(cur.w - w) < 3 && Math.abs(cur.h - h) < 3) return;
  State.sizeHint = { view, w: Math.round(w), h: Math.round(h) };
  queueMicrotask(() => State.notify());
}
