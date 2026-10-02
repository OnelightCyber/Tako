import {
  Bridge, onEvent,
  type DownloadInfo, type DriveInfo, type NetworkInfo, type NoticeInfo, type PowerInfo, type PrivacyInfo,
  type VolumeInfo, type WeatherInfo,
} from "../core/bridge";
import { bytes, initials, middle, toneFor, type HudSpec } from "../core/hud";
import { Sound } from "../core/sound";
import { State } from "../core/state";
import type { Island } from "./island";

const CALL_APPS = new Set(["discord", "teams", "zoom", "skype", "slack", "whatsapp", "telegram", "signal", "messenger", "webex", "facetime", "google meet"]);
const MAX_NOTICES = 30;
const DOWNLOAD_STALE_MS = 6000;
const NOTICE_FRESH_MS = 45_000;
const MISSED = /^(\d+) notifications?$/;

let lowWarned = 101;
let testCallTimer: number | null = null;
const downloads = new Map<string, { info: DownloadInfo; at: number }>();
let downloadSweep: number | null = null;

function batteryTone(percent: number): string {
  if (percent <= 20) return "#F4505E";
  if (percent <= 45) return "#F5A524";
  return "#34D399";
}

export function isCallApp(app: string): boolean {
  return CALL_APPS.has(app.trim().toLowerCase());
}

function applyPrivacy(island: Island, p: PrivacyInfo, live: boolean) {
  State.privacy = State.settings.privacyDots || State.settings.callActivity ? p : { mic: [], cam: [] };
  const caller = State.settings.callActivity ? p.mic.find((u) => isCallApp(u.app)) : undefined;
  const was = State.call;
  State.call = caller ? { app: caller.app, since: caller.since > 0 ? caller.since : Date.now() } : null;
  if (live && State.call && (!was || was.app !== State.call.app)) {
    Sound.play("peek");
    island.reveal();
  }
  State.notify();
}

function testCall(island: Island) {
  if (testCallTimer != null) window.clearTimeout(testCallTimer);
  const real = State.privacy;
  const since = Date.now() - 65_000;
  applyPrivacy(island, { mic: [...real.mic.filter((u) => u.app !== "Discord"), { app: "Discord", since }], cam: real.cam }, true);
  testCallTimer = window.setTimeout(() => {
    testCallTimer = null;
    void Bridge.privacyStatus().then((p) => applyPrivacy(island, p ?? { mic: [], cam: [] }, false));
  }, 9000);
}

function powerSpec(p: PowerInfo, previous: PowerInfo | null): { spec: HudSpec; sound: string } | null {
  const plugChanged = !previous || !previous.hasBattery || previous.plugged !== p.plugged;
  if (plugChanged) lowWarned = 101;
  if (!p.plugged && p.percent <= 20) {
    const threshold = p.percent <= 10 ? 10 : 20;
    if (threshold >= lowWarned) return null;
    lowWarned = threshold;
    return {
      sound: "error",
      spec: {
        key: "power", tone: "#F4505E", icon: "battery", title: threshold === 10 ? "Batterie très faible" : "Batterie faible",
        detail: p.saver ? "Économiseur de batterie activé" : "Branche ton chargeur", value: p.percent / 100,
        meta: `${p.percent} %`, metaTone: "#F4505E", ms: 5200, priority: 2,
      },
    };
  }
  if (plugChanged && previous) {
    return p.plugged
      ? { sound: "approve", spec: { key: "power", tone: "#22C55E", icon: "batteryCharge", title: "En charge", value: p.percent / 100, meta: `${p.percent} %`, metaTone: "#22C55E", ms: 2800, priority: 2, pulse: true } }
      : { sound: "", spec: { key: "power", tone: batteryTone(p.percent), icon: "battery", title: "Sur batterie", value: p.percent / 100, meta: `${p.percent} %`, ms: 2200, priority: 1 } };
  }
  if (p.plugged && p.percent >= 100 && previous && previous.percent < 100) {
    return { sound: "", spec: { key: "power", tone: "#22C55E", icon: "battery", title: "Batterie chargée", value: 1, meta: "100 %", metaTone: "#22C55E", ms: 2600, priority: 1 } };
  }
  return null;
}

function onPower(island: Island, p: PowerInfo) {
  const previous = State.power;
  State.power = p;
  State.notify();
  if (!State.settings.batteryAlerts || !p.hasBattery) return;
  const shown = powerSpec(p, previous);
  if (!shown) return;
  island.hud(shown.spec);
  if (shown.sound) Sound.play(shown.sound);
}

