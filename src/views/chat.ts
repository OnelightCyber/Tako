import { h, svg, clear } from "./dom";
import { ICONS } from "./icons";
import { proIcon } from "./pro-icons";
import { contentHeight, islandBox, setSizeHint } from "./fit";
import { Bridge, onEvent, type ChatContext, type UsageReport } from "../core/bridge";
import { Sound } from "../core/sound";
import { State, type ChatMessage } from "../core/state";
import type { ViewHost } from "./views";
import { countdown, fetchUsage, longLabel, mainLines, ring, tone, usageError } from "../usage/gauge";

let nextId = 1;

interface Command {
  name: string;
  desc: string;
  kind: "local" | "builtin" | "skill";
}

const BUILTINS: Record<string, string> = {
  usage: "Tes limites Claude : session et semaine",
  context: "Ce qui occupe le contexte",
  compact: "Résumer la conversation pour libérer du contexte",
  recap: "Récapituler la conversation",
  init: "Créer un CLAUDE.md pour ce projet",
  "security-review": "Revue de sécurité des changements",
  insights: "Analyse de tes sessions Claude Code",
};

const SKILLS: Record<string, string> = {
  "code-review": "Revue du code modifié",
  simplify: "Simplifier le code modifié",
  debug: "Trouver la cause d'un bug",
  verify: "Vérifier qu'un changement marche",
  "deep-research": "Recherche approfondie sur le web",
  dataviz: "Créer un graphique",
  "claude-api": "Aide sur l'API Claude",
  run: "Lancer l'app du projet",
  design: "Créer un design",
};

const LOCAL: Command[] = [
  { name: "clear", desc: "Vider la conversation", kind: "local" },
  { name: "usage", desc: "Tes limites Claude : session et semaine", kind: "local" },
];

let catalog: Command[] = [...LOCAL];
let catalogLoaded = false;

async function loadCatalog() {
  if (catalogLoaded) return;
  catalogLoaded = true;
  let found = await Bridge.chatCommands();
  if (!found && import.meta.env.DEV) {
    found = {
      commands: ["code-review", "simplify", "debug", "verify", "deep-research", "dataviz", "usage", "context", "compact", "recap", "init", "security-review"],
      skills: ["code-review", "simplify", "debug", "verify", "deep-research", "dataviz"],
    };
  }
  if (!found) return;
  const skills = new Set(found.skills ?? []);
  const list: Command[] = [...LOCAL];
  for (const name of found.commands ?? []) {
    if (LOCAL.some((c) => c.name === name)) continue;
    if (skills.has(name)) list.push({ name, desc: SKILLS[name] ?? "Skill Claude Code", kind: "skill" });
    else if (BUILTINS[name]) list.push({ name, desc: BUILTINS[name], kind: "builtin" });
  }
  catalog = list;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = h("textarea", { style: "position:fixed;left:-9999px;top:0" }) as HTMLTextAreaElement;
    area.value = text;
    document.body.append(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  }
}

function copyButton(text: string): HTMLElement {
  const btn = h("button", { class: "copy-btn", title: "Copy" }, proIcon("file", 12, 2));
  btn.addEventListener("mousedown", (e) => e.stopPropagation());
  btn.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!(await copyText(text))) return;
    btn.classList.add("done");
    btn.replaceChildren(proIcon("check", 12, 2.4));
    window.setTimeout(() => {
      btn.classList.remove("done");
      btn.replaceChildren(proIcon("file", 12, 2));
    }, 1400);
  });
  return btn;
}

function usageText(report: UsageReport): string {
  if (report.lines.length === 0) return usageError(report.error);
  return report.lines
    .map((l) => `${longLabel(l.label)} : ${l.percent} %${l.resets ? ` (reset dans ${countdown(l.resets)})` : ""}`)
    .join("\n");
}

function usageCard(report: UsageReport): HTMLElement {
  const card = h("div", { class: "usage-card" });
  card.append(
    h("div", { class: "uc-head" }, proIcon("gauge", 14, 2), h("b", { text: "Utilisation Claude" }),
      report.subscription ? h("span", { class: "uc-plan", text: "Abonnement" }) : null),
  );
  if (report.lines.length === 0) {
    card.append(h("div", { class: "uc-empty", text: usageError(report.error) }));
    return card;
  }
  const main = mainLines(report.lines);
  const rings = h("div", { class: "uc-rings" });
  for (const line of main) {
    rings.append(
      h("div", { class: "uc-ring" },
        h("div", { class: "uc-gauge" }, ring(line.percent, 50, 5), h("b", { text: `${line.percent}%`, style: `color:${tone(line.percent)}` })),
        h("div", { class: "uc-meta" },
          h("span", { class: "uc-label", text: longLabel(line.label) }),
          line.resets ? h("span", { class: "uc-reset" }, proIcon("clock", 11, 2.2), h("span", { text: `reset dans ${countdown(line.resets)}` })) : null),
      ),
    );
  }
  card.append(rings);
  const rest = report.lines.filter((l) => !main.includes(l));
  if (rest.length > 0) {
    const rows = h("div", { class: "uc-rows" });
    for (const line of rest) {
      rows.append(
        h("div", { class: "uc-row" },
          h("span", { text: longLabel(line.label) }),
          h("div", { class: "uc-bar" }, h("i", { style: `width:${line.percent}%;background:${tone(line.percent)}` })),
          h("b", { text: `${line.percent}%` })),
      );
    }
    card.append(rows);
  }
  return card;
}

