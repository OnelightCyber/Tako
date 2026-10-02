import "./style.css";
import "./session.css";
import "./extra.css";
import "./live.css";
import "./hud.css";
import "./alive.css";
import "./squad.css";
import { Bridge, IS_TAURI, onEvent } from "./core/bridge";
import { Sound } from "./core/sound";
import { State, type Settings } from "./core/state";
import { Island } from "./island/island";
import { registerHookHandlers } from "./island/hooks";
import { registerIntegrationHandlers, refreshConfigured } from "./island/integrations";
import { registerExtras } from "./island/extras";
import { registerLive } from "./island/live";
import { registerSystem } from "./island/system";
import { registerVoice } from "./island/voice";
import { registerLens } from "./island/lens";
import { registerSquad } from "./island/squad";

async function main() {
  const root = document.getElementById("root");
  if (!root) return;

  void Sound.preload();

  const island = new Island(root);

  const boot = await Bridge.boot();
  if (boot) {
    State.settings = { ...State.settings, ...boot.settings };
  }
  island.applySettings();
  State.loadIntegrationTasks();
  State.chatBackend = await Bridge.chatBackend();

  await onEvent<{ x: number; y: number }>("cursor", ({ x, y }) => island.onCursor(x, y));

  const setPaused = (on: boolean) => {
    if (State.paused === on) return;
    State.paused = on;
    void Bridge.setPaused(on);
  };

  await onEvent<string>("tray", (what) => {
    switch (what) {
      case "settings":
        setPaused(false);
        island.alert("settings");
        break;
      case "open":
        setPaused(false);
        island.alert(State.defaultView());
        break;
      case "pause":
        setPaused(!State.paused);
        if (State.paused) island.fsm.forceHidden();
        else island.reveal();
        break;
    }
  });

  await onEvent<null>("screen-changed", () => void Bridge.reposition());

  await onEvent<null>("drag-wake", () => {
    void Bridge.log(`drag-wake mode=${State.mode}`);
    if (State.mode === "hidden" && !State.paused) island.reveal();
  });


  await onEvent<Settings>("settings-changed", (s) => {
    State.settings = { ...State.settings, ...s };
    island.applySettings();
    State.loadIntegrationTasks();
    void refreshConfigured();
  });

  registerHookHandlers(island);
  registerExtras(island);
  registerLive(island);
  registerSystem(island);
  registerVoice(island);
  registerLens(island);
  registerSquad(island);
  registerIntegrationHandlers(island);

  island.launch();

  if (localStorage.getItem("tako.debug") === "1") {
    const { Hud } = await import("./core/hud");
    Object.assign(window, { __tako: { State, Hud, island } });
  }

  if (!IS_TAURI) {
    document.addEventListener("click", () => Sound.resume(), { once: true });
    const params = new URLSearchParams(location.search);
    const feature = params.get("feature");
    const hud = params.get("hud");
    const alive = params.get("alive");
    if (import.meta.env.DEV && alive) {
      const { runAliveDemo } = await import("../dev/alive-demo");
      runAliveDemo(island, alive);
    } else if (import.meta.env.DEV && hud) {
      const { demoSystem } = await import("./island/system");
      (window as unknown as { __island: Island; __state: typeof State }).__island = island;
      (window as unknown as { __state: typeof State }).__state = State;
      window.setTimeout(() => {
        island.fsm.forcePetit();
        demoSystem(island, hud);
      }, 1800);
    } else if (import.meta.env.DEV && feature) {
      const { runFeatureDemo } = await import("../dev/features-demo");
      runFeatureDemo(island, feature);
    } else if (import.meta.env.DEV && location.search.includes("demo=usage")) {
      const { runUsageDemo } = await import("../dev/usage-demo");
      runUsageDemo(island);
    } else if (import.meta.env.DEV && location.search.includes("demo")) {
      const { runSessionDemo } = await import("../dev/session-demo");
      runSessionDemo(island);
    }
  }
}

void main();
