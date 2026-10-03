import "./settings.css";
import { Bridge, onEvent } from "../core/bridge";
import { Sound } from "../core/sound";
import { DEFAULT_SETTINGS, type Settings } from "../core/state";
import { h, clear } from "../views/dom";
import { proIcon } from "../views/pro-icons";
import { blob } from "./blob";
import { NAV, app, navItem, type Ctx, type PageId, type UpdateInfo } from "./ctx";
import { closeDropdowns } from "./dropdown";
import { appearancePage, chatPage, claudePage, generalPage, homePage } from "./pages-core";
import { gamePage, livePage, networkPage, notificationsPage, systemPage } from "./pages-modules";
import { INTEGRATIONS, aboutPage, integrationsPage, usagePage } from "./pages-more";
import { lensPage, squadPage, voicePage } from "./pages-assist";
import { pill, tile } from "./ui";

interface SearchEntry {
  page: PageId;
  title: string;
  desc: string;
  text: string;
}

const root = document.getElementById("settings-root")!;
const doze = () => document.documentElement.classList.toggle("asleep", !document.hasFocus());
window.addEventListener("focus", doze);
window.addEventListener("blur", doze);
doze();
const pageHost = h("main", { class: "content" });
const navHost = h("nav", { class: "nav-items" });
const footHost = h("div", { class: "nav-foot" });
const toastEl = h("div", { class: "toast" });
const search = h("input", { class: "search-input", type: "search", placeholder: "Rechercher un réglage", spellcheck: "false", autocomplete: "off" }) as HTMLInputElement;
let current: PageId = "home";
let toastTimer: number | null = null;
let index: SearchEntry[] | null = null;

function buildPage(id: PageId): Node[] {
  switch (id) {
    case "home": return homePage();
    case "general": return generalPage();
    case "appearance": return appearancePage();
    case "claude": return claudePage();
    case "chat": return chatPage();
    case "voice": return voicePage();
    case "squad": return squadPage();
    case "usage": return usagePage();
    case "live": return livePage();
    case "notifications": return notificationsPage();
    case "lens": return lensPage();
    case "system": return systemPage();
    case "network": return networkPage();
    case "game": return gamePage();
    case "integrations": return integrationsPage();
    case "about": return aboutPage();
  }
}

function toast(text: string, kind: "ok" | "err" = "ok") {
  clear(toastEl);
  toastEl.append(proIcon(kind === "ok" ? "check" : "x", 14, 2.4), h("span", { text }));
  toastEl.className = `toast show ${kind}`;
  if (toastTimer != null) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toastEl.className = `toast ${kind}`), 2200);
}

function badgeFor(id: PageId): HTMLElement | null {
  const c = app.ctx;
  if (id === "claude" && (!c.hooks.installed || !c.hooks.upToDate)) return h("i", { class: "nav-badge" });
  if (id === "about" && c.update) return h("i", { class: "nav-badge update" });
  return null;
}

function renderNav() {
  clear(navHost);
  for (const g of NAV) {
    const block = h("div", { class: "nav-group" });
    if (g.group) block.append(h("div", { class: "nav-label", text: g.group }));
    for (const item of g.items) {
      const b = h("button", { type: "button", class: item.id === current && !search.value ? "nav-item on" : "nav-item" },
        tile(item.icon, item.tone, 24),
        h("span", { class: "nav-text", text: item.label }),
        badgeFor(item.id),
      );
      b.addEventListener("click", () => {
        search.value = "";
        go(item.id);
      });
      block.append(b);
    }
    navHost.append(block);
  }
}

function renderFoot() {
  const c = app.ctx;
  clear(footHost);
  const ready = c.hooks.installed && (c.cc.found || c.hasKey);
  const status = h("button", { type: "button", class: "foot-status" }, pill(ready ? "ok" : "warn", ready ? "Tout est branché" : "Une étape à faire"));
  status.addEventListener("click", () => go(ready ? "home" : "claude"));
  footHost.append(status, h("div", { class: "foot-ver", text: `Tako ${c.version}` }));
}

