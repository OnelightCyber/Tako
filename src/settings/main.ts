import "./settings.css";
import { Bridge, onEvent, type HookStatus, type UsageSample } from "../core/bridge";
import { Sound } from "../core/sound";
import { DEFAULT_SETTINGS, type Settings } from "../core/state";
import { h, clear } from "../views/dom";
import { proIcon, type ProIconName } from "../views/pro-icons";
import { brandLogo } from "../views/brand-logos";
import { blob } from "./blob";
import { closeDropdowns, dropdown, type Choice } from "./dropdown";
import { countdown, fetchHistory, fetchUsage, longLabel, resetDate, tone, usageError } from "../usage/gauge";

type PageId = "home" | "claude" | "chat" | "integrations" | "island" | "usage" | "about";

interface Ctx {
  settings: Settings;
  version: string;
  hooks: HookStatus;
  cc: { found: boolean; path: string; version: string };
  hasKey: boolean;
  present: Record<string, boolean>;
}

const REPO_URL = "https://github.com/OnelightCyber/Tako";

const PAGES: { id: PageId; label: string; icon: ProIconName }[] = [
  { id: "home", label: "Accueil", icon: "home" },
  { id: "claude", label: "Claude Code", icon: "code" },
  { id: "chat", label: "Chat & agent", icon: "chat" },
  { id: "integrations", label: "Intégrations", icon: "plug" },
  { id: "island", label: "Îlot & sons", icon: "sliders" },
  { id: "usage", label: "Utilisation", icon: "gauge" },
  { id: "about", label: "À propos", icon: "info" },
];

interface IntegrationDef {
  id: string;
  name: string;
  color: string;
  blurb: string;
  fields: { key: string; label: string; placeholder: string; secret: boolean }[];
}

const INTEGRATIONS: IntegrationDef[] = [
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

const MAX_ACTIVE = 4;

const MODELS: Choice<string>[] = [
  { value: "claude-opus-5-5", label: "Claude Opus 5.5", hint: "Le plus capable" },
  { value: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", hint: "Rapide et polyvalent" },
  { value: "claude-haiku-4-5", label: "Claude Haiku 4.5", hint: "Le plus rapide, le moins cher" },
];

const SCREENS: Choice<Settings["screen"]>[] = [
  { value: "primary", label: "Écran principal", hint: "Toujours au même endroit", icon: "monitor" },
  { value: "cursor", label: "Écran sous la souris", hint: "Suit ta souris d'un écran à l'autre", icon: "eye" },
];

const root = document.getElementById("settings-root")!;
let ctx: Ctx;
let current: PageId = "home";
const pageHost = h("main", { class: "content" });
const navHost = h("nav", { class: "nav-items" });
const footHost = h("div", { class: "nav-foot" });
const toastEl = h("div", { class: "toast" });
let toastTimer: number | null = null;
let pendingUpdate: { version: string; current: string; notes: string } | null = null;

function toast(text: string, kind: "ok" | "err" = "ok") {
  clear(toastEl);
  toastEl.append(proIcon(kind === "ok" ? "check" : "x", 14, 2.2), h("span", { text }));
  toastEl.className = `toast show ${kind}`;
  if (toastTimer != null) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toastEl.className = `toast ${kind}`), 2200);
}

async function save(message = "Enregistré") {
  await Bridge.saveSettings(ctx.settings);
  toast(message);
  renderFoot();
}

function toggle(on: boolean, onChange: (v: boolean) => void, disabled = false): HTMLElement {
  const el = h("button", { class: on ? "switch on" : "switch", role: "switch", "aria-checked": on });
  if (disabled) el.setAttribute("disabled", "");
  el.addEventListener("click", () => {
    const next = !el.classList.contains("on");
    el.classList.toggle("on", next);
    el.setAttribute("aria-checked", String(next));
    onChange(next);
  });
  return el;
}

function pill(ok: boolean | "warn", text: string): HTMLElement {
  const kind = ok === "warn" ? "warn" : ok ? "ok" : "off";
  return h("span", { class: `pill ${kind}` }, h("i"), h("span", { text }));
}

function row(title: string, desc: string | null, control: Node, iconName?: ProIconName): HTMLElement {
  return h(
    "div",
    { class: "row" },
    iconName ? h("div", { class: "row-icon" }, proIcon(iconName, 16)) : null,
    h("div", { class: "row-text" }, h("div", { class: "row-title", text: title }), desc ? h("div", { class: "row-desc", text: desc }) : null),
    h("div", { class: "row-control" }, control),
  );
}

function card(...children: (Node | null)[]): HTMLElement {
  return h("section", { class: "card" }, ...children);
}

function cardHead(title: string, right?: Node, iconName?: ProIconName): HTMLElement {
  return h(
    "div",
    { class: "card-head" },
    h("div", { class: "card-title" }, iconName ? h("span", { class: "card-icon" }, proIcon(iconName, 15)) : null, h("h3", { text: title })),
    right ?? null,
  );
}

function pageHeader(title: string, subtitle: string): HTMLElement {
  return h("header", { class: "page-head" }, h("h1", { text: title }), h("p", { text: subtitle }));
}

function button(label: string, kind: "primary" | "ghost" | "danger" | "" , onClick: () => void, iconName?: ProIconName): HTMLButtonElement {
  const el = h("button", { class: `btn ${kind}` }, iconName ? proIcon(iconName, 15) : null, h("span", { text: label })) as HTMLButtonElement;
  el.addEventListener("click", onClick);
  return el;
}

function renderDiff(text: string): HTMLElement {
  const box = h("div", { class: "diff" });
  for (const line of text.split("\n")) {
    const cls = line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "ctx";
    box.append(h("div", { class: cls, text: line || " " }));
  }
  return box;
}

function activeCount(): number {
  return ctx.settings.activeIntegrations.length;
}

function chatMode(): { label: string; ok: boolean | "warn" } {
  if (ctx.cc.found) return { label: "Ton compte Claude Code", ok: true };
  if (ctx.hasKey) return { label: "Clé API", ok: true };
  return { label: "Non configuré", ok: false };
}

