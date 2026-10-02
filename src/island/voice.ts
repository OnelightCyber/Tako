import { Bridge, onEvent, type VoiceFinal, type VoiceHeard } from "../core/bridge";
import { Sound } from "../core/sound";
import { State } from "../core/state";
import { Timer } from "../core/timer";
import { ChatBus } from "../views/chat";
import { VoiceUi } from "../views/voice";
import { weatherLabel } from "../views/weather";
import { decideCurrent } from "./hooks";
import type { Island } from "./island";

const DAYS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
const MONTHS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const WORDS: Record<string, number> = {
  un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, sept: 7, huit: 8, neuf: 9, dix: 10,
  onze: 11, douze: 12, quinze: 15, vingt: 20, "vingt-cinq": 25, trente: 30, quarante: 40, "quarante-cinq": 45, cinquante: 50, soixante: 60,
};
const APPROVAL_DELAY_MS = 1200;

interface Local {
  say: string;
  run?: () => void;
  keepMusic?: boolean;
}

let island: Island;
let flow = 0;
let speakToken = 0;
let ctx: AudioContext | null = null;
let source: AudioBufferSourceNode | null = null;
let resumeMusic = false;
let lastWake = 0;
let awaiting = false;

export function plain(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "le lien")
    .replace(/^\s{0,3}#{1,6}\s*/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, "")
    .replace(/[*_~>|#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function fold(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[’']/g, " ")
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function amount(text: string): number | null {
  const digits = /(\d+(?:[.,]\d+)?)/.exec(text);
  if (digits) return Number(digits[1].replace(",", "."));
  for (const word of text.split(" ")) {
    if (word in WORDS) return WORDS[word];
  }
  if (/\bune? demi(-| )?heure\b/.test(text)) return 30;
  return null;
}

function clock(d = new Date()): string {
  const m = d.getMinutes();
  return `${d.getHours()} h${m ? ` ${String(m).padStart(2, "0")}` : ""}`;
}

export function timerMinutes(text: string): number | null {
  if (/\bdemi(-| )?heure\b/.test(text) && !/\d|\bheures?\b.*\bheures?\b/.test(text)) return 30;
  const n = amount(text);
  if (n == null || n <= 0) return null;
  if (/\bheures?\b|\b\d+ ?h\b/.test(text)) return Math.round(n * 60);
  if (/\bsecondes?\b|\bsec\b/.test(text)) return Math.max(1, Math.ceil(n / 60));
  return Math.round(n);
}

export function localIntent(raw: string): Local | null {
  const t = fold(raw);
  if (!t) return null;
  if (/^(rien|annule|laisse tomber|non rien|c est bon|oublie|stop|tais toi)$/.test(t)) return { say: "" };
  if (t.length < 40 && /\bquel(le)?s? heures?\b|^l heure$/.test(t)) return { say: `Il est ${clock()}.` };
  if (t.length < 45 && /\bquel jour\b|\bquelle date\b|\bon est le combien\b|\bla date\b/.test(t)) {
    const d = new Date();
    return { say: `On est ${DAYS[d.getDay()]} ${d.getDate() === 1 ? "1er" : d.getDate()} ${MONTHS[d.getMonth()]}.` };
  }
  if (t.length < 60 && /\bmeteo\b|\bquel temps\b|\bil fait (chaud|froid|beau|combien)\b|\btemperature\b|\bva t il pleuvoir\b/.test(t)) {
    const w = State.weather;
    if (!w) return { say: "Je n'ai pas encore la météo. Vérifie qu'elle est activée dans les réglages." };
    const where = w.city ? `À ${w.city}, il` : "Il";
    return { say: `${where} fait ${Math.round(w.temp)} degrés, ${weatherLabel(w.code).toLowerCase()}. Entre ${Math.round(w.min)} et ${Math.round(w.max)} aujourd'hui.` };
  }
  if (/\b(minuteur|timer|chrono|compte a rebours|pomodoro)\b/.test(t)) {
    if (/\b(arrete|stoppe|annule|coupe|supprime)\b/.test(t)) {
      return Timer.active ? { say: "Minuteur arrêté.", run: () => Timer.stop() } : { say: "Aucun minuteur en cours." };
    }
    if (/\bpomodoro\b/.test(t)) return { say: "C'est parti pour un pomodoro.", run: () => Timer.startPomodoro() };
    const minutes = timerMinutes(t);
    if (minutes == null) return { say: "Dis-moi une durée, par exemple : minuteur de cinq minutes." };
    if (minutes > 600) return { say: "C'est un peu long pour un minuteur." };
    const label = minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60} heure${minutes > 60 ? "s" : ""}` : `${minutes} minute${minutes > 1 ? "s" : ""}`;
    return { say: `Minuteur de ${label} lancé.`, run: () => Timer.startMinutes(minutes) };
  }
  const m = State.media;
  if (m?.active) {
    if (/^(mets? (la musique |la video )?en )?pause$|^pause( la musique)?$|^(coupe|arrete) la musique$/.test(t)) {
      return m.playing ? { say: "", run: () => void Bridge.mediaControl("toggle"), keepMusic: true } : { say: "C'est déjà en pause." };
    }
    if (/^(reprends|relance|remets)( la musique| la lecture)?$|^lecture$|^play$/.test(t)) {
      return { say: "", run: () => { if (!m.playing || resumeMusic) void Bridge.mediaControl("toggle"); }, keepMusic: true };
    }
    if (/^(musique |chanson |piste )?suivante?$|^(passe|zappe)( a la suivante| la chanson| la musique)?$|^next$/.test(t)) {
      return { say: "", run: () => void Bridge.mediaControl("next") };
    }
    if (/^(musique |chanson |piste )?precedente?$|^reviens en arriere$/.test(t)) {
      return { say: "", run: () => void Bridge.mediaControl("previous") };
    }
    if (/\b(c est quoi|quelle est) (cette|la) (musique|chanson)\b|\bqu est ce qui (joue|passe)\b/.test(t)) {
      return { say: m.artist ? `C'est ${m.title}, de ${m.artist}.` : `C'est ${m.title}.` };
    }
  }
  if (/^(ouvre |montre |affiche )?(mes |les )?notifications?$/.test(t)) {
    const n = State.unreadNotices;
    return { say: n ? `Tu as ${n} notification${n > 1 ? "s" : ""}.` : "Aucune nouvelle notification.", run: () => island.setView("notifications") };
  }
  if (/^(ouvre )?(les )?(reglages|parametres)( de tako)?$/.test(t)) return { say: "J'ouvre les réglages.", run: () => void Bridge.openSettingsWindow() };
  return null;
}

function failure(code: string | null): string {
  switch (code) {
    case "silence":
      return "Je n'ai rien entendu.";
    case "unclear":
      return "Je n'ai pas bien compris, tu peux répéter ?";
    case "microphone":
      return "Je n'arrive pas à utiliser ton micro.";
    case "model":
      return "Je télécharge ma reconnaissance vocale (190 Mo, une seule fois). Réessaie dans une minute.";
    case "cpu":
      return "Ton processeur est trop ancien pour la reconnaissance vocale locale (il lui faut AVX2).";
    default:
      return "La reconnaissance vocale a échoué.";
  }
}

function armed(): boolean {
  return State.settings.voiceEnabled && !State.paused && !State.gameMode;
}

function pauseMusic() {
  if (State.media?.active && State.media.playing) {
    resumeMusic = true;
    void Bridge.mediaControl("toggle");
  }
}

function restoreMusic() {
  if (!resumeMusic) return;
  resumeMusic = false;
  if (State.media?.active && !State.media.playing) void Bridge.mediaControl("toggle");
}

function stopSpeaking() {
  speakToken++;
  const node = source;
  source = null;
  try {
    node?.stop();
  } catch {
    node?.disconnect();
  }
}

function settle(holdMs: number) {
  island.voiceMood("off");
  restoreMusic();
  island.releaseVoice(holdMs);
  State.notify();
}

function finish(message: string, failed: boolean) {
  State.voicePhase = "idle";
  State.voiceAnswer = message;
  State.voiceFailed = failed;
  settle(message ? 3600 + Math.min(6000, message.length * 45) : 700);
}

export function listen() {
  if (!armed() || awaiting) return;
  flow++;
  stopSpeaking();
  if (State.voicePhase === "idle") pauseMusic();
  State.voicePhase = "listening";
  State.voicePartial = "";
  State.voiceAnswer = "";
  State.voiceFailed = false;
  island.voiceMood("listen");
  island.openVoice();
  awaiting = true;
  void Bridge.voiceListen();
  State.notify();
}

export async function announce(text: string) {
  if (!State.settings.voiceReplies || State.voicePhase !== "idle" || !island) return;
  const words = plain(text);
  if (!words) return;
  const token = ++speakToken;
  let url: string;
  try {
    url = await Bridge.voiceSay(words);
  } catch {
    return;
  }
  if (token !== speakToken) return;
  island.voiceMood("speak");
  try {
    await play(url, token);
  } catch {
    island.voiceLevel(0);
  }
  if (token === speakToken) island.voiceMood("off");
}

export function stop() {
  flow++;
  if (awaiting) void Bridge.voiceCancel();
  awaiting = false;
  stopSpeaking();
  State.voicePhase = "idle";
  State.voicePartial = "";
  State.voiceAnswer = "";
  State.voiceFailed = false;
  settle(0);
}

async function play(url: string, token: number): Promise<void> {
  ctx ??= new AudioContext();
  if (ctx.state === "suspended") await ctx.resume().catch(() => undefined);
  const raw = atob(url.slice(url.indexOf(",") + 1));
  const data = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) data[i] = raw.charCodeAt(i);
  const buffer = await ctx.decodeAudioData(data.buffer);
  if (token !== speakToken) return;
  const node = ctx.createBufferSource();
  node.buffer = buffer;
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  node.connect(analyser);
  analyser.connect(ctx.destination);
  source = node;
  const samples = new Uint8Array(analyser.fftSize);
  let running = true;
  const meter = () => {
    if (!running) return;
    analyser.getByteTimeDomainData(samples);
    let sum = 0;
    for (const v of samples) {
      const x = (v - 128) / 128;
      sum += x * x;
    }
    island.voiceLevel(Math.min(1, Math.sqrt(sum / samples.length) * 3.4));
    window.requestAnimationFrame(meter);
  };
  await new Promise<void>((resolve) => {
    node.onended = () => resolve();
    node.start();
    window.requestAnimationFrame(meter);
  });
  running = false;
  if (source === node) source = null;
  island.voiceLevel(0);
}

async function speak(text: string, mine: number) {
  const words = plain(text);
  if (!words) return;
  const token = ++speakToken;
  let url: string;
  try {
    url = await Bridge.voiceSay(words);
  } catch {
    return;
  }
  if (token !== speakToken || mine !== flow) return;
  State.voicePhase = "speaking";
  island.voiceMood("speak");
  State.notify();
  try {
    await play(url, token);
  } catch {
    return;
  }
}

async function respond(text: string, mine: number) {
  State.voiceAnswer = text;
  State.voiceFailed = false;
  State.notify();
  if (State.settings.voiceReplies && text) await speak(text, mine);
  if (mine !== flow) return;
  finish(text, false);
}

async function ask(text: string, mine: number) {
  if (!ChatBus.ask) {
    finish("Le chat n'est pas encore prêt.", true);
    return;
  }
  if (ChatBus.busy) {
    finish("Claude répond déjà à une autre question.", true);
    return;
  }
  State.voicePhase = "thinking";
  island.voiceMood("off");
  State.notify();
  try {
    const answer = await ChatBus.ask(text, { spoken: true });
    if (mine !== flow) return;
    if (!answer) {
      finish("Claude n'a rien répondu.", true);
      return;
    }
    await respond(answer, mine);
  } catch (err) {
    if (mine !== flow) return;
    finish(String(err).replace(/^Error:\s*/, ""), true);
  }
}

async function onFinal(final: VoiceFinal) {
  if (!awaiting) return;
  awaiting = false;
  const mine = flow;
  const text = final.text.trim();
  if (final.error === "canceled") return;
  if (final.error || !text) {
    finish(failure(final.error ?? "silence"), true);
    return;
  }
  State.voicePartial = text.charAt(0).toUpperCase() + text.slice(1);
  State.voicePhase = "thinking";
  island.voiceMood("off");
  State.notify();
  const local = localIntent(text);
  if (local) {
    if (local.keepMusic) resumeMusic = false;
    local.run?.();
    if (!local.say) {
      Sound.play("blip");
      finish("", false);
      return;
    }
    await respond(local.say, mine);
    return;
  }
  await ask(text, mine);
}

function onApproval(heard: VoiceHeard): boolean {
  const req = State.pendingApproval;
  if (!req || !State.settings.voiceApprovals) return false;
  if (Date.now() - (req.shownAt ?? 0) < APPROVAL_DELAY_MS) return true;
  if (heard.kind === "yes") {
    if (!heard.sure) {
      island.hud({ key: "voice-approval", tone: "#F5A524", icon: "mic", title: "Pas sûr d'avoir compris", detail: "Redis « Tako, oui » bien distinctement.", ms: 2600, priority: 2 });
      return true;
    }
    decideCurrent(island, "allow");
  } else {
    decideCurrent(island, "deny");
  }
  return true;
}

function onHeard(heard: VoiceHeard) {
  if (!armed() || State.call) return;
  if (heard.kind === "stop") {
    if (State.voicePhase !== "idle" || State.view === "voice") stop();
    return;
  }
  if (heard.kind === "yes" || heard.kind === "no") {
    onApproval(heard);
    return;
  }
  const now = Date.now();
  if (now - lastWake < 900 || State.voicePhase === "listening") return;
  lastWake = now;
  listen();
}

export function registerVoice(target: Island) {
  island = target;
  VoiceUi.onListen = () => listen();
  VoiceUi.onStop = () => stop();
  VoiceUi.onChat = () => {
    stop();
    island.setView("prompt");
  };
  void onEvent<VoiceHeard>("voice", (heard) => onHeard(heard));
  void onEvent<string>("voice-partial", (text) => {
    if (State.voicePhase !== "listening") return;
    State.voicePartial = text;
    State.notify();
  });
  void onEvent<number>("voice-level", (peak) => {
    if (State.voicePhase === "listening") island.voiceLevel(Math.min(1, Math.pow(Math.max(0, peak), 0.6) * 1.7));
  });
  void onEvent<VoiceFinal>("voice-final", (final) => void onFinal(final));
  void onEvent<null>("voice-ready", () => {
    if (State.voicePhase === "listening") Sound.play("peek");
  });
  void onEvent<null>("voice-busy", () => {
    if (State.voicePhase !== "listening") return;
    State.voicePhase = "thinking";
    island.voiceMood("off");
    State.notify();
  });
}
