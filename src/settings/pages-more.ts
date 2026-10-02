import { Bridge, onEvent, type UsageSample } from "../core/bridge";
import type { Settings } from "../core/state";
import { h, clear } from "../views/dom";
import { brandLogo } from "../views/brand-logos";
import { proIcon } from "../views/pro-icons";
import { countdown, fetchHistory, fetchUsage, longLabel, resetDate, tone, usageError } from "../usage/gauge";
import { blob } from "./blob";
import { app, errText, save, set } from "./ctx";
import { button, field, group, pageHead, pill, row, toggle, whenShown } from "./ui";

const REPO_URL = "https://github.com/OnelightCyber/Tako";
const MAX_ACTIVE = 4;

interface IntegrationDef {
  id: string;
  name: string;
  color: string;
  blurb: string;
  fields: { key: string; label: string; placeholder: string; secret: boolean }[];
}

export const INTEGRATIONS: IntegrationDef[] = [
  { id: "integration_github", name: "GitHub", color: "#F4505E", blurb: "PR, issues et CI de tes repos",
    fields: [{ key: "github-token", label: "Token", placeholder: "ghp_…", secret: true }] },
  { id: "integration_vercel", name: "Vercel", color: "#7C5CFF", blurb: "Déploiements en cours et en échec",
    fields: [{ key: "vercel-token", label: "Token", placeholder: "…", secret: true }] },
  { id: "integration_n8n", name: "n8n", color: "#F29B38", blurb: "Exécutions de tes workflows",
    fields: [
      { key: "n8n-url", label: "URL de l'instance", placeholder: "https://n8n.exemple.com", secret: false },
      { key: "n8n-api-key", label: "Clé API", placeholder: "…", secret: true },
    ] },
  { id: "integration_resend", name: "Resend", color: "#22C55E", blurb: "Emails envoyés et rebonds",
    fields: [{ key: "resend-api-key", label: "Clé API", placeholder: "re_…", secret: true }] },
  { id: "integration_notion", name: "Notion", color: "#A3A3A3", blurb: "Pages modifiées récemment",
    fields: [{ key: "notion-api-key", label: "Token d'intégration", placeholder: "ntn_…", secret: true }] },
  { id: "integration_calcom", name: "Cal.com", color: "#C9956A", blurb: "Tes prochains rendez-vous",
    fields: [{ key: "calcom-api-key", label: "Clé API", placeholder: "cal_…", secret: true }] },
  { id: "integration_stripe", name: "Stripe", color: "#635BFF", blurb: "Paiements reçus en direct",
    fields: [{ key: "stripe-api-key", label: "Clé restreinte", placeholder: "rk_live_…", secret: true }] },
];