function mount(nodes: Node[]) {
  clear(pageHost);
  const page = h("div", { class: "page" });
  page.append(...nodes);
  pageHost.append(page);
  pageHost.scrollTo({ top: 0, behavior: "instant" });
}

function go(id: PageId, focus?: string) {
  closeDropdowns();
  current = id;
  history.replaceState(null, "", `#${id}`);
  renderNav();
  mount(buildPage(id));
  if (focus) {
    requestAnimationFrame(() => {
      const target = Array.from(pageHost.querySelectorAll<HTMLElement>("[data-title]")).find((r) => r.dataset.title === focus);
      if (!target) return;
      target.scrollIntoView({ block: "center", behavior: "smooth" });
      if (target.classList.contains("group")) target.classList.add("flash");
      target.classList.add("flash");
      window.setTimeout(() => target.classList.remove("flash"), 1800);
    });
  }
}

function buildIndex(): SearchEntry[] {
  const out: SearchEntry[] = [];
  const sandbox = h("div");
  for (const g of NAV) {
    for (const item of g.items) {
      if (item.id === "home") continue;
      clear(sandbox);
      sandbox.append(...buildPage(item.id));
      for (const r of Array.from(sandbox.querySelectorAll<HTMLElement>("[data-search]"))) {
        const title = r.dataset.title ?? "";
        if (!title) continue;
        out.push({
          page: item.id,
          title,
          desc: r.querySelector(".row-desc")?.textContent ?? "",
          text: `${r.dataset.search ?? ""} ${item.label}`.toLowerCase(),
        });
      }
      for (const g of Array.from(sandbox.querySelectorAll<HTMLElement>(".group"))) {
        const title = g.querySelector(".group-title h3")?.textContent ?? "";
        if (!title || out.some((e) => e.page === item.id && e.title === title)) continue;
        const note = g.querySelector(".group-note")?.textContent ?? "";
        g.dataset.title = title;
        out.push({ page: item.id, title, desc: note, text: `${title} ${note} ${item.label}`.toLowerCase() });
      }
    }
  }
  closeDropdowns();
  return out;
}