function renderNav() {
  clear(navHost);
  for (const page of PAGES) {
    const btn = h("button", { class: page.id === current ? "nav-item on" : "nav-item" }, proIcon(page.icon, 17), h("span", { text: page.label }));
    if (page.id === "claude" && !ctx.hooks.installed) btn.append(h("i", { class: "nav-badge" }));
    if (page.id === "about" && pendingUpdate) btn.append(h("i", { class: "nav-badge update" }));
    btn.addEventListener("click", () => go(page.id));
    navHost.append(btn);
  }
}

function renderFoot() {
  clear(footHost);
  const ready = ctx.hooks.installed && (ctx.cc.found || ctx.hasKey);
  footHost.append(
    pill(ready ? true : "warn", ready ? "Tout est branché" : "Une étape à faire"),
    h("div", { class: "foot-ver", text: `Tako ${ctx.version}` }),
  );
}

function go(id: PageId) {
  closeDropdowns();
  current = id;
  renderNav();
  clear(pageHost);
  const page = h("div", { class: "page" });
  page.append(...buildPage(id));
  pageHost.append(page);
  pageHost.scrollTop = 0;
}

function buildPage(id: PageId): Node[] {
  switch (id) {
    case "home": return homePage();
    case "claude": return claudePage();
    case "chat": return chatPage();
    case "integrations": return integrationsPage();
    case "island": return islandPage();
    case "usage": return usagePage();
    case "about": return aboutPage();
  }
}

function homePage(): Node[] {
  const ready = ctx.hooks.installed;
  const hero = h(
    "section",
    { class: "hero" },
    h("div", { class: "hero-glow" }),
    h("div", { class: "hero-text" },
      h("div", { class: "hero-kicker" }, h("i"), h("span", { text: ready ? "En ligne" : "Presque prêt" })),
      h("h2", { text: ready ? "Tako veille sur Claude Code." : "Branche Claude Code pour réveiller Tako." }),
      h("p", { text: ready
        ? "Chaque fichier lu, chaque diff, chaque commande s'affiche en direct dans l'îlot. Les permissions se valident d'un clic."
        : "Une seule étape : installer les hooks. Tu vois exactement ce qui change dans ta config avant que rien ne soit écrit." }),
      h("div", { class: "hero-actions" },
        ready
          ? button("Ouvrir l'îlot", "primary", () => void Bridge.showIsland(), "play")
          : button("Installer les hooks", "primary", () => go("claude"), "bolt"),
        button("Dossier Tako", "ghost", () => void Bridge.openTakoFolder(), "folder"),
      ),
    ),
    h("div", { class: "hero-art" }, blob(96, { particles: true, interactive: true })),
  );

  const mode = chatMode();
  const tiles = h(
    "div",
    { class: "tiles" },
    tile("code", "Hooks Claude Code", ctx.hooks.installed ? "Installés" : "À installer", ctx.hooks.installed, () => go("claude")),
    tile("terminal", "Claude Code", ctx.cc.found ? (ctx.cc.version.split(" ")[0] || "Détecté") : "Introuvable", ctx.cc.found, () => go("claude")),
    tile("chat", "Chat", mode.label, mode.ok, () => go("chat")),
    tile("globe", "Agent navigateur", ctx.settings.chatAgent ? "Activé" : "Désactivé", ctx.settings.chatAgent ? true : "warn", () => go("chat")),
    tile("monitor", "Vision de l'écran", ctx.settings.chatScreen ? "Activée" : "Désactivée", ctx.settings.chatScreen ? true : "warn", () => go("chat")),
    tile("plug", "Intégrations", `${activeCount()} / ${MAX_ACTIVE} actives`, activeCount() > 0 ? true : "warn", () => go("integrations")),
  );

  const tips = card(
    cardHead("Dans l'îlot", undefined, "layers"),
    h("div", { class: "keys" },
      key("Survol", "en haut au centre fait sortir l'îlot"),
      key("Clic sur une étape", "affiche son diff, sa sortie ou son plan"),
      key("Y / N", "Allow / Deny sur une permission"),
      key("/", "dans le chat, propose les commandes Claude"),
      key("Échap", "referme l'îlot"),
      key("Glisser un fichier", "le dépose dans le chat"),
    ),
  );

  return [pageHeader("Accueil", "L'état de Tako en un coup d'œil."), hero, tiles, tips];
}

function tile(iconName: ProIconName, title: string, value: string, ok: boolean | "warn", onClick: () => void): HTMLElement {
  const kind = ok === "warn" ? "warn" : ok ? "ok" : "off";
  const el = h("button", { class: `tile ${kind}` },
    h("div", { class: "tile-top" }, h("span", { class: "tile-icon" }, proIcon(iconName, 16)), h("i", { class: "tile-dot" })),
    h("div", { class: "tile-title", text: title }),
    h("div", { class: "tile-value", text: value }),
  );
  el.addEventListener("click", onClick);
  return el;
}

function key(k: string, what: string): HTMLElement {
  return h("div", { class: "key" }, h("kbd", { text: k }), h("span", { text: what }));
}

