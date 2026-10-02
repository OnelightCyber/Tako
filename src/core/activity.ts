export type ActivityKind =
  | "edit" | "write" | "read" | "shell" | "search" | "web" | "agent" | "todo" | "other";

export type ActivityStatus = "running" | "done" | "failed";

export interface DiffLine {
  kind: "ctx" | "add" | "del" | "sep";
  text: string;

  no: number | null;
}

export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

export interface Activity {
  id: string;
  tool: string;
  kind: ActivityKind;

  label: string;

  target: string;

  path?: string;
  status: ActivityStatus;

  diff?: DiffLine[];
  numbered?: boolean;

  code?: { text: string; start: number };
  command?: string;
  output?: string;
  todos?: TodoItem[];
  startedAt: number;
}

type Input = Record<string, unknown>;

const str = (o: Input | undefined, k: string): string | undefined =>
  o && typeof o[k] === "string" ? (o[k] as string) : undefined;

const num = (o: Input | undefined, k: string): number | undefined =>
  o && typeof o[k] === "number" ? (o[k] as number) : undefined;

export function baseName(p: string): string {
  const cleaned = p.replace(/[\\/]+$/, "");
  const i = Math.max(cleaned.lastIndexOf("\\"), cleaned.lastIndexOf("/"));
  return i >= 0 ? cleaned.slice(i + 1) : cleaned;
}

export function relativePath(path: string, cwd: string | null | undefined): string {
  const norm = (s: string) => s.replace(/\\/g, "/").replace(/\/+$/, "");
  const p = norm(path);
  const c = cwd ? norm(cwd) : "";
  if (c && p.toLowerCase().startsWith(c.toLowerCase() + "/")) return p.slice(c.length + 1);
  return p;
}

const KIND: Record<string, ActivityKind> = {
  Edit: "edit", MultiEdit: "edit", NotebookEdit: "edit",
  Write: "write",
  Read: "read",
  Bash: "shell", PowerShell: "shell", BashOutput: "shell",
  Grep: "search", Glob: "search", LS: "search",
  WebFetch: "web", WebSearch: "web",
  Task: "agent", Agent: "agent",
  TodoWrite: "todo",
};

const LABEL: Record<ActivityKind, string> = {
  edit: "Modifie", write: "Écrit", read: "Lit", shell: "Commande", search: "Cherche",
  web: "Web", agent: "Agent", todo: "Plan", other: "Outil",
};

let seq = 0;

export function activityFromPre(
  tool: string,
  input: Input,
  toolUseId: string | undefined,
): Activity {
  const browser = tool.startsWith("mcp__playwright__browser_");
  const kind = KIND[tool] ?? (browser ? "web" : "other");
  const a: Activity = {
    id: toolUseId || `a${++seq}`,
    tool,
    kind,
    label: browser ? "Navigateur" : tool === "mcp__tako__screenshot" ? "Écran" : kind === "other" ? prettyTool(tool) : LABEL[kind],
    target: "",
    status: "running",
    startedAt: Date.now(),
  };

  const file = str(input, "file_path") ?? str(input, "notebook_path") ?? str(input, "path");
  if (file) {
    a.path = file;
    a.target = baseName(file);
  }

  switch (kind) {
    case "edit": {
      const edits = Array.isArray(input.edits) ? (input.edits as Input[]) : [input];
      const lines: DiffLine[] = [];
      edits.slice(0, 4).forEach((e, i) => {
        if (i > 0) lines.push({ kind: "sep", text: "", no: null });
        lines.push(...lineDiff(str(e, "old_string") ?? "", str(e, "new_string") ?? str(e, "new_source") ?? ""));
      });
      a.diff = lines;
      break;
    }
    case "write": {
      const content = str(input, "content") ?? "";
      a.diff = splitLines(content).map((text, i) => ({ kind: "add" as const, text, no: i + 1 }));
      a.numbered = true;
      break;
    }
    case "shell": {
      a.command = str(input, "command") ?? "";
      a.target = str(input, "description") ?? firstLine(a.command);
      break;
    }
    case "search": {
      const pattern = str(input, "pattern") ?? "";
      a.target = pattern || a.target;
      a.command = [pattern, str(input, "glob"), str(input, "path") && baseName(str(input, "path")!)]
        .filter(Boolean)
        .join("  ·  ");
      break;
    }
    case "web": {
      if (browser) {
        const action = tool.slice("mcp__playwright__browser_".length).replace(/_/g, " ");
        const url = str(input, "url");
        const what = url ? hostOf(url) : str(input, "element") ?? str(input, "text") ?? "";
        a.target = what ? `${action} · ${what}` : action;
        a.command = [action, url ?? str(input, "element") ?? str(input, "text") ?? ""].filter(Boolean).join("  ");
        break;
      }
      a.target = str(input, "query") ?? hostOf(str(input, "url") ?? "");
      a.command = str(input, "query") ?? str(input, "url") ?? "";
      break;
    }
    case "agent": {
      a.target = str(input, "description") ?? str(input, "subagent_type") ?? "subagent";
      a.output = str(input, "prompt");
      break;
    }
    case "todo": {
      a.todos = readTodos(input.todos);
      const doing = a.todos.find((t) => t.status === "in_progress");
      a.target = doing?.content ?? `${a.todos.length} tasks`;
      break;
    }
    case "other": {
      if (tool === "mcp__tako__screenshot") {
        a.target = "your screen";
        break;
      }
      a.target = a.target || summarise(input);
      a.output = JSON.stringify(input, null, 2).slice(0, 1200);
      break;
    }
  }
  return a;
}

