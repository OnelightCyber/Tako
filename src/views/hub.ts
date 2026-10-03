import { Bridge, type NoticeInfo } from "../core/bridge";
import { ago, initials, shortDate, toneFor } from "../core/hud";
import { State } from "../core/state";
import { Timer } from "../core/timer";
import { dropNotice, openNotice } from "../island/system";
import { h, clear } from "./dom";
import { contentHeight, islandBox, setSizeHint } from "./fit";
import { proIcon, type ProIconName } from "./pro-icons";
import { weatherIcon, weatherLabel, weatherTone } from "./weather";
import type { ViewActions, ViewHost } from "./views";
import { liveRing } from "./extra";
import { VoiceUi } from "./voice";
import { mainLines, tone } from "../usage/gauge";

const DAYS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
const MONTHS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];

function quick(icon: ProIconName, label: string, run: () => void, badge = 0): HTMLElement {
  const b = h("button", { class: "home-quick", title: label }, proIcon(icon, 14, 2.1));
  if (badge > 0) b.append(h("i", { class: "home-badge", text: badge > 9 ? "9+" : String(badge) }));
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    run();
  });
  return b;
}

export function homeCard(actions: ViewActions): { el: HTMLElement; update(): void } {
  const time = h("div", { class: "home-time" });
  const date = h("div", { class: "home-date" });
  const weather = h("div", { class: "home-weather" });
  const quicks = h("div", { class: "home-quicks" });
  const today = h("button", { class: "home-today", title: "Calendrier et météo" }, time, date);
  today.addEventListener("click", (e) => {
    e.stopPropagation();
    actions.setView("today");
  });
  weather.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest(".home-wx-add")) return;
    e.stopPropagation();
    actions.setView("today");
  });
  const el = h("div", { class: "home-card" },
    h("div", { class: "home-row" }, today, weather),
    quicks,
  );
  let key = "";
  let minute = -1;

  const update = () => {
    const now = new Date();
    if (now.getMinutes() !== minute) {
      minute = now.getMinutes();
      time.textContent = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
      date.textContent = `${DAYS[now.getDay()]} ${now.getDate()} ${MONTHS[now.getMonth()]}`;
    }
    const w = State.weather;
    const busy = State.sessions.filter((t) => t.state !== "idle").length;
    const k = [
      w ? `${w.city}~${Math.round(w.temp)}~${w.code}~${w.isDay}` : State.settings.weatherCity ? "loading" : "none",
      State.settings.weatherEnabled, State.unreadNotices, busy, State.sessions.length, State.settings.hooksInstalled, Timer.active,
    ].join("|");
    if (k === key) return;
    key = k;

    date.title = busy
      ? `${busy} session${busy > 1 ? "s" : ""} Claude en cours`
      : State.settings.hooksInstalled
        ? "Claude Code est au calme"
        : "Branche Claude Code dans les réglages";

    clear(weather);
    if (State.settings.weatherEnabled && w) {
      weather.style.setProperty("--wx", weatherTone(w));
      weather.title = `${weatherLabel(w.code)} · ${w.city} · ${Math.round(w.min)}° / ${Math.round(w.max)}°`;
      weather.append(
        proIcon(weatherIcon(w), 20, 1.9),
        h("div", { class: "home-wx-text" }, h("b", { text: `${Math.round(w.temp)}°` }), h("span", { text: w.city })),
      );
    } else if (State.settings.weatherEnabled) {
      const add = h("button", { class: "home-wx-add", title: "Choisir une ville pour la météo" }, proIcon("cloudSun", 15, 2), h("span", { text: State.settings.weatherCity ? "…" : "Météo" }));
      add.addEventListener("click", (e) => {
        e.stopPropagation();
        actions.openSettingsWindow();
      });
      weather.append(add);
    }

    clear(quicks);
    quicks.append(
      quick("chat", "Demander à Claude", () => actions.setView("prompt")),
      quick("timer", Timer.active ? "Minuteur en cours" : "Lancer un focus", () => actions.setView("timer")),
      quick("rocket", "Nouvelle mission", () => actions.setView("mission")),
      quick("bell", "Notifications", () => actions.setView("notifications"), State.unreadNotices),
    );
  };

  const tick = () => {
    if (el.isConnected) update();
    window.setTimeout(tick, 60_000 - (Date.now() % 60_000) + 50);
  };
  window.setTimeout(tick, 60_000 - (Date.now() % 60_000) + 50);
  update();
  return { el, update };
}