function driveSpec(d: DriveInfo): HudSpec {
  const what = d.kind === "disc" ? "Disque" : "Clé USB";
  if (!d.present) {
    return { key: "drive", tone: "#9398a1", icon: d.kind === "disc" ? "disc" : "usb", title: `${what} retiré${d.kind === "disc" ? "" : "e"}`, meta: `${d.letter}:`, ms: 1800, priority: 1 };
  }
  const open = () => void Bridge.driveOpen(d.letter);
  return {
    key: "drive", tone: "#38BDF8", icon: d.kind === "disc" ? "disc" : "usb", title: d.label || what,
    detail: d.total > 0 ? `${d.letter}: · ${bytes(d.free)} libres sur ${bytes(d.total)}` : `${d.letter}: · connecté`,
    ms: 5600, priority: 2, onClick: open, actions: [{ label: "Ouvrir", primary: true, run: open }],
  };
}

function onDrive(island: Island, d: DriveInfo) {
  if (!State.settings.drivesEnabled) return;
  island.hud(driveSpec(d));
  if (d.present) Sound.play("peek");
}

function networkSpec(n: NetworkInfo): HudSpec {
  return n.online
    ? { key: "network", tone: "#22C55E", icon: "wifi", title: "Connexion rétablie", detail: n.name || undefined, ms: 2800, priority: 2 }
    : { key: "network", tone: "#F4505E", icon: "wifiOff", title: "Connexion perdue", detail: n.name ? `${n.name} · plus d'accès à Internet` : "Plus d'accès à Internet", ms: 5200, priority: 2 };
}

function onNetwork(island: Island, n: NetworkInfo) {
  State.network = n;
  State.notify();
  if (!State.settings.networkAlerts) return;
  island.hud(networkSpec(n));
  Sound.play(n.online ? "approve" : "error");
}

function refreshDownload() {
  const now = Date.now();
  for (const [name, entry] of downloads) {
    if (now - entry.at > DOWNLOAD_STALE_MS) downloads.delete(name);
  }
  const first = downloads.values().next().value;
  State.download = first ? first.info : null;
  State.downloadCount = downloads.size;
  if (!downloads.size && downloadSweep != null) {
    window.clearInterval(downloadSweep);
    downloadSweep = null;
  }
  State.notify();
}

function downloadSpec(d: DownloadInfo): HudSpec {
  const open = () => void Bridge.downloadOpen(d.path);
  const reveal = () => void Bridge.downloadReveal(d.path);
  return {
    key: `download-${d.name}`, tone: "#38BDF8", icon: "download", title: middle(d.name || "Téléchargement terminé", 34),
    detail: `Téléchargé · ${bytes(d.bytes)}`, ms: 6500, priority: 2,
    onClick: reveal,
    actions: d.runnable ? [{ label: "Afficher", primary: true, run: reveal }] : [{ label: "Ouvrir", primary: true, run: open }, { label: "Dossier", run: reveal }],
  };
}

function onDownload(island: Island, d: DownloadInfo) {
  if (!State.settings.downloadsEnabled) return;
  if (d.state === "active") {
    downloads.set(d.name, { info: d, at: Date.now() });
    if (downloadSweep == null) downloadSweep = window.setInterval(refreshDownload, 1000);
    refreshDownload();
    return;
  }
  if (!downloads.delete(d.name)) downloads.delete("");
  refreshDownload();
  if (d.state === "cancelled") return;
  island.hud(downloadSpec(d));
  Sound.play("finish");
}

export function openNotice(n: NoticeInfo) {
  if (n.appId) void Bridge.notificationOpen(n.appId);
  dropNotice(n.id, n.at);
}

export function dropNotice(id: number, at: number) {
  State.notices = State.notices.filter((x) => !(x.id === id && x.at === at));
  State.unreadNotices = Math.min(State.unreadNotices, State.notices.length);
  State.notify();
}

function noticeSpec(n: NoticeInfo, onClick?: () => void): HudSpec {
  return {
    key: `notice-${n.id}-${n.at}`, banner: true, tone: toneFor(n.app || n.title), image: n.logo,
    initials: initials(n.app || n.title || "?"), title: n.title || n.app, detail: n.body, meta: n.app,
    at: n.at || Date.now(), ms: 6500, priority: 3, onClick,
  };
}

function countMissedNotice() {
  const index = State.missed.findIndex((m) => MISSED.test(m));
  const count = index >= 0 ? Number(MISSED.exec(State.missed[index])?.[1] ?? 0) + 1 : 1;
  const label = `${count} notification${count > 1 ? "s" : ""}`;
  if (index >= 0) State.missed[index] = label;
  else State.missed.push(label);
}

function onNotice(island: Island, n: NoticeInfo) {
  if (!State.settings.notificationsEnabled) return;
  State.notices = [n, ...State.notices.filter((x) => !(x.id === n.id && x.at === n.at))].slice(0, MAX_NOTICES);
  State.unreadNotices = Math.min(State.notices.length, State.unreadNotices + 1);
  if (State.gameMode) {
    countMissedNotice();
    State.notify();
    return;
  }
  State.notify();
  const fresh = !n.at || Date.now() - n.at < NOTICE_FRESH_MS;
  if (State.mode === "expanded" || !fresh) return;
  island.hud(noticeSpec(n, () => openNotice(n)));
  Sound.play("peek");
}

