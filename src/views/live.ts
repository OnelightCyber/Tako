import { h, clear } from "./dom";
import { proIcon, type ProIconName } from "./pro-icons";
import { liveRing } from "./extra";
import { contentHeight, islandBox, setSizeHint } from "./fit";
import { Bridge } from "../core/bridge";
import { Sound } from "../core/sound";
import { State } from "../core/state";
import { Timer, PHASE_COLORS, clockText, phaseLabel } from "../core/timer";
import { washRGBA } from "../core/layout";
import type { ViewActions, ViewHost } from "./views";

const DEVICE_ICONS: Record<string, ProIconName> = {
  headphones: "headphones",
  speaker: "speaker",
  phone: "phone",
  gamepad: "gamepad",
  peripheral: "bluetooth",
  device: "bluetooth",
};

function btn(label: string, kind: "primary" | "secondary" | "danger", onClick: () => void, icon?: ProIconName): HTMLButtonElement {
  return h("button", { class: `btn ${kind}`, onclick: onClick }, icon ? proIcon(icon, 12, 2.2) : null, h("span", { text: label })) as HTMLButtonElement;
}

function batteryTone(level: number): string {
  if (level <= 20) return "#F4505E";
  if (level <= 45) return "#F5A524";
  return "#34D399";
}

export function buildTimer(actions: ViewActions): ViewHost {
  const chip = h("span", { class: "tm-chip" });
  const dots = h("span", { class: "tm-dots" });
  const time = h("div", { class: "tm-time" });
  const sub = h("div", { class: "tm-sub" });
  const row = h("div", { class: "actions tm-actions" });
  const presets = h("div", { class: "tm-presets" });
  const body = h("div", { class: "stack tm-stack" }, h("div", { class: "tm-head" }, chip, dots), time, sub, row, presets);
  const card = h("div", { class: "card wash tm-card" }, body);
  const el = h("div", { class: "view" }, card);

  let key = "";

  const paint = () => {
    const s = Timer.state;
    time.textContent = clockText(s ? Timer.remaining() : State.settings.pomodoroFocus * 60_000);
    time.classList.toggle("last", !!s?.running && Timer.remaining() < 60_000);
  };
  Timer.onTick(() => {
    if (State.view === "timer" && State.mode === "expanded") paint();
  });

  let builtAt = 0;
  const preset = (label: string, run: () => void, primary = false) => {
    const b = h("button", { class: `tm-preset${primary ? " primary" : ""}`, text: label });
    b.addEventListener("click", () => {
      if (performance.now() - builtAt < 600) return;
      Sound.play("approve");
      run();
    });
    return b;
  };

  return {
    el,
    sync() {
      const s = Timer.state;
      const k = s ? `${s.phase}~${s.running}~${s.done}~${s.round}~${s.rounds}` : "idle";
      if (k !== key) {
        key = k;
        const color = s ? PHASE_COLORS[s.phase] : PHASE_COLORS.focus;
        el.style.setProperty("--tm", color);
        card.style.setProperty("--wash", s?.done ? washRGBA("amber") : s?.phase === "break" || s?.phase === "long" ? washRGBA("green") : `${color}40`);
        chip.textContent = s ? phaseLabel(s) : "Minuteur";
        clear(dots);
        if (s?.pomodoro) {
          for (let i = 1; i <= s.rounds; i++) {
            const done = i < s.round || (i === s.round && s.done && s.phase === "focus");
            dots.append(h("i", { class: `${done ? "on" : ""}${i === s.round && !s.done ? " now" : ""}` }));
          }
        }
        clear(row);
        clear(presets);
        builtAt = performance.now();
        if (!s) {
          sub.textContent = "Lance un focus Pomodoro ou un minuteur.";
          presets.append(
            preset(`Pomodoro ${State.settings.pomodoroFocus} min`, () => Timer.startPomodoro(), true),
            preset("5 min", () => Timer.startMinutes(5)),
            preset("10 min", () => Timer.startMinutes(10)),
            preset("15 min", () => Timer.startMinutes(15)),
            preset("30 min", () => Timer.startMinutes(30)),
            preset("1 h", () => Timer.startMinutes(60)),
          );
        } else if (s.done) {
          if (s.pomodoro) {
            const nextIsBreak = s.phase === "focus";
            const long = nextIsBreak && s.round >= s.rounds;
            sub.textContent = nextIsBreak ? (long ? "Bien joué, tu as fini le cycle !" : "Bien joué ! Une petite pause ?") : "Pause finie, on repart ?";
            const label = nextIsBreak
              ? `${long ? "Grande pause" : "Pause"} ${long ? State.settings.pomodoroLong : State.settings.pomodoroBreak} min`
              : `Focus ${State.settings.pomodoroFocus} min`;
            row.append(btn(label, "primary", () => Timer.next(), "play"));
          } else {
            sub.textContent = "C'est l'heure !";
          }
          row.append(btn("+5 min", "secondary", () => Timer.addMinutes(5), "plusSmall"), btn("Terminer", "secondary", () => {
            Timer.stop();
            actions.collapse();
          }));
        } else if (s.running) {
          sub.textContent = s.phase === "focus" ? "Concentre-toi, Tako garde l'œil sur Claude." : s.phase === "custom" ? "Le minuteur tourne." : "Respire, bouge un peu.";
          row.append(
            btn("Pause", "secondary", () => Timer.pause(), "pause"),
            btn("+5 min", "secondary", () => Timer.addMinutes(5), "plusSmall"),
            btn("Arrêter", "danger", () => Timer.stop(), "stop"),
          );
        } else {
          sub.textContent = "En pause.";
          row.append(
            btn("Reprendre", "primary", () => Timer.resume(), "play"),
            btn("Arrêter", "danger", () => Timer.stop(), "stop"),
          );
        }
      }
      paint();
    },
  };
}

