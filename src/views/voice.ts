import { h, clear } from "./dom";
import { proIcon } from "./pro-icons";
import { fit } from "./extra";
import { ChatBus } from "./chat";
import { State } from "../core/state";
import type { ViewActions, ViewHost } from "./views";

const BARS = 34;

export const VoiceUi = {
  onListen: () => {},
  onStop: () => {},
  onChat: () => {},
  push: (_level: number) => {},
};

function statusText(): { text: string; tone: string } {
  switch (State.voicePhase) {
    case "listening":
      return { text: "Je t'écoute…", tone: "listen" };
    case "thinking":
      return { text: State.chatStatus || (ChatBus.busy ? "Claude réfléchit…" : "Un instant…"), tone: "think" };
    case "speaking":
      return { text: "Tako te répond", tone: "speak" };
    default:
      return State.voiceFailed ? { text: "Petit souci", tone: "fail" } : { text: State.voiceAnswer ? "Réponse" : "Dis « Hey Tako »", tone: "idle" };
  }
}

export function buildVoice(actions: ViewActions): ViewHost {
  const dotEl = h("i", { class: "vo-dot" });
  const status = h("span", { class: "vo-status-text" });
  const mic = h("button", { class: "vo-btn", title: "Reparler" }, proIcon("mic", 13, 2.2));
  const stop = h("button", { class: "vo-btn", title: "Arrêter" }, proIcon("x", 13, 2.4));
  const chat = h("button", { class: "vo-btn", title: "Continuer dans le chat" }, proIcon("message", 13, 2.2));
  for (const b of [mic, stop, chat]) b.addEventListener("mousedown", (e) => e.stopPropagation());
  mic.addEventListener("click", () => {
    actions.blip();
    VoiceUi.onListen();
  });
  stop.addEventListener("click", () => VoiceUi.onStop());
  chat.addEventListener("click", () => {
    actions.blip();
    VoiceUi.onChat();
  });
  const head = h("div", { class: "vo-head" }, h("div", { class: "vo-status" }, dotEl, status), h("div", { class: "vo-actions" }, mic, chat, stop));
  const said = h("div", { class: "vo-said" });
  const answer = h("div", { class: "vo-answer" });
  const wave = h("div", { class: "vo-wave" });
  const bars: HTMLElement[] = [];
  for (let i = 0; i < BARS; i++) {
    const bar = h("i");
    bar.style.setProperty("--i", String(i));
    bars.push(bar);
    wave.append(bar);
  }
  const history: number[] = new Array(BARS).fill(0);
  const body = h("div", { class: "stack vo-body" }, head, said, answer, wave);
  const el = h("div", { class: "view fits voice-view" }, h("div", { class: "card wash vo-card" }, body));
  let key = "";

  VoiceUi.push = (level: number) => {
    history.shift();
    history.push(Math.max(0, Math.min(1, level)));
    if (State.view !== "voice" || State.mode !== "expanded") return;
    for (let i = 0; i < BARS; i++) {
      const fade = 0.35 + 0.65 * Math.sin((Math.PI * (i + 0.5)) / BARS);
      bars[i].style.transform = `scaleY(${(0.08 + history[i] * 0.92 * fade).toFixed(3)})`;
    }
  };

  return {
    el,
    sync() {
      const phase = State.voicePhase;
      const s = statusText();
      el.dataset.phase = phase;
      el.dataset.tone = s.tone;
      status.textContent = s.text;
      const heard = State.voicePartial;
      const reply = phase === "thinking" ? State.chatPartial : State.voiceAnswer;
      const next = `${phase}~${heard}~${reply.length}~${s.text}~${State.voiceFailed}`;
      if (next === key) return;
      key = next;
      said.textContent = heard ? `« ${heard} »` : phase === "listening" ? "Parle, je t'écoute." : "";
      said.classList.toggle("ghost", !heard);
      clear(answer);
      if (reply) answer.textContent = reply;
      answer.style.display = reply ? "" : "none";
      wave.classList.toggle("on", phase === "listening" || phase === "speaking");
      wave.classList.toggle("think", phase === "thinking");
      mic.style.display = phase === "listening" ? "none" : "";
      chat.style.display = State.chatHistory.length > 0 && phase !== "listening" ? "" : "none";
      if (phase !== "listening" && phase !== "speaking") {
        history.fill(0);
        for (const bar of bars) bar.style.transform = "";
      }
      window.requestAnimationFrame(() => {
        if (State.view === "voice") fit("voice", el, body);
      });
    },
  };
}