function sampleSpec(kind: string): HudSpec | null {
  const none = () => undefined;
  switch (kind) {
    case "volume":
      return { key: "volume", tone: "#F5F6F8", icon: "volume", title: "", value: 0.64, meta: "64", ms: 1700, priority: 1 };
    case "caps":
      return { key: "caps", tone: "#22C55E", icon: "lock", title: "Verr. Maj", meta: "activé", metaTone: "#22C55E", ms: 1500, priority: 1 };
    case "charging":
      return { key: "power", tone: "#22C55E", icon: "batteryCharge", title: "En charge", value: 0.54, meta: "54 %", metaTone: "#22C55E", ms: 2800, priority: 2, pulse: true };
    case "battery":
      return { key: "power", tone: "#F4505E", icon: "battery", title: "Batterie faible", detail: "Branche ton chargeur", value: 0.09, meta: "9 %", metaTone: "#F4505E", ms: 4200, priority: 2 };
    case "drive":
      return { ...driveSpec({ letter: "E", label: "KINGSTON", total: 64 * 1024 ** 3, free: 41.2 * 1024 ** 3, kind: "usb", present: true }), onClick: undefined, actions: [{ label: "Ouvrir", primary: true, run: none }] };
    case "network":
      return networkSpec({ online: false, name: "Livebox-4F2A" });
    case "download":
      return { ...downloadSpec({ name: "rapport-annuel-2026-version-finale.pdf", path: "", bytes: 2_480_000, speed: 0, state: "done", runnable: false }), onClick: undefined, actions: [{ label: "Ouvrir", primary: true, run: none }, { label: "Dossier", run: none }] };
    case "notification":
    case "notice":
      return noticeSpec({ id: 0, app: "Discord", appId: "", title: "Léa", body: "t'es dispo pour une partie ce soir ? on lance à 21 h", logo: null, at: Date.now() });
    default:
      return null;
  }
}

export function testHud(island: Island, kind: string) {
  if (kind === "call") {
    testCall(island);
    return;
  }
  const spec = sampleSpec(kind);
  if (spec && island.hud(spec)) Sound.play(kind === "notification" || kind === "notice" || kind === "drive" ? "peek" : "blip");
}

export function registerSystem(island: Island) {
  void Bridge.powerStatus().then((p) => {
    if (p) State.power = p;
  });
  void Bridge.privacyStatus().then((p) => {
    if (p) applyPrivacy(island, p, false);
  });
  void Bridge.weatherNow().then((w) => {
    State.weather = w ?? null;
    State.notify();
  });

  void onEvent<VolumeInfo>("volume", (v) => {
    if (!State.settings.volumeHud) return;
    const silent = v.muted || v.level === 0;
    island.hud({
      key: "volume", tone: silent ? "#9398a1" : "#F5F6F8", icon: silent ? "volumeOff" : v.level < 40 ? "volumeLow" : "volume",
      title: "", value: silent ? 0 : v.level / 100, meta: v.muted ? "muet" : String(v.level), ms: 1700, priority: 1,
    });
  });
  void onEvent<{ key: string; on: boolean }>("lock-key", (k) => {
    if (!State.settings.lockKeysHud) return;
    island.hud({
      key: "caps", tone: k.on ? "#22C55E" : "#9398a1", icon: k.on ? "lock" : "lockOpen", title: "Verr. Maj",
      meta: k.on ? "activé" : "désactivé", metaTone: k.on ? "#22C55E" : "#9398a1", ms: 1500, priority: 1,
    });
  });
  void onEvent<PowerInfo>("power", (p) => onPower(island, p));
  void onEvent<PrivacyInfo>("privacy", (p) => applyPrivacy(island, p, true));
  void onEvent<DriveInfo>("drive", (d) => onDrive(island, d));
  void onEvent<NetworkInfo>("network", (n) => onNetwork(island, n));
  void onEvent<DownloadInfo>("download", (d) => onDownload(island, d));
  void onEvent<NoticeInfo>("notification", (n) => onNotice(island, n));
  void onEvent<WeatherInfo | null>("weather", (w) => {
    State.weather = w ?? null;
    State.notify();
  });
  void onEvent<string>("hud-test", (kind) => testHud(island, kind));
  void onEvent<number>("audio-level", (peak) => island.audioLevel(peak));
}

export function demoSystem(island: Island, kind: string) {
  const spec = sampleSpec(kind);
  if (kind === "call") testCall(island);
  else if (spec) island.hud({ ...spec, ms: 60_000 });
}
