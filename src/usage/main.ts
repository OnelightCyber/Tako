import "./usage.css";
import { Bridge, onEvent, type UsageReport } from "../core/bridge";
import { DEFAULT_SETTINGS, type Settings } from "../core/state";
import { h, clear } from "../views/dom";
import { proIcon } from "../views/pro-icons";
import { countdown, fetchUsage, longLabel, mainLines, ring, shortLabel, tone, usageError } from "./gauge";

const root = document.getElementById("usage-root")!;
let report: UsageReport | null = null;
let settings: Settings = { ...DEFAULT_SETTINGS };
let open = false;
let closeTimer: number | null = null;
let loading = false;
let dragging = false;
let closing = false;

function ago(seconds: number): string {
  const mins = Math.round((Date.now() / 1000 - seconds) / 60);
  if (mins < 1) return "à l'instant";
  if (mins < 60) return `il y a ${mins} min`;
  return `il y a ${Math.round(mins / 60)} h`;
}

function isDocked(): boolean {
  const spot = settings.usagePosition;
  return spot.startsWith("island") || (spot === "custom" && settings.usageY <= 0);
}

function head(): HTMLElement {
  const el = h("div", { class: "usage-head" });
  const main = mainLines(report?.lines ?? []);
  if (!report) {
    el.append(h("span", { class: "dim", text: "Utilisation…" }));
  } else if (main.length === 0) {
    el.append(proIcon("info", 13, 2), h("span", { class: "dim", text: usageError(report.error) }));
  } else {
    for (const line of main) {
      const gauge = h("div", { class: "gauge" }, ring(line.percent), h("span", { class: "gauge-pct", text: String(line.percent) }));
      el.append(h("div", { class: "metric" }, gauge, h("span", { class: "metric-label", text: shortLabel(line.label) })));
    }
    const session = main[0];
    if (session?.resets) el.append(h("div", { class: "reset" }, proIcon("clock", 11, 2.2), h("span", { text: countdown(session.resets) })));
  }
  el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || closing) return;
    const sx = e.screenX;
    const sy = e.screenY;
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    const move = (m: PointerEvent) => {
      if (Math.abs(m.screenX - sx) + Math.abs(m.screenY - sy) < 4) return;
      stop();
      dragging = true;
      el.classList.add("grabbing");
      void Bridge.usageDrag();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  });
  return el;
}

function details(r: UsageReport): HTMLElement {
  const list = h("div", { class: "usage-list" });
  for (const line of r.lines) {
    list.append(
      h("div", { class: "row" },
        h("div", { class: "row-top" }, h("span", { text: longLabel(line.label) }), h("b", { text: `${line.percent}%` })),
        h("div", { class: "bar" }, h("i", { style: `width:${line.percent}%;background:${tone(line.percent)}` })),
        line.resets ? h("div", { class: "row-sub", text: `reset dans ${countdown(line.resets)}` }) : null,
      ),
    );
  }
  const refresh = h("button", { class: "refresh", title: "Rafraîchir" }, proIcon("refresh", 12, 2), h("span", { text: loading ? "Mise à jour…" : `Mis à jour ${ago(r.fetchedAt)}` }));
  refresh.addEventListener("click", () => void load(true));
  list.append(refresh, h("div", { class: "hint", text: "Glisse pour déplacer · clic droit pour masquer" }));
  return list;
}

function render() {
  clear(root);
  const docked = isDocked();
  const card = h("div", { class: `usage ${docked ? "docked" : "floating"}${closing ? " closing" : ""}` });
  card.append(head());
  if (open && report) card.append(details(report));

  card.addEventListener("mouseenter", () => {
    if (closeTimer != null) window.clearTimeout(closeTimer);
    if (!open && !dragging) {
      open = true;
      render();
    }
  });
  card.addEventListener("mouseleave", () => {
    if (dragging) return;
    closeTimer = window.setTimeout(() => {
      open = false;
      render();
    }, 350);
  });
  card.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    if (closing) return;
    closing = true;
    card.classList.add("closing");
    window.setTimeout(() => void Bridge.usageClose(), 180);
  });
  root.append(card);
  requestAnimationFrame(() => {
    const r = card.getBoundingClientRect();
    void Bridge.usageResize(Math.ceil(r.width) + 2, Math.ceil(r.height) + (docked ? 2 : 4));
  });
}

async function load(force: boolean) {
  if (loading) return;
  loading = true;
  if (open) render();
  report = (await fetchUsage(force)) ?? report;
  loading = false;
  render();
}

async function main() {
  document.addEventListener("contextmenu", (e) => e.preventDefault());
  const boot = await Bridge.boot();
  settings = { ...settings, ...(boot?.settings ?? {}) };
  if (new URLSearchParams(location.search).has("open")) open = true;
  render();
  if (settings.usageWidget) void load(false);
  void onEvent<UsageReport>("usage-updated", (r) => {
    report = r;
    render();
  });
  void onEvent<Settings>("settings-changed", (s) => {
    const wasOn = settings.usageWidget;
    settings = { ...settings, ...s };
    if (settings.usageWidget && !wasOn) {
      closing = false;
      open = false;
    }
    render();
    if (settings.usageWidget && (!wasOn || !report)) void load(false);
  });
  void onEvent("usage-drag-end", () => {
    dragging = false;
    render();
  });
  window.setInterval(() => render(), 60_000);
}

void main();