function bubble(message: ChatMessage, live = false): HTMLElement {
  if (message.usage) {
    const card = usageCard(message.usage);
    card.append(copyButton(message.content));
    return h("div", { class: "chat-row" }, card);
  }
  if (message.role === "user") {
    return h("div", { class: "chat-row user" }, h("div", { class: "bubble", text: message.content }));
  }
  const reply = h("div", { class: "reply", text: message.content });
  if (!live) reply.append(copyButton(message.content));
  return h("div", { class: "chat-row" }, reply);
}

function typingDots(status: string): HTMLElement {
  return h(
    "div",
    { class: "chat-row" },
    h("div", { class: "typing" }, h("i"), h("i"), h("i")),
    status ? h("span", { class: "chat-status shimmer", text: status }) : null,
  );
}

function chatCwd(): string | null {
  return State.tasks.find((t) => t.id === "integration_claude")?.sessionCwd ?? null;
}

function contextChip(label: string): HTMLElement {
  const chip = h("div", { class: "chip" }, h("i", { class: "chip-dot" }), h("span", { text: label }));
  requestAnimationFrame(() => chip.classList.add("settled"));
  return chip;
}

function matches(query: string): Command[] {
  const q = query.toLowerCase();
  const starts = catalog.filter((c) => c.name.startsWith(q));
  const contains = catalog.filter((c) => !c.name.startsWith(q) && c.name.includes(q));
  return [...starts, ...contains].slice(0, 6);
}

