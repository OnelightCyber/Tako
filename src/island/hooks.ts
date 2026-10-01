import { Bridge, onEvent, type ContextInfo, type TurnSummary } from "../core/bridge";
import { activityFromPre, applyPost, type Activity } from "../core/activity";
import { colorForProject } from "../core/layout";
import { Sound } from "../core/sound";
import { State, type AgentTask, type ApprovalInfo, type ReviewPreview } from "../core/state";
import type { Island } from "./island";

export interface HookPayload {
  hook_event_name?: string;
  request_id?: string;
  session_id?: string;
  cwd?: string;
  message?: string;

  prompt?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;

  tool_use_id?: string;

  tool_response?: unknown;

  error?: string;

  tako_origin?: string;
  permission_mode?: string;
  user_prompt?: string;
  last_assistant_message?: string;
  tako_review?: ReviewPreview;
}

const MAX_ACTIVITY = 40;

const PROJECT_ALIASES: Record<string, string> = {};

function aliasProjectName(name: string): string {
  return PROJECT_ALIASES[name.toLowerCase()] ?? name;
}

function lastPathComponent(p: string): string {
  const cleaned = p.replace(/[\\/]+$/, "");
  const idx = Math.max(cleaned.lastIndexOf("\\"), cleaned.lastIndexOf("/"));
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
}

const TOOL_LABELS: Record<string, string> = {
  Bash: "Exécute",
  Read: "Lit",
  Write: "Écrit",
  Edit: "Modifie",
  Glob: "Cherche",
  Grep: "Recherche",
  WebSearch: "Recherche web",
  WebFetch: "Récupère",
  TodoWrite: "Tâches",
  Task: "Agent",
  LS: "Liste",
  MultiEdit: "Modifie",
  NotebookEdit: "Notebook",
  PowerShell: "Exécute",
};

function stepLabel(tool: string, input: Record<string, unknown>): string {
  const label = TOOL_LABELS[tool] ?? tool;
  const str = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : null);
  const cmd = str("command");
  if (cmd) {
    const shown = str("description")?.trim() || cmd.trim().split(/\r?\n/)[0].replace(/\s+/g, " ");
    return `${label} · ${shown.slice(0, 60)}`;
  }
  const path = str("path");
  if (path) return `${label} · ${lastPathComponent(path)}`;
  const file = str("file_path");
  if (file) return `${label} · ${lastPathComponent(file)}`;
  const query = str("query");
  if (query) return `${label} · ${query.slice(0, 40)}`;
  return label;
}

const APPROVAL_FIELDS = [
  "command",
  "file_path",
  "path",
  "url",
  "query",
  "pattern",
  "prompt",
] as const;

function approvalTarget(tool: string, input: Record<string, unknown>): string {
  for (const field of APPROVAL_FIELDS) {
    const value = input[field];
    if (typeof value === "string" && value.trim()) {
      return `${tool} · ${value.trim()}`;
    }
  }
  return tool;
}

const AGENT_FIELDS = ["url", "element", "text", "key", "function", "code", "action", "name"] as const;

function agentTarget(tool: string, input: Record<string, unknown>): string {
  const action = tool.replace(/^mcp__playwright__browser_|^mcp__tako__/, "").replace(/_/g, " ");
  const parts: string[] = [];
  for (const field of AGENT_FIELDS) {
    const value = input[field];
    if (typeof value === "string" && value.trim()) parts.push(value.trim().slice(0, 160));
  }
  if (Array.isArray(input.fields)) parts.push(`${input.fields.length} fields`);
  if (Array.isArray(input.values)) parts.push(input.values.map(String).join(", ").slice(0, 80));
  if (Array.isArray(input.paths)) parts.push(input.paths.map(String).join(", ").slice(0, 120));
  return parts.length ? `${action} · ${parts.join(" → ")}` : action;
}

const MAX_SESSIONS = 6;
const STALE_MS = 45 * 60_000;
const DECISION_MS = 94_000;
const CLICK_GUARD_MS = 700;

let approvalTimer: number | null = null;

function prune() {
  const now = Date.now();
  for (const t of [...State.sessions]) {
    const stale = t.state === "idle" && now - (t.lastEventAt ?? 0) > STALE_MS;
    if (stale && t.id !== State.focusId) State.removeTask(t.id);
  }
  const live = [...State.sessions].sort((a, b) => (a.lastEventAt ?? 0) - (b.lastEventAt ?? 0));
  while (live.length >= MAX_SESSIONS) {
    const victim = live.find((t) => t.state === "idle") ?? live[0];
    live.splice(live.indexOf(victim), 1);
    State.removeTask(victim.id);
  }
}

