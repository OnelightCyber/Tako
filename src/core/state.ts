import type { BotEmoteName, BotStateName, IslandMode, IslandViewName, SizeHint } from "./layout";
import type { EyeShape } from "../mascot/engine";
import type { Activity } from "./activity";
import type {
  BtEvent, ContextInfo, DownloadInfo, NetworkInfo, NoticeInfo, PowerInfo, PrivacyInfo, SquadJob, SquadReport, SystemStats, Track, TurnSummary,
  UsageAlert, UsageReport, VpnEvent, WeatherInfo,
} from "./bridge";
import type { DiffLine } from "./activity";

export type AgentSource = "claudeCode" | "n8n";
export type PillBadge = "approval" | "finished" | "error";

export interface AgentTask {
  id: string;
  name: string;
  color: string;
  state: BotStateName;
  stepIndex: number;
  steps: string[];
  source: AgentSource;
  isIntegration: boolean;
  emote?: BotEmoteName | null;
  miniEye?: EyeShape | null;
  pillBadge?: PillBadge | null;
  sessionCwd?: string | null;

  activity?: Activity[];

  prompt?: string | null;

  sessionId?: string;
  stepTotal?: number;
  lastEventAt?: number;
  context?: Omit<ContextInfo, "sessionId"> | null;
  turn?: TurnSummary | null;
  finalMessage?: string | null;
  origin?: string | null;
  reviewAll?: boolean;
  permissionMode?: string | null;
}

export interface ReviewPreview {
  path: string;
  lines: DiffLine[];
  added: number;
  removed: number;
  created: boolean;
  truncated?: boolean;
  unknown?: boolean;
  unreadable?: boolean;
}

export interface ApprovalInfo {
  requestId: string;
  sessionId: string;
  tool: string;
  command: string;
  origin?: "session" | "chat";
  kind: "permission" | "agent" | "review";
  taskId?: string;
  review?: ReviewPreview;
  expiresAt: number;
  shownAt?: number;
}

export const PLACEHOLDER_ID = "integration_claude";

export interface ChatMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
  usage?: UsageReport;
}

export type PromptContext =
  | { kind: "window"; appName: string; title: string; url?: string }
  | { kind: "file"; name: string; path?: string };

export interface ResultItem {
  label: string;
  detail: string;
  url?: string;
}

export interface SearchResult {
  title: string;
  items: ResultItem[];
  note?: string;
}

const task = (
  id: string, name: string, color: string, source: AgentSource,
): AgentTask => ({
  id, name, color, state: "idle", stepIndex: 0, steps: [], source, isIntegration: true,
});

export const INTEGRATION_AGENTS: AgentTask[] = [
  task("integration_claude", "VS Code", "#F5F6F8", "claudeCode"),
  task("integration_resend", "Resend", "#22C55E", "n8n"),
  task("integration_n8n", "n8n", "#F29B38", "n8n"),
  task("integration_vercel", "Vercel", "#7C5CFF", "n8n"),
  task("integration_github", "GitHub", "#F4505E", "n8n"),
  task("integration_notion", "Notion", "#8C8C8C", "n8n"),
  task("integration_calcom", "Cal.com", "#C9956A", "n8n"),
  task("integration_stripe", "Stripe", "#0570DE", "n8n"),
];

export const TOGGLEABLE_INTEGRATION_IDS = [
  "integration_resend", "integration_n8n", "integration_vercel", "integration_github",
  "integration_notion", "integration_calcom", "integration_stripe",
];

export interface IntegrationInfo {
  data: Record<string, unknown>;
  error: string | null;
  loaded: boolean;
  configured: boolean;
}

export interface Settings {
  soundEnabled: boolean;
  soundVolume: number;
  autoCloseInterval: number;
  absenceInterval: number;
  activeIntegrations: string[];
  screen: "primary" | "cursor";
  autostart: boolean;
  hooksInstalled: boolean;

