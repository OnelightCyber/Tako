import { Bridge, onEvent } from "../core/bridge";
import { activityFromPre, applyPost, type Activity } from "../core/activity";
import { Sound } from "../core/sound";
import { State } from "../core/state";
import type { Island } from "./island";

const CLAUDE_ID = "integration_claude";

let pendingTimeout: number | null = null;

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

const AGENT_FIELDS = ["url", "element", "text", "key", "function", "code", "action"] as const;

function agentTarget(tool: string, input: Record<string, unknown>): string {
  const action = tool.replace(/^mcp__playwright__browser_/, "").replace(/_/g, " ");
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

let agentTimeout: number | null = null;

function requestAgentApproval(island: Island, payload: HookPayload) {
  const requestId = payload.request_id ?? "";
  if (State.pendingApproval) {
    void Bridge.approvalDecline(requestId);
    return;
  }
  State.pendingApproval = {
    requestId,
    sessionId: payload.session_id ?? "",
    tool: payload.tool_name ?? "browser",
    command: agentTarget(payload.tool_name ?? "", payload.tool_input ?? {}),
    origin: "chat",
  };
  void Bridge.approvalAck(requestId);
  State.isPinned = true;
  Sound.play("approval");
  island.alert("approval");
  if (agentTimeout != null) window.clearTimeout(agentTimeout);
  agentTimeout = window.setTimeout(() => {
    agentTimeout = null;
    if (State.pendingApproval?.requestId !== requestId) return;
    State.pendingApproval = null;
    State.isPinned = false;
    island.dropPin();
    if (State.view === "approval") island.setView("prompt");
    State.notify();
  }, 110_000);
  State.notify();
}

function upsert(projectName: string, cwd: string) {
  const t = State.tasks.find((x) => x.id === CLAUDE_ID);
  if (!t) return;
  t.name = projectName;
  if (cwd) t.sessionCwd = cwd;
}

function claudeTask() {
  return State.tasks.find((x) => x.id === CLAUDE_ID);
}

function startTurn(prompt: string | null) {
  const t = claudeTask();
  if (!t) return;
  t.prompt = prompt;
  t.activity = [];
}

function startActivity(payload: HookPayload) {
  const t = claudeTask();
  if (!t) return;
  const list = (t.activity ??= []);
  list.push(activityFromPre(payload.tool_name ?? "Tool", payload.tool_input ?? {}, payload.tool_use_id));
  if (list.length > MAX_ACTIVITY) list.splice(0, list.length - MAX_ACTIVITY);
}

function findActivity(payload: HookPayload): Activity | undefined {
  const list = claudeTask()?.activity ?? [];
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

function finishActivity(payload: HookPayload, failed: boolean) {
  const tool = payload.tool_name ?? "Tool";
  if (!loggedShapes.has(tool)) {
    loggedShapes.add(tool);
    const r = payload.tool_response;
    const keys = r && typeof r === "object" ? Object.keys(r).join(",") : typeof r;
    void Bridge.log(`result shape ${tool}: ${keys} id=${payload.tool_use_id ? "yes" : "no"}`);
  }
  const a = findActivity(payload);
  if (a) applyPost(a, payload.tool_response, failed, payload.error);
}

function settleActivity() {
  for (const a of claudeTask()?.activity ?? []) {
    if (a.status === "running") a.status = "done";
  }
}

function clearSession() {
  const t = claudeTask();
  if (!t) return;
  t.activity = [];
  t.prompt = null;
  t.steps = [];
  t.stepIndex = 0;
  t.name = "VS Code";
  t.pillBadge = null;
}

export function registerHookHandlers(island: Island) {
  void onEvent<HookPayload>("hook", (payload) => handleHook(island, payload));
}

export function handleHook(island: Island, payload: HookPayload) {
  if (State.paused) {
    if (payload.request_id) void Bridge.approvalDecline(payload.request_id);
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
  const cwd = payload.cwd ?? "";
  const raw = lastPathComponent(cwd);
  const projectName = aliasProjectName(raw || "Session");
  const focused = State.focusId === CLAUDE_ID;

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
      upsert(projectName, cwd);
      surface("overview", false);
      Sound.play("work");
      break;

    case "UserPromptSubmit": {
      upsert(projectName, cwd);
      State.updateTask(CLAUDE_ID, "thinking");

      const asked = payload.prompt ?? payload.message;
      startTurn(asked?.trim() ? asked.trim().slice(0, 400) : null);
      if (asked) State.appendStep(CLAUDE_ID, asked.slice(0, 60));
      surface("overview", false);
      break;
    }

    case "PreToolUse": {
      upsert(projectName, cwd);
      State.updateTask(CLAUDE_ID, "working");
      const tool = payload.tool_name ?? "Tool";
      State.appendStep(CLAUDE_ID, stepLabel(tool, payload.tool_input ?? {}));
      startActivity(payload);
      surface("overview", false);
      break;
    }

    case "PostToolUse":
      State.updateTask(CLAUDE_ID, "working");
      finishActivity(payload, false);
      break;

    case "PostToolUseFailure":
      State.updateTask(CLAUDE_ID, "working");
      State.appendStep(CLAUDE_ID, "⚠ failed");
      finishActivity(payload, true);
      break;

    case "Notification": {
      const message = payload.message ?? "";
      const lower = message.toLowerCase();
      if (lower.includes("rate limit") || lower.includes("limite d")) {
        State.updateTask(CLAUDE_ID, "ratelimit");
        Sound.play("rate");
      } else if (message.endsWith("?")) {
        State.updateTask(CLAUDE_ID, "question");
        State.appendStep(CLAUDE_ID, message);
      }
      break;
    }

    case "Stop":
      State.updateTask(CLAUDE_ID, "finished");
      settleActivity();
      if (payload.message) State.appendStep(CLAUDE_ID, payload.message.slice(0, 60));
      Sound.play("finish");

      const watching = State.mode === "expanded" && State.view === "session";
      if (focused && State.settings.openOnFinish && !watching) surface("finished", true);
      else if (!watching) State.setPillBadge(CLAUDE_ID, "finished");
      window.setTimeout(() => {
        State.updateTask(CLAUDE_ID, "idle");
        State.setPillBadge(CLAUDE_ID, null);
      }, 5200);
      break;

    case "StopFailure":
      State.updateTask(CLAUDE_ID, "error");
      Sound.play("error");
      if (focused) surface("error", true);
      else State.setPillBadge(CLAUDE_ID, "error");
      break;

    case "SessionEnd":
      State.updateTask(CLAUDE_ID, "idle");
      clearSession();
      break;

    case "SubagentStart":
      State.appendStep(CLAUDE_ID, "+ subagent");
      break;

    case "SubagentStop":
      State.appendStep(CLAUDE_ID, "• subagent done");
      break;

    case "PermissionRequest": {
      const requestId = payload.request_id ?? "";

      if (State.pendingApproval && State.pendingApproval.requestId !== requestId) {
        if (requestId) void Bridge.approvalDecline(requestId);
        break;
      }
      upsert(projectName, cwd);
      if (pendingTimeout != null) window.clearTimeout(pendingTimeout);
      const tool = payload.tool_name ?? "Tool";
      const input = payload.tool_input ?? {};
      State.pendingApproval = {
        requestId,
        sessionId: payload.session_id ?? "",
        tool,
        command: approvalTarget(tool, input),
      };

      if (requestId) void Bridge.approvalAck(requestId);
      State.updateTask(CLAUDE_ID, "approval");
      State.isPinned = true;
      Sound.play("approval");
      if (focused) {
        island.alert("approval");
      } else {
        State.setPillBadge(CLAUDE_ID, "approval");
        island.reveal();
      }

      pendingTimeout = window.setTimeout(() => {
        pendingTimeout = null;
        if (!State.pendingApproval) return;
        State.pendingApproval = null;
        State.isPinned = false;
        island.dropPin();
        State.updateTask(CLAUDE_ID, "working");
        State.setPillBadge(CLAUDE_ID, null);
        if (State.view === "approval") island.setView(State.defaultView());
        State.notify();
      }, 110_000);
      break;
    }

    default:
      break;
  }
  State.notify();
}
