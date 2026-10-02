import { temp } from "../core/hud";
import { State } from "../core/state";
import { h, clear } from "./dom";
import { proIcon } from "./pro-icons";
import { weatherIcon, weatherLabel, weatherTone } from "./weather";
import type { ViewActions, ViewHost } from "./views";

const MONTHS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const DAYS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
const SHORT = ["L", "M", "M", "J", "V", "S", "D"];
const SHORT_DAYS = ["dim.", "lun.", "mar.", "mer.", "jeu.", "ven.", "sam."];

function monthGrid(now: Date): HTMLElement {
  const grid = h("div", { class: "td-grid" });
  for (const d of SHORT) grid.append(h("span", { class: "td-head", text: d }));
  const first = new Date(now.getFullYear(), now.getMonth(), 1);
  const offset = (first.getDay() + 6) % 7;
  const start = new Date(first);
  start.setDate(first.getDate() - offset);
  const today = now.toDateString();
  for (let i = 0; i < 42; i++) {
    const day = new Date(start);
    day.setDate(start.getDate() + i);
    if (i >= 35 && day.getMonth() !== now.getMonth()) break;
    const cls = ["td-day"];
    if (day.getMonth() !== now.getMonth()) cls.push("other");
    if (day.toDateString() === today) cls.push("today");
    if (day.getDay() === 0 || day.getDay() === 6) cls.push("weekend");
    grid.append(h("span", { class: cls.join(" "), text: String(day.getDate()) }));
  }
  return grid;
}

function dayLabel(date: string, index: number): string {
  if (index === 0) return "auj.";
  const d = new Date(`${date}T12:00:00`);
  return Number.isNaN(d.getTime()) ? date.slice(5) : SHORT_DAYS[d.getDay()];
}

export function buildToday(actions: ViewActions): ViewHost {
  const month = h("div", { class: "td-month" });
  const weekday = h("div", { class: "td-weekday" });
  const year = h("div", { class: "td-year" });
  const big = h("div", { class: "td-big" });
  const gridHost = h("div", { class: "td-grid-host" });
  const cal = h("div", { class: "card td-cal" }, h("div", { class: "td-side" }, month, weekday, year, big), gridHost);
  const wx = h("div", { class: "card td-wx" });
  const el = h("div", { class: "view" }, h("div", { class: "td-body" }, cal, wx));
  let key = "";

  return {
    el,
    sync() {
      const now = new Date();
      const w = State.weather;
      const k = `${now.toDateString()}|${w ? `${w.city}${Math.round(w.temp)}${w.code}${w.days.length}` : "none"}|${State.settings.weatherEnabled}|${State.settings.weatherCity}`;
      if (k === key) return;
      key = k;
      month.textContent = MONTHS[now.getMonth()];
      weekday.textContent = DAYS[now.getDay()];
      year.textContent = String(now.getFullYear());
      big.textContent = String(now.getDate());
      clear(gridHost);
      gridHost.append(monthGrid(now));

      clear(wx);
      if (!State.settings.weatherEnabled || !w) {
        const add = h("button", { class: "btn primary td-add" }, proIcon("cloudSun", 13, 2.2), h("span", { text: State.settings.weatherCity ? "Météo indisponible" : "Choisir ma ville" }));
        add.addEventListener("click", () => actions.openSettingsWindow());
        wx.append(h("div", { class: "td-empty" },
          proIcon("cloudSun", 26, 1.7),
          h("b", { text: "Météo" }),
          h("span", { text: State.settings.weatherCity ? "Pas de réponse pour cette ville. Vérifie son nom dans les réglages." : "Choisis ta ville dans les réglages pour voir la météo et les prévisions." }),
          add,
        ));
        return;
      }
      wx.style.setProperty("--wx", weatherTone(w));
      const now0 = h("div", { class: "td-now" },
        h("div", { class: "td-place" }, proIcon("globe", 11, 2.2), h("span", { text: w.city })),
        h("div", { class: "td-temp" }, h("b", { text: temp(w.temp) }), h("div", { class: "td-icon" }, proIcon(weatherIcon(w), 30, 1.7))),
        h("div", { class: "td-label", text: weatherLabel(w.code) }),
        h("div", { class: "td-meta" },
          h("span", { text: `${Math.round(w.wind)} km/h` }),
          h("span", { text: `${Math.round(w.humidity)} % d'humidité` }),
        ),
      );
      const list = h("div", { class: "td-days" });
      w.days.slice(0, 5).forEach((d, i) => {
        list.append(h("div", { class: "td-row" },
          h("span", { class: "td-dname", text: dayLabel(d.date, i) }),
          h("span", { class: "td-dicon" }, proIcon(weatherIcon({ ...w, code: d.code, isDay: true }), 14, 2)),
          h("b", { text: temp(d.max) }),
          h("span", { class: "td-min", text: temp(d.min) }),
        ));
      });
      wx.append(now0, list);
    },
  };
}
