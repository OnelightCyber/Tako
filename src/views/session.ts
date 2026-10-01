import { h, svg, clear } from "./dom";
import { ICONS } from "./icons";
import { proIcon, type ProIconName } from "./pro-icons";
import { contentHeight, islandBox, monoCharWidth, setSizeHint } from "./fit";
import { fileBadge, highlightLine } from "./highlight";
import { relativePath, type Activity, type DiffLine } from "../core/activity";
import { State, type AgentTask } from "../core/state";
import type { ViewActions, ViewHost } from "./views";

const MAX_ROWS = 5;

const LEAD_ROWS = 3;
const ROW_H = 16;

export function buildSession(actions: ViewActions): ViewHost {
  const name = h("div", { class: "s-name" });
  const sub = h("div", { class: "s-sub" });
  const steps = h("div", { class: "s-steps" });
  const left = h("div", { class: "s-left" }, name, sub, steps);

  const headBadge = h("span", { class: "p-badge" });
  const headName = h("span", { class: "p-name" });
  const headDot = h("i", { class: "p-dot" });
  const headPath = h("span", { class: "p-path" });
  const head = h("div", { class: "p-head" }, headBadge, headName, headDot, headPath);
  const body = h("div", { class: "p-body" });
  const panel = h("div", { class: "s-panel" }, head, body);

  const card = h("div", { class: "card session-card" }, left, panel);
  const el = h("div", { class: "view session" }, card);

  let selectedId: string | null = null;
  let stepsKey = "";
  let panelKey = "";
  let lastPrompt: string | null | undefined;

  function select(id: string | null) {
    actions.blip();
    selectedId = id;
    panelKey = "";
    stepsKey = "";
    State.notify();
  }

  return {
    el,
    sync() {
      const task = State.focusTask;
      if (!task || task.source !== "claudeCode") return;
      const list = task.activity ?? [];

      if (task.prompt !== lastPrompt) {
        lastPrompt = task.prompt;
        selectedId = null;
      }
      if (selectedId && !list.some((a) => a.id === selectedId)) selectedId = null;

      name.textContent = task.name;
      sub.textContent = subtitle(task);

      const finished = task.state === "finished" || (task.state === "idle" && list.length > 0);
      const sk = `${list.map((a) => `${a.id}:${a.status}:${a.target}`).join("|")}~${finished}~${selectedId}`;
      if (sk !== stepsKey) {
        stepsKey = sk;
        renderSteps(steps, list, finished, selectedId, select);
      }

      const current = (selectedId && list.find((a) => a.id === selectedId)) || list[list.length - 1] || null;
      const pk = current ? activityKey(current) : `prompt~${task.prompt ?? ""}~${task.state}`;
      if (pk !== panelKey) {
        const sameStep = panelKey.split("~")[0] === pk.split("~")[0];
        panelKey = pk;
        renderPanel(task, current, { head, headBadge, headName, headDot, headPath, body }, sameStep);
      }
      if (State.view === "session") fitToContent(el, panel, body);
    },
  };
}

function fitToContent(view: HTMLElement, panel: HTMLElement, body: HTMLElement) {
  const box = islandBox(view);
  if (!box) return;
  const h = box.h - body.clientHeight + contentHeight(body);
  let longest = 0;
  for (const tx of Array.from(body.querySelectorAll<HTMLElement>(".code-rows .tx"))) {
    longest = Math.max(longest, (tx.textContent ?? "").length);
  }
  const rowsWidth = longest ? longest * monoCharWidth() + 34 + 14 + 14 : 0;
  const w = rowsWidth ? box.w - panel.clientWidth + rowsWidth : 0;
  setSizeHint("session", w, h);
}

function subtitle(task: AgentTask): string {
  switch (task.state) {
    case "thinking": return "Claude Code · thinking";
    case "working": return "Claude Code · working";
    case "approval": return "Claude Code · needs you";
    case "question": return "Claude Code · asking";
    case "error": return "Claude Code · error";
    case "ratelimit": return "Claude Code · rate limited";
    case "finished": return "Claude Code · done";
    default: return "Claude Code";
  }
}

function activityKey(a: Activity): string {
  return [
    a.id, a.status, a.diff?.length ?? 0, a.numbered ? 1 : 0, a.output?.length ?? 0,
    a.code?.text.length ?? 0, a.todos?.map((t) => t.status[0]).join("") ?? "",
  ].join("~");
}

function renderSteps(
  host: HTMLElement,
  list: Activity[],
  finished: boolean,
  selectedId: string | null,
  select: (id: string | null) => void,
) {
  clear(host);
  const rows = list.length + (finished ? 1 : 0);
  const room = (rows > MAX_ROWS ? MAX_ROWS - 1 : MAX_ROWS) - (finished ? 1 : 0);
  const shown = list.slice(-room);
  const hidden = list.length - shown.length;
  if (hidden > 0) host.append(h("div", { class: "s-more", text: `+${hidden} earlier` }));

  const followed = selectedId ?? list[list.length - 1]?.id ?? null;
  for (const a of shown) {
    const row = h(
      "div",
      { class: `s-step ${a.status}${a.id === followed ? " on" : ""}`, title: `${a.label} · ${a.target}` },
      statusIcon(a.status),
      h("span", { class: "s-label", text: a.label }),
      h("span", { class: "s-target", text: a.target }),
    );

    row.addEventListener("click", () => select(selectedId === a.id ? null : a.id));
    host.append(row);
  }
  if (finished) {
    host.append(h("div", { class: "s-step done final" }, statusIcon("done"), h("span", { class: "s-label", text: "Done" })));
  }
}