export function buildPrompt(onHeightChange: () => void): ViewHost {
  const chipRow = h("div", { class: "chip-row" });
  const log = h("div", { class: "chat-log" });
  const input = h("input", {
    type: "text",
    class: "chat-input",
    placeholder: "Ask me anything…",
    spellcheck: "false",
  }) as HTMLInputElement;
  const send = h("button", { class: "send-btn", title: "Send" }, svg(ICONS.arrowUp, 11));
  const clearBtn = h("button", { class: "chat-clear", title: "Clear the conversation" }, svg(ICONS.trash, 12));
  const bar = h("div", { class: "chat-bar" }, clearBtn, input, send);
  const menu = h("div", { class: "cmd-menu" });

  const el = h(
    "div",
    { class: "view" },
    h("div", { class: "card wash chat-card" }, h("div", { class: "chat-body" }, chipRow, log, menu, bar)),
  );
  (el.querySelector(".card") as HTMLElement).style.setProperty("--wash", "rgba(99,102,241,0.5)");

  let sending = false;
  let renderedKey = "";
  let shown: Command[] = [];
  let selected = 0;

  function clearConversation() {
    Sound.play("blip");
    State.chatHistory = [];
    State.chatPartial = "";
    State.chatStatus = "";
    State.droppedFile = null;
    State.promptContext = null;
    void Bridge.chatReset();
    State.notify();
    onHeightChange();
    input.focus();
  }

  function renderMenu() {
    const value = input.value;
    const open = value.startsWith("/") && !value.includes(" ") && !sending;
    shown = open ? matches(value.slice(1)) : [];
    if (selected >= shown.length) selected = 0;
    clear(menu);
    menu.classList.toggle("on", shown.length > 0);
    shown.forEach((cmd, i) => {
      const icon = cmd.kind === "skill" ? proIcon("sparkles", 13) : cmd.kind === "local" ? proIcon("x", 13) : proIcon("slash", 13);
      const item = h(
        "div",
        { class: i === selected ? "cmd-item on" : "cmd-item" },
        h("span", { class: `cmd-icon ${cmd.kind}` }, icon),
        h("span", { class: "cmd-name", text: `/${cmd.name}` }),
        h("span", { class: "cmd-desc", text: cmd.desc }),
      );
      item.addEventListener("mousedown", (e) => {
        e.preventDefault();
        pick(cmd);
      });
      item.addEventListener("mouseenter", () => {
        selected = i;
        menu.querySelectorAll(".cmd-item").forEach((n, j) => n.classList.toggle("on", j === i));
      });
      menu.append(item);
    });
  }

  function pick(cmd: Command) {
    input.value = `/${cmd.name}`;
    shown = [];
    renderMenu();
    if (cmd.kind === "local" || cmd.kind === "builtin") void submit();
    else {
      input.value = `/${cmd.name} `;
      input.focus();
    }
  }

  async function submit() {
    const query = input.value.trim();
    if (!query || sending) return;
    if (query === "/clear") {
      input.value = "";
      renderMenu();
      clearConversation();
      return;
    }
    if (query === "/usage") {
      input.value = "";
      renderMenu();
      await showUsage(query);
      return;
    }
    input.value = "";
    renderMenu();
    sending = true;
    Sound.play("send");

    State.chatHistory.push({ id: nextId++, role: "user", content: query });
    State.chatPartial = "";
    State.chatStatus = "";
    State.stateOverride = "thinking";
    State.notify();
    onHeightChange();

    const file = State.droppedFile;
    const context: ChatContext | null =
      State.chatHistory.length === 1 && file ? { kind: "file", name: file.name, path: file.path } : null;

    try {
      const reply = await Bridge.chatSend(query, context, chatCwd());
      State.chatHistory.push({ id: nextId++, role: "assistant", content: reply.text });
      State.stateOverride = null;
      Sound.play("finish");
    } catch (err) {
      State.stateOverride = null;
      State.noteMessage = String(err).replace(/^Error:\s*/, "");
      State.view = "note";
      Sound.play("error");
    } finally {
      State.chatPartial = "";
      State.chatStatus = "";
      sending = false;
      State.notify();
      onHeightChange();
      input.focus();
    }
  }

  async function showUsage(query: string) {
    sending = true;
    Sound.play("send");
    State.chatHistory.push({ id: nextId++, role: "user", content: query });
    State.chatPartial = "";
    State.chatStatus = "Lecture de tes limites…";
    State.stateOverride = "thinking";
    State.notify();
    onHeightChange();
    const report = await fetchUsage(true);
    if (report) State.chatHistory.push({ id: nextId++, role: "assistant", content: usageText(report), usage: report });
    else State.chatHistory.push({ id: nextId++, role: "assistant", content: "Utilisation indisponible ici." });
    State.stateOverride = null;
    State.chatStatus = "";
    sending = false;
    Sound.play("finish");
    State.notify();
    onHeightChange();
    input.focus();
  }

  void onEvent<string>("chat-delta", (text) => {
    if (!sending) return;
    State.chatPartial = text;
    State.chatStatus = "";
    State.notify();
    onHeightChange();
  });
  void onEvent<string>("chat-status", (status) => {
    if (!sending) return;
    State.chatStatus = status;
    State.notify();
  });

  clearBtn.addEventListener("click", () => {
    if (!sending) clearConversation();
  });

  send.addEventListener("click", () => void submit());
  input.addEventListener("input", () => {
    if (input.value.startsWith("/")) void loadCatalog().then(renderMenu);
    renderMenu();
  });
  input.addEventListener("keydown", (e) => {
    const key = (e as KeyboardEvent).key;
    if (shown.length > 0) {
      if (key === "ArrowDown" || key === "ArrowUp") {
        e.preventDefault();
        selected = (selected + (key === "ArrowDown" ? 1 : shown.length - 1)) % shown.length;
        renderMenu();
      } else if (key === "Tab" || (key === "Enter" && input.value.trim() !== `/${shown[selected].name}`)) {
        e.preventDefault();
        pick(shown[selected]);
      } else if (key === "Escape") {
        e.preventDefault();
        input.value = "";
        renderMenu();
      } else if (key === "Enter") {
        e.preventDefault();
        void submit();
      }
    } else if (key === "Enter") {
      e.preventDefault();
      void submit();
    }
    e.stopPropagation();
  });

  return {
    el,
    sync() {
      const file = State.droppedFile;
      const project = State.chatBackend === "claude-code" ? chatCwd()?.split(/[\\/]/).filter(Boolean).pop() : undefined;
      const wantChip = file?.name ?? project ?? "";
      if (chipRow.dataset.label !== wantChip) {
        chipRow.dataset.label = wantChip;
        clear(chipRow);
        if (wantChip) chipRow.append(contextChip(wantChip));
      }

      const thinking = State.stateOverride === "thinking";
      const key = `${State.chatHistory.length}~${thinking}~${State.chatPartial.length}~${State.chatStatus}`;
      if (key !== renderedKey) {
        renderedKey = key;
        clear(log);
        for (const m of State.chatHistory) log.append(bubble(m));
        if (thinking && State.chatPartial) {
          log.append(bubble({ id: 0, role: "assistant", content: State.chatPartial }, true));
        } else if (thinking) {
          log.append(typingDots(State.chatStatus));
        }
        log.scrollTop = log.scrollHeight;
      }
      if (State.view === "prompt") {
        const box = islandBox(el);
        if (box) setSizeHint("prompt", 0, box.h - log.clientHeight + contentHeight(log));
      }

      const viaClaudeCode = State.chatBackend === "claude-code";
      input.placeholder = State.chatHistory.length > 0
        ? "Continue…"
        : viaClaudeCode ? "Ask Claude, or type / for commands" : "Ask me anything…";
      input.disabled = sending;
      clearBtn.style.display = State.chatHistory.length > 0 || State.droppedFile ? "" : "none";
      clearBtn.disabled = sending;
    },
    focus() {
      input.focus();
      input.select();
      if (State.chatBackend === "claude-code") void loadCatalog();
    },
  };
}
