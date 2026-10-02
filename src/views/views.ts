import { h, svg, clear, dot } from "./dom";
import { ICONS } from "./icons";
import { Ticker } from "./ticker";
import { PLACEHOLDER_ID, State, type AgentTask } from "../core/state";
import { washRGBA, type IslandViewName, type Wash } from "../core/layout";
import { createMiniBot, pruneMiniBots } from "../mascot/minibots";
import { buildPrompt } from "./chat";
import { buildChoose, buildUpload, buildUploading } from "./upload";
import { renderIntegrationCard, type IntegrationCardHooks } from "./integrations";
import { buildSession } from "./session";
import { proIcon } from "./pro-icons";
import {
  buildFinished, buildMission, buildMusic, buildReview, buildSystem, buildUsageAlert,
  contextBadge, fit, mediaPill, statsPill,
} from "./extra";
import { buildBluetooth, buildTimer, buildVpn, timerPill } from "./live";
import { buildNotifications, glancePills, homeCard, noticePill, privacyPill } from "./hub";
import { buildToday } from "./today";
import { buildVoice } from "./voice";
import { buildSquad } from "./squad";
import { buildDawn } from "./dawn";
import { Timer } from "../core/timer";

export interface ViewActions {
  setView(v: IslandViewName): void;
  collapse(): void;
  setFocus(id: string): void;
  openTerminal(): void;

  openTarget(): void;
  openUrl(url: string): void;
  decide(d: "allow" | "deny" | "all"): void;
  toggleSound(): void;
  setVolume(v: number): void;
  setAutoClose(seconds: number): void;
  openSettingsWindow(): void;
  blip(): void;
}

export interface ViewHost {
  el: HTMLElement;
  sync(): void;

  focus?(): void;

  tick?(nowMs: number): void;

  animating?(): boolean;
}

function card(wash: Wash, ...children: (Node | string)[]): HTMLElement {
  const el = h("div", { class: wash ? "card wash" : "card" }, ...children);
  if (wash) el.style.setProperty("--wash", washRGBA(wash));
  return el;
}

function btn(
  label: string,
  kind: "primary" | "secondary",
  onClick: () => void,
  kbd?: string,
): HTMLElement {
  return h(
    "button",
    { class: `btn ${kind}`, onclick: onClick },
    h("span", { text: label }),
    kbd ? h("span", { class: "kbd", text: kbd }) : null,
  );
}

function agentWho(task: AgentTask | null, label: string): HTMLElement {
  const row = h("div", { class: "who-row" });
  if (task) {
    row.append(dot(task.color, 8), h("span", { class: "n", text: task.name }));
  }
  row.append(h("span", { text: label }));
  return row;
}

function stack(padLeft: number, padRight: number, ...children: Node[]): HTMLElement {
  const el = h("div", { class: "stack" }, ...children);
  el.style.padding = `4px ${padRight}px 4px ${padLeft}px`;
  return el;
}

export function buildHeader(actions: ViewActions): ViewHost {
  const tabHome = h("button", {
    class: "tab",
    title: "Accueil",
    onclick: () => go(State.view === "session" ? "overview" : State.defaultView()),
  }, svg(ICONS.house, 13));
  const tabChat = h("button", { class: "tab", title: "Demander à Claude", onclick: () => go("prompt") }, svg(ICONS.bubble, 13));
  const tabDrop = h("button", { class: "tab", title: "Déposer un fichier", onclick: () => go("upload") }, svg(ICONS.plus, 13));
  const missionBadge = h("i", { class: "tab-badge" });
  const tabMission = h("button", { class: "tab", title: "Mission Control", onclick: () => go("squad") }, proIcon("rocket", 13, 2), missionBadge);
  const tabTimer = h("button", { class: "tab", title: "Minuteur", onclick: () => go("timer") }, proIcon("timer", 13, 2));
  const bellBadge = h("i", { class: "tab-badge" });
  const tabBell = h("button", { class: "tab", title: "Notifications", onclick: () => go("notifications") }, proIcon("bell", 13, 2), bellBadge);

  const gearBtn = h("button", { title: "Réglages", onclick: () => go("settings") }, svg(ICONS.gear, 14));
  const soundBtn = h("button", { title: "Son", onclick: () => actions.toggleSound() }, svg(ICONS.speakerOn, 14));

  function go(v: IslandViewName) {
    actions.blip();
    actions.setView(v);
  }

  const el = h(
    "div",
    { id: "header" },
    h("div", { class: "tabs" }, tabHome, tabChat, tabMission, tabTimer, tabBell, tabDrop),
    h("div", { class: "header-actions" }, gearBtn, soundBtn),
  );

  return {
    el,
    sync() {
      const v = State.view;
      tabHome.classList.toggle("on", v === "overview" || v === "empty" || v === "session");
      tabChat.classList.toggle("on", v === "prompt");
      tabDrop.classList.toggle("on", v === "upload");
      tabMission.classList.toggle("on", v === "mission" || v === "squad" || v === "dawn");
      const ready = State.squad.filter((j) => j.status === "done" || j.status === "waiting").length;
      missionBadge.textContent = ready ? String(ready) : "";
      missionBadge.style.display = ready && v !== "squad" ? "" : "none";
      tabMission.classList.toggle("live", State.squad.some((j) => j.status === "running"));
      tabTimer.classList.toggle("on", v === "timer");
      tabTimer.classList.toggle("live", Timer.active);
      tabBell.classList.toggle("on", v === "notifications");
      bellBadge.textContent = State.unreadNotices > 9 ? "9+" : State.unreadNotices ? String(State.unreadNotices) : "";
      bellBadge.style.display = State.unreadNotices && v !== "notifications" ? "" : "none";
      gearBtn.classList.toggle("on", v === "settings");
      clear(gearBtn);
      gearBtn.append(svg(v === "settings" ? ICONS.gearFill : ICONS.gear, 14));
      clear(soundBtn);
      soundBtn.append(svg(State.settings.soundEnabled ? ICONS.speakerOn : ICONS.speakerOff, 14));
      el.style.opacity = v === "confused" ? "0" : "1";
    },
  };
}