function claudePage(): Node[] {
  const hookCard = card();

  const draw = () => {
    clear(hookCard);
    hookCard.append(
      cardHead("Hooks", pill(ctx.hooks.installed, ctx.hooks.installed ? "Installés" : "Non installés"), "bolt"),
      h("p", { class: "muted", text: ctx.hooks.installed
        ? "Tako reçoit les événements de toutes tes sessions Claude Code, depuis n'importe quel terminal."
        : "Installe les hooks pour voir tes sessions dans l'îlot et valider les permissions sans quitter ce que tu fais." }),
      h("div", { class: "kv" },
        h("span", { text: "settings.json" }), h("code", { text: ctx.hooks.settingsPath || "—" }),
        h("span", { text: "Relais" }), h("code", { text: ctx.hooks.hookPath || "—" }),
      ),
    );
    if (!ctx.hooks.hookReady) {
      hookCard.append(h("div", { class: "notice warn", text: "tako-hook.exe n'est pas encore en place. Relance Tako ; si ça persiste, compile-le avec cargo build -p tako-hook." }));
    }
    const outdated = ctx.hooks.installed && !ctx.hooks.upToDate;
    if (outdated) {
      hookCard.append(h("div", { class: "notice warn", text: "Les hooks de Tako ont évolué (relecture des modifs, délais plus longs). Mets-les à jour pour en profiter." }));
    }
    const install = button(outdated ? "Mettre à jour…" : ctx.hooks.installed ? "Réinstaller…" : "Installer les hooks…", "primary", () => void preview(true), "bolt");
    if (!ctx.hooks.hookReady) install.setAttribute("disabled", "");
    const actions = h("div", { class: "actions" }, install);
    if (ctx.hooks.installed) actions.append(button("Désinstaller…", "danger", () => void preview(false), "x"));
    hookCard.append(actions);
  };

  const preview = async (install: boolean) => {
    let plan;
    try {
      plan = await Bridge.hooksPreview(install);
    } catch (err) {
      clear(hookCard);
      hookCard.append(
        cardHead("Hooks", undefined, "bolt"),
        h("div", { class: "notice err", text: String(err).replace(/^Error:\s*/, "") }),
        h("div", { class: "actions" }, button("Retour", "ghost", draw)),
      );
      return;
    }
    if (!plan) return;
    clear(hookCard);
    const confirm = button(install ? "Sauvegarder et écrire" : "Sauvegarder et retirer", install ? "primary" : "danger", async () => {
      confirm.setAttribute("disabled", "");
      try {
        const backup = await Bridge.hooksApply(install, plan.fingerprint);
        const fresh = await Bridge.hooksStatus();
        if (fresh) ctx.hooks = fresh;
        toast(install ? "Hooks installés" : "Hooks retirés");
        draw();
        hookCard.append(h("div", { class: "notice ok", text: `Ancienne config sauvegardée : ${backup}. Ouvre une nouvelle session Claude Code pour en profiter.` }));
        renderNav();
        renderFoot();
      } catch (err) {
        confirm.removeAttribute("disabled");
        hookCard.append(h("div", { class: "notice err", text: `Écriture impossible : ${String(err)}` }));
      }
    }, "check");
    hookCard.append(
      cardHead(install ? "Ce qui va changer" : "Ce qui va être retiré", undefined, "file"),
      h("p", { class: "muted", text: install
        ? "Exactement ce qui sera écrit dans ton settings.json. Tes propres hooks ne sont pas touchés."
        : "Seules les entrées de Tako partent. Tes propres hooks restent." }),
      renderDiff(plan.diff),
      h("div", { class: "kv" }, h("span", { text: "Sauvegarde" }), h("code", { text: plan.backup })),
      h("div", { class: "actions" }, confirm, button("Annuler", "ghost", draw)),
    );
  };

  draw();

  const behaviour = card(
    cardHead("Comportement", undefined, "sliders"),
    row("Ouvrir l'îlot quand Claude a fini", "Avec le bilan : fichiers, lignes, tokens, et les boutons Commit, Diff et Annuler. Sinon une simple pastille verte.",
      toggle(ctx.settings.openOnFinish, (v) => { ctx.settings.openOnFinish = v; void save(); }), "eye"),
    row("Annuler un tour", "Avant chaque modification, Tako garde une copie du fichier pendant 3 jours, sur ton PC uniquement (1 Go maximum). Le bouton Annuler remet tout comme avant le tour, sauf les fichiers retouchés depuis. Les fichiers sensibles (.env, clés, .ssh…) ne sont jamais copiés ni envoyés pour le message de commit.",
      h("span", { class: "muted small", text: "Toujours actif" }), "undo"),
  );

  const reviewReady = ctx.hooks.installed && ctx.hooks.upToDate;
  const review = card(
    cardHead("Mode relecture", pill(ctx.settings.reviewMode ? (reviewReady ? true : "warn") : false, ctx.settings.reviewMode ? "Actif" : "Désactivé"), "review"),
    h("p", { class: "muted", text: "Chaque modification de fichier par Claude attend ton OK dans l'îlot, diff affiché, avant d'être écrite : valider, refuser, ou tout valider pour le tour. Pas de réponse, Tako en pause ou trop de modifs d'un coup : la modif est refusée. Ça concerne les fichiers, pas les commandes. Si Tako est fermé, Claude Code applique ses propres permissions." }),
    row("Relire chaque modification", reviewReady ? null : "Mets d'abord les hooks à jour (carte au-dessus).",
      toggle(ctx.settings.reviewMode, (v) => { ctx.settings.reviewMode = v; void save(v ? "Relecture activée" : "Relecture désactivée"); }, !reviewReady && !ctx.settings.reviewMode), "eye"),
  );

  const HOTKEYS = [
    { value: "Alt+Shift+Space", label: "Alt + Maj + Espace" },
    { value: "Ctrl+Shift+Space", label: "Ctrl + Maj + Espace" },
    { value: "Alt+Shift+T", label: "Alt + Maj + T" },
    { value: "Ctrl+Alt+Space", label: "Ctrl + Alt + Espace" },
    { value: "off", label: "Désactivé" },
  ];
  const hotkeyNote = h("div", { class: "notice warn", style: "display:none" });
  const checkHotkey = async () => {
    const err = await Bridge.hotkeyStatus();
    hotkeyNote.textContent = err ? `Ce raccourci est déjà pris par une autre application. Choisis-en un autre.` : "";
    hotkeyNote.style.display = err ? "" : "none";
  };
  void checkHotkey();
  const hotkey = dropdown(HOTKEYS, ctx.settings.missionHotkey || "Alt+Shift+Space", (v) => {
    ctx.settings.missionHotkey = v;
    void save("Raccourci enregistré").then(() => window.setTimeout(() => void checkHotkey(), 300));
  });
  const missions = card(
    cardHead("Missions", undefined, "rocket"),
    h("p", { class: "muted", text: "Tape une tâche dans l'îlot : Tako ouvre Claude Code dans le projet choisi, dans un nouveau terminal, et tu suis tout en live." }),
    row("Raccourci global", "Ouvre « Nouvelle mission » depuis n'importe où. Aussi dans l'onglet fusée de l'îlot.", hotkey, "bolt"),
    hotkeyNote,
  );

  const binary = card(
    cardHead("Claude Code sur ce PC", pill(ctx.cc.found, ctx.cc.found ? "Détecté" : "Introuvable"), "terminal"),
    ctx.cc.found
      ? h("div", { class: "kv" },
        h("span", { text: "Version" }), h("code", { text: ctx.cc.version || "—" }),
        h("span", { text: "Exécutable" }), h("code", { text: ctx.cc.path }))
      : h("p", { class: "muted", text: "Installe Claude Code (npm i -g @anthropic-ai/claude-code) puis relance Tako." }),
  );

  return [pageHeader("Claude Code", "Ce qui relie Tako à tes sessions."), hookCard, review, missions, behaviour, binary];
}