function noticeRow(n: NoticeInfo, actions: ViewActions): HTMLElement {
  const lead = h("div", { class: "nt-lead" });
  if (n.logo && n.logo.startsWith("data:image/")) lead.append(h("img", { src: n.logo, alt: "" }));
  else {
    lead.append(h("span", { text: initials(n.app || n.title || "?") }));
    lead.style.background = toneFor(n.app || n.title);
  }
  const close = h("button", { class: "nt-x", title: "Effacer" }, proIcon("x", 11, 2.4));
  close.addEventListener("click", (e) => {
    e.stopPropagation();
    dropNotice(n.id, n.at);
  });
  const mute = h("button", { class: "nt-mute", title: `Ne plus afficher ${n.app}` }, proIcon("bellOff", 11, 2.2));
  mute.addEventListener("click", (e) => {
    e.stopPropagation();
    const id = n.app || n.appId;
    if (!id) return;
    const lower = id.toLowerCase();
    if (!State.settings.notificationsMuted.some((m) => m.toLowerCase() === lower)) State.settings.notificationsMuted = [...State.settings.notificationsMuted, id];
    State.notices = State.notices.filter((x) => (x.app || x.appId).toLowerCase() !== lower && (x.appId || "").toLowerCase() !== lower);
    State.unreadNotices = Math.min(State.unreadNotices, State.notices.length);
    void Bridge.saveSettings(State.settings);
    State.notify();
  });
  const row = h("div", { class: "nt-row" },
    lead,
    h("div", { class: "nt-text" },
      h("div", { class: "nt-top" }, h("span", { class: "nt-app", text: n.app || "Notification" }), h("span", { class: "nt-time", text: ago(n.at, Date.now(), false) })),
      h("div", { class: "nt-title", text: n.title }),
      n.body ? h("div", { class: "nt-body", text: n.body }) : null,
    ),
    h("div", { class: "nt-tools" }, mute, close),
  );
  row.addEventListener("click", () => {
    actions.blip();
    openNotice(n);
  });
  return row;
}

export function buildNotifications(actions: ViewActions): ViewHost {
  const count = h("span", { class: "nt-count" });
  const clearAll = h("button", { class: "nt-clear" }, proIcon("trash", 12, 2), h("span", { text: "Tout effacer" }));
  clearAll.addEventListener("click", () => {
    State.notices = [];
    State.unreadNotices = 0;
    State.notify();
  });
  const list = h("div", { class: "nt-list" });
  const empty = h("div", { class: "nt-empty" },
    proIcon("bell", 22, 1.8),
    h("b", { text: "Aucune notification" }),
    h("span", { text: "Les notifications de Windows (Discord, WhatsApp, Outlook…) arrivent ici et dans l'îlot." }),
  );
  const off = h("div", { class: "nt-empty" },
    proIcon("bellOff", 22, 1.8),
    h("b", { text: "Notifications désactivées" }),
    h("span", { text: "Active-les dans les réglages, section Notifications." }),
  );
  const head = h("div", { class: "nt-head" }, proIcon("bell", 14, 2.1), h("b", { text: "Notifications" }), count, h("div", { class: "grow" }), clearAll);
  const el = h("div", { class: "view" }, h("div", { class: "card nt-card" }, head, list));
  let key = "";
  const measure = () => {
    if (State.view !== "notifications" || State.mode !== "expanded") return;
    const box = islandBox(el);
    if (box) setSizeHint("notifications", 0, box.h - list.clientHeight + contentHeight(list));
  };
  return {
    el,
    sync() {
      if (State.mode === "expanded" && State.view === "notifications" && State.unreadNotices) State.unreadNotices = 0;
      requestAnimationFrame(measure);
      const k = `${State.settings.notificationsEnabled}|${State.notices.map((n) => `${n.id}:${n.at}`).join(",")}|${Math.floor(Date.now() / 60_000)}`;
      if (k === key) return;
      key = k;
      clear(list);
      count.textContent = State.notices.length ? String(State.notices.length) : "";
      clearAll.style.display = State.notices.length ? "" : "none";
      if (!State.settings.notificationsEnabled) {
        list.append(off);
        return;
      }
      if (!State.notices.length) {
        list.append(empty);
        return;
      }
      for (const n of State.notices) list.append(noticeRow(n, actions));
    },
  };
}