function fold(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function runSearch() {
  const q = fold(search.value.trim());
  if (!q) {
    go(current);
    return;
  }
  index ??= buildIndex();
  const terms = q.split(/\s+/).filter(Boolean);
  const hits = index.filter((e) => {
    const words = fold(e.text).split(/[^a-z0-9]+/).filter(Boolean);
    return terms.every((t) => words.some((w) => (t.length <= 3 ? w === t || w === `${t}s` : w.startsWith(t))));
  });
  renderNav();
  const list = h("div", { class: "results" });
  if (!hits.length) {
    list.append(h("div", { class: "results-empty" }, proIcon("search", 22, 1.8), h("b", { text: "Aucun réglage trouvé" }), h("span", { text: "Essaie « notifications », « taille », « vpn », « micro »…" })));
  }
  for (const hit of hits.slice(0, 40)) {
    const nav = navItem(hit.page);
    const b = h("button", { type: "button", class: "result" },
      tile(nav.icon, nav.tone, 30),
      h("div", { class: "result-text" }, h("b", { text: hit.title }), hit.desc ? h("span", { text: hit.desc }) : null),
      h("span", { class: "result-page", text: nav.label }),
    );
    b.addEventListener("click", () => {
      search.value = "";
      go(hit.page, hit.title);
    });
    list.append(b);
  }
  mount([
    h("header", { class: "page-head" }, tile("search", "gray", 44), h("div", {}, h("h1", { text: "Recherche" }), h("p", { text: `${hits.length} résultat${hits.length > 1 ? "s" : ""} pour « ${search.value.trim()} »` }))),
    list,
  ]);
}

async function main() {
  void Sound.preload();
  const boot = await Bridge.boot();
  const hooks = (await Bridge.hooksStatus()) ?? { installed: false, upToDate: false, settingsPath: "", hookPath: "", hookReady: false };
  const cc = (await Bridge.claudeCodeInfo()) ?? { found: false, path: "", version: "" };
  const hasKey = (await Bridge.secretPresent("anthropic-api-key")) ?? false;
  const present: Record<string, boolean> = {};
  for (const def of INTEGRATIONS) {
    for (const f of def.fields) present[f.key] = (await Bridge.secretPresent(f.key)) ?? false;
  }
  const ctx: Ctx = {
    settings: { ...DEFAULT_SETTINGS, ...(boot?.settings ?? {}) },
    version: boot?.version ?? "dev",
    hooks,
    cc,
    hasKey,
    present,
    update: null,
  };
  if (import.meta.env.DEV && location.search.includes("demo")) {
    ctx.version = "0.5.0";
    ctx.hooks = { installed: true, upToDate: true, hookReady: true, settingsPath: String.raw`C:\Users\dev\.claude\settings.json`, hookPath: String.raw`C:\Users\dev\AppData\Local\Tako\bin\tako-hook.exe` };
    ctx.cc = { found: true, path: String.raw`C:\Users\dev\.local\bin\claude.exe`, version: "2.1.286 (Claude Code)" };
    ctx.settings.chatAgent = true;
    ctx.settings.weatherCity = "Paris";
    ctx.settings.notificationsMuted = ["microsoft.teams"];
    ctx.settings.activeIntegrations = ["integration_github", "integration_vercel", "integration_stripe"];
    for (const k of ["github-token", "vercel-token", "stripe-api-key"]) ctx.present[k] = true;
  }
  app.ctx = ctx;
  app.go = go;
  app.toast = toast;
  app.refresh = () => {
    renderNav();
    renderFoot();
  };
  Sound.setEnabled(ctx.settings.soundEnabled);
  Sound.setVolume(ctx.settings.soundVolume);

  let searchTimer: number | null = null;
  search.addEventListener("input", () => {
    if (searchTimer != null) window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(runSearch, 90);
  });
  search.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      search.value = "";
      go(current);
    }
  });
  window.addEventListener("keydown", (e) => {
    if ((e.ctrlKey && e.key.toLowerCase() === "f") || (e.key === "/" && document.activeElement?.tagName !== "INPUT")) {
      e.preventDefault();
      search.focus();
      search.select();
    }
  });

  clear(root);
  root.append(
    h("div", { class: "app" },
      h("aside", { class: "nav" },
        h("div", { class: "brand" },
          h("div", { class: "brand-logo" }, blob(26)),
          h("div", { class: "brand-text" }, h("div", { class: "brand-name", text: "Tako" }), h("div", { class: "brand-sub", text: "Réglages" })),
        ),
        h("label", { class: "search" }, proIcon("search", 14, 2.2), search, h("kbd", { text: "Ctrl F" })),
        navHost,
        footHost,
      ),
      pageHost,
    ),
    toastEl,
  );
  renderNav();
  renderFoot();
  const wanted = location.hash.slice(1) as PageId;
  const valid = NAV.some((g) => g.items.some((i) => i.id === wanted));
  go(valid ? wanted : "home");
  window.addEventListener("hashchange", () => {
    const id = location.hash.slice(1) as PageId;
    if (id !== current && NAV.some((g) => g.items.some((i) => i.id === id))) go(id);
  });

  void onEvent<Settings>("settings-changed", (s) => {
    ctx.settings = { ...ctx.settings, ...s };
  });
  void onEvent<UpdateInfo>("update-available", (info) => {
    ctx.update = info;
    renderNav();
    toast(`Tako ${info.version} est disponible`);
    if (current === "about" || current === "home") go(current);
  });
}

void main();