export function integrationsPage(): Node[] {
  const c = app.ctx;
  const counter = h("span", { class: "tag" });
  const updateCounter = () => (counter.textContent = `${c.settings.activeIntegrations.length} / ${MAX_ACTIVE} affichées`);
  updateCounter();
  const grid = h("div", { class: "int-grid" });
  for (const def of INTEGRATIONS) {
    const configured = def.fields.every((f) => c.present[f.key]);
    const active = c.settings.activeIntegrations.includes(def.id);
    let status = pill(configured ? "ok" : "off", configured ? "Connecté" : "Pas de clé");
    const statusHost = h("div", { class: "int-status" }, status);
    const sw = toggle(active, (on) => {
      const list = c.settings.activeIntegrations;
      if (on && list.length >= MAX_ACTIVE) {
        sw.classList.remove("on");
        app.toast(`${MAX_ACTIVE} pastilles maximum`, "err");
        return;
      }
      c.settings.activeIntegrations = on ? [...list, def.id] : list.filter((x) => x !== def.id);
      updateCounter();
      void save(on ? `${def.name} affiché` : `${def.name} masqué`);
    });
    const fields = h("div", { class: "int-fields" });
    for (const f of def.fields) {
      const box = field({
        value: "", placeholder: c.present[f.key] ? "••••••••  (enregistré)" : f.placeholder, secret: f.secret, button: "OK",
        onSubmit: async (value) => {
          try {
            await Bridge.secretSet(f.key, value);
            c.present[f.key] = value.length > 0;
            box.input.value = "";
            box.input.placeholder = value ? "••••••••  (enregistré)" : f.placeholder;
            const all = def.fields.every((x) => c.present[x.key]);
            const next = pill(all ? "ok" : "off", all ? "Connecté" : "Pas de clé");
            status.replaceWith(next);
            status = next;
            app.toast(value ? `${def.name} : clé enregistrée` : `${def.name} : clé retirée`);
          } catch (err) {
            app.toast(`Impossible : ${errText(err)}`, "err");
          }
        },
      });
      fields.append(h("label", { class: "int-label", text: f.label }), box.el);
    }
    const el = h("div", { class: "int-card" },
      h("div", { class: "int-head" },
        h("div", { class: "int-logo" }, brandLogo(def.id, 19) ?? h("span", { text: def.name[0] })),
        h("div", { class: "int-name" }, h("div", { class: "row-title", text: def.name }), h("div", { class: "row-desc", text: def.blurb })),
        sw,
      ),
      statusHost,
      fields,
    );
    el.style.setProperty("--c", def.color);
    el.dataset.search = `${def.name} ${def.blurb} intégration`.toLowerCase();
    el.dataset.title = def.name;
    grid.append(el);
  }
  return [
    pageHead("plug", "purple", "Intégrations", "Des pastilles de couleur à côté du personnage, pour garder un œil sur tes services."),
    group({ title: "Tes services", icon: "shieldCheck", tone: "green", right: counter, note: "Les clés vont dans le Gestionnaire d'identification Windows, jamais sur le disque. L'îlot peut seulement demander si une clé existe." }, grid),
  ];
}

const USAGE_SPOTS: [Settings["usagePosition"], string][] = [
  ["corner-left", "Coin gauche"],
  ["island-left", "Gauche de l'îlot"],
  ["island-right", "Droite de l'îlot"],
  ["corner-right", "Coin droit"],
];

function dayKey(t: number): string {
  const d = new Date(t * 1000);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function dailyUse(samples: UsageSample[]): { label: string; title: string; value: number }[] {
  const sorted = [...samples].sort((a, b) => a.t - b.t);
  const totals = new Map<string, number>();
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1];
    const b = sorted[i];
    if (a.week == null || b.week == null || a.weekResets !== b.weekResets) continue;
    const delta = b.week - a.week;
    if (delta > 0) totals.set(dayKey(b.t), (totals.get(dayKey(b.t)) ?? 0) + delta);
  }
  const out = [];
  const days = ["D", "L", "M", "M", "J", "V", "S"];
  for (let i = 13; i >= 0; i--) {
    const d = new Date();
    d.setHours(12, 0, 0, 0);
    d.setDate(d.getDate() - i);
    const value = totals.get(dayKey(d.getTime() / 1000)) ?? 0;
    out.push({ label: days[d.getDay()], title: `${d.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "short" })} : ${value} % de la semaine`, value });
  }
  return out;
}

function weeklyPeaks(samples: UsageSample[]): { label: string; title: string; value: number }[] {
  const peaks = new Map<string, { value: number; t: number }>();
  for (const s of samples) {
    if (s.week == null || !s.weekResets) continue;
    const cur = peaks.get(s.weekResets);
    if (!cur || s.week > cur.value) peaks.set(s.weekResets, { value: s.week, t: s.t });
    else cur.t = Math.max(cur.t, s.t);
  }
  return [...peaks.entries()]
    .sort((a, b) => a[1].t - b[1].t)
    .slice(-8)
    .map(([resets, p]) => {
      const date = resetDate(resets);
      const label = date ? date.toLocaleDateString("fr-FR", { day: "numeric", month: "short" }) : "—";
      return { label, title: `Semaine finissant le ${label} : ${p.value} %`, value: p.value };
    });
}

