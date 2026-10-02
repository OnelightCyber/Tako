import { Bridge } from "../core/bridge";
import { Sound } from "../core/sound";
import type { Settings } from "../core/state";
import { h, clear } from "../views/dom";
import { proIcon, type ProIconName } from "../views/pro-icons";
import { blob } from "./blob";
import { app, errText, save, set, type PageId } from "./ctx";
import { dropdown, type Choice } from "./dropdown";
import {
  button, chip, field, group, inline, kv, notice, pageHead, pill, row, segmented, slider, testButton, tile, toggle, whenShown,
  type Tone,
} from "./ui";

const SCREENS: Choice<Settings["screen"]>[] = [
  { value: "primary", label: "Écran principal", hint: "Toujours au même endroit", icon: "monitor" },
  { value: "cursor", label: "Écran sous la souris", hint: "Suit ta souris d'un écran à l'autre", icon: "eye" },
];

const MODELS: Choice<string>[] = [
  { value: "claude-opus-5-5", label: "Claude Opus 5.5", hint: "Le plus capable" },
  { value: "claude-opus-5", label: "Claude Opus 5", hint: "Très capable" },
  { value: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", hint: "Rapide et polyvalent" },
  { value: "claude-haiku-4-5", label: "Claude Haiku 4.5", hint: "Le plus rapide, le moins cher" },
];

const HOTKEYS: Choice<string>[] = [
  { value: "Alt+Shift+Space", label: "Alt + Maj + Espace" },
  { value: "Ctrl+Shift+Space", label: "Ctrl + Maj + Espace" },
  { value: "Alt+Shift+T", label: "Alt + Maj + T" },
  { value: "Ctrl+Alt+Space", label: "Ctrl + Alt + Espace" },
  { value: "off", label: "Désactivé" },
];

const SIZES = [
  { value: "1", label: "Normale", hint: "100 %" },
  { value: "1.2", label: "Grande", hint: "120 %" },
  { value: "1.4", label: "Très grande", hint: "140 %" },
];

export function chatMode(): { label: string; ok: boolean } {
  const c = app.ctx;
  if (c.cc.found) return { label: "Ton compte Claude Code", ok: true };
  if (c.hasKey) return { label: "Clé API", ok: true };
  return { label: "Non configuré", ok: false };
}

function statusTile(icon: ProIconName, tone: Tone, title: string, value: string, kind: "ok" | "warn" | "off", page: PageId): HTMLElement {
  const valueEl = h("div", { class: "st-value", text: value });
  const el = h("button", { class: `st st-${kind}`, type: "button" },
    h("div", { class: "st-top" }, tile(icon, tone, 28), h("i", { class: "st-dot" })),
    h("div", { class: "st-title", text: title }),
    valueEl,
  );
  el.addEventListener("click", () => app.go(page));
  return el;
}

function whatsNew(icon: ProIconName, tone: Tone, title: string, desc: string): HTMLElement {
  return h("div", { class: "wn" }, tile(icon, tone, 34), h("div", {}, h("b", { text: title }), h("span", { text: desc })));
}

export function homePage(): Node[] {
  const c = app.ctx;
  const ready = c.hooks.installed && (c.cc.found || c.hasKey);
  const hero = h("section", { class: "hero" },
    h("div", { class: "hero-glow" }),
    h("div", { class: "hero-text" },
      h("div", { class: `hero-kicker ${ready ? "ok" : "warn"}` }, h("i"), h("span", { text: ready ? "Tout est branché" : "Une étape avant de commencer" })),
      h("h2", { text: ready ? "Ton îlot dynamique est prêt." : "Branche Claude Code pour réveiller Tako." }),
      h("p", { text: ready
        ? "Claude Code, la musique, les appels, les notifications, la batterie, les téléchargements : tout s'affiche en haut de l'écran, au bon moment."
        : "Installe les hooks : tu vois exactement ce qui change dans ta config avant que rien ne soit écrit. Le reste de l'îlot marche déjà." }),
      h("div", { class: "hero-actions" },
        ready
          ? button("Ouvrir l'îlot", "primary", () => void Bridge.showIsland(), "play")
          : button("Installer les hooks", "primary", () => app.go("claude"), "bolt"),
        button("Personnaliser", "ghost", () => app.go("appearance"), "sparkles"),
      ),
    ),
    h("div", { class: "hero-art" }, blob(104, { particles: true, interactive: true })),
  );

  const mode = chatMode();
  const vpnTile = statusTile("shield", "indigo", "VPN", "Recherche…", "off", "network");
  whenShown(vpnTile, () => {
    void Bridge.vpnStatus().then((s) => {
      const value = vpnTile.querySelector(".st-value");
      if (!value) return;
      if (!s) value.textContent = "Dans l'app";
      else if (!s.present) value.textContent = "Aucun VPN";
      else value.textContent = s.up ? `${s.name} connecté` : `${s.name} coupé`;
      vpnTile.className = `st st-${s?.present ? (s.up ? "ok" : "warn") : "off"}`;
    });
  });
  const tiles = h("div", { class: "st-grid" },
    statusTile("code", "orange", "Hooks Claude Code", c.hooks.installed ? (c.hooks.upToDate ? "Installés" : "À mettre à jour") : "À installer", c.hooks.installed ? (c.hooks.upToDate ? "ok" : "warn") : "off", "claude"),
    statusTile("terminal", "gray", "Claude Code", c.cc.found ? (c.cc.version.split(" ")[0] || "Détecté") : "Introuvable", c.cc.found ? "ok" : "off", "claude"),
    statusTile("chat", "blue", "Chat", c.cc.found ? "Ton compte Claude" : c.hasKey ? "Clé API" : "Non configuré", mode.ok ? "ok" : "off", "chat"),
    statusTile("bell", "red", "Notifications", c.settings.notificationsEnabled ? "Dans l'îlot" : "Désactivées", c.settings.notificationsEnabled ? "ok" : "off", "notifications"),
    vpnTile,
    statusTile("refresh", "green", "Mises à jour", c.update ? `v${c.update.version} dispo` : `Tako ${c.version}`, c.update ? "warn" : "ok", "about"),
  );

  const news = group({ title: "Nouveau dans Tako", icon: "sparkles", tone: "purple" },
    h("div", { class: "wn-grid" },
      whatsNew("rocket", "indigo", "Mission Control", "Plusieurs Claude en même temps, chacun dans sa copie du projet. Tu relis, tu fusionnes en un clic."),
      whatsNew("moon", "purple", "L'équipe de nuit", "Des tâches pour la nuit, et au réveil Tako te lit ce qui est prêt à fusionner."),
      whatsNew("mic", "orange", "Tako en mode Jarvis", "Dis « Hey Tako », pose ta question : Claude te répond à voix haute. « Tako, oui » valide une permission."),
      whatsNew("clipboard", "cyan", "La Lentille", "Copie une erreur, un texte anglais, un numéro de colis ou une adresse : l'îlot propose la bonne action."),
      whatsNew("music", "pink", "Un perso vivant", "Il danse sur ta musique, transpire quand le PC chauffe, dort la nuit et fête tes tests qui passent."),
      whatsNew("layers", "green", "Animations à la Apple", "Effet gelée, appui long, Maj + molette pour changer d'activité, couleurs de la pochette."),
    ),
  );

  const tips = group({ title: "Dans l'îlot", icon: "info", tone: "gray" },
    h("div", { class: "keys" },
      key("Survol", "en haut au centre fait sortir l'îlot"),
      key("Clic", "ouvre l'îlot, ou l'activité de la petite bulle"),
      key("Appui long", "ouvre directement l'activité en cours"),
      key("Maj + molette", "passe d'une activité à l'autre"),
      key("« Hey Tako »", "pose une question à voix haute"),
      key("Y / N", "autorise ou refuse une permission"),
      key("/", "dans le chat, propose les commandes Claude"),
      key("Échap", "referme l'îlot"),
      key("Glisser un fichier", "le dépose dans le chat"),
    ),
  );

  return [pageHead("home", "orange", "Accueil", "L'état de Tako en un coup d'œil."), hero, tiles, news, tips];
}

function key(k: string, what: string): HTMLElement {
  return h("div", { class: "key" }, h("kbd", { text: k }), h("span", { text: what }));
}

export function generalPage(): Node[] {
  const c = app.ctx;
  const samples = ["approve", "finish", "love", "approval", "peek"];
  let sample = 0;
  const volume = slider({
    min: 0, max: 0.2, step: 0.005, value: c.settings.soundVolume,
    format: (v) => `${Math.round((v / 0.2) * 100)} %`,
    onInput: (v) => Sound.setVolume(v),
    onChange: (v) => {
      c.settings.soundVolume = v;
      void save();
      Sound.play("blip");
    },
  });
  const test = testButton(() => {
    Sound.resume();
    Sound.setEnabled(true);
    Sound.setVolume(c.settings.soundVolume);
    Sound.play(samples[sample++ % samples.length]);
  }, "Écouter");

  return [
    pageHead("sliders", "gray", "Général", "Démarrage, écran et sons."),
    group({ title: "Démarrage", icon: "bolt", tone: "amber" },
      row({ icon: "bolt", tone: "amber", title: "Lancer au démarrage de Windows", desc: "Tako s'ouvre discrètement en haut de l'écran.", control: toggle(c.settings.autostart, (v) => set("autostart", v)) }),
      row({ icon: "monitor", tone: "blue", title: "Afficher l'îlot sur", desc: "Avec plusieurs écrans.", control: dropdown(SCREENS, c.settings.screen, (v) => set("screen", v)) }),
    ),
    group({ title: "Comportement", icon: "clock", tone: "cyan" },
      row({
        icon: "clock", tone: "cyan", title: "Fermeture automatique", desc: "Après combien de temps l'îlot ouvert se replie quand ta souris s'en va.",
        control: slider({ min: 5, max: 60, step: 1, value: Math.round(c.settings.autoCloseInterval), format: (v) => `${v} s`, onChange: (v) => set("autoCloseInterval", v) }),
      }),
    ),
    group({ title: "Sons", icon: "volume", tone: "pink" },
      row({ icon: "volume", tone: "pink", title: "Sons de Tako", desc: "Un petit son aux moments importants : permission, fin, erreur, notification.", control: toggle(c.settings.soundEnabled, (v) => {
        Sound.setEnabled(v);
        set("soundEnabled", v);
      }) }),
      row({ icon: "sliders", tone: "pink", title: "Volume", control: inline(volume, test) }),
    ),
  ];
}

function islandPreview(scale: number): { el: HTMLElement; set(scale: number): void } {
  const pill = h("div", { class: "pv-pill" },
    h("div", { class: "pv-blob" }, blob(20)),
    h("div", { class: "pv-strip" }, h("i", { class: "pv-art" }), h("span", { text: "Midnight City" }), h("span", { class: "pv-viz" }, h("i"), h("i"), h("i"), h("i"))),
    h("div", { class: "pv-dots" }, h("i"), h("i"), h("i"), h("i")),
  );
  const caption = h("div", { class: "pv-caption" });
  const el = h("div", { class: "pv" }, h("div", { class: "pv-screen" }, pill), caption);
  const apply = (s: number) => {
    pill.style.setProperty("--z", String(s));
    caption.textContent = `Îlot replié : ${Math.round(288 * s)} × ${Math.round(32 * s)} px · ouvert : ${Math.round(640 * s)} px de large`;
  };
  apply(scale);
  return { el, set: apply };
}

export function appearancePage(): Node[] {
  const c = app.ctx;
  const current = String(Math.round(c.settings.islandScale * 100) / 100);
  const preview = islandPreview(c.settings.islandScale);
  const known = SIZES.some((s) => s.value === current);
  const sizes = known ? SIZES : [...SIZES, { value: current, label: `${Math.round(c.settings.islandScale * 100)} %`, hint: "" }];
  return [
    pageHead("sparkles", "purple", "Apparence", "La taille de l'îlot et ce qu'il montre."),
    group({ title: "Taille de l'îlot", icon: "monitor", tone: "purple", note: "Sur un grand écran de PC, l'îlot gagne à être plus grand. Tout grandit d'un coup : textes, personnage, bulles et animations." },
      preview.el,
      row({
        icon: "sparkles", tone: "purple", title: "Taille", keywords: "zoom grand petit échelle",
        control: segmented(sizes, current, (v) => {
          preview.set(Number(v));
          set("islandScale", Number(v), `Taille ${Math.round(Number(v) * 100)} %`);
        }),
      }),
    ),
    group({ title: "Le personnage", icon: "sparkles", tone: "pink", note: "Tako vit sa vie : il danse sur ta musique, transpire quand le processeur chauffe, s'endort la nuit quand tu ne fais rien et fait la fête quand tes tests passent." },
      row({ icon: "sparkles", tone: "pink", title: "Personnage vivant", desc: "Danse, sueur, sommeil et fêtes. Désactive-le pour un personnage plus sage.", keywords: "mascotte danse musique dodo nuit tests fête",
        control: inline(testButton(() => void Bridge.hudTest("celebrate"), "Faire la fête"), toggle(c.settings.mascotAlive, (v) => set("mascotAlive", v))) }),
      row({ icon: "eye", tone: "gray", title: "Réduire les animations", desc: "Plus d'effet gelée, plus de flou entre les vues, le personnage ne danse plus.", keywords: "mouvement calme accessibilité animation",
        control: toggle(c.settings.calmMotion, (v) => set("calmMotion", v)) }),
    ),
    group({ title: "Pastilles", icon: "layers", tone: "blue" },
      row({ icon: "cpu", tone: "cyan", title: "Stats du PC", desc: "Processeur, mémoire et carte graphique, dans l'îlot ouvert.", control: toggle(c.settings.statsEnabled, (v) => set("statsEnabled", v)) }),
      row({ icon: "eye", tone: "blue", title: "Ouvrir l'îlot quand Claude a fini", desc: "Avec le bilan du tour : fichiers, lignes, tokens, Commit, Diff, Annuler. Sinon une pastille verte.", control: toggle(c.settings.openOnFinish, (v) => set("openOnFinish", v)) }),
    ),
  ];
}

export function claudePage(): Node[] {
  const c = app.ctx;
  const hookCard = group({ title: "Hooks", icon: "bolt", tone: "orange" });
  const body = hookCard.querySelector(".group-body") as HTMLElement;

  const draw = () => {
    clear(body);
    const outdated = c.hooks.installed && !c.hooks.upToDate;
    body.append(
      row({
        icon: "code", tone: "orange", title: c.hooks.installed ? "Tako reçoit tes sessions" : "Relier Tako à Claude Code", keywords: "hooks settings.json relais",
        desc: c.hooks.installed
          ? "Toutes tes sessions Claude Code, depuis n'importe quel terminal, s'affichent dans l'îlot."
          : "Installe les hooks pour voir tes sessions dans l'îlot et valider les permissions sans quitter ce que tu fais.",
        control: pill(c.hooks.installed ? (outdated ? "warn" : "ok") : "off", c.hooks.installed ? (outdated ? "À mettre à jour" : "Installés") : "Non installés"),
      }),
      kv([["settings.json", c.hooks.settingsPath], ["Relais", c.hooks.hookPath]]),
    );
    if (!c.hooks.hookReady) body.append(notice("warn", "tako-hook.exe n'est pas encore en place. Relance Tako ; si ça persiste, compile-le avec cargo build -p tako-hook."));
    if (outdated) body.append(notice("warn", "Les hooks de Tako ont évolué. Mets-les à jour pour profiter de tout (relecture, délais plus longs)."));
    const install = button(outdated ? "Mettre à jour…" : c.hooks.installed ? "Réinstaller…" : "Installer les hooks…", "primary", () => void preview(true), "bolt");
    if (!c.hooks.hookReady) install.disabled = true;
    const actions = h("div", { class: "actions" }, install);
    if (c.hooks.installed) actions.append(button("Désinstaller…", "danger", () => void preview(false), "x"));
    body.append(actions);
  };

  const preview = async (install: boolean) => {
    let plan;
    try {
      plan = await Bridge.hooksPreview(install);
    } catch (err) {
      clear(body);
      body.append(notice("err", errText(err)), h("div", { class: "actions" }, button("Retour", "ghost", draw)));
      return;
    }
    if (!plan) return;
    clear(body);
    const confirm = button(install ? "Sauvegarder et écrire" : "Sauvegarder et retirer", install ? "primary" : "danger", async () => {
      confirm.disabled = true;
      try {
        const backup = await Bridge.hooksApply(install, plan.fingerprint);
        const fresh = await Bridge.hooksStatus();
        if (fresh) c.hooks = fresh;
        app.toast(install ? "Hooks installés" : "Hooks retirés");
        draw();
        body.append(notice("ok", `Ancienne config sauvegardée : ${backup}. Ouvre une nouvelle session Claude Code pour en profiter.`));
        app.refresh();
      } catch (err) {
        confirm.disabled = false;
        body.append(notice("err", `Écriture impossible : ${errText(err)}`));
      }
    }, "check");
    body.append(
      h("p", { class: "group-note", text: install
        ? "Exactement ce qui sera écrit dans ton settings.json. Tes propres hooks ne sont pas touchés."
        : "Seules les entrées de Tako partent. Tes propres hooks restent." }),
      diffBox(plan.diff),
      kv([["Sauvegarde", plan.backup]]),
      h("div", { class: "actions" }, confirm, button("Annuler", "ghost", draw)),
    );
  };
  draw();

  const reviewReady = c.hooks.installed && c.hooks.upToDate;
  const review = group({ title: "Mode relecture", icon: "review", tone: "green", right: pill(c.settings.reviewMode ? (reviewReady ? "ok" : "warn") : "off", c.settings.reviewMode ? "Actif" : "Désactivé"),
    note: "Chaque modification de fichier attend ton OK dans l'îlot, diff affiché, avant d'être écrite. Pas de réponse ou Tako en pause : la modif est refusée. Une session en mode auto de Claude Code n'est jamais retenue." },
    row({ icon: "eye", tone: "green", title: "Relire chaque modification", desc: reviewReady ? null : "Mets d'abord les hooks à jour.",
      control: toggle(c.settings.reviewMode, (v) => set("reviewMode", v, v ? "Relecture activée" : "Relecture désactivée"), !reviewReady && !c.settings.reviewMode) }),
    row({ icon: "undo", tone: "gray", title: "Annuler un tour", desc: "Avant chaque modification, Tako garde une copie du fichier 3 jours, sur ton PC uniquement (1 Go maximum). Les fichiers sensibles (.env, clés, .ssh…) ne sont jamais copiés.", control: h("span", { class: "muted small", text: "Toujours actif" }) }),
  );

  const hotkeyNote = notice("warn", "Ce raccourci est déjà pris par une autre application. Choisis-en un autre.");
  hotkeyNote.style.display = "none";
  const checkHotkey = async () => {
    const err = await Bridge.hotkeyStatus();
    hotkeyNote.style.display = err ? "" : "none";
  };
  whenShown(hotkeyNote, () => void checkHotkey());
  const missions = group({ title: "Missions", icon: "rocket", tone: "purple", note: "Tape une tâche dans l'îlot : Tako ouvre Claude Code dans le projet choisi, dans un nouveau terminal, et tu suis tout en direct." },
    row({ icon: "bolt", tone: "purple", title: "Raccourci global", desc: "Ouvre « Nouvelle mission » depuis n'importe où.", keywords: "hotkey clavier",
      control: dropdown(HOTKEYS, c.settings.missionHotkey || "Alt+Shift+Space", (v) => {
        c.settings.missionHotkey = v;
        void save("Raccourci enregistré").then(() => window.setTimeout(() => void checkHotkey(), 300));
      }) }),
    hotkeyNote,
  );

  const binary = group({ title: "Claude Code", icon: "terminal", tone: "gray", right: pill(c.cc.found ? "ok" : "off", c.cc.found ? (c.cc.version.split(" ")[0] || "Détecté") : "Introuvable") },
    c.cc.found
      ? kv([["Exécutable", c.cc.path]])
      : h("p", { class: "group-note", text: "Installe Claude Code (npm i -g @anthropic-ai/claude-code) puis relance Tako." }),
  );

  return [pageHead("code", "orange", "Claude Code", "Ce qui relie Tako à tes sessions."), hookCard, review, missions, binary];
}

function diffBox(text: string): HTMLElement {
  const box = h("div", { class: "diff" });
  for (const line of text.split("\n")) {
    const cls = line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "ctx";
    box.append(h("div", { class: cls, text: line || " " }));
  }
  return box;
}

export function chatPage(): Node[] {
  const c = app.ctx;
  const mode = chatMode();
  const noCli = !c.cc.found;

  const backend = group({ title: "Qui répond", icon: "chat", tone: "blue", right: pill(mode.ok ? "ok" : "off", mode.label),
    note: c.cc.found
      ? "Le chat lance ton propre Claude Code en arrière-plan : pas de clé API, ton abonnement, et Tako ne touche jamais à tes identifiants. Tape / pour ses commandes."
      : "Claude Code n'est pas installé : le chat utilise une clé API Anthropic, rangée dans le Gestionnaire d'identification Windows." },
    h("div", { class: "chips" }, chip("file", "Lit tes fichiers"), chip("search", "Cherche sur le web"), chip("slash", "Commandes /"), chip("shieldCheck", "Ne modifie rien")),
  );

  const powers = group({ title: "Pouvoirs du chat", icon: "sparkles", tone: "purple" },
    row({ icon: "monitor", tone: "cyan", title: "Voir ton écran", desc: "Quand ta question parle de ce que tu vois, il prend une capture tout seul. Jamais enregistrée, jamais en arrière-plan.", keywords: "vision capture",
      control: toggle(c.settings.chatScreen, (v) => set("chatScreen", v, v ? "Vision activée" : "Vision désactivée"), noCli) }),
    row({ icon: "apps", tone: "green", title: "Ouvrir tes applis", desc: "« Ouvre Spotify », « lance Discord » : il ouvre l'appli du menu Démarrer et la laisse ouverte. Il ne ferme jamais rien.", keywords: "applications lancer",
      control: toggle(c.settings.chatApps, (v) => set("chatApps", v, v ? "Applications activées" : "Applications désactivées"), noCli) }),
  );

  const agentBody = h("div", { class: "sub-rows" });
  const drawAgent = () => {
    clear(agentBody);
    if (!c.settings.chatAgent) return;
    agentBody.append(
      row({ icon: "eye", tone: "blue", title: "Navigateur visible", desc: "Regarde l'agent cliquer en direct. Le navigateur s'ouvre seulement quand le chat en a besoin, puis reste ouvert.",
        control: toggle(c.settings.agentBrowserVisible, (v) => set("agentBrowserVisible", v)) }),
      row({ icon: "bolt", tone: "amber", title: "Mode auto", desc: "Le chat agit sans te demander à chaque action (navigateur et applis). Plus rapide, moins sûr.",
        control: toggle(c.settings.agentAuto, (v) => {
          c.settings.agentAuto = v;
          drawAgent();
          void save(v ? "Mode auto activé" : "Mode auto désactivé");
        }) }),
    );
    if (c.settings.agentAuto) {
      agentBody.append(notice("warn", "Mode auto : l'agent ouvre, clique et tape sans te demander. Une page piégée peut alors lui faire faire une action que tu n'as pas vue. Garde-le pour les sites de confiance."));
    } else {
      agentBody.append(h("div", { class: "guard" },
        h("div", { class: "guard-title" }, proIcon("shield", 15), h("span", { text: "Ce que l'agent te demande avant de le faire" })),
        h("div", { class: "chips" },
          chip("globe", "Ouvrir une page", "warn"), chip("bolt", "Cliquer", "warn"), chip("terminal", "Taper du texte", "warn"),
          chip("listChecks", "Remplir un formulaire", "warn"), chip("code", "Exécuter du JavaScript", "warn"), chip("apps", "Ouvrir une appli", "warn"),
        ),
        h("p", { class: "muted small", text: "Chaque action arrive dans l'îlot avec l'URL ou le texte exact. Sans réponse, elle est refusée. Le contenu des sites est traité comme une donnée, jamais comme un ordre." }),
      ));
    }
  };
  drawAgent();
  const agent = group({ title: "Agent navigateur", icon: "globe", tone: "indigo", right: h("span", { class: "tag", text: "Playwright" }) },
    row({ icon: "sparkles", tone: "indigo", title: "Donner un navigateur au chat", desc: "Il ouvre des sites, clique et remplit des formulaires pour toi. Chrome ne se lance qu'au moment où il en a besoin.", keywords: "agent playwright chrome",
      control: toggle(c.settings.chatAgent, (v) => {
        c.settings.chatAgent = v;
        drawAgent();
        void save(v ? "Agent activé" : "Agent désactivé");
      }, noCli) }),
    agentBody,
  );

  const keyField = field({
    value: "", placeholder: c.hasKey ? "••••••••••••  (enregistrée)" : "sk-ant-…", secret: true, button: "Enregistrer",
    onSubmit: async (value) => {
      if (!value) return;
      try {
        await Bridge.secretSet("anthropic-api-key", value);
        c.hasKey = true;
        keyField.input.value = "";
        keyField.input.placeholder = "••••••••••••  (enregistrée)";
        drop.style.display = "";
        app.toast("Clé enregistrée");
        app.refresh();
      } catch (err) {
        app.toast(`Impossible : ${errText(err)}`, "err");
      }
    },
  });
  const drop = button("Retirer", "danger", async () => {
    try {
      await Bridge.secretClear("anthropic-api-key");
      c.hasKey = false;
      keyField.input.placeholder = "sk-ant-…";
      drop.style.display = "none";
      app.toast("Clé retirée");
      app.refresh();
    } catch (err) {
      app.toast(`Impossible : ${errText(err)}`, "err");
    }
  });
  drop.classList.add("small");
  drop.style.display = c.hasKey ? "" : "none";
  const models = MODELS.some((m) => m.value === c.settings.model) ? MODELS : [...MODELS, { value: c.settings.model, label: c.settings.model }];
  const api = group({ title: "Clé API (secours)", icon: "key", tone: "gray", right: pill(c.hasKey ? "ok" : "off", c.hasKey ? "Enregistrée" : "Aucune"),
    note: c.cc.found ? "Utilisée seulement si Claude Code n'est plus trouvé." : "Facturée à l'usage sur console.anthropic.com." },
    h("div", { class: "inline grow" }, keyField.el, drop),
    row({ icon: "cpu", tone: "gray", title: "Modèle", desc: "Pour le chat par clé API. Avec Claude Code, c'est ton modèle par défaut qui répond.", control: dropdown(models, c.settings.model, (v) => set("model", v)) }),
  );

  return [pageHead("chat", "blue", "Chat & agent", "Parle à Claude depuis l'îlot, et laisse-le agir pour toi."), backend, powers, agent, api];
}