export function timerPill(actions: ViewActions): { el: HTMLElement; update(): void } {
  const ring = liveRing(20, 2.6);
  const label = h("span", { class: "lbl timer" });
  const el = h("div", { class: "pill timer-pill", title: "Minuteur", onclick: () => actions.setView("timer") }, h("div", { class: "tp-ring" }, ring.el), label);
  return {
    el,
    update() {
      const s = Timer.state;
      if (!s) return;
      ring.set(Timer.progress() * 100);
      ring.el.querySelector(".ring-bar")?.setAttribute("stroke", PHASE_COLORS[s.phase]);
      label.textContent = s.done ? "Terminé" : `${clockText(Timer.remaining())}${s.running ? "" : " ⏸"}`;
    },
  };
}

export function buildBluetooth(actions: ViewActions): ViewHost {
  const ring = liveRing(92, 6);
  const icon = h("div", { class: "bt-icon" });
  const hero = h("div", { class: "bt-hero" }, ring.el, icon);
  const name = h("div", { class: "bt-name" });
  const status = h("div", { class: "bt-status" });
  const level = h("div", { class: "bt-level" });
  const body = h("div", { class: "bt-body" }, hero, h("div", { class: "bt-text" }, name, status, level));
  const el = h("div", { class: "view" }, h("div", { class: "card wash bt-card" }, body));

  let key = "";
  let closeTimer: number | null = null;

  return {
    el,
    sync() {
      const e = State.btEvent;
      if (!e) return;
      const k = `${e.address}~${e.battery}~${e.connected}`;
      if (k === key) return;
      const fresh = key.split("~")[0] !== e.address || key.split("~")[2] !== String(e.connected);
      key = k;
      clear(icon);
      icon.append(proIcon(DEVICE_ICONS[e.kind] ?? "bluetooth", 38, 1.7));
      name.textContent = e.name || "Appareil Bluetooth";
      status.textContent = e.connected ? (e.test ? "Connecté · test" : "Connecté") : "Déconnecté";
      const color = e.battery != null ? batteryTone(e.battery) : "#60A5FA";
      el.style.setProperty("--bt", color);
      (el.querySelector(".bt-card") as HTMLElement).style.setProperty("--wash", e.battery != null && e.battery <= 20 ? washRGBA("red") : "rgba(96,165,250,0.32)");
      ring.set(e.battery ?? 100);
      ring.el.querySelector(".ring-bar")?.setAttribute("stroke", color);
      clear(level);
      if (e.battery != null) {
        level.append(h("b", { text: `${e.battery} %` }), h("span", { text: e.battery <= 20 ? "batterie faible" : "batterie" }));
      }
      if (fresh) {
        hero.classList.remove("pop");
        void hero.offsetWidth;
        hero.classList.add("pop");
        if (closeTimer != null) window.clearTimeout(closeTimer);
        closeTimer = window.setTimeout(() => {
          closeTimer = null;
          if (State.view === "bluetooth" && State.mode === "expanded" && !State.isPinned) actions.collapse();
        }, 4600);
      }
    },
  };
}

export function buildVpn(actions: ViewActions): ViewHost {
  const icon = h("div", { class: "vpn-icon" });
  const title = h("div", { class: "title" });
  const sub = h("div", { class: "sub vpn-sub" });
  const row = h("div", { class: "actions" });
  const body = h("div", { class: "stack vpn-stack" }, title, sub, row);
  const card = h("div", { class: "card wash vpn-card" }, h("div", { class: "vpn-hero" }, icon), body);
  const el = h("div", { class: "view" }, card);

  let key = "";
  let closeTimer: number | null = null;

  return {
    el,
    sync() {
      const e = State.vpnEvent;
      if (!e) return;
      const k = `${e.kind}~${e.name}~${e.location}~${e.test}`;
      if (k !== key) {
        key = k;
        const name = e.name || "Le VPN";
        const tone = e.kind === "up" ? "green" : e.kind === "off" ? "amber" : "red";
        card.style.setProperty("--wash", washRGBA(tone));
        el.dataset.kind = e.kind;
        clear(icon);
        icon.append(proIcon(e.kind === "up" ? "shieldCheck" : "shieldOff", 34, 1.8));
        if (e.kind === "up") {
          title.textContent = "VPN reconnecté";
          sub.textContent = e.location ? `${e.location} · ${name}` : `Tu es de nouveau protégé · ${name}`;
        } else if (e.kind === "off") {
          title.textContent = "VPN désactivé";
          sub.textContent = `${name} est déconnecté : ton adresse IP réelle est visible.`;
        } else {
          title.textContent = e.test ? "VPN coupé (test)" : "VPN coupé";
          sub.textContent = `${name} s'est coupé : ton adresse IP réelle est visible. Il essaie de se reconnecter.`;
        }
        clear(row);
        if (e.kind !== "up" && e.name.toLowerCase().includes("mullvad")) {
          row.append(btn("Ouvrir Mullvad", "primary", () => {
            void Bridge.vpnOpenApp();
            actions.collapse();
          }, "shield"));
        }
        row.append(btn("OK", "secondary", () => actions.collapse()));
        if (closeTimer != null) window.clearTimeout(closeTimer);
        closeTimer = null;
        if (e.kind === "up") {
          closeTimer = window.setTimeout(() => {
            closeTimer = null;
            if (State.view === "vpn" && State.mode === "expanded") actions.collapse();
          }, 4200);
        }
      }
      if (State.view === "vpn") {
        const box = islandBox(el);
        if (box) setSizeHint("vpn", 0, box.h - body.clientHeight + contentHeight(body));
      }
    },
  };
}