export function noticePill(actions: ViewActions): { el: HTMLElement; update(): void } {
  const label = h("span", { class: "lbl" });
  const count = h("i", { class: "pill-count" });
  const el = h("div", { class: "pill notice-pill", title: "Notifications", onclick: () => actions.setView("notifications") },
    h("div", { class: "pill-ico" }, proIcon("bell", 13, 2.2)), label, count);
  return {
    el,
    update() {
      const last = State.notices[0];
      label.textContent = last ? last.app || last.title || "Notifications" : "Notifications";
      count.textContent = State.unreadNotices > 9 ? "9+" : String(State.unreadNotices || "");
      count.style.display = State.unreadNotices ? "" : "none";
    },
  };
}

export interface GlancePill {
  el: HTMLElement;
  available(): boolean;
  update(): void;
}

function glance(kind: string, title: string, run: () => void): { el: HTMLElement; ico: HTMLElement; label: HTMLElement } {
  const ico = h("div", { class: `pill-ico ${kind}` });
  const label = h("span", { class: "lbl" });
  const el = h("div", { class: `pill glance-pill ${kind}-pill`, title, onclick: run }, ico, label);
  return { el, ico, label };
}

export function glancePills(actions: ViewActions): GlancePill[] {
  const wx = glance("wx", "Météo du jour", () => actions.setView("today"));
  let wxKey = "";
  const weather: GlancePill = {
    el: wx.el,
    available: () => State.settings.weatherEnabled && !!State.weather,
    update() {
      const w = State.weather;
      if (!w) return;
      const key = `${w.code}~${w.isDay}`;
      if (key !== wxKey) {
        wxKey = key;
        clear(wx.ico);
        wx.ico.append(proIcon(weatherIcon(w), 13, 2.2));
        wx.el.style.setProperty("--g", weatherTone(w));
      }
      wx.label.textContent = w.city ? `${Math.round(w.temp)}° · ${w.city}` : `${Math.round(w.temp)}°`;
    },
  };

  const us = glance("usage", "Ton utilisation de Claude", () => actions.openSettingsWindow());
  const ring = liveRing(20, 2.6);
  us.ico.append(ring.el);
  const usage: GlancePill = {
    el: us.el,
    available: () => !!State.usage && State.usage.lines.length > 0,
    update() {
      const line = State.usage ? mainLines(State.usage.lines)[0] : undefined;
      if (!line) return;
      ring.set(line.percent);
      ring.el.querySelector(".ring-bar")?.setAttribute("stroke", tone(line.percent));
      us.label.textContent = `Claude ${line.percent} %`;
    },
  };

  const vo = glance("voice", "Parler à Tako", () => {
    actions.blip();
    VoiceUi.onListen();
  });
  vo.ico.append(proIcon("mic", 13, 2.2));
  vo.label.textContent = "« Hey Tako »";
  const voice: GlancePill = {
    el: vo.el,
    available: () => State.settings.voiceEnabled && !State.gameMode,
    update() {},
  };

  const day = glance("today", "Aujourd'hui", () => actions.setView("today"));
  day.ico.append(proIcon("calendar", 13, 2.2));
  const today: GlancePill = {
    el: day.el,
    available: () => true,
    update() {
      day.label.textContent = shortDate(new Date());
    },
  };

  const tm = glance("timer", "Lancer un minuteur", () => actions.setView("timer"));
  tm.ico.append(proIcon("timer", 13, 2.2));
  tm.label.textContent = "Minuteur";
  const timer: GlancePill = {
    el: tm.el,
    available: () => !Timer.state,
    update() {},
  };

  return [weather, usage, voice, today, timer];
}

export function privacyPill(): { el: HTMLElement; update(): void } {
  const label = h("span", { class: "lbl" });
  const ico = h("div", { class: "pill-ico privacy" });
  const el = h("div", { class: "pill privacy-pill" }, ico, label);
  let key = "";
  return {
    el,
    update() {
      const p = State.privacy;
      const k = `${p.mic.map((u) => u.app).join(",")}|${p.cam.map((u) => u.app).join(",")}`;
      if (k === key) return;
      key = k;
      clear(ico);
      const cam = p.cam.length > 0;
      ico.append(proIcon(cam ? "camera" : "mic", 13, 2.2));
      ico.classList.toggle("cam", cam);
      el.classList.toggle("cam", cam);
      const who = (cam ? p.cam : p.mic).map((u) => u.app).join(", ");
      label.textContent = `${cam ? "Caméra" : "Micro"} · ${who}`;
      el.title = [p.mic.length ? `Micro : ${p.mic.map((u) => u.app).join(", ")}` : "", p.cam.length ? `Caméra : ${p.cam.map((u) => u.app).join(", ")}` : ""].filter(Boolean).join(" · ");
    },
  };
}