function statusIcon(status: Activity["status"]): HTMLElement {
  const box = h("span", { class: `s-icon ${status}` });
  if (status === "running") box.append(h("i", { class: "spinner" }));
  else if (status === "done") box.append(svg(ICONS.check, 9, { stroke: 3 }));
  else box.append(svg(ICONS.xmark, 8));
  return box;
}

interface PanelParts {
  head: HTMLElement;
  headBadge: HTMLElement;
  headName: HTMLElement;
  headDot: HTMLElement;
  headPath: HTMLElement;
  body: HTMLElement;
}

function renderPanel(task: AgentTask, a: Activity | null, p: PanelParts, sameStep: boolean) {
  const keepScroll = sameStep ? p.body.scrollTop : null;
  clear(p.body);
  p.body.className = "p-body";
  p.headDot.className = "p-dot";

  if (!a) {
    setHead(p, { icon: "message" }, "#6366F1", "Prompt", "");
    renderPrompt(p.body, task);
    return;
  }

  if (a.status === "running") p.headDot.classList.add("running");
  if (a.status === "failed") p.headDot.classList.add("failed");

  switch (a.kind) {
    case "edit":
    case "write":
    case "read": {
      const file = a.target || "file";
      const badge = fileBadge(file);
      const rel = a.path ? relativePath(a.path, task.sessionCwd) : "";
      setHead(p, badge.label, badge.color, file, rel);
      if (a.status === "failed") {
        renderText(p.body, a.output ?? "Failed.", "err");
      } else if (a.kind === "read") {
        if (a.code) renderCode(p.body, a.code.text, a.code.start, badge.ext);
        else renderWaiting(p.body, a.status === "running" ? "Reading…" : a.output ?? "");
      } else {
        renderDiff(p.body, a.diff ?? [], !!a.numbered, badge.ext, a.status === "running");
      }
      break;
    }
    case "shell":
      setHead(p, { icon: "terminal" }, "#22C55E", a.tool === "PowerShell" ? "PowerShell" : "Terminal", a.target);
      p.body.classList.add("term");
      renderTerminal(p.body, a);
      break;
    case "search":
      setHead(p, { icon: "search" }, "#A78BFA", a.tool, "");
      renderSearch(p.body, a, task.sessionCwd);
      break;
    case "web":
      setHead(p, { icon: "globe" }, "#38BDF8", a.tool, "");
      renderText(p.body, [a.command, a.output].filter(Boolean).join("\n\n"), a.status === "running" ? "wait" : "");
      break;
    case "agent":
      setHead(p, { icon: "sparkles" }, "#F472B6", "Subagent", a.target);
      renderText(p.body, a.output ?? "", a.status === "running" ? "wait" : "");
      break;
    case "todo":
      setHead(p, { icon: "listChecks" }, "#F5A524", "Plan", `${a.todos?.filter((t) => t.status === "completed").length ?? 0}/${a.todos?.length ?? 0}`);
      renderTodos(p.body, a);
      break;
    default:
      setHead(p, { icon: a.tool.startsWith("mcp__tako__") ? "monitor" : a.tool.includes("playwright") ? "globe" : "wrench" }, "#8E939C", a.label, a.tool.startsWith("mcp__") ? a.tool.split("__")[1] ?? "" : "");
      renderText(p.body, a.output ?? "", "");
  }

  const pinsItself = a.kind === "shell" || a.kind === "edit" || a.kind === "write";
  if (keepScroll != null && !pinsItself) p.body.scrollTop = keepScroll;
}

function setHead(p: PanelParts, badge: string | { icon: ProIconName }, color: string, name: string, path: string) {
  clear(p.headBadge);
  if (typeof badge === "string") p.headBadge.textContent = badge;
  else p.headBadge.append(proIcon(badge.icon, 11, 2.2));
  p.headBadge.classList.toggle("icon", typeof badge !== "string");
  p.headBadge.style.background = `${color}26`;
  p.headBadge.style.color = color;
  p.headName.textContent = name;
  p.headPath.textContent = path;
  p.headPath.title = path;
}