function chatPage(): Node[] {
  const mode = chatMode();
  const backend = card(
    cardHead("Qui répond", pill(mode.ok, mode.label), "chat"),
    h("p", { class: "muted", text: ctx.cc.found
      ? "Le chat lance ton propre Claude Code en arrière-plan : pas de clé API, ton abonnement, et Tako ne touche jamais à tes identifiants. Il lit le projet de ta session en cours, et tape / pour ses commandes."
      : "Claude Code n'est pas installé : le chat utilise une clé API Anthropic, rangée dans le Gestionnaire d'identification Windows." }),
    h("div", { class: "chips" },
      chip("file", "Lit tes fichiers"), chip("search", "Cherche sur le web"), chip("slash", "Commandes /"), chip("shieldCheck", "Ne modifie rien"),
    ),
  );

  const vision = card(
    cardHead("Vision de l'écran", pill(ctx.settings.chatScreen, ctx.settings.chatScreen ? "Activée" : "Désactivée"), "monitor"),
    row("Laisser Claude regarder ton écran", "Quand ta question parle de ce que tu vois — une erreur, une page, un design — il prend une capture tout seul et la regarde.",
      toggle(ctx.settings.chatScreen, (v) => { ctx.settings.chatScreen = v; void save(v ? "Vision activée" : "Vision désactivée"); }, !ctx.cc.found), "eye"),
    h("p", { class: "muted small", text: "La capture part directement à Claude pour ce message, sans être enregistrée sur le disque. Elle n'est prise que pendant une question au chat, jamais en arrière-plan." }),
  );

  const agentBody = h("div", { class: "agent-body" });
  const drawAgent = () => {
    clear(agentBody);
    if (!ctx.settings.chatAgent) return;
    const autoNote = h("div", { class: "notice warn small", text: "Mode auto : l'agent ouvre, clique et tape sans te demander. Une page piégée peut alors lui faire faire une action que tu n'as pas vue. Garde-le pour les sites de confiance." });
    autoNote.style.display = ctx.settings.agentAuto ? "" : "none";
    agentBody.append(
      row("Navigateur visible", "Regarde l'agent cliquer en direct. Le navigateur reste ouvert entre les messages, en plein écran.",
        toggle(ctx.settings.agentBrowserVisible, (v) => { ctx.settings.agentBrowserVisible = v; void save(); }), "eye"),
      row("Mode auto", "L'agent agit sans te demander à chaque action. Plus rapide, moins sûr.",
        toggle(ctx.settings.agentAuto, (v) => { ctx.settings.agentAuto = v; autoNote.style.display = v ? "" : "none"; drawGuard(); void save(v ? "Mode auto activé" : "Mode auto désactivé"); }), "bolt"),
      autoNote,
      guardHost,
    );
    drawGuard();
  };
  const guardHost = h("div", {});
  const drawGuard = () => {
    clear(guardHost);
    if (ctx.settings.agentAuto) return;
    guardHost.append(
      h("div", { class: "guard" },
        h("div", { class: "guard-title" }, proIcon("shield", 15), h("span", { text: "Ce que l'agent te demande avant de le faire" })),
        h("div", { class: "chips" },
          chip("globe", "Ouvrir une page", "warn"), chip("bolt", "Cliquer", "warn"), chip("terminal", "Taper du texte", "warn"),
          chip("listChecks", "Remplir un formulaire", "warn"), chip("code", "Exécuter du JavaScript", "warn"), chip("file", "Envoyer un fichier", "warn"),
        ),
        h("p", { class: "muted small", text: "Chaque action arrive dans l'îlot avec l'URL ou le texte exact. Sans réponse, elle est refusée. Lire la page et faire des captures ne demande rien. Le contenu des sites est traité comme une donnée, jamais comme un ordre." }),
      ),
    );
  };
  const agent = card(
    cardHead("Agent navigateur", h("span", { class: "tag", text: "Playwright" }), "globe"),
    row("Donner un navigateur au chat", "Le chat devient un agent : il ouvre des sites, clique, remplit des formulaires pour toi.",
      toggle(ctx.settings.chatAgent, (v) => { ctx.settings.chatAgent = v; drawAgent(); void save(v ? "Agent activé" : "Agent désactivé"); }, !ctx.cc.found), "sparkles"),
    agentBody,
  );
  drawAgent();

  const field = h("input", { type: "password", placeholder: ctx.hasKey ? "••••••••••••  (enregistrée)" : "sk-ant-…", autocomplete: "off", spellcheck: "false" }) as HTMLInputElement;
  const dropKey = button("Retirer", "danger", async () => {
    try {
      await Bridge.secretClear("anthropic-api-key");
      ctx.hasKey = false;
      field.placeholder = "sk-ant-…";
      dropKey.style.display = "none";
      toast("Clé retirée");
      renderFoot();
    } catch (err) {
      toast(`Impossible : ${String(err)}`, "err");
    }
  });
  dropKey.style.display = ctx.hasKey ? "" : "none";
  const saveKey = button("Enregistrer", "", async () => {
    const value = field.value.trim();
    if (!value) return;
    try {
      await Bridge.secretSet("anthropic-api-key", value);
      ctx.hasKey = true;
      field.value = "";
      field.placeholder = "••••••••••••  (enregistrée)";
      dropKey.style.display = "";
      toast("Clé enregistrée");
      renderFoot();
    } catch (err) {
      toast(`Impossible : ${String(err)}`, "err");
    }
  });
  const models = MODELS.some((m) => m.value === ctx.settings.model)
    ? MODELS
    : [...MODELS, { value: ctx.settings.model, label: ctx.settings.model }];
  const model = dropdown(models, ctx.settings.model, (v) => { ctx.settings.model = v; void save(); });

  const api = card(
    cardHead("Clé API (secours)", pill(ctx.hasKey, ctx.hasKey ? "Enregistrée" : "Aucune"), "key"),
    h("p", { class: "muted", text: ctx.cc.found ? "Utilisée seulement si Claude Code n'est plus trouvé." : "Facturée à l'usage sur console.anthropic.com." }),
    h("div", { class: "inline" }, field, saveKey, dropKey),
    row("Modèle", "Pour le chat par clé API. Avec Claude Code, c'est ton modèle par défaut qui répond.", model, "cpu"),
  );

  const apps = card(
    cardHead("Applications", pill(ctx.settings.chatApps, ctx.settings.chatApps ? "Activé" : "Désactivé"), "apps"),
    row("Ouvrir des applis pour toi", "« Ouvre Spotify », « lance Discord » : le chat ouvre l'appli installée et la laisse ouverte. Il ne ferme jamais rien : c'est toi qui fermes.",
      toggle(ctx.settings.chatApps, (v) => { ctx.settings.chatApps = v; void save(v ? "Applications activées" : "Applications désactivées"); }, !ctx.cc.found), "apps"),
    h("p", { class: "muted small", text: "Seules les applis du menu Démarrer peuvent être ouvertes. Chaque ouverture t'est demandée dans l'îlot, sauf en mode auto." }),
  );

  return [pageHeader("Chat & agent", "Parle à Claude depuis l'îlot, et laisse-le agir pour toi."), backend, vision, apps, agent, api];
}