export function applyPost(a: Activity, response: unknown, failed: boolean, error?: string) {
  a.status = failed ? "failed" : "done";
  const r = (response && typeof response === "object" ? response : {}) as Input;

  if (failed) {
    const msg = error ?? (typeof response === "string" ? response : str(r, "error") ?? str(r, "stderr"));
    if (msg) a.output = msg;
    return;
  }

  switch (a.kind) {
    case "edit":
    case "write": {
      const patch = Array.isArray(r.structuredPatch) ? (r.structuredPatch as Input[]) : [];
      if (patch.length > 0) {
        a.diff = diffFromPatch(patch);
        a.numbered = true;
      }
      break;
    }
    case "read": {
      const file = (r.file && typeof r.file === "object" ? r.file : null) as Input | null;
      const content = str(file ?? undefined, "content");
      if (content != null) {
        a.code = { text: content, start: num(file ?? undefined, "startLine") ?? 1 };
      } else if (str(r, "type") === "image") {
        a.output = "(image)";
      }
      break;
    }
    case "shell": {
      const out = [str(r, "stdout"), str(r, "stderr")].filter((s) => s && s.trim()).join("\n");
      a.output = out || (typeof response === "string" ? response : "");
      break;
    }
    case "search": {
      const names = Array.isArray(r.filenames) ? (r.filenames as unknown[]).filter((x) => typeof x === "string") as string[] : [];
      const content = str(r, "content");
      a.output = content?.trim() ? content : names.join("\n");
      const n = num(r, "numFiles") ?? names.length;
      if (!content?.trim()) a.output = a.output || "no match";
      a.target = `${a.target}${n ? `  ·  ${n}` : ""}`;
      break;
    }
    case "web": {
      const blocks = Array.isArray(response) ? response : Array.isArray(r.content) ? (r.content as unknown[]) : [];
      const fromBlocks = blocks
        .map((b) => (b && typeof b === "object" && typeof (b as Input).text === "string" ? ((b as Input).text as string) : ""))
        .filter(Boolean)
        .join("\n");
      const result = str(r, "result") ?? (fromBlocks || (typeof response === "string" ? response : undefined));
      if (result) a.output = result;
      break;
    }
    case "agent": {
      const content = Array.isArray(r.content) ? (r.content as Input[]) : [];
      const text = content.map((c) => str(c, "text") ?? "").join("\n").trim();
      if (text) a.output = text;
      break;
    }
  }
}

export function diffFromPatch(hunks: Input[]): DiffLine[] {
  const out: DiffLine[] = [];
  hunks.slice(0, 6).forEach((hunk, i) => {
    if (i > 0) out.push({ kind: "sep", text: "", no: null });
    let oldNo = num(hunk, "oldStart") ?? 1;
    let newNo = num(hunk, "newStart") ?? 1;
    const lines = Array.isArray(hunk.lines) ? (hunk.lines as unknown[]) : [];
    for (const raw of lines) {
      if (typeof raw !== "string") continue;
      const sign = raw[0];
      const text = raw.slice(1);
      if (sign === "-") out.push({ kind: "del", text, no: oldNo++ });
      else if (sign === "+") out.push({ kind: "add", text, no: newNo++ });
      else if (sign === "\\") continue;
      else {
        out.push({ kind: "ctx", text, no: newNo++ });
        oldNo++;
      }
    }
  });
  return out;
}

export function lineDiff(before: string, after: string): DiffLine[] {
  const a = splitLines(before);
  const b = splitLines(after);
  if (a.length * b.length > 40_000) {
    return [
      ...a.map((text) => ({ kind: "del" as const, text, no: null })),
      ...b.map((text) => ({ kind: "add" as const, text, no: null })),
    ];
  }
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: "ctx", text: a[i], no: null });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ kind: "del", text: a[i++], no: null });
    } else {
      out.push({ kind: "add", text: b[j++], no: null });
    }
  }
  while (i < a.length) out.push({ kind: "del", text: a[i++], no: null });
  while (j < b.length) out.push({ kind: "add", text: b[j++], no: null });
  return out;
}

function splitLines(s: string): string[] {
  if (!s) return [];
  const lines = s.replace(/\r\n?/g, "\n").split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function readTodos(raw: unknown): TodoItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((t) => {
    const o = t as Input;
    const content = str(o, "content");
    if (!content) return [];
    const s = str(o, "status");
    const status = s === "completed" || s === "in_progress" ? s : "pending";
    return [{ content, status }];
  });
}

function firstLine(s: string): string {
  return s.split(/\r?\n/)[0].trim();
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function prettyTool(tool: string): string {
  const parts = tool.split("__");
  return (parts[parts.length - 1] || tool).replace(/_/g, " ");
}

function summarise(input: Input): string {
  for (const v of Object.values(input)) {
    if (typeof v === "string" && v.trim()) return firstLine(v).slice(0, 60);
  }
  return "";
}
