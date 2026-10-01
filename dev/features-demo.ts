import type { Island } from "../src/island/island";
import { State, type AgentTask } from "../src/core/state";
import { colorForProject, type IslandViewName } from "../src/core/layout";

function art(): string {
  const c = document.createElement("canvas");
  c.width = c.height = 120;
  const g = c.getContext("2d")!;
  const grad = g.createLinearGradient(0, 0, 120, 120);
  grad.addColorStop(0, "#ff7a59");
  grad.addColorStop(1, "#6d28d9");
  g.fillStyle = grad;
  g.fillRect(0, 0, 120, 120);
  g.fillStyle = "rgba(255,255,255,0.85)";
  g.beginPath();
  g.arc(60, 60, 22, 0, Math.PI * 2);
  g.fill();
  return c.toDataURL("image/png");
}

function session(id: string, name: string, cwd: string, extra: Partial<AgentTask>): AgentTask {
  return {
    id: `session:${id}`,
    name,
    color: colorForProject(name),
    state: "working",
    stepIndex: 0,
    steps: [],
    source: "claudeCode",
    isIntegration: false,
    sessionId: id,
    sessionCwd: cwd,
    activity: [],
    prompt: null,
    lastEventAt: Date.now(),
    ...extra,
  };
}

function seed() {
  const tako = session("s1", "Tako", String.raw`C:\Users\dev\Desktop\Tako`, {
    steps: ["Lit · hooks.ts", "Modifie · ticker.ts", "Exécute · Run the tests"],
    stepIndex: 2,
    stepTotal: 27,
    context: { used: 312_000, window: 1_000_000, model: "claude-opus-5-5" },
    finalMessage: "J'ai corrigé le chevauchement du ticker et ajouté un test pour la limite de 20 étapes.",
    turn: {
      sessionId: "s1",
      files: [
        { path: "src/views/ticker.ts", added: 22, removed: 17, created: false, skipped: false },
        { path: "src/core/state.ts", added: 2, removed: 0, created: false, skipped: false },
        { path: "src/views/views.ts", added: 18, removed: 6, created: false, skipped: false },
      ],
      added: 42,
      removed: 23,
      durationMs: 4 * 60_000 + 12_000,
      tokens: 1_240_000,
      outputTokens: 18_400,
      git: true,
      undone: false,
    },
  });
  const breach = session("s2", "breachhub", String.raw`C:\Users\dev\projects\breachhub`, { state: "idle", pillBadge: "finished", lastEventAt: Date.now() - 60_000 });
  const jarvis = session("s3", "Jarvis 2.0", String.raw`C:\Users\dev\Desktop\Jarvis 2.0`, { state: "approval", pillBadge: "approval", lastEventAt: Date.now() - 30_000 });
  State.tasks = State.tasks.filter((t) => !t.sessionId);
  State.tasks.unshift(tako, breach, jarvis);
  State.focusId = tako.id;
  State.media = { active: true, title: "Midnight City", artist: "M83", app: "Spotify", playing: true, positionMs: 83_000, durationMs: 243_000, atMs: Date.now(), art: art() };
  State.stats = { cpu: 23, ram: 61, ramUsedGb: 9.8, ramTotalGb: 16, gpu: 12 };
  State.settings.recentProjects = [String.raw`C:\Users\dev\Desktop\Tako`, String.raw`C:\Users\dev\projects\breachhub`];
}

export function runFeatureDemo(island: Island, kind: string) {
  (window as unknown as { __island: Island; __state: typeof State }).__island = island;
  (window as unknown as { __state: typeof State }).__state = State;
  seed();
  const show = () => {
    State.isPinned = true;
    let view: IslandViewName = "overview";
    if (kind === "review") {
      State.pendingApproval = {
        requestId: "demo",
        sessionId: "s1",
        tool: "Edit",
        command: String.raw`C:\Users\dev\Desktop\Tako\src\views\ticker.ts`,
        origin: "session",
        kind: "review",
        taskId: "session:s1",
        expiresAt: Date.now() + 100_000,
        review: {
          path: String.raw`C:\Users\dev\Desktop\Tako\src\views\ticker.ts`,
          added: 3,
          removed: 1,
          created: false,
          lines: [
            { kind: "ctx", text: "  const dim = h(\"span\", {", no: 28 },
            { kind: "ctx", text: "    class: \"tick-text\",", no: 29 },
            { kind: "del", text: "    style: \"position:absolute;left:0;right:0;color:#6b7079\",", no: 30 },
            { kind: "add", text: "    style: \"position:absolute;left:0;right:0;top:0;color:#6b7079\",", no: 30 },
            { kind: "ctx", text: "  });", no: 31 },
            { kind: "sep", text: "", no: null },
            { kind: "ctx", text: "  sync(task: AgentTask | null) {", no: 84 },
            { kind: "add", text: "    const added = this.shown ? appended(this.shown, steps) : -1;", no: 86 },
            { kind: "add", text: "    this.shown = [...steps];", no: 87 },
            { kind: "ctx", text: "", no: 88 },
          ],
        },
      };
      State.approvalQueue = [];
      view = "review";
    } else if (kind === "finished") {
      State.tasks[0].state = "finished";
      view = "finished";
    } else if (kind === "music") {
      view = "music";
    } else if (kind === "system") {
      view = "system";
    } else if (kind === "mission") {
      view = "mission";
    } else if (kind === "usage") {
      State.usageAlert = { kind: "session", percent: 82, threshold: 80, resets: "Oct 1, 11:30pm (Europe/Paris)", forecastAt: Math.floor(Date.now() / 1000) + 50 * 60 };
      view = "usage";
    }
    island.alert(view);
    State.notify();
  };
  window.setTimeout(show, 1500);
}