function sessionTask(payload: HookPayload): AgentTask {
  const sid = payload.session_id || "default";
  const cwd = payload.cwd ?? "";
  const name = aliasProjectName(lastPathComponent(cwd) || "Session");
  let task = State.sessionTask(sid);
  if (!task) {
    prune();
    task = {
      id: `session:${sid}`,
      name,
      color: colorForProject(name),
      state: "idle",
      stepIndex: 0,
      steps: [],
      source: "claudeCode",
      isIntegration: false,
      sessionId: sid,
      sessionCwd: cwd || null,
      activity: [],
      prompt: null,
      origin: payload.tako_origin || null,
    };
    State.tasks.unshift(task);
  }
  if (task.name !== name) {
    task.name = name;
    task.color = colorForProject(name);
  }
  if (cwd) task.sessionCwd = cwd;
  if (payload.tako_origin) task.origin = payload.tako_origin;
  if (payload.permission_mode) task.permissionMode = payload.permission_mode;
  task.lastEventAt = Date.now();
  return task;
}

function claimFocus(task: AgentTask) {
  const current = State.focusTask;
  if (!current || current.id === task.id || !current.sessionId) {
    State.focusId = task.id;
    return;
  }
  const busy = current.state !== "idle" && current.state !== "finished";
  const recent = Date.now() - (current.lastEventAt ?? 0) < 20_000;
  if (!busy && !recent) State.focusId = task.id;
}

function isFocused(task: AgentTask): boolean {
  return State.focusTask?.id === task.id;
}

function startTurn(task: AgentTask, prompt: string | null) {
  task.prompt = prompt;
  task.activity = [];
  task.turn = null;
  task.finalMessage = null;
  task.reviewAll = false;
}

function startActivity(task: AgentTask, payload: HookPayload) {
  const list = (task.activity ??= []);
  list.push(activityFromPre(payload.tool_name ?? "Tool", payload.tool_input ?? {}, payload.tool_use_id));
  if (list.length > MAX_ACTIVITY) list.splice(0, list.length - MAX_ACTIVITY);
}

function findActivity(task: AgentTask, payload: HookPayload): Activity | undefined {
  const list = task.activity ?? [];
  if (payload.tool_use_id) {
    const byId = list.find((a) => a.id === payload.tool_use_id);
    if (byId) return byId;
  }
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].status === "running" && list[i].tool === payload.tool_name) return list[i];
  }
  return undefined;
}

const loggedShapes = new Set<string>();

function finishActivity(task: AgentTask, payload: HookPayload, failed: boolean) {
  const tool = payload.tool_name ?? "Tool";
  if (!loggedShapes.has(tool)) {
    loggedShapes.add(tool);
    const r = payload.tool_response;
    const keys = r && typeof r === "object" ? Object.keys(r).join(",") : typeof r;
    void Bridge.log(`result shape ${tool}: ${keys} id=${payload.tool_use_id ? "yes" : "no"}`);
  }
  const a = findActivity(task, payload);
  if (a) applyPost(a, payload.tool_response, failed, payload.error);
}

function settleActivity(task: AgentTask) {
  for (const a of task.activity ?? []) {
    if (a.status === "running") a.status = "done";
  }
}

function present(island: Island, info: ApprovalInfo) {
  info.shownAt = Date.now();
  State.pendingApproval = info;
  State.isPinned = true;
  const task = info.taskId ? State.tasks.find((t) => t.id === info.taskId) : undefined;
  if (task) {
    State.focusId = task.id;
    task.pillBadge = null;
    if (info.kind !== "agent") task.state = "approval";
  }
  Sound.play("approval");
  island.alert(info.kind === "review" ? "review" : "approval");
  if (approvalTimer != null) window.clearTimeout(approvalTimer);
  approvalTimer = window.setTimeout(() => expire(island, info.requestId), Math.max(1000, info.expiresAt - Date.now()));
  window.setTimeout(() => State.notify(), CLICK_GUARD_MS + 20);
  State.notify();
}

function settleView(island: Island, done: ApprovalInfo) {
  State.isPinned = false;
  island.dropPin();
  const open = State.view === "approval" || State.view === "review";
  if (open) island.setView(done.origin === "chat" ? "prompt" : State.defaultView());
}

function advance(island: Island, done: ApprovalInfo) {
  State.approvalQueue = State.approvalQueue.filter((i) => i.expiresAt - Date.now() > 3000);
  const next = State.approvalQueue.shift();
  if (next) present(island, next);
  else settleView(island, done);
  State.notify();
}