function buildOverview(actions: ViewActions): ViewHost {
  const ticker = new Ticker();
  const who = h("div", { class: "who" });
  const tickerBody = h("div", { class: "card-body clickable", title: "Voir la session" }, who, ticker.el);
  tickerBody.addEventListener("click", () => {
    actions.blip();
    actions.setView("session");
  });
  const leftBody = h("div", { class: "left-body" });
  const jump = h(
    "button",
    { class: "icon-btn jump", title: "Ouvrir", onclick: () => actions.openTarget() },
    svg(ICONS.arrowUpRight, 8),
  );
  const left = card(null, leftBody, jump);
  const pills = h("div", { class: "pills" });
  const right = card(null, pills);

  const el = h("div", { class: "view overview" },
    h("div", { class: "left" }, left),
    h("div", { class: "right" }, right),
  );

  let pillIds = "";
  const timer = timerPill(actions);
  Timer.onTick(() => {
    if (State.view === "overview" && State.mode === "expanded" && Timer.state) timer.update();
  });
  const media = mediaPill(actions);
  const stats = statsPill(actions);
  const notice = noticePill(actions);
  const privacy = privacyPill();
  const fillers = glancePills(actions);
  let detailOpen = false;
  let lastFocus: string | null = null;
  let mode: "ticker" | "card" | "home" | null = null;
  const home = homeCard(actions);
  let cardKey = "";

  const hooks: IntegrationCardHooks = {
    get detailOpen() {
      return detailOpen;
    },
    openDetail() {
      detailOpen = true;
      cardKey = "";
      State.notify();
    },
    closeDetail() {
      detailOpen = false;
      cardKey = "";
      State.notify();
    },
    openSettings: () => actions.openSettingsWindow(),
  };

  return {
    el,
    tick(nowMs: number) {
      if (mode === "ticker") ticker.tick(nowMs);
    },
    animating() {
      return mode === "ticker" && ticker.animating;
    },
    sync() {
      const task = State.focusTask;
      if (task?.id !== lastFocus) {
        lastFocus = task?.id ?? null;
        detailOpen = false;
        cardKey = "";
        mode = null;
      }

      const sessionActive = !!task?.sessionId && (task.state !== "idle" || task.steps.length > 0);

      if (task && sessionActive) {
        if (mode !== "ticker") {
          clear(leftBody);
          leftBody.append(tickerBody);
          mode = "ticker";
          cardKey = "";
        }
        clear(who);
        who.append(
          dot(task.color, 7),
          h("span", { class: "name", text: task.name }),
          h("span", { class: "tool", text: task.origin === "mission" ? "Mission" : task.source === "claudeCode" ? "Claude Code" : "n8n" }),
        );
        const ctx = contextBadge(task);
        if (ctx) who.append(ctx);
        else if ((task.stepTotal ?? 0) > 1) who.append(h("span", { class: "count", text: `${task.stepTotal} étapes` }));
        ticker.sync(task);
      } else if (task && task.id === PLACEHOLDER_ID) {
        if (mode !== "home") {
          clear(leftBody);
          leftBody.append(home.el);
          mode = "home";
          cardKey = "";
        }
        home.update();
      } else if (task) {
        const info = State.integrations[task.id];
        const key = [
          task.id, detailOpen, task.state, task.steps.join("|"),
          info?.loaded, info?.error, info?.configured,
          JSON.stringify(info?.data ?? {}),
        ].join("~");
        if (key !== cardKey) {
          cardKey = key;
          mode = "card";
          clear(leftBody);
          leftBody.append(renderIntegrationCard(task, hooks));
        }
      }

      jump.style.display = detailOpen || mode === "home" ? "none" : "";

      const showTimer = !!Timer.state;
      const showMedia = State.settings.mediaEnabled && !!State.media?.active;
      const showStats = State.settings.statsEnabled && !!State.stats;
      const p = State.privacy;
      const showPrivacy = State.settings.privacyDots && (p.mic.length > 0 || p.cam.length > 0);
      const showNotice = State.settings.notificationsEnabled;
      const used = [showTimer, showMedia, showStats, showPrivacy, showNotice].filter(Boolean).length;
      const others = State.otherTasks.slice(0, Math.max(0, Math.min(4, 6 - used)));
      const room = Math.max(0, 6 - used - others.length);
      const filled = fillers.filter((f) => f.available()).slice(0, room);
      const pillKey = `${others.map((t) => `${t.id}:${t.pillBadge ?? ""}:${t.name}`).join("|")}~${showTimer}~${showMedia}~${showStats}~${showPrivacy}~${showNotice}~${filled.map((f) => fillers.indexOf(f)).join(",")}`;
      if (pillKey !== pillIds) {
        pillIds = pillKey;
        clear(pills);
        for (const t of others) pills.append(buildPill(t, actions));
        if (showPrivacy) pills.append(privacy.el);
        if (showTimer) pills.append(timer.el);
        if (showMedia) pills.append(media.el);
        if (showNotice) pills.append(notice.el);
        if (showStats) pills.append(stats.el);
        for (const f of filled) pills.append(f.el);
        pruneMiniBots();
      }
      for (const f of filled) f.update();
      if (showTimer) timer.update();
      if (showMedia) media.update();
      if (showStats) stats.update();
      if (showNotice) notice.update();
      if (showPrivacy) privacy.update();
    },
  };
}