function chip(iconName: ProIconName, text: string, kind: "" | "warn" = ""): HTMLElement {
  return h("span", { class: `chip ${kind}` }, proIcon(iconName, 13), h("span", { text }));
}

function integrationsPage(): Node[] {
  const counter = h("span", { class: "tag" });
  const updateCounter = () => (counter.textContent = `${activeCount()} / ${MAX_ACTIVE} actives`);
  updateCounter();
  const grid = h("div", { class: "int-grid" });

  for (const def of INTEGRATIONS) {
    const configured = def.fields.every((f) => ctx.present[f.key]);
    const active = ctx.settings.activeIntegrations.includes(def.id);
    let status = pill(configured, configured ? "Connecté" : "Pas de clé");
    const statusHost = h("div", { class: "int-status" }, status);
    const sw = toggle(active, (on) => {
      const list = ctx.settings.activeIntegrations;
      if (on && list.length >= MAX_ACTIVE) {
        sw.classList.remove("on");
        toast(`${MAX_ACTIVE} pastilles maximum`, "err");
        return;
      }
      ctx.settings.activeIntegrations = on ? [...list, def.id] : list.filter((x) => x !== def.id);
      updateCounter();
      void save(on ? `${def.name} affiché` : `${def.name} masqué`);
    });
    const fields = h("div", { class: "int-fields" });
    for (const f of def.fields) {
      const input = h("input", { type: f.secret ? "password" : "text", placeholder: ctx.present[f.key] ? "••••••••  (enregistré)" : f.placeholder, autocomplete: "off", spellcheck: "false" }) as HTMLInputElement;
      const ok = button("OK", "", async () => {
        const value = input.value.trim();
        try {
          await Bridge.secretSet(f.key, value);
          ctx.present[f.key] = value.length > 0;
          input.value = "";
          input.placeholder = value ? "••••••••  (enregistré)" : f.placeholder;
          const all = def.fields.every((x) => ctx.present[x.key]);
          const next = pill(all, all ? "Connecté" : "Pas de clé");
          status.replaceWith(next);
          status = next;
          toast(value ? `${def.name} : clé enregistrée` : `${def.name} : clé retirée`);
        } catch (err) {
          toast(`Impossible : ${String(err)}`, "err");
        }
      });
      ok.classList.add("small");
      fields.append(h("label", { class: "int-label", text: f.label }), h("div", { class: "inline" }, input, ok));
    }
    const el = h(
      "div",
      { class: "int-card" },
      h("div", { class: "int-head" },
        h("div", { class: "int-logo" }, brandLogo(def.id, 19) ?? h("span", { text: def.name[0] })),
        h("div", { class: "int-name" }, h("div", { class: "row-title", text: def.name }), h("div", { class: "row-desc", text: def.blurb })),
        sw,
      ),
      statusHost,
      fields,
    );
    el.style.setProperty("--c", def.color);
    grid.append(el);
  }

  return [
    pageHeader("Intégrations", "Des pastilles de couleur à côté du personnage, pour garder un œil sur tes services."),
    h("div", { class: "lead" }, h("span", { class: "lead-icon" }, proIcon("shieldCheck", 15)), h("p", { class: "muted", text: "Les clés vont dans le Gestionnaire d'identification Windows, jamais sur le disque. L'îlot peut seulement demander si une clé existe." }), counter),
    grid,
  ];
}