function barChart(bars: { label: string; title: string; value: number }[], max: number): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const W = 640;
  const H = 128;
  const pad = 18;
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("class", "chart");
  const slot = W / Math.max(1, bars.length);
  const bw = Math.min(28, slot * 0.6);
  const top = Math.max(max, ...bars.map((b) => b.value), 1);
  bars.forEach((b, i) => {
    const x = i * slot + (slot - bw) / 2;
    const hgt = Math.max(b.value > 0 ? 3 : 1.5, ((H - pad - 22) * b.value) / top);
    const rect = document.createElementNS(ns, "rect");
    rect.setAttribute("x", x.toFixed(1));
    rect.setAttribute("y", (H - pad - hgt).toFixed(1));
    rect.setAttribute("width", bw.toFixed(1));
    rect.setAttribute("height", hgt.toFixed(1));
    rect.setAttribute("rx", "5");
    rect.setAttribute("fill", b.value > 0 ? tone(b.value) : "rgba(255,255,255,0.08)");
    rect.style.animationDelay = `${i * 25}ms`;
    const tip = document.createElementNS(ns, "title");
    tip.textContent = b.title;
    rect.append(tip);
    const text = document.createElementNS(ns, "text");
    text.setAttribute("x", (x + bw / 2).toFixed(1));
    text.setAttribute("y", String(H - 4));
    text.setAttribute("text-anchor", "middle");
    text.textContent = b.label;
    svg.append(rect, text);
    if (b.value > 0) {
      const v = document.createElementNS(ns, "text");
      v.setAttribute("x", (x + bw / 2).toFixed(1));
      v.setAttribute("y", (H - pad - hgt - 5).toFixed(1));
      v.setAttribute("text-anchor", "middle");
      v.setAttribute("class", "v");
      v.textContent = `${b.value}`;
      svg.append(v);
    }
  });
  return svg;
}

function usageWidgetGroup(): HTMLElement {
  const c = app.ctx;
  const spots = h("div", { class: "spots" });
  for (const [id, label] of USAGE_SPOTS) {
    const b = h("button", { type: "button", class: `spot${c.settings.usagePosition === id ? " on" : ""}`, title: label },
      h("div", { class: `spot-screen ${id}` }, h("i", { class: "spot-island" }), h("i", { class: "spot-widget" })),
      h("span", { text: label }));
    b.addEventListener("click", () => {
      c.settings.usagePosition = id;
      for (const el of Array.from(spots.children)) el.classList.toggle("on", el === b);
      void save("Position enregistrée");
    });
    spots.append(b);
  }
  spots.classList.toggle("disabled", !c.settings.usageWidget);
  const free = c.settings.usagePosition === "custom";
  return group({ title: "Widget d'utilisation", icon: "gauge", tone: "amber", right: free ? pill("info", "Position libre") : null,
    note: "Tes limites Claude toujours en haut de l'écran : session de 5 h et semaine. Survole-le pour le détail, glisse-le où tu veux, clic droit pour le masquer." },
    row({ icon: "eye", tone: "amber", title: "Afficher le widget", control: toggle(c.settings.usageWidget, (v) => {
      c.settings.usageWidget = v;
      spots.classList.toggle("disabled", !v);
      void save(v ? "Widget affiché" : "Widget masqué");
    }) }),
    h("div", { class: "spots-wrap" }, spots),
  );
}