  model: string;
  chatAgent: boolean;
  agentBrowserVisible: boolean;
  openOnFinish: boolean;
  chatScreen: boolean;
  agentAuto: boolean;
  usageWidget: boolean;
  usagePosition: "island-right" | "island-left" | "corner-right" | "corner-left" | "custom";
  usageX: number;
  usageY: number;
  usageAlerts: boolean;
  usageRecharge: boolean;
  reviewMode: boolean;
  missionHotkey: string;
  recentProjects: string[];
  mediaEnabled: boolean;
  statsEnabled: boolean;
  gameMode: boolean;
  gameMute: boolean;
  btAnimation: boolean;
  vpnAlerts: boolean;
  chatApps: boolean;
  pomodoroFocus: number;
  pomodoroBreak: number;
  pomodoroLong: number;
  pomodoroRounds: number;
  islandScale: number;
  keepLiveVisible: boolean;
  volumeHud: boolean;
  lockKeysHud: boolean;
  batteryAlerts: boolean;
  privacyDots: boolean;
  callActivity: boolean;
  downloadsEnabled: boolean;
  drivesEnabled: boolean;
  networkAlerts: boolean;
  notificationsEnabled: boolean;
  notificationsPrivate: boolean;
  notificationsMuted: string[];
  weatherEnabled: boolean;
  weatherCity: string;
  visualizer: boolean;
  voiceEnabled: boolean;
  voiceReplies: boolean;
  voiceName: string;
  voiceApprovals: boolean;
  lensEnabled: boolean;
  mascotAlive: boolean;
  calmMotion: boolean;
  squadParallel: number;
  nightParallel: number;
  nightHour: number;
  nightPolicy: "safe" | "auto";
  nightKeepAwake: boolean;
  nightBriefing: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  soundEnabled: true,
  soundVolume: 0.12,
  autoCloseInterval: 15,
  absenceInterval: 180,
  activeIntegrations: [
    "integration_resend", "integration_n8n", "integration_vercel", "integration_github",
  ],
  screen: "primary",
  autostart: false,
  hooksInstalled: false,
  model: "claude-opus-5",
  chatAgent: false,
  agentBrowserVisible: true,
  openOnFinish: true,
  chatScreen: true,
  agentAuto: false,
  usageWidget: true,
  usagePosition: "island-right",
  usageX: 0,
  usageY: 0,
  usageAlerts: true,
  usageRecharge: true,
  reviewMode: false,
  missionHotkey: "Alt+Shift+Space",
  recentProjects: [],
  mediaEnabled: true,
  statsEnabled: true,
  gameMode: true,
  gameMute: true,
  btAnimation: true,
  vpnAlerts: true,
  chatApps: true,
  pomodoroFocus: 25,
  pomodoroBreak: 5,
  pomodoroLong: 15,
  pomodoroRounds: 4,
  islandScale: 1.2,
  keepLiveVisible: true,
  volumeHud: true,
  lockKeysHud: true,
  batteryAlerts: true,
  privacyDots: true,
  callActivity: true,
  downloadsEnabled: true,
  drivesEnabled: true,
  networkAlerts: true,
  notificationsEnabled: true,
  notificationsPrivate: false,
  notificationsMuted: [],
  weatherEnabled: true,
  weatherCity: "",
  visualizer: true,
  voiceEnabled: false,
  voiceReplies: true,
  voiceName: "siwis",
  voiceApprovals: false,
  lensEnabled: true,
  mascotAlive: true,
  calmMotion: false,
  squadParallel: 3,
  nightParallel: 1,
  nightHour: 1,
  nightPolicy: "safe",
  nightKeepAwake: true,
  nightBriefing: true,
};

export type VoicePhase = "idle" | "listening" | "thinking" | "speaking";

export interface CallInfo {
  app: string;
  since: number;
}

type Listener = () => void;

class AppState {
  mode: IslandMode = "hidden";
  view: IslandViewName = "overview";

  tasks: AgentTask[] = [];
  focusId: string | null = null;

  stateOverride: BotStateName | null = null;

  mouse = { x: 0, y: 0 };

  mouseInIsland = { x: 0, y: 0 };

  isPinned = false;
  paused = false;

  uploadProgress = 0;
  uploadDuration = 2.4;
  fileDragOver = false;

  promptContext: PromptContext | null = null;
  droppedFile: { name: string; path: string } | null = null;
  noteMessage: string | null = null;
  searchResult: SearchResult | null = null;
  chatHistory: ChatMessage[] = [];
  sizeHint: SizeHint | null = null;

  chatBackend: "claude-code" | "api" | null = null;

  chatPartial = "";

  chatStatus = "";
  pendingApproval: ApprovalInfo | null = null;
  approvalQueue: ApprovalInfo[] = [];

  media: Track | null = null;
  stats: SystemStats | null = null;
  usage: UsageReport | null = null;
  usageAlert: UsageAlert | null = null;

  gameMode = false;
  gameApp = "";
  missed: string[] = [];
  vpnEvent: VpnEvent | null = null;
  btEvent: BtEvent | null = null;

  notices: NoticeInfo[] = [];
  unreadNotices = 0;
  privacy: PrivacyInfo = { mic: [], cam: [] };
  call: CallInfo | null = null;
  power: PowerInfo | null = null;
  network: NetworkInfo | null = null;
  weather: WeatherInfo | null = null;
  download: DownloadInfo | null = null;
  downloadCount = 0;
  voicePhase: VoicePhase = "idle";
  voicePartial = "";
  voiceAnswer = "";
  voiceFailed = false;
  voiceHint = "";
  missionDraft: string | null = null;
  squad: SquadJob[] = [];
  squadReport: SquadReport | null = null;
  nightArmed = false;
  dawnPending = false;
  livePreferred: string | null = null;
  audioPeak = 0;