function renderDiff(body: HTMLElement, lines: DiffLine[], numbered: boolean, ext: string, typing: boolean) {
  const table = h("div", { class: "code-rows" });
  let firstChange = -1;
  let typed = 0;
  lines.forEach((l, i) => {
    if (l.kind === "sep") {
      table.append(h("div", { class: "row sep" }, h("span", { class: "ln" }), h("span", { class: "tx", text: "⋯" })));
      return;
    }
    if (firstChange < 0 && l.kind !== "ctx") firstChange = i;
    const sign = l.kind === "add" ? "+" : l.kind === "del" ? "−" : " ";
    const tx = h("span", { class: "tx" });
    tx.append(highlightLine(l.text, ext));
    const row = h(
      "div",
      { class: `row ${l.kind}` },
      h("span", { class: "ln", text: numbered && l.no != null ? String(l.no) : "" }),
      h("span", { class: "sg", text: sign }),
      tx,
    );

    if (typing && l.kind === "add" && typed < 14) {
      row.classList.add("typing");
      row.style.animationDelay = `${typed * 70}ms`;
      typed++;
    }
    table.append(row);
  });
  if (lines.length === 0) table.append(h("div", { class: "row ctx" }, h("span", { class: "ln" }), h("span", { class: "tx dim", text: "(empty)" })));
  body.append(table);
  if (firstChange > LEAD_ROWS) body.scrollTop = (firstChange - LEAD_ROWS) * ROW_H;
}

function renderCode(body: HTMLElement, text: string, start: number, ext: string) {
  const table = h("div", { class: "code-rows" });
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  lines.slice(0, 200).forEach((line, i) => {
    const tx = h("span", { class: "tx" });
    tx.append(highlightLine(line, ext));
    table.append(h("div", { class: "row ctx" }, h("span", { class: "ln", text: String(start + i) }), h("span", { class: "sg", text: " " }), tx));
  });
  body.append(table);

  body.append(h("div", { class: "read-sweep" }));
}

function renderTerminal(body: HTMLElement, a: Activity) {
  const cmd = (a.command ?? "").split(/\r?\n/);
  cmd.slice(0, 4).forEach((line, i) => {
    body.append(h("div", { class: "t-line t-cmd" }, h("span", { class: "t-ps", text: i === 0 ? "$" : " " }), h("span", { text: line })));
  });
  if (cmd.length > 4) body.append(h("div", { class: "t-line dim", text: `  … ${cmd.length - 4} more lines` }));

  const out = (a.output ?? "").replace(/\r\n?/g, "\n").replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
  const lines = out ? out.split("\n").slice(-60) : [];
  for (const line of lines) {
    body.append(h("div", { class: `t-line ${tone(line)}`, text: line || " " }));
  }
  if (a.status === "running") body.append(h("div", { class: "t-line" }, h("i", { class: "t-cursor" })));
  else if (a.status === "failed" && !lines.length) body.append(h("div", { class: "t-line err", text: "✕ failed" }));
  body.scrollTop = body.scrollHeight;
}

function tone(line: string): string {
  if (/\b(fail(ed|ure|ing)?|errors?|exception|traceback|panicked|denied)\b|✗|✘|✕/i.test(line)) return "err";
  if (/\bwarn(ing)?s?\b/i.test(line)) return "warn";
  if (/\b(pass(ed|ing)?|ok|success(ful)?|done|finished)\b|✓|✔/i.test(line)) return "ok";
  return "";
}

function renderSearch(body: HTMLElement, a: Activity, cwd: string | null | undefined) {
  body.append(h("div", { class: "q-line" }, h("span", { class: "q-ico" }, proIcon("search", 12, 2)), h("span", { text: a.command || a.target })));
  if (a.status === "running") {
    renderWaiting(body, "Searching…");
    return;
  }
  const rows = (a.output ?? "").split("\n").filter((l) => l.trim()).slice(0, 80);
  for (const r of rows) {
    const m = /^(.+?):(\d+):(.*)$/.exec(r);
    if (m) {
      body.append(h("div", { class: "q-hit" }, h("span", { class: "q-file", text: `${relativePath(m[1], cwd)}:${m[2]}` }), h("span", { class: "q-text", text: m[3].trim() })));
    } else {
      body.append(h("div", { class: "q-hit" }, h("span", { class: "q-file", text: relativePath(r, cwd) })));
    }
  }
}

function renderTodos(body: HTMLElement, a: Activity) {
  for (const t of a.todos ?? []) {
    const icon = h("span", { class: `todo-box ${t.status}` });
    if (t.status === "completed") icon.append(svg(ICONS.check, 9, { stroke: 3 }));
    if (t.status === "in_progress") icon.append(h("i", { class: "spinner" }));
    body.append(h("div", { class: `todo ${t.status}` }, icon, h("span", { class: t.status === "in_progress" ? "shimmer" : "", text: t.content })));
  }
}

function renderPrompt(body: HTMLElement, task: AgentTask) {
  if (task.prompt) body.append(h("div", { class: "prompt-bubble", text: task.prompt }));
  const label = task.state === "thinking" ? "Claude is thinking…" : task.state === "working" ? "Working…" : "Waiting for the next prompt.";
  body.append(h("div", { class: `prompt-status ${task.state === "thinking" || task.state === "working" ? "shimmer" : "dim"}`, text: label }));
}

function renderText(body: HTMLElement, text: string, mode: "" | "err" | "wait") {
  if (!text && mode === "wait") {
    renderWaiting(body, "Working…");
    return;
  }
  body.append(h("div", { class: `plain ${mode}`, text: text || "—" }));
}

function renderWaiting(body: HTMLElement, label: string) {
  body.append(h("div", { class: "plain shimmer", text: label }));
}