function expire(island: Island, requestId: string) {
  const info = State.pendingApproval;
  if (!info || info.requestId !== requestId) return;
  State.pendingApproval = null;
  const task = info.taskId ? State.tasks.find((t) => t.id === info.taskId) : undefined;
  if (task && task.state === "approval") task.state = "working";
  advance(island, info);
}

function request(island: Island, info: ApprovalInfo) {
  if (State.gameMode) {
    if (info.kind === "permission") void Bridge.approvalDecline(info.requestId);
    else void Bridge.approvalDecision(info.requestId, "deny");
    const label = info.kind === "permission" ? "une permission t'attend dans le terminal" : info.kind === "review" ? "une modif a été refusée (relecture)" : "une action du chat a été refusée";
    if (!State.missed.includes(label)) State.missed.push(label);
    return;
  }
  if (info.requestId) void Bridge.approvalAck(info.requestId);
  if (!State.pendingApproval) {
    present(island, info);
    return;
  }
  if (State.approvalQueue.length >= 6) {
    if (info.kind === "review") void Bridge.approvalDecision(info.requestId, "deny");
    else void Bridge.approvalDecline(info.requestId);
    return;
  }
  State.approvalQueue.push(info);
  const task = info.taskId ? State.tasks.find((t) => t.id === info.taskId) : undefined;
  if (task) {
    task.state = "approval";
    task.pillBadge = "approval";
  }
  Sound.play("approval");
  State.notify();
}

export function decideCurrent(island: Island, choice: "allow" | "deny" | "all") {
  const req = State.pendingApproval;
  if (!req) return;
  if (choice !== "deny" && Date.now() - (req.shownAt ?? 0) < CLICK_GUARD_MS) {
    void Bridge.log(`ignored a click ${Date.now() - (req.shownAt ?? 0)} ms after req=${req.requestId} appeared`);
    return;
  }
  const word = choice === "deny" ? "deny" : "allow";
  void Bridge.log(`decide ${choice} req=${req.requestId}`);
  void Bridge.approvalDecision(req.requestId, word);
  Sound.play(word === "deny" ? "blip" : "approve");
  if (approvalTimer != null) window.clearTimeout(approvalTimer);
  approvalTimer = null;
  State.pendingApproval = null;
  const task = req.taskId ? State.tasks.find((t) => t.id === req.taskId) : undefined;
  if (task) {
    task.state = "working";
    task.pillBadge = null;
    if (choice === "all") {
      task.reviewAll = true;
      State.approvalQueue = State.approvalQueue.filter((q) => {
        if (q.kind !== "review" || q.taskId !== task.id) return true;
        void Bridge.approvalDecision(q.requestId, "allow");
        return false;
      });
    }
  }
  advance(island, req);
}

function reviewTarget(payload: HookPayload): string {
  const input = payload.tool_input ?? {};
  const raw = typeof input.file_path === "string" ? input.file_path : typeof input.notebook_path === "string" ? input.notebook_path : "";
  return raw || payload.tool_name || "file";
}

function requestAgentApproval(island: Island, payload: HookPayload) {
  const requestId = payload.request_id ?? "";
  request(island, {
    requestId,
    sessionId: payload.session_id ?? "",
    tool: payload.tool_name ?? "browser",
    command: agentTarget(payload.tool_name ?? "", payload.tool_input ?? {}),
    origin: "chat",
    kind: "agent",
    expiresAt: Date.now() + DECISION_MS,
  });
}

export function registerHookHandlers(island: Island) {
  void onEvent<HookPayload>("hook", (payload) => handleHook(island, payload));
  void onEvent<ContextInfo>("session-context", (info) => {
    const task = State.sessionTask(info.sessionId);
    if (!task) return;
    task.context = { used: info.used, window: info.window, model: info.model };
    State.notify();
  });
  void onEvent<TurnSummary>("session-turn", (summary) => {
    const task = State.sessionTask(summary.sessionId);
    if (!task) return;
    task.turn = summary;
    State.notify();
  });
}