function islandPage(): Node[] {
  const vol = h("input", { type: "range", min: "0", max: "0.2", step: "0.005", value: String(ctx.settings.soundVolume) }) as HTMLInputElement;
  const volLabel = h("span", { class: "range-value" });
  const setVolLabel = () => {
    volLabel.textContent = `${Math.round((Number(vol.value) / 0.2) * 100)} %`;
    vol.style.setProperty("--p", `${(Number(vol.value) / 0.2) * 100}%`);
  };
  setVolLabel();
  vol.addEventListener("input", () => { setVolLabel(); Sound.setVolume(Number(vol.value)); });
  vol.addEventListener("change", () => { ctx.settings.soundVolume = Number(vol.value); void save(); Sound.play("blip"); });

  const samples = ["approve", "finish", "love", "approval", "peek"];
  let sample = 0;
  const test = button("Tester", "", () => {
    Sound.resume();
    Sound.setEnabled(true);
    Sound.setVolume(ctx.settings.soundVolume);
    Sound.play(samples[sample++ % samples.length]);
  }, "play");
  test.classList.add("small");

  const auto = h("input", { type: "range", min: "5", max: "60", step: "1", value: String(Math.round(ctx.settings.autoCloseInterval)) }) as HTMLInputElement;
  const autoLabel = h("span", { class: "range-value" });
  const setAutoLabel = () => {
    autoLabel.textContent = `${auto.value} s`;
    auto.style.setProperty("--p", `${((Number(auto.value) - 5) / 55) * 100}%`);
  };
  setAutoLabel();
  auto.addEventListener("input", setAutoLabel);
  auto.addEventListener("change", () => { ctx.settings.autoCloseInterval = Number(auto.value); void save(); });

  const screen = dropdown(SCREENS, ctx.settings.screen, (v) => { ctx.settings.screen = v; void save(); });

  return [
    pageHeader("Îlot & sons", "Comment Tako se montre, et comment il sonne."),
    card(
      cardHead("Sons", undefined, "volume"),
      row("Sons activés", "Un petit son à chaque étape importante : permission, fin, erreur.",
        toggle(ctx.settings.soundEnabled, (v) => { ctx.settings.soundEnabled = v; Sound.setEnabled(v); void save(); })),
      row("Volume", null, h("div", { class: "range" }, vol, volLabel, test)),
    ),
    card(
      cardHead("Îlot", undefined, "layers"),
      row("Fermeture automatique", "Après combien de temps l'îlot se replie quand ta souris s'en va.", h("div", { class: "range" }, auto, autoLabel), "clock"),
      row("Afficher sur", null, screen, "monitor"),
      row("Lancer au démarrage de Windows", null, toggle(ctx.settings.autostart, (v) => { ctx.settings.autostart = v; void save(); }), "bolt"),
    ),
    card(
      cardHead("Pastilles", undefined, "layers"),
      row("Musique en cours", "Spotify, YouTube, Deezer… avec la pochette et les boutons lecture / suivant, et un mini égaliseur dans l'îlot replié.",
        toggle(ctx.settings.mediaEnabled, (v) => { ctx.settings.mediaEnabled = v; void save(); }), "music"),
      row("Stats du PC", "Processeur, mémoire et carte graphique en direct.",
        toggle(ctx.settings.statsEnabled, (v) => { ctx.settings.statsEnabled = v; void save(); }), "cpu"),
    ),
    gameCard(),
    timerCard(),
    alertsCard(),
  ];
}

function gameCard(): HTMLElement {
  const status = h("span", { class: "muted small", text: "Aucun jeu en plein écran." });
  void Bridge.gameStatus().then((g) => {
    if (g?.active) status.textContent = `Actif : ${g.app || "plein écran"}`;
  });
  return card(
    cardHead("Mode jeu", undefined, "gameMode"),
    h("p", { class: "muted", text: "Quand un jeu ou une vidéo est en plein écran, rien ne s'ouvre : l'îlot et le widget se cachent, les clics passent au jeu. À la sortie, Tako te dit ce que tu as raté." }),
    row("Mode jeu automatique", null, toggle(ctx.settings.gameMode, (v) => { ctx.settings.gameMode = v; void save(v ? "Mode jeu activé" : "Mode jeu désactivé"); }), "gameMode"),
    row("Couper les sons de Tako en jeu", "Le minuteur sonne quand même.", toggle(ctx.settings.gameMute, (v) => { ctx.settings.gameMute = v; void save(); }), "volume"),
    h("div", { class: "row-desc" }, status),
  );
}

function timerCard(): HTMLElement {
  const minutes = (values: number[]) => values.map((m) => ({ value: String(m), label: `${m} min` }));
  const pick = (values: number[], current: number, apply: (v: number) => void) =>
    dropdown(minutes(values), String(current), (v) => { apply(Number(v)); void save(); });
  const rounds = dropdown([2, 3, 4, 5, 6].map((n) => ({ value: String(n), label: `${n} focus` })), String(ctx.settings.pomodoroRounds), (v) => {
    ctx.settings.pomodoroRounds = Number(v);
    void save();
  });
  return card(
    cardHead("Minuteur & Pomodoro", undefined, "timer"),
    h("p", { class: "muted", text: "Lance-le depuis l'onglet minuteur de l'îlot. Le temps reste affiché autour du blob, et l'îlot se divise en deux quand Claude travaille en même temps." }),
    row("Focus", null, pick([15, 20, 25, 30, 45, 50, 60, 90], ctx.settings.pomodoroFocus, (v) => (ctx.settings.pomodoroFocus = v)), "timer"),
    row("Pause", null, pick([3, 5, 10, 15], ctx.settings.pomodoroBreak, (v) => (ctx.settings.pomodoroBreak = v)), "clock"),
    row("Grande pause", null, pick([10, 15, 20, 30], ctx.settings.pomodoroLong, (v) => (ctx.settings.pomodoroLong = v)), "clock"),
    row("Grande pause après", null, rounds, "layers"),
  );
}

function alertsCard(): HTMLElement {
  const vpnLine = h("span", { class: "muted small", text: "Recherche d'un VPN…" });
  void Bridge.vpnStatus().then((s) => {
    if (!s) {
      vpnLine.textContent = "Disponible dans l'app Tako.";
      return;
    }
    vpnLine.textContent = !s.present ? "Aucun VPN détecté sur ce PC." : s.up ? `${s.name} connecté${s.location ? ` · ${s.location}` : ""}` : `${s.name} déconnecté`;
  });
  const testBt = button("Tester", "", () => void Bridge.bluetoothTest(), "play");
  testBt.classList.add("small");
  const testVpn = button("Tester", "", () => void Bridge.vpnTest(), "play");
  testVpn.classList.add("small");
  return card(
    cardHead("Bluetooth & VPN", undefined, "shield"),
    row("Animation à la connexion d'un casque", "Le nom, l'icône et la batterie, comme sur iPhone.",
      h("div", { class: "inline" }, testBt, toggle(ctx.settings.btAnimation, (v) => { ctx.settings.btAnimation = v; void save(); })), "headphones"),
    row("Alerte si le VPN se coupe", "Mullvad, WireGuard, NordVPN, Proton… Tako te prévient dès que ton IP réelle est visible.",
      h("div", { class: "inline" }, testVpn, toggle(ctx.settings.vpnAlerts, (v) => { ctx.settings.vpnAlerts = v; void save(); })), "shield"),
    h("div", { class: "row-desc" }, vpnLine),
  );
}

const USAGE_SPOTS: [Settings["usagePosition"], string][] = [
  ["corner-left", "Coin gauche"],
  ["island-left", "Gauche de l'îlot"],
  ["island-right", "Droite de l'îlot"],
  ["corner-right", "Coin droit"],
];

let usageCardEl: HTMLElement | null = null;