  integrations: Record<string, IntegrationInfo> = {};

  lastActivity = performance.now();

  settings: Settings = { ...DEFAULT_SETTINGS };

  private listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  notify() {
    for (const fn of this.listeners) fn();
  }

  get sessions(): AgentTask[] {
    return this.tasks.filter((t) => !!t.sessionId);
  }

  isSquadTask(t: AgentTask): boolean {
    if (t.origin === "squad") return true;
    const norm = (p: string) => p.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
    const cwd = t.sessionCwd ? norm(t.sessionCwd) : "";
    if (!cwd) return false;
    return this.squad.some((j) => {
      const w = norm(j.worktree);
      return cwd === w || cwd.startsWith(`${w}\\`);
    });
  }

  get ownSessions(): AgentTask[] {
    return this.sessions.filter((t) => !this.isSquadTask(t));
  }

  get focusTask(): AgentTask | null {
    const found = this.tasks.find((t) => t.id === this.focusId);
    if (found && !(found.id === PLACEHOLDER_ID && this.ownSessions.length > 0)) return found;
    const recent = [...this.ownSessions].sort((a, b) => (b.lastEventAt ?? 0) - (a.lastEventAt ?? 0))[0];
    return recent ?? this.tasks.find((t) => !t.sessionId || !this.isSquadTask(t)) ?? this.tasks[0] ?? null;
  }

  get effectiveState(): BotStateName {
    return this.stateOverride ?? this.focusTask?.state ?? "idle";
  }

  get otherTasks(): AgentTask[] {
    const focus = this.focusTask?.id;
    const hidePlaceholder = this.sessions.length > 0;
    const unconfigured = (t: AgentTask) => t.isIntegration && t.id !== PLACEHOLDER_ID && !this.integrations[t.id]?.configured;
    const others = this.tasks.filter((t) => t.id !== focus && !(hidePlaceholder && t.id === PLACEHOLDER_ID) && !unconfigured(t));
    const sessions = others.filter((t) => t.sessionId).sort((a, b) => (b.lastEventAt ?? 0) - (a.lastEventAt ?? 0));
    return [...sessions, ...others.filter((t) => !t.sessionId)];
  }

  sessionTask(sessionId: string): AgentTask | undefined {
    return this.tasks.find((t) => t.sessionId === sessionId);
  }

  removeTask(id: string) {
    const i = this.tasks.findIndex((t) => t.id === id);
    if (i < 0) return;
    this.tasks.splice(i, 1);
    if (this.focusId === id) this.focusId = null;
    this.notify();
  }

  setFocus(id: string) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    this.focusId = id;
    t.pillBadge = null;
    this.notify();
  }

  updateTask(id: string, state: BotStateName) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    t.state = state;
    this.notify();
  }

  appendStep(id: string, step: string) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    t.steps.push(step);
    if (t.steps.length > 20) t.steps.shift();
    t.stepIndex = t.steps.length - 1;
    t.stepTotal = (t.stepTotal ?? 0) + 1;
    this.notify();
  }

  setPillBadge(id: string, badge: PillBadge | null) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    t.pillBadge = badge;
    this.notify();
  }

  loadIntegrationTasks() {
    for (const proto of INTEGRATION_AGENTS) {
      const shouldLoad =
        proto.id === "integration_claude" || this.settings.activeIntegrations.includes(proto.id);
      const idx = this.tasks.findIndex((t) => t.id === proto.id);
      if (shouldLoad && idx < 0) this.tasks.push({ ...proto, steps: [] });
      if (!shouldLoad && idx >= 0) this.tasks.splice(idx, 1);
    }

    const order = INTEGRATION_AGENTS.map((t) => t.id);
    const rank = (t: AgentTask) => (t.sessionId ? -1 : order.indexOf(t.id));
    this.tasks.sort((a, b) => rank(a) - rank(b));
    if (!this.focusId) this.focusId = PLACEHOLDER_ID;
    this.notify();
  }

  toggleIntegration(id: string) {
    if (id === PLACEHOLDER_ID) return;
    const active = this.settings.activeIntegrations;
    if (active.includes(id)) {
      this.settings.activeIntegrations = active.filter((x) => x !== id);
      if (this.focusId === id) this.focusId = PLACEHOLDER_ID;
    } else {
      if (active.length >= 4) return;
      this.settings.activeIntegrations = [...active, id];
    }
    this.loadIntegrationTasks();
  }

  get sessionLive(): boolean {
    const t = this.focusTask;
    return (
      !!t?.sessionId &&
      (t.state !== "idle" || (t.activity?.length ?? 0) > 0 || !!t.prompt)
    );
  }

  defaultView(): IslandViewName {
    if (this.tasks.length === 0) return "empty";
    return this.sessionLive ? "session" : "overview";
  }
}

export const State = new AppState();