export function handleHook(island: Island, payload: HookPayload) {
  if (State.paused) {
    if (payload.request_id && payload.tako_review) {
      void Bridge.approvalAck(payload.request_id);
      void Bridge.approvalDecision(payload.request_id, "deny");
    } else if (payload.request_id) {
      void Bridge.approvalDecline(payload.request_id);
    }
    return;
  }

  if (payload.tako_origin === "chat") {
    if (payload.request_id && payload.hook_event_name === "PreToolUse") {
      requestAgentApproval(island, payload);
    } else if (payload.request_id) {
      void Bridge.approvalDecline(payload.request_id);
    }
    return;
  }

  const name = payload.hook_event_name ?? "";
  if (name === "SessionEnd") {
    const ended = payload.session_id ? State.sessionTask(payload.session_id) : undefined;
    if (ended) {
      ended.state = "idle";
      window.setTimeout(() => {
        if (ended.state === "idle" && State.pendingApproval?.taskId !== ended.id) State.removeTask(ended.id);
      }, 4000);
    }
    State.notify();
    return;
  }

  const task = sessionTask(payload);
  const focused = () => isFocused(task);

  const surface = (view: Parameters<Island["alert"]>[0], isAlert: boolean) => {
    if (State.mode === "expanded") {
      if (isAlert) island.setView(view);
    } else if (isAlert) {
      island.alert(view);
    } else if (State.mode === "hidden") {
      island.reveal();
    }
  };

  switch (name) {
    case "SessionStart":
      claimFocus(task);
      surface("overview", false);
      Sound.play("work");
      break;

    case "UserPromptSubmit": {
      claimFocus(task);
      task.state = "thinking";
      task.pillBadge = null;
      const asked = payload.prompt ?? payload.user_prompt ?? payload.message;
      startTurn(task, asked?.trim() ? asked.trim().slice(0, 400) : null);
      if (asked) State.appendStep(task.id, asked.slice(0, 60));
      surface("overview", false);
      break;
    }

    case "PreToolUse": {
      if (task.state === "idle" || task.state === "finished") claimFocus(task);
      task.state = "working";
      const tool = payload.tool_name ?? "Tool";
      State.appendStep(task.id, stepLabel(tool, payload.tool_input ?? {}));
      startActivity(task, payload);
      if (payload.request_id && payload.tako_review) {
        if (task.reviewAll) {
          void Bridge.approvalAck(payload.request_id);
          void Bridge.approvalDecision(payload.request_id, "allow");
        } else {
          request(island, {
            requestId: payload.request_id,
            sessionId: payload.session_id ?? "",
            tool,
            command: reviewTarget(payload),
            origin: "session",
            kind: "review",
            taskId: task.id,
            review: payload.tako_review,
            expiresAt: Date.now() + DECISION_MS,
          });
        }
      } else if (payload.request_id) {
        void Bridge.approvalDecline(payload.request_id);
      } else {
        surface("overview", false);
      }
      break;
    }

    case "PostToolUse":
      task.state = "working";
      finishActivity(task, payload, false);
      break;

    case "PostToolUseFailure":
      task.state = "working";
      State.appendStep(task.id, "⚠ failed");
      finishActivity(task, payload, true);
      break;

    case "Notification": {
      const message = payload.message ?? "";
      const lower = message.toLowerCase();
      if (lower.includes("rate limit") || lower.includes("limite d")) {
        task.state = "ratelimit";
        Sound.play("rate");
      } else if (message.endsWith("?")) {
        task.state = "question";
        State.appendStep(task.id, message);
      }
      break;
    }

    case "Stop": {
      task.state = "finished";
      task.reviewAll = false;
      settleActivity(task);
      const final = (payload.last_assistant_message ?? payload.message ?? "").replace(/\s+/g, " ").trim();
      task.finalMessage = final ? final.slice(0, 240) : null;
      if (payload.message) State.appendStep(task.id, payload.message.slice(0, 60));
      Sound.play("finish");

      const watching = State.mode === "expanded" && State.view === "session" && focused();
      if (focused() && State.settings.openOnFinish && !watching) surface("finished", true);
      else if (!focused()) task.pillBadge = "finished";
      window.setTimeout(() => {
        if (task.state === "finished") task.state = "idle";
        State.notify();
      }, 5200);
      break;
    }

    case "StopFailure":
      task.state = "error";
      Sound.play("error");
      if (focused()) surface("error", true);
      else task.pillBadge = "error";
      break;

    case "SubagentStart":
      State.appendStep(task.id, "+ subagent");
      break;

    case "SubagentStop":
      State.appendStep(task.id, "• subagent done");
      break;

    case "PermissionRequest": {
      const requestId = payload.request_id ?? "";
      const tool = payload.tool_name ?? "Tool";
      const input = payload.tool_input ?? {};
      if (!focused() && !State.pendingApproval) State.focusId = task.id;
      request(island, {
        requestId,
        sessionId: payload.session_id ?? "",
        tool,
        command: approvalTarget(tool, input),
        origin: "session",
        kind: "permission",
        taskId: task.id,
        expiresAt: Date.now() + DECISION_MS,
      });
      if (!isFocused(task)) island.reveal();
      break;
    }

    default:
      break;
  }
  State.notify();
}