function usageKey(): string {
  return `${ctx.settings.usageWidget}~${ctx.settings.usagePosition}`;
}

function usageWidgetCard(): HTMLElement {

  const spots = h("div", { class: "spots" });
  for (const [id, label] of USAGE_SPOTS) {
    const b = h("button", { class: `spot${ctx.settings.usagePosition === id ? " on" : ""}`, title: label },
      h("div", { class: `spot-screen ${id}` }, h("i", { class: "spot-island" }), h("i", { class: "spot-widget" })),
      h("span", { text: label }));
    b.addEventListener("click", () => {
      ctx.settings.usagePosition = id;
      for (const el of Array.from(spots.children)) el.classList.toggle("on", el === b);
      void save("Position enregistrée");
    });
    spots.append(b);
  }
  spots.classList.toggle("disabled", !ctx.settings.usageWidget);

  const free = ctx.settings.usagePosition === "custom";
  usageCardEl = card(
    cardHead("Widget d'utilisation", free ? pill(true, "Position libre") : undefined, "gauge"),
    h("p", { class: "muted", text: "Tes limites Claude toujours en haut de l'écran : session de 5 h et semaine. Survole-le pour le détail, ou tape /usage dans le chat." }),
    row("Afficher le widget", null, toggle(ctx.settings.usageWidget, (v) => {
      ctx.settings.usageWidget = v;
      spots.classList.toggle("disabled", !v);
      void save(v ? "Widget affiché" : "Widget masqué");
    }), "eye"),
    h("div", { class: "spots-wrap" },
      h("div", { class: "row-title", text: "Position" }),
      spots,
      h("p", { class: "muted small", text: "Ou attrape le widget et glisse-le où tu veux. Clic droit dessus pour le masquer." })),
  );
  return usageCardEl;
}

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
  const W = 560;
  const H = 120;
  const pad = 18;
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("class", "chart");
  const slot = W / Math.max(1, bars.length);
  const bw = Math.min(26, slot * 0.6);
  const top = Math.max(max, ...bars.map((b) => b.value), 1);
  bars.forEach((b, i) => {
    const x = i * slot + (slot - bw) / 2;
    const hgt = Math.max(b.value > 0 ? 3 : 1.5, ((H - pad - 8) * b.value) / top);
    const rect = document.createElementNS(ns, "rect");
    rect.setAttribute("x", x.toFixed(1));
    rect.setAttribute("y", (H - pad - hgt).toFixed(1));
    rect.setAttribute("width", bw.toFixed(1));
    rect.setAttribute("height", hgt.toFixed(1));
    rect.setAttribute("rx", "4");
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
      v.setAttribute("y", (H - pad - hgt - 4).toFixed(1));
      v.setAttribute("text-anchor", "middle");
      v.setAttribute("class", "v");
      v.textContent = `${b.value}`;
      svg.append(v);
    }
  });
  return svg;
}

function usagePage(): Node[] {
  const now = h("div", { class: "usage-preview first" }, h("span", { class: "muted small", text: "Lecture de /usage…" }));
  const forecast = h("p", { class: "muted small forecast" });
  void fetchUsage(false).then((r) => {
    clear(now);
    if (!r || r.lines.length === 0) {
      now.append(h("span", { class: "muted small", text: r ? usageError(r.error) : "Disponible dans l'app Tako." }));
      return;
    }
    for (const line of r.lines) {
      now.append(
        h("div", { class: "up-row" },
          h("div", { class: "up-top" }, h("span", { text: longLabel(line.label) }), h("b", { text: `${line.percent} %` })),
          h("div", { class: "up-bar" }, h("i", { style: `width:${line.percent}%;background:${tone(line.percent)}` })),
          line.resets ? h("div", { class: "up-sub", text: `Reset dans ${countdown(line.resets)}` }) : null),
      );
    }
    const session = r.lines.find((l) => l.label.toLowerCase().includes("session"));
    const reset = session ? resetDate(session.resets) : null;
    if (r.forecastAt && (!reset || r.forecastAt * 1000 < reset.getTime())) {
      const at = new Date(r.forecastAt * 1000);
      forecast.textContent = `À ce rythme, ta session de 5 h sera pleine vers ${at.getHours()} h ${String(at.getMinutes()).padStart(2, "0")}.`;
    } else if (session) {
      forecast.textContent = "À ce rythme, tu n'atteindras pas la limite avant le reset.";
    }
  });

  const daily = h("div", { class: "chart-box" }, h("span", { class: "muted small", text: "Chargement…" }));
  const weekly = h("div", { class: "chart-box" });
  void fetchHistory().then((samples) => {
    clear(daily);
    clear(weekly);
    const list = samples ?? [];
    if (list.length < 2) {
      daily.append(h("p", { class: "muted small", text: "Les données s'accumulent : Tako relève tes limites toutes les 4 minutes. Reviens dans quelques heures." }));
      return;
    }
    daily.append(barChart(dailyUse(list), 10));
    const peaks = weeklyPeaks(list);
    if (peaks.length) weekly.append(barChart(peaks, 100));
  });

  return [
    pageHeader("Utilisation", "Tes limites Claude, en direct et dans le temps."),
    card(cardHead("Maintenant", undefined, "gauge"), now, forecast),
    card(
      cardHead("Alertes", undefined, "bolt"),
      row("Me prévenir à 80 % et 90 %", "Pour la session de 5 h et la semaine, avec l'heure à laquelle tu atteindras la limite à ce rythme.",
        toggle(ctx.settings.usageAlerts, (v) => { ctx.settings.usageAlerts = v; void save(); }), "eye"),
      row("Son quand la session est rechargée", "Un petit son quand ta limite de 5 h repart de zéro.",
        toggle(ctx.settings.usageRecharge, (v) => { ctx.settings.usageRecharge = v; void save(); }), "volume"),
    ),
    usageWidgetCard(),
    card(
      cardHead("Historique", undefined, "layers"),
      h("div", { class: "row-title", text: "Consommation par jour (en % de la semaine)" }),
      daily,
      h("div", { class: "row-title", text: "Pic de chaque semaine" }),
      weekly,
    ),
  ];
}