export function usagePage(): Node[] {
  const c = app.ctx;
  const now = h("div", { class: "usage-now" }, h("span", { class: "muted small", text: "Lecture de /usage…" }));
  const forecast = h("p", { class: "group-note forecast" });
  whenShown(now, () => {
    void fetchUsage(false).then((r) => {
      clear(now);
      if (!r || r.lines.length === 0) {
        now.append(h("span", { class: "muted small", text: r ? usageError(r.error) : "Disponible dans l'app Tako." }));
        return;
      }
      for (const line of r.lines) {
        now.append(h("div", { class: "up-row" },
          h("div", { class: "up-top" }, h("span", { text: longLabel(line.label) }), h("b", { text: `${line.percent} %` })),
          h("div", { class: "up-bar" }, h("i", { style: `width:${line.percent}%;background:${tone(line.percent)}` })),
          line.resets ? h("div", { class: "up-sub", text: `Reset dans ${countdown(line.resets)}` }) : null,
        ));
      }
      const session = r.lines.find((l) => l.label.toLowerCase().includes("session"));
      const reset = session ? resetDate(session.resets) : null;
      if (r.forecastAt && (!reset || r.forecastAt * 1000 < reset.getTime())) {
        const at = new Date(r.forecastAt * 1000);
        forecast.textContent = `À ce rythme, ta session de 5\u00A0h sera pleine vers ${at.getHours()}\u00A0h\u00A0${String(at.getMinutes()).padStart(2, "0")}.`;
      } else if (session) {
        forecast.textContent = "À ce rythme, tu n'atteindras pas la limite avant le reset.";
      }
    });
  });

  const daily = h("div", { class: "chart-box" }, h("span", { class: "muted small", text: "Chargement…" }));
  const weekly = h("div", { class: "chart-box" });
  whenShown(daily, () => {
    void fetchHistory().then((samples) => {
      clear(daily);
      clear(weekly);
      const list = samples ?? [];
      if (list.length < 2) {
        daily.append(h("p", { class: "group-note", text: "Les données s'accumulent : Tako relève tes limites toutes les 4 minutes. Reviens dans quelques heures." }));
        return;
      }
      daily.append(barChart(dailyUse(list), 10));
      const peaks = weeklyPeaks(list);
      if (peaks.length) weekly.append(barChart(peaks, 100));
    });
  });

  return [
    pageHead("gauge", "amber", "Utilisation", "Tes limites Claude, en direct et dans le temps."),
    group({ title: "Maintenant", icon: "gauge", tone: "amber" }, now, forecast),
    group({ title: "Alertes", icon: "bolt", tone: "red" },
      row({ icon: "bell", tone: "red", title: "Me prévenir à 80 % et 90 %", desc: "Pour la session de 5 h et la semaine, avec l'heure à laquelle tu atteindras la limite à ce rythme.", keywords: "limite quota",
        control: toggle(c.settings.usageAlerts, (v) => set("usageAlerts", v)) }),
      row({ icon: "volume", tone: "green", title: "Son quand la session est rechargée", desc: "Un petit son quand ta limite de 5 h repart de zéro.",
        control: toggle(c.settings.usageRecharge, (v) => set("usageRecharge", v)) }),
    ),
    usageWidgetGroup(),
    group({ title: "Historique", icon: "layers", tone: "blue" },
      h("div", { class: "chart-title", text: "Consommation par jour (en % de la semaine)" }), daily,
      h("div", { class: "chart-title", text: "Pic de chaque semaine" }), weekly,
    ),
  ];
}

let progressHooked = false;
let progressSink: ((done: number, total: number | null) => void) | null = null;

