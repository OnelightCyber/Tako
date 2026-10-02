import type { Island } from "../src/island/island";
import { State, type AgentTask } from "../src/core/state";
import { colorForProject } from "../src/core/layout";
import { testLens } from "../src/island/lens";
import { VoiceUi } from "../src/views/voice";

function busy(): AgentTask {
  return {
    id: "session:a1",
    name: "Tako",
    color: colorForProject("Tako"),
    state: "working",
    stepIndex: 1,
    steps: ["Lit · island.ts", "Modifie · voice.ts"],
    source: "claudeCode",
    isIntegration: false,
    sessionId: "a1",
    sessionCwd: String.raw`C:\Users\dev\Desktop\Tako`,
    activity: [],
    prompt: "ajoute le mode Jarvis",
    lastEventAt: Date.now(),
  };
}

export function runAliveDemo(island: Island, kind: string) {
  (window as unknown as { __island: Island; __state: typeof State }).__island = island;
  (window as unknown as { __state: typeof State }).__state = State;
  State.weather = { city: "Paris", temp: 14.2, code: 3, isDay: true, max: 17, min: 9, wind: 12, humidity: 71, days: [] };
  State.settings.voiceEnabled = kind.startsWith("voice") || kind === "glance-mic";
  window.setTimeout(() => {
    if (kind === "glance" || kind === "glance-mic") {
      island.fsm.forcePetit();
    } else if (kind === "session") {
      State.tasks.unshift(busy());
      State.focusId = "session:a1";
      island.fsm.forcePetit();
    } else if (kind.startsWith("lens-")) {
      island.fsm.forcePetit();
      window.setTimeout(() => testLens(island, kind.slice(5)), 300);
    } else if (kind === "voice-listen") {
      State.voicePhase = "listening";
      State.voicePartial = "Quelle heure est-il à";
      island.openVoice();
      island.voiceMood("listen");
      let t = 0;
      window.setInterval(() => {
        t += 0.05;
        const level = Math.abs(Math.sin(t * 7)) * 0.7 * (0.6 + 0.4 * Math.sin(t * 2.3));
        island.voiceLevel(level);
        VoiceUi.push(level);
      }, 45);
    } else if (kind === "voice-think") {
      State.voicePhase = "thinking";
      State.voicePartial = "Explique-moi ce qu'est une closure";
      island.openVoice();
    } else if (kind === "voice-answer") {
      State.voicePhase = "idle";
      State.voicePartial = "Explique-moi ce qu'est une closure";
      State.voiceAnswer = "Une closure, c'est une fonction qui garde accès aux variables de l'endroit où elle a été créée, même après que cet endroit a fini de s'exécuter.";
      island.openVoice();
    } else if (kind === "voice-fail") {
      State.voicePhase = "idle";
      State.voiceFailed = true;
      State.voicePartial = "";
      State.voiceAnswer = "Active la reconnaissance vocale en ligne dans Windows : Paramètres, Confidentialité, Voix.";
      island.openVoice();
    }
    State.notify();
  }, 1600);
}