function updatesCard(): HTMLElement {
  const body = h("div", { class: "stack" });
  const status = h("p", { class: "muted" });
  const bar = h("div", { class: "progress" }, h("i"));
  bar.style.display = "none";
  const actions = h("div", { class: "actions" });
  const draw = () => {
    clear(actions);
    if (pendingUpdate) {
      status.textContent = `La version ${pendingUpdate.version} est disponible (tu as la ${pendingUpdate.current}).${pendingUpdate.notes ? " " + pendingUpdate.notes : ""}`;
      actions.append(button(`Installer la ${pendingUpdate.version}`, "primary", () => void install(), "bolt"));
    } else {
      status.textContent = `Tako ${ctx.version}. Les nouvelles versions publiées sur GitHub s'installent d'un clic, et Tako vérifie tout seul toutes les 6 heures.`;
    }
    actions.append(button("Vérifier maintenant", "ghost", () => void check(), "clock"));
  };
  const check = async () => {
    status.textContent = "Vérification…";
    try {
      pendingUpdate = (await Bridge.updateCheck()) ?? null;
      if (!pendingUpdate) toast("Tako est à jour");
    } catch (err) {
      status.textContent = `Impossible de vérifier : ${String(err).replace(/^Error:\s*/, "")}`;
      return;
    }
    draw();
    renderNav();
  };
  const install = async () => {
    bar.style.display = "";
    status.textContent = "Téléchargement de la mise à jour…";
    clear(actions);
    try {
      await Bridge.updateInstall();
    } catch (err) {
      bar.style.display = "none";
      status.textContent = `La mise à jour a échoué : ${String(err).replace(/^Error:\s*/, "")}`;
      draw();
    }
  };
  void onEvent<{ done: number; total: number | null }>("update-progress", ({ done, total }) => {
    const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
    (bar.firstChild as HTMLElement).style.width = `${pct}%`;
    status.textContent = total ? `Téléchargement… ${pct} %` : "Téléchargement…";
  });
  draw();
  body.append(status, bar, actions);
  return card(cardHead("Mises à jour", pendingUpdate ? pill("warn", `v${pendingUpdate.version} dispo`) : pill(true, "À jour"), "bolt"), body);
}

function aboutPage(): Node[] {
  return [
    pageHeader("À propos", `Tako ${ctx.version}`),
    h("section", { class: "hero small" },
      h("div", { class: "hero-glow" }),
      h("div", { class: "hero-text" },
        h("h2", { text: "Un petit compagnon pour tes agents." }),
        h("p", { text: "Tako vit en haut de ton écran et te montre ce que fait Claude Code, en vrai : les fichiers, les diffs, les commandes, les permissions." }),
        h("div", { class: "hero-actions" },
          button("Ouvrir le repo", "primary", () => void Bridge.openUrl(REPO_URL), "external"),
          button("Dossier Tako & log", "ghost", () => void Bridge.openTakoFolder(), "folder"),
        ),
      ),
      h("div", { class: "hero-art" }, blob(96, { particles: true, interactive: true })),
    ),
    updatesCard(),
    card(
      cardHead("Vie privée", undefined, "shieldCheck"),
      h("ul", { class: "list" },
        h("li", { text: "Aucune télémétrie. Les seules requêtes réseau vont vers les services que tu configures." }),
        h("li", { text: "Les clés restent dans le Gestionnaire d'identification Windows." }),
        h("li", { text: "Le chat utilise ton Claude Code ; Tako ne lit jamais tes identifiants Claude." }),
        h("li", { text: "L'écran n'est capturé que pendant une question au chat, et seulement si la vision est activée." }),
        h("li", { text: "Le log reste sur ta machine : %LOCALAPPDATA%\\Tako\\tako.log." }),
      ),
    ),
    card(
      cardHead("Licence", undefined, "file"),
      h("p", { class: "muted", text: "Code sous licence MIT. Le nom Tako, le personnage, l'icône et les sons sont réservés (LICENSE-ASSETS.md). Certaines parties du code dérivent de code MIT tiers, crédité dans THIRD_PARTY_NOTICES.md — les trois fichiers sont installés avec Tako." }),
    ),
  ];
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
  ctx = {
    settings: { ...DEFAULT_SETTINGS, ...(boot?.settings ?? {}) },
    version: boot?.version ?? "dev",
    hooks,
    cc,
    hasKey,
    present,
  };
  if (import.meta.env.DEV && location.search.includes("demo")) {
    ctx.version = "0.1.1";
    ctx.hooks = { installed: true, upToDate: true, hookReady: true, settingsPath: String.raw`C:\Users\dev\.claude\settings.json`, hookPath: String.raw`C:\Users\dev\AppData\Local\Tako\bin\tako-hook.exe` };
    ctx.cc = { found: true, path: String.raw`C:\Users\dev\.local\bin\claude.exe`, version: "2.1.286 (Claude Code)" };
    ctx.settings.chatAgent = true;
    ctx.settings.activeIntegrations = ["integration_github", "integration_vercel", "integration_stripe"];
    for (const k of ["github-token", "vercel-token", "stripe-api-key"]) ctx.present[k] = true;
  }
  Sound.setEnabled(ctx.settings.soundEnabled);
  Sound.setVolume(ctx.settings.soundVolume);

  clear(root);
  root.append(
    h("div", { class: "app" },
      h("aside", { class: "nav" },
        h("div", { class: "brand" }, h("div", { class: "brand-logo" }, blob(20)), h("div", {}, h("div", { class: "brand-name", text: "Tako" }), h("div", { class: "brand-sub", text: "Réglages" }))),
        navHost,
        footHost,
      ),
      pageHost,
    ),
    toastEl,
  );
  renderNav();
  renderFoot();
  const wanted = location.hash.slice(1);
  go(PAGES.some((p) => p.id === wanted) ? (wanted as PageId) : "home");

  void onEvent<Settings>("settings-changed", (s) => {
    const before = usageKey();
    ctx.settings = { ...ctx.settings, ...s };
    if (usageKey() !== before && usageCardEl?.isConnected) usageCardEl.replaceWith(usageWidgetCard());
  });
  void onEvent<{ version: string; current: string; notes: string }>("update-available", (info) => {
    pendingUpdate = info;
    renderNav();
    toast(`Tako ${info.version} est disponible`);
    if (current === "about") go("about");
  });
}

void main();