function updatesGroup(): HTMLElement {
  const c = app.ctx;
  const status = h("p", { class: "group-note" });
  const bar = h("div", { class: "progress" }, h("i"));
  bar.style.display = "none";
  const actions = h("div", { class: "actions" });
  const right = h("span", {});
  const draw = () => {
    clear(actions);
    clear(right);
    right.append(c.update ? pill("warn", `v${c.update.version} dispo`) : pill("ok", "À jour"));
    if (c.update) {
      status.textContent = `La version ${c.update.version} est disponible (tu as la ${c.update.current}).${c.update.notes ? ` ${c.update.notes}` : ""}`;
      actions.append(button(`Installer la ${c.update.version}`, "primary", () => void install(), "bolt"));
    } else {
      status.textContent = `Tako ${c.version}. Les nouvelles versions s'installent d'un clic, et Tako vérifie tout seul toutes les 6 heures.`;
    }
    actions.append(button("Vérifier maintenant", "ghost", () => void check(), "refresh"));
  };
  const check = async () => {
    status.textContent = "Vérification…";
    try {
      c.update = (await Bridge.updateCheck()) ?? null;
      if (!c.update) app.toast("Tako est à jour");
    } catch (err) {
      status.textContent = `Impossible de vérifier : ${errText(err)}`;
      return;
    }
    draw();
    app.refresh();
  };
  const install = async () => {
    bar.style.display = "";
    status.textContent = "Téléchargement de la mise à jour…";
    clear(actions);
    try {
      await Bridge.updateInstall();
    } catch (err) {
      bar.style.display = "none";
      status.textContent = `La mise à jour a échoué : ${errText(err)}`;
      draw();
    }
  };
  progressSink = (done, total) => {
    if (!bar.isConnected) return;
    const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
    (bar.firstChild as HTMLElement).style.width = `${pct}%`;
    status.textContent = total ? `Téléchargement… ${pct} %` : "Téléchargement…";
  };
  if (!progressHooked) {
    progressHooked = true;
    void onEvent<{ done: number; total: number | null }>("update-progress", ({ done, total }) => progressSink?.(done, total));
  }
  draw();
  return group({ title: "Mises à jour", icon: "refresh", tone: "green", right }, status, bar, actions);
}

export function aboutPage(): Node[] {
  const c = app.ctx;
  return [
    pageHead("info", "gray", "À propos", `Tako ${c.version}`),
    h("section", { class: "hero small" },
      h("div", { class: "hero-glow" }),
      h("div", { class: "hero-text" },
        h("h2", { text: "L'îlot dynamique de ton PC." }),
        h("p", { text: "Tako vit en haut de ton écran : Claude Code en direct, la musique, les appels, les notifications, la batterie, les téléchargements, le minuteur." }),
        h("div", { class: "hero-actions" },
          button("Ouvrir le repo", "primary", () => void Bridge.openUrl(REPO_URL), "external"),
          button("Dossier Tako & log", "ghost", () => void Bridge.openTakoFolder(), "folder"),
        ),
      ),
      h("div", { class: "hero-art" }, blob(92, { particles: true, interactive: true })),
    ),
    updatesGroup(),
    group({ title: "Vie privée", icon: "shieldCheck", tone: "green" },
      h("ul", { class: "list" },
        h("li", { text: "Aucune télémétrie. Les seules requêtes réseau vont vers les services que tu configures." }),
        h("li", { text: "Les notifications sont lues sur ton PC et ne le quittent jamais." }),
        h("li", { text: "La météo n'envoie que le nom de ta ville à Open-Meteo, et seulement si tu en choisis une." }),
        h("li", { text: "Les clés restent dans le Gestionnaire d'identification Windows." }),
        h("li", { text: "Le chat utilise ton Claude Code ; Tako ne lit jamais tes identifiants Claude." }),
        h("li", { text: "L'écran n'est capturé que pendant une question au chat, et seulement si la vision est activée." }),
        h("li", { text: "Le log reste sur ta machine : %LOCALAPPDATA%\\Tako\\tako.log." }),
      ),
    ),
    group({ title: "Licence", icon: "file", tone: "gray" },
      h("p", { class: "group-note", text: "Code sous licence MIT. Le nom Tako, le personnage, l'icône et les sons sont réservés (LICENSE-ASSETS.md). Certaines parties du code dérivent de code MIT tiers, crédité dans THIRD_PARTY_NOTICES.md — les trois fichiers sont installés avec Tako." }),
    ),
    h("div", { class: "foot-links" }, proIcon("code", 13, 2), h("span", { text: `Tako ${c.version} · Windows` })),
  ];
}
