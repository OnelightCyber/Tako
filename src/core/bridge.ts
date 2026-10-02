import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Settings } from "./state";

export const IS_TAURI =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!IS_TAURI) return null;
  try {
    return await invoke<T>(cmd, args);
  } catch (err) {
    console.error(`[tako] ${cmd} failed`, err);
    return null;
  }
}

export interface BootInfo {
  settings: Settings;

  screen: { x: number; y: number; width: number; height: number; scale: number };
  version: string;
  hookPath: string;
}

export const Bridge = {
  boot: () => call<BootInfo>("boot"),

  saveSettings: (settings: Settings) => call<void>("save_settings", { settings }),

  setCollapsed: (collapsed: boolean) => call<void>("set_collapsed", { collapsed }),

  setIslandRect: (x: number, y: number, width: number, height: number) =>
    call<void>("set_island_rect", { x, y, width, height }),

  focusWindow: (focused: boolean) => call<void>("focus_window", { focused }),

  reposition: () => call<void>("reposition"),

  openUrl: (url: string) => call<void>("open_url", { url }),

  openInVSCode: (path: string | null) => call<boolean>("open_in_vscode", { path }),

  quit: () => call<void>("quit_app"),

  openSettingsWindow: () => call<void>("open_settings_window"),

  log: (message: string) => call<void>("log_line", { message }),

  hooksStatus: () => call<HookStatus>("hooks_status"),

  hooksPreview: (install: boolean) => callOrThrow<HookPreview>("hooks_preview", { install }),

  hooksApply: (install: boolean, fingerprint: string) =>
    callOrThrow<string>("hooks_apply", { install, fingerprint }),

  approvalDecision: (requestId: string, decision: "allow" | "deny") =>
    call<void>("approval_decision", { requestId, decision }),

  approvalAck: (requestId: string) => call<void>("approval_ack", { requestId }),

  approvalDecline: (requestId: string) => call<void>("approval_decline", { requestId }),

  chatSend: (query: string, context: ChatContext | null, cwd: string | null) =>
    callOrThrow<{ text: string }>("chat_send", { query, context, cwd }),
  chatReset: () => call<void>("chat_reset"),

  chatBackend: () => call<"claude-code" | "api">("chat_backend"),
  claudeCodeInfo: () => call<{ found: boolean; path: string; version: string }>("claude_code_info"),
  openTakoFolder: () => call<void>("open_tako_folder"),
  showIsland: () => call<void>("show_island"),
  usageGet: (force: boolean) => call<UsageReport>("usage_get", { force }),
  usageResize: (width: number, height: number) => call<void>("usage_resize", { width, height }),
  usageHistory: () => call<UsageSample[]>("usage_history"),
  sessionSummary: (sessionId: string, cwd: string) => call<TurnSummary | null>("session_summary", { sessionId, cwd }),
  sessionUndo: (sessionId: string) => callOrThrow<UndoReport>("session_undo", { sessionId }),
  sessionDiff: (sessionId: string, project: string) => callOrThrow<void>("session_diff", { sessionId, project }),
  sessionCommitMessage: (sessionId: string, cwd: string) => callOrThrow<string>("session_commit_message", { sessionId, cwd }),
  sessionCommit: (sessionId: string, cwd: string, message: string) => callOrThrow<string>("session_commit", { sessionId, cwd, message }),
  missionStart: (task: string, cwd: string) => callOrThrow<void>("mission_start", { task, cwd }),
  pickFolder: () => call<string | null>("pick_folder"),
  hotkeyStatus: () => call<string | null>("hotkey_status"),
  gameStatus: () => call<GameState>("game_status"),
  vpnStatus: () => call<VpnStatus>("vpn_status"),
  vpnTest: () => call<void>("vpn_test"),
  vpnOpenApp: () => call<boolean>("vpn_open_app"),
  bluetoothTest: () => call<void>("bluetooth_test"),
  mediaControl: (action: "toggle" | "next" | "previous") => call<void>("media_control", { action }),
  usageDrag: () => call<void>("usage_drag"),
  usageClose: () => call<void>("usage_close"),
  updateCheck: () => callOrThrow<{ version: string; current: string; notes: string } | null>("update_check"),
  updateInstall: () => callOrThrow<void>("update_install"),
  chatCommands: () => call<{ commands: string[]; skills: string[]; usage?: string }>("chat_commands"),

  ingestFile: (path: string) => callOrThrow<DroppedFile>("ingest_file", { path }),
  ingestBytes: async (name: string, data: Uint8Array): Promise<DroppedFile> => {
    if (!IS_TAURI) throw new Error("Dropping files needs the app.");
    return invoke<DroppedFile>("ingest_bytes", data, { headers: { "x-file-name": encodeURIComponent(name) } });
  },

  secretPresent: (key: string) => call<boolean>("secret_present", { key }),
  secretSet: (key: string, value: string) => callOrThrow<void>("secret_set", { key, value }),
  secretClear: (key: string) => callOrThrow<void>("secret_clear", { key }),

  refreshIntegration: (id: string) => call<void>("refresh_integration", { id }),

  openN8n: () => call<void>("open_n8n"),

  setPaused: (paused: boolean) => call<void>("set_paused", { paused }),

  audioMeter: (on: boolean) => call<void>("audio_meter", { on }),
  powerStatus: () => call<PowerInfo>("power_status"),
  privacyStatus: () => call<PrivacyInfo>("privacy_status"),
  weatherNow: () => call<WeatherInfo | null>("weather_now"),
  weatherRefresh: () => call<void>("weather_refresh"),
  weatherFailure: () => call<string | null>("weather_failure"),
  driveOpen: (letter: string) => call<boolean>("drive_open", { letter }),
  downloadOpen: (path: string) => call<boolean>("download_open", { path }),
  downloadReveal: (path: string) => call<boolean>("download_reveal", { path }),
  notificationOpen: (appId: string) => call<boolean>("notification_open", { appId }),
  hudTest: (kind: string) => call<void>("hud_test", { kind }),
  voiceListen: () => call<void>("voice_listen"),
  voiceCancel: () => call<void>("voice_cancel"),
  sttStatus: () => call<SttStatus>("stt_status"),
  sttDownload: () => call<void>("stt_download"),
  ttsStatus: (voice: string) => call<TtsStatus>("tts_status", { voice }),
  squadBoard: () => call<SquadBoard>("squad_board"),
  squadAdd: (repo: string, task: string, night: boolean) => callOrThrow<SquadBoard>("squad_add", { repo, task, night }),
  squadAction: (id: string, action: "stop" | "discard" | "merge" | "diff" | "open" | "reply", text?: string) =>
    callOrThrow<string>("squad_action", { id, action, text: text ?? null }),
  squadNightNow: () => call<void>("squad_night_now"),
  squadClear: () => call<void>("squad_clear"),
  squadReportSeen: () => call<void>("squad_report_seen"),
  idleMs: () => call<number>("idle_ms"),
  ttsDownload: (voice: string) => call<void>("tts_download", { voice }),
  voiceSay: (text: string) => callOrThrow<string>("voice_say", { text }),
};

