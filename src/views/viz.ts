import { h } from "./dom";

const live = new Set<HTMLElement>();
let fedAt = 0;

export function vizEl(count = 4, cls = ""): HTMLElement {
  const el = h("div", { class: `viz ${cls}`.trim() });
  for (let i = 0; i < count; i++) el.append(h("i"));
  live.add(el);
  return el;
}

export function feedViz(peak: number) {
  const now = performance.now();
  fedAt = now;
  const t = now / 1000;
  const level = Math.min(1, Math.pow(Math.max(0, peak), 0.55) * 1.2);
  for (const el of live) {
    if (!el.isConnected) {
      live.delete(el);
      continue;
    }
    el.classList.add("live");
    const bars = el.children;
    for (let i = 0; i < bars.length; i++) {
      const wobble = 0.5 + 0.5 * Math.abs(Math.sin(t * (2.6 + i * 1.9) + i * 1.7));
      const v = 0.16 + level * wobble * 0.84;
      (bars[i] as HTMLElement).style.transform = `scaleY(${v.toFixed(3)})`;
    }
  }
}

export function idleViz(force = false) {
  if (!force && performance.now() - fedAt < 400) return;
  for (const el of live) {
    if (!el.isConnected) {
      live.delete(el);
      continue;
    }
    if (!el.classList.contains("live")) continue;
    el.classList.remove("live");
    for (const bar of Array.from(el.children)) (bar as HTMLElement).style.transform = "";
  }
}
