import { BotEngine } from "../mascot/engine";

const live = new Set<() => void>();
const ticks = new Set<(dt: number) => void>();
let mouse = { x: -9999, y: -9999 };
let running = false;
let last = 0;
let drawn = 0;
let moved = performance.now();

const FRAME_MS = 1000 / 30;
const IDLE_MS = 8000;

window.addEventListener("mousemove", (e) => {
  mouse = { x: e.clientX, y: e.clientY };
  moved = performance.now();
  start();
});

window.addEventListener("focus", () => {
  moved = performance.now();
  start();
});

function start() {
  if (running) return;
  running = true;
  last = performance.now();
  requestAnimationFrame(frame);
}

function frame(now: number) {
  if (now - drawn >= FRAME_MS - 1) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    drawn = now;
    for (const tick of ticks) tick(dt);
    for (const draw of live) draw();
  }
  const awake = live.size > 0 && document.visibilityState === "visible" && document.hasFocus() && now - moved < IDLE_MS;
  if (awake) requestAnimationFrame(frame);
  else running = false;
}

export function blob(diameter: number, options: { particles?: boolean; interactive?: boolean } = {}): HTMLCanvasElement {
  const engine = new BotEngine();
  const overhang = options.particles ? Math.round(diameter * 0.7) : 0;
  const w = Math.round(diameter / 0.6);
  const hCss = w + overhang;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const canvas = document.createElement("canvas");
  canvas.className = "blob";
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(hCss * dpr);
  canvas.style.width = `${w}px`;
  canvas.style.height = `${hCss}px`;
  engine.particleOverhang = overhang;
  engine.setState("idle", true);

  let dt = 0;
  let hoverTimer: number | null = null;
  const tick = (d: number) => (dt = d);
  const draw = () => {
    if (!canvas.isConnected) {
      live.delete(draw);
      ticks.delete(tick);
      return;
    }
    const r = canvas.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + w / 2 + overhang / 2;
    engine.lookX = Math.tanh((mouse.x - cx) / 260);
    engine.lookY = -Math.tanh((mouse.y - cy) / 200);
    engine.update(dt || 1 / 60);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hCss);
    engine.draw(ctx, w, hCss);
  };

  if (options.interactive) {
    canvas.addEventListener("mouseenter", () => {
      engine.blink();
      engine.tgEs = 1.08;
      hoverTimer = window.setTimeout(() => engine.triggerEmote("love"), 1400);
    });
    canvas.addEventListener("mouseleave", () => {
      engine.tgEs = 1;
      if (hoverTimer != null) window.clearTimeout(hoverTimer);
    });
    canvas.addEventListener("click", () => engine.triggerEmote("happy"));
  }

  live.add(draw);
  ticks.add(tick);
  requestAnimationFrame(() => start());
  return canvas;
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") start();
});