export interface VoiceHeard {
  kind: "wake" | "yes" | "no" | "stop";
  text: string;
  sure: boolean;
}

export interface SttStatus {
  installed: boolean;
  downloading: boolean;
  received: number;
  total: number;
}

export type SquadStatus = "queued" | "running" | "waiting" | "done" | "empty" | "failed" | "merged" | "discarded";

export interface SquadJob {
  id: string;
  repo: string;
  task: string;
  branch: string;
  base: string;
  baseCommit: string;
  worktree: string;
  agent: string | null;
  session: string | null;
  status: SquadStatus;
  night: boolean;
  created: number;
  started: number | null;
  finished: number | null;
  files: number;
  added: number;
  removed: number;
  note: string;
}

export interface SquadReport {
  at: number;
  done: number;
  empty: number;
  failed: number;
  jobs: string[];
  seen: boolean;
}

export interface SquadBoard {
  jobs: SquadJob[];
  report: SquadReport | null;
  nightArmed: boolean;
}

export interface TtsStatus {
  ready: boolean;
  downloading: boolean;
  received: number;
  total: number;
}

export interface TtsProgress {
  voice: string;
  received: number;
  total: number;
  done: boolean;
  error: string | null;
}

export interface SttProgress {
  received: number;
  total: number;
  done: boolean;
  error: string | null;
}

export interface VoiceFinal {
  text: string;
  error: string | null;
}

export interface LensInfo {
  kind: "error" | "english" | "tracking" | "address";
  text: string;
}