function buildPill(task: AgentTask, actions: ViewActions): HTMLElement {
  const label = task.name;
  const canvas = createMiniBot(task, 24);
  const pill = h(
    "div",
    { class: "pill", onclick: () => actions.setFocus(task.id) },
    canvas,
    h("span", { class: "lbl", text: label }),
  );
  pill.style.borderColor = `${task.color}24`;
  pill.addEventListener("mouseenter", () => {
    pill.style.background = `${task.color}2e`;
    pill.style.borderColor = `${task.color}8c`;
    pill.style.boxShadow = `0 2px 10px ${task.color}59`;
    (pill.querySelector(".lbl") as HTMLElement).style.color = lighten(task.color, 0.3);
  });
  pill.addEventListener("mouseleave", () => {
    pill.style.background = "";
    pill.style.borderColor = `${task.color}24`;
    pill.style.boxShadow = "";
    (pill.querySelector(".lbl") as HTMLElement).style.color = "";
  });

  if (task.pillBadge) {
    const colors = { approval: "#F4505E", finished: "#22C55E", error: "#F4505E" } as const;
    const icons = { approval: ICONS.bang, finished: ICONS.check, error: ICONS.xmark } as const;
    const inner = h("i", { style: `background:${colors[task.pillBadge]}` }, svg(icons[task.pillBadge], 6, { stroke: task.pillBadge === "finished" ? 3 : 0 }));
    const badge = h("div", { class: `pill-badge ${task.pillBadge}` }, inner);
    badge.style.boxShadow = `0 0 4px ${colors[task.pillBadge]}99`;
    pill.append(badge);
  }
  return pill;
}