export interface VolumeInfo {
  level: number;
  muted: boolean;
}

export interface PowerInfo {
  hasBattery: boolean;
  percent: number;
  plugged: boolean;
  saver: boolean;
}

export interface DeviceUse {
  app: string;
  since: number;
}

export interface PrivacyInfo {
  mic: DeviceUse[];
  cam: DeviceUse[];
}

export interface DriveInfo {
  letter: string;
  label: string;
  total: number;
  free: number;
  kind: "usb" | "disc";
  present: boolean;
}

export interface NetworkInfo {
  online: boolean;
  name: string;
}

export interface DownloadInfo {
  name: string;
  path: string;
  bytes: number;
  speed: number;
  state: "active" | "done" | "cancelled";
  runnable: boolean;
}

export interface NoticeInfo {
  id: number;
  app: string;
  appId: string;
  title: string;
  body: string;
  logo: string | null;
  at: number;
}

export interface WeatherDay {
  date: string;
  code: number;
  max: number;
  min: number;
}

export interface WeatherInfo {
  city: string;
  temp: number;
  code: number;
  isDay: boolean;
  max: number;
  min: number;
  wind: number;
  humidity: number;
  days: WeatherDay[];
}

export interface IntegrationUpdate {
  id: string;
  data: Record<string, unknown>;
  error: string | null;
  event: { success: boolean; label: string; detail: string | null } | null;
}

export type ChatContext =
  | { kind: "file"; name: string; path: string }
  | { kind: "window"; appName: string; title: string; url?: string };

export interface DroppedFile {
  name: string;
  path: string;
  size: number;
}

export interface UsageLine {
  label: string;
  percent: number;
  resets: string;
}

export interface UsageReport {
  lines: UsageLine[];
  subscription: boolean;
  fetchedAt: number;
  error?: string | null;
  forecastAt?: number | null;
}

export interface UsageSample {
  t: number;
  session: number | null;
  week: number | null;
  sessionResets: string;
  weekResets: string;
}

export interface UsageAlert {
  kind: "session" | "week";
  percent: number;
  threshold: number;
  resets: string;
  forecastAt: number | null;
}

export interface ContextInfo {
  sessionId: string;
  used: number;
  window: number;
  model: string;
}

export interface FileChange {
  path: string;
  added: number;
  removed: number;
  created: boolean;
  skipped: boolean;
}

export interface TurnSummary {
  sessionId: string;
  files: FileChange[];
  added: number;
  removed: number;
  durationMs: number;
  tokens: number;
  outputTokens: number;
  git: boolean;
  undone: boolean;
}

export interface UndoReport {
  restored: string[];
  skipped: string[];
}

export interface Track {
  active: boolean;
  title: string;
  artist: string;
  app: string;
  playing: boolean;
  positionMs: number;
  durationMs: number;
  atMs: number;
  art: string | null;
}

export interface SystemStats {
  cpu: number;
  ram: number;
  ramUsedGb: number;
  ramTotalGb: number;
  gpu: number | null;
}

export interface GameState {
  active: boolean;
  app: string;
}

export interface VpnStatus {
  present: boolean;
  up: boolean;
  name: string;
  location: string;
}

export interface VpnEvent {
  kind: "down" | "off" | "up";
  name: string;
  location: string;
  test: boolean;
}

export interface BtEvent {
  name: string;
  kind: "headphones" | "speaker" | "phone" | "gamepad" | "peripheral" | "device";
  connected: boolean;
  battery: number | null;
  address: string;
  test: boolean;
}

export interface HookStatus {
  installed: boolean;
  upToDate: boolean;
  settingsPath: string;
  hookPath: string;
  hookReady: boolean;
}

export interface HookPreview {
  diff: string;
  backup: string;
  settingsPath: string;

  fingerprint: string;
}

async function callOrThrow<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!IS_TAURI) throw new Error("not running inside Tako");
  return invoke<T>(cmd, args);
}

export type BridgeEvent =
  | { name: "cursor"; payload: { x: number; y: number } }
  | { name: "tray"; payload: string }
  | { name: "hook"; payload: Record<string, unknown> }
  | { name: "screen-changed"; payload: null };

export async function onEvent<T>(name: string, handler: (payload: T) => void) {
  if (!IS_TAURI) return () => {};
  return listen<T>(name, (e) => handler(e.payload));
}