function lighten(hex: string, amount: number): string {
  const v = parseInt(hex.replace("#", ""), 16);
  const c = [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((x) =>
    Math.min(255, Math.round(x + amount * 255)),
  );
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

function buildEmpty(actions: ViewActions): ViewHost {
  const body = h(
    "div",
    { class: "stack", style: "padding:0 18px 0 118px;flex-direction:row;align-items:center;gap:16px" },
    h(
      "div",
      { style: "display:flex;flex-direction:column;gap:5px" },
      h("div", { class: "title", text: "Rien en cours pour l'instant." }),
      h("div", { class: "sub", text: "Dépose un fichier ou demande-moi n'importe quoi." }),
    ),
    h("div", { class: "grow" }),
    btn("Demander à Claude", "primary", () => actions.setView("prompt")),
  );
  return { el: h("div", { class: "view" }, card(null, body)), sync() {} };
}

function buildApproval(actions: ViewActions): ViewHost {
  const who = h("div");
  const code = h("div", { class: "code wrap" });
  const row = h("div", { class: "actions" });
  const body = stack(116, 16, who, code, row);
  const el = h("div", { class: "view fits" }, card("amber", body));
  const hint = h("span", { class: "voice-hint" }, proIcon("mic", 11, 2.2), h("span", { text: "« Tako, oui » · « Tako, non »" }));
  let rowKey = "";
  return {
    el,
    sync() {
      clear(who);
      const req = State.pendingApproval;
      if (req?.origin === "chat") {
        const what = req.tool.endsWith("open_app") ? "veut ouvrir une application" : "veut utiliser le navigateur";
        who.append(h("div", { class: "who-row" }, dot("#FF7A59", 8), h("span", { class: "n", text: "Tako agent" }), h("span", { text: what })));
      } else {
        const task = State.tasks.find((t) => t.id === req?.taskId) ?? State.focusTask;
        who.append(agentWho(task, "demande une permission"));
      }
      if (State.approvalQueue.length) who.append(h("span", { class: "rv-queue inline", text: `+${State.approvalQueue.length} en attente` }));

      code.textContent = State.pendingApproval?.command || State.pendingApproval?.tool || "…";

      const fresh = Date.now() - (req?.shownAt ?? 0) < 700;
      if (rowKey !== "built") {
        rowKey = "built";
        clear(row);
        row.append(
          btn("Refuser", "secondary", () => actions.decide("deny"), "N"),
          btn("Autoriser", "primary", () => actions.decide("allow"), "Y"),
        );
      }
      row.lastElementChild?.classList.toggle("guard", fresh);
      const spoken = State.settings.voiceEnabled && State.settings.voiceApprovals;
      if (spoken && !hint.isConnected) row.append(hint);
      else if (!spoken && hint.isConnected) hint.remove();
      if (State.view === "approval") fit("approval", el, body);
    },
  };
}

function buildQuestion(): ViewHost {
  const who = h("div");
  const title = h("div", { class: "title wrap long" });
  const row = h("div", { class: "actions" });
  const body = stack(116, 16, who, title, row);
  const el = h("div", { class: "view fits" }, card("cyan", body));
  return {
    el,
    sync() {
      window.requestAnimationFrame(() => {
        if (State.view === "question") fit("question", el, body);
      });
      clear(who);
      who.append(agentWho(State.focusTask, "Claude Code te pose une question"));
      const task = State.focusTask;
      title.textContent = task?.steps.at(-1) ?? "Claude attend une réponse.";
      clear(row);
      row.append(h("div", { class: "sub", text: "Réponds dans ton terminal : Tako ne peut pas encore répondre à ta place." }));
    },
  };
}

function buildError(actions: ViewActions): ViewHost {
  const who = h("div");
  const title = h("div", { class: "title", text: "Workflow arrêté." });
  const detail = h("div", { class: "detail wrap" });
  const row = h("div", { class: "actions" },
    btn("OK", "primary", () => actions.setView(State.defaultView())),
    btn("Ouvrir le projet", "secondary", () => actions.openTarget()),
  );
  const body = stack(116, 16, who, title, detail, row);
  const el = h("div", { class: "view fits" }, card("red", body));
  return {
    el,
    sync() {
      window.requestAnimationFrame(() => {
        if (State.view === "error") fit("error", el, body);
      });
      const task = State.focusTask;
      clear(who);
      who.append(agentWho(task, task?.source === "n8n" ? "n8n" : "Claude Code"));
      title.textContent = task?.source === "n8n" ? "Workflow arrêté." : "Session arrêtée sur une erreur.";
      detail.textContent = task?.steps.at(-1) ?? "Pas de détail.";
    },
  };
}

function buildConfused(): ViewHost {
  const body = h(
    "div",
    { class: "stack", style: "padding:0 18px 0 128px" },
    h("div", { class: "title", text: "Doucement, ça tourne !" }),
    h("div", { class: "sub", text: "Laisse-moi trois secondes et je reviens." }),
  );
  return { el: h("div", { class: "view" }, card("pink", body)), sync() {} };
}

function buildNote(): ViewHost {
  const title = h("div", { class: "title wrap" });
  const body = h("div", { class: "stack", style: "padding:12px 18px 12px 98px" }, title);
  const el = h("div", { class: "view fits" }, card(null, body));
  return {
    el,
    sync() {
      title.textContent = State.noteMessage ?? "";
      window.requestAnimationFrame(() => {
        if (State.view === "note") fit("note", el, body);
      });
    },
  };
}

function buildSettings(actions: ViewActions): ViewHost {
  const soundSwitch = h("button", { class: "switch", onclick: () => actions.toggleSound() });
  const volume = h("input", {
    type: "range", min: "0", max: "0.2", step: "0.005",
    oninput: (e: Event) => actions.setVolume(Number((e.target as HTMLInputElement).value)),
  }) as HTMLInputElement;
  const autoLabel = h("span", {});
  const segButtons = [10, 15, 30].map((s) =>
    h("button", { onclick: () => actions.setAutoClose(s) }, `${s}s`),
  );
  const claudeBadge = h("span", { class: "status-badge" });
  const apiBadge = h("span", { class: "status-badge" });

  const rows = h(
    "div",
    { class: "settings-rows" },
    h("div", { class: "settings-row" }, soundSwitch, h("span", { text: "Son" }), volume),
    h(
      "div",
      { class: "settings-row" },
      svg(ICONS.timer, 12),
      autoLabel,
      h("div", { class: "seg" }, ...segButtons),
    ),
    h(
      "div",
      { class: "settings-row", style: "gap:14px" },
      claudeBadge,
      apiBadge,
      h("div", { class: "grow" }),
      h("button", {
        class: "link-btn",
        style: "color:#8e939c;font-size:11.5px",
        text: "Tous les réglages…",
        onclick: () => actions.openSettingsWindow(),
      }),
    ),
  );

  const el = h("div", { class: "view" },
    card(null, h("div", { class: "stack", style: "padding:14px 16px 14px 84px" }, rows)));

  return {
    el,
    sync() {
      const s = State.settings;
      soundSwitch.classList.toggle("on", s.soundEnabled);
      volume.value = String(s.soundVolume);
      volume.style.opacity = s.soundEnabled ? "1" : "0.4";
      autoLabel.textContent = `Fermeture auto · ${Math.round(s.autoCloseInterval)} s`;
      segButtons.forEach((b, i) => b.classList.toggle("on", s.autoCloseInterval === [10, 15, 30][i]));
      clear(claudeBadge);
      claudeBadge.append(
        dot(s.hooksInstalled ? "#22C55E" : "#F4505E", 6),
        h("span", { text: "Claude Code" }),
      );
      clear(apiBadge);
      const viaClaudeCode = State.chatBackend === "claude-code";
      apiBadge.append(dot(viaClaudeCode ? "#22C55E" : "#F4505E", 6), h("span", { text: viaClaudeCode ? "Chat · ton compte" : "Chat · clé API" }));
    },
  };
}

function buildPlaceholder(title: string, sub: string): ViewHost {
  const body = h(
    "div",
    { class: "stack", style: "padding:0 18px 0 118px" },
    h("div", { class: "title", text: title }),
    h("div", { class: "sub", text: sub }),
  );
  return { el: h("div", { class: "view" }, card(null, body)), sync() {} };
}

export function buildViews(
  actions: ViewActions,
  onChatHeightChange: () => void,
): Map<IslandViewName, ViewHost> {
  const map = new Map<IslandViewName, ViewHost>();
  map.set("overview", buildOverview(actions));
  map.set("session", buildSession(actions));
  map.set("empty", buildEmpty(actions));
  map.set("approval", buildApproval(actions));
  map.set("question", buildQuestion());
  map.set("error", buildError(actions));
  map.set("finished", buildFinished(actions));
  map.set("confused", buildConfused());
  map.set("note", buildNote());
  map.set("settings", buildSettings(actions));
  map.set("prompt", buildPrompt(onChatHeightChange));
  map.set("upload", buildUpload());
  map.set("uploading", buildUploading());
  map.set("choose", buildChoose(actions));
  map.set("review", buildReview(actions));
  map.set("mission", buildMission(actions));
  map.set("music", buildMusic());
  map.set("system", buildSystem());
  map.set("usage", buildUsageAlert(actions));
  map.set("timer", buildTimer(actions));
  map.set("bluetooth", buildBluetooth(actions));
  map.set("vpn", buildVpn(actions));
  map.set("notifications", buildNotifications(actions));
  map.set("today", buildToday(actions));
  map.set("voice", buildVoice(actions));
  map.set("squad", buildSquad(actions));
  map.set("dawn", buildDawn(actions));

  map.set("mail", buildPlaceholder("L'envoi par e-mail arrive bientôt.", ""));
  map.set("searching", buildPlaceholder("Claude cherche…", ""));
  map.set("result", buildPlaceholder("Résultat", ""));
  return map;
}
